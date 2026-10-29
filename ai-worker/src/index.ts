// Gym Tracker AI proxy.
//
// The tracker page (public GitHub Pages) can never hold the Anthropic key, so it sends
// each question here with the signed-in user's Firebase ID token. This Worker:
//   1. checks the origin (CORS) and verifies the token with Firebase (accounts:lookup),
//   2. allows only the e-mails in ALLOWED_EMAILS (FO),
//   3. refuses when this month's spend has reached MONTHLY_CAP_USD,
//   4. streams Claude's answer back as Server-Sent Events,
//   5. records token usage + estimated cost in KV so the page can show an "AI usage" panel.
//
// Routes:  OPTIONS *        CORS preflight
//          POST   /ask      {question, context, history?, feature?, effort?}  -> SSE stream
//          GET    /usage    this month's ledger  {month, cap, total_usd, requests, rows[]}
//          GET    /health   {ok:true}

import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  AI_LEDGER: KVNamespace;
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGINS: string;
  ALLOWED_EMAILS: string;
  FIREBASE_API_KEY: string;
  MONTHLY_CAP_USD: string;
  MODEL: string;
}

// USD per million tokens (input / output / cache read / 5-min cache write).
// Fable 5.1: $10 / $50 / $0.25 / $12.50.  Opus 5.5: $4 / $20 / $0.20 / $5.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

const SYSTEM_PROMPT = `You are the AI coach inside a personal gym-tracking app. The user is an experienced recreational lifter in Melbourne, Australia who trains with a 4-week exercise rotation, logs every set (kg and reps), Peloton rides, incline walks and swims, and tracks nutrition and bodyweight.

You receive a data packet with the user's profile and a summary of the last weeks of training, cardio and nutrition. Answer from that data first. Use metric units (kg, cm, km/h, kcal). Be direct and specific: name exercises, weights, rep ranges, set counts and dates from the packet rather than speaking in generalities. When comparing to strength standards for the user's age, bodyweight and sex, say which standard you are using and that it is a general population reference.

Rules:
- If the packet lacks the data a question needs, say so and ask for it instead of guessing.
- Flag anything in the data that looks like a risk: sudden volume jumps, repeated missed body parts, very low protein, rapid weight change, a pattern that suggests an injury.
- You give general training and nutrition guidance, not medical advice. If something sounds like pain, illness or a medical condition, say so once, briefly, and suggest a professional.
- Keep answers tight. Lead with the answer, then the reasoning. Use short headings or bullets only when they help; no filler, no restating the question.
- Numbers in the packet are from the user's own log. Do not invent sessions, weights or dates that are not in it.`;

type Row = { ts: string; feature: string; model: string; in: number; out: number; cr: number; cw: number; usd: number };
type Ledger = { month: string; total_usd: number; requests: number; rows: Row[] };

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function monthKey(d = new Date()): string {
  // Melbourne calendar month so the cap resets when the user's month does.
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

async function readLedger(env: Env, month: string): Promise<Ledger> {
  const raw = await env.AI_LEDGER.get(`ledger:${month}`);
  if (raw) {
    try { return JSON.parse(raw) as Ledger; } catch { /* fall through */ }
  }
  return { month, total_usd: 0, requests: 0, rows: [] };
}

function costUsd(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const p = PRICES[model] || PRICES["claude-opus-5-5"];
  const cr = u.cache_read_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  return (u.input_tokens * p.input + u.output_tokens * p.output + cr * p.cacheRead + cw * p.cacheWrite) / 1_000_000;
}

// --- Firebase ID token check --------------------------------------------------------------
// One HTTPS call to Google; no JWT libraries needed. Results cached in memory for 5 minutes
// per token so a chat of several questions costs one lookup.
const tokenCache = new Map<string, { email: string; exp: number }>();

async function verifyUser(req: Request, env: Env): Promise<{ email: string } | { error: string; status: number }> {
  const auth = req.headers.get("Authorization") || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!idToken) return { error: "Missing Authorization bearer token", status: 401 };

  const now = Date.now();
  const hit = tokenCache.get(idToken);
  let email = hit && hit.exp > now ? hit.email : "";
  if (!email) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!r.ok) return { error: "Firebase rejected the token", status: 401 };
    const data = (await r.json()) as { users?: { email?: string; disabled?: boolean }[] };
    const u = data.users && data.users[0];
    if (!u || !u.email || u.disabled) return { error: "Unknown or disabled user", status: 401 };
    email = u.email.toLowerCase();
    tokenCache.set(idToken, { email, exp: now + 5 * 60 * 1000 });
    if (tokenCache.size > 200) tokenCache.clear();
  }
  const allowed = env.ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email)) return { error: "This account is not allowed to use the AI coach", status: 403 };
  return { email };
}

// --- request body -------------------------------------------------------------------------
type AskBody = {
  question: string;
  context?: string;                       // data packet built by the page (profile + training summary)
  history?: { role: "user" | "assistant"; content: string }[];
  feature?: string;                       // "ask" | "weekly" | "month" (ledger label)
  effort?: "low" | "medium" | "high";
};

