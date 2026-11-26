# Willow

A modern web proxy with a search front end. Search results come from the Brave Search API, and every result opens through a server-side proxy running on Vercel.

```
public/index.html     the whole front end (home, results, page viewer)
api/search.js         GET /api/search?q=...&page=0   -> Brave Search API
api/proxy.js          GET /api/proxy?url=...         -> fetches and rewrites pages
api/_lib/net.js       SSRF guard (blocks localhost / private IPs)
api/_lib/rewrite.js   HTML/CSS URL rewriting + injected runtime shim
```

## Deploy

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project**, import the repo, keep the defaults (no build command, no framework).
3. Under **Settings → Environment Variables** add `BRAVE_API_KEY` (key from https://brave.com/search/api/), then redeploy.

## Run locally

```bash
npm i -g vercel
npm install
cp .env.example .env     # add your key
vercel dev
```

## Known limits

- Vercel caps serverless responses at ~4.5 MB, so large downloads and video are refused.
- No WebSockets, and cookies are not forwarded, so logins don't work.
- Sites built as heavy JavaScript apps (ES module imports, service workers, location changes done in script) may only partly work.
- Anything proxied runs on your domain's origin. Keep secrets, cookies and logins off that domain.
- A public proxy gets abused. Before sharing the link widely, add rate limiting (Vercel Firewall or Upstash Ratelimit) and check Vercel's Acceptable Use Policy.
