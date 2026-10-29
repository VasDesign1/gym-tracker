# gym-tracker-ai (Cloudflare Worker)

Proxy between the gym tracker page and the Claude API. Holds the Anthropic key as a Worker
secret, verifies the Firebase login, allows only the FO account, enforces a monthly cap and
keeps a usage ledger in KV. No secret lives in this folder or in the repo.

## One-time setup (run from this folder)

```
npm install
npx wrangler login                              # browser opens, pick the Cloudflare account
npx wrangler kv namespace create AI_LEDGER      # paste the printed id into wrangler.toml
npx wrangler deploy                             # prints the Worker URL
```

Then in the Cloudflare dashboard: Workers & Pages -> gym-tracker-ai -> Settings ->
Variables and Secrets -> Add -> type Secret, name `ANTHROPIC_API_KEY`, paste the key -> Deploy.

Put the Worker URL into `index.html` (`AI_WORKER_URL`).

## Day to day

```
npx wrangler deploy        # after any change in src/
npx wrangler tail          # live logs
```

Cap: `MONTHLY_CAP_USD` in `wrangler.toml` (redeploy after changing). Resets each Melbourne
calendar month. The Console spend limit on the Anthropic side is the outer guard.

## Local check without a key

```
npx wrangler dev           # http://localhost:8787
curl http://localhost:8787/health
curl -i http://localhost:8787/usage      # 401, no token
```