function cleanBody(b: AskBody): AskBody | string {
  if (!b || typeof b.question !== "string" || !b.question.trim()) return "question is required";
  if (b.question.length > 6000) return "question too long (6000 chars max)";
  if (b.context && (typeof b.context !== "string" || b.context.length > 60000)) return "context too large (60 kB max)";
  const history = Array.isArray(b.history) ? b.history.slice(-12) : [];
  for (const h of history) {
    if (!h || (h.role !== "user" && h.role !== "assistant") || typeof h.content !== "string") return "bad history entry";
    if (h.content.length > 20000) return "history entry too long";
  }
  const feature = typeof b.feature === "string" ? b.feature.slice(0, 20) : "ask";
  const effort = b.effort === "low" || b.effort === "high" ? b.effort : "medium";
  return { question: b.question.trim(), context: b.context || "", history, feature, effort };
}

// --- SSE helpers --------------------------------------------------------------------------
function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get("Origin");
    const cors = corsHeaders(origin, env);
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health") return json({ ok: true, model: env.MODEL }, 200, cors);

    const who = await verifyUser(req, env);
    if ("error" in who) return json({ error: who.error }, who.status, cors);

    const month = monthKey();
    const cap = parseFloat(env.MONTHLY_CAP_USD) || 0;

    if (req.method === "GET" && url.pathname === "/usage") {
      const led = await readLedger(env, month);
      return json({ ...led, cap, remaining_usd: Math.max(0, cap - led.total_usd), model: env.MODEL }, 200, cors);
    }

    if (req.method !== "POST" || url.pathname !== "/ask") return json({ error: "Not found" }, 404, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Worker has no ANTHROPIC_API_KEY secret yet" }, 500, cors);

    let parsed: AskBody | string;
    try { parsed = cleanBody((await req.json()) as AskBody); } catch { parsed = "body must be JSON"; }
    if (typeof parsed === "string") return json({ error: parsed }, 400, cors);
    const body = parsed;

    const ledger = await readLedger(env, month);
    if (cap > 0 && ledger.total_usd >= cap) {
      return json({ error: `Monthly AI cap of $${cap} reached for ${month}. It resets on the 1st.`, capped: true }, 429, cors);
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
    const model = env.MODEL || "claude-opus-5-5";

    // System = fixed instructions + the data packet. The packet is the same for every follow-up
    // question in one sitting, so the cache marker on it makes follow-ups cheap.
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT }];
    if (body.context) {
      system.push({ type: "text", text: `<data_packet>\n${body.context}\n</data_packet>`, cache_control: { type: "ephemeral" } });
    }
    const messages: Anthropic.MessageParam[] = [
      ...body.history!.map((h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam),
      { role: "user", content: body.question },
    ];

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const run = async () => {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: body.feature === "month" ? 16000 : 4000,
          thinking: { type: "adaptive" },
          output_config: { effort: body.effort },
          system,
          messages,
        });
        stream.on("text", (delta) => { void writer.write(sse({ type: "text", text: delta })); });
        const final = await stream.finalMessage();
        const usd = costUsd(model, final.usage);
        const row: Row = {
          ts: new Date().toISOString(), feature: body.feature!, model,
          in: final.usage.input_tokens, out: final.usage.output_tokens,
          cr: final.usage.cache_read_input_tokens || 0, cw: final.usage.cache_creation_input_tokens || 0,
          usd: Math.round(usd * 10000) / 10000,
        };
        // Re-read so two overlapping requests do not clobber each other's rows.
        const led = await readLedger(env, month);
        led.rows.push(row);
        if (led.rows.length > 300) led.rows = led.rows.slice(-300);
        led.requests += 1;
        led.total_usd = Math.round((led.total_usd + usd) * 10000) / 10000;
        await env.AI_LEDGER.put(`ledger:${month}`, JSON.stringify(led), { expirationTtl: 60 * 60 * 24 * 400 });
        await writer.write(sse({
          type: "done",
          stop_reason: final.stop_reason,
          usage: { input: row.in, output: row.out, cache_read: row.cr, cache_write: row.cw },
          usd: row.usd, month_total_usd: led.total_usd, cap, remaining_usd: Math.max(0, cap - led.total_usd),
        }));
      } catch (err: unknown) {
        let msg = "Unexpected error";
        if (err instanceof Anthropic.RateLimitError) msg = "Claude is rate-limited right now, try again in a minute.";
        else if (err instanceof Anthropic.AuthenticationError) msg = "The Anthropic key was rejected. Check the Worker secret.";
        else if (err instanceof Anthropic.APIError) msg = `Claude API error ${err.status}: ${err.message}`;
        else if (err instanceof Error) msg = err.message;
        await writer.write(sse({ type: "error", error: msg }));
      } finally {
        await writer.close();
      }
    };
    ctx.waitUntil(run());

    return new Response(readable, {
      status: 200,
      headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
    });
  },
};
