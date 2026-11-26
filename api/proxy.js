import { assertPublicUrl, httpError } from './_lib/net.js';
import { rewriteHtml, rewriteCss } from './_lib/rewrite.js';

const MAX_BYTES = 4_000_000; // Vercel caps serverless responses at ~4.5 MB
const MAX_REDIRECTS = 5;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PASS_HEADERS = [
  'content-type',
  'cache-control',
  'content-disposition',
  'last-modified',
  'etag',
  'content-range',
  'accept-ranges',
  'expires',
];

function decode(buf, type) {
  const m = type.match(/charset=([^;]+)/i);
  try {
    return new TextDecoder((m?.[1] || 'utf-8').trim()).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

async function fetchFollow(start, init) {
  let current = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const url = await assertPublicUrl(current);
    const r = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const location = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && location) {
      current = new URL(location, url).href;
      if (init.method === 'POST' && [301, 302, 303].includes(r.status)) {
        init = { ...init, method: 'GET', body: undefined };
      }
      continue;
    }
    return { upstream: r, finalUrl: url.href };
  }
  throw httpError(508, 'That site redirected too many times.');
}

function sendError(res, status, message) {
  const safe = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res
    .status(status)
    .setHeader('content-type', 'text/html; charset=utf-8')
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Can't open this page</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#eaf0ec;color:#17261f}
  @media (prefers-color-scheme:dark){body{background:#0f1a16;color:#e4eee7}}
  main{max-width:30rem;padding:2rem}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;opacity:.8}
</style>
<main><h1>Willow can't open this page</h1><p>${safe}</p></main>`);
}

export default async function handler(req, res) {
  try {
    const target = req.query.url;
    if (!target) throw httpError(400, 'No address was given.');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw httpError(405, 'Unsupported request method.');

    const headers = {
      'user-agent': UA,
      accept: req.headers.accept || '*/*',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    };
    if (req.headers.range) headers.range = req.headers.range;

    const init = { method: req.method, headers };
    if (req.method === 'POST' && req.body != null) {
      const ct = req.headers['content-type'] || '';
      headers['content-type'] = ct;
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') init.body = req.body;
      else if (ct.includes('json')) init.body = JSON.stringify(req.body);
      else init.body = new URLSearchParams(req.body).toString();
    }

    const { upstream, finalUrl } = await fetchFollow(String(target), init);
    const type = (upstream.headers.get('content-type') || '').toLowerCase();

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw httpError(413, 'This file is too large to open through Willow.');
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) throw httpError(413, 'This file is too large to open through Willow.');

    for (const h of PASS_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (req.method === 'GET' && upstream.ok && type.startsWith('image/')) {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    }
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(upstream.status);

    if (req.method === 'HEAD') return res.end();

    if (type.includes('text/html') || type.includes('application/xhtml')) {
      res.removeHeader('etag');
      res.removeHeader('last-modified');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.send(rewriteHtml(decode(buf, type), finalUrl));
    }

    if (type.includes('text/css')) {
      res.removeHeader('etag');
      res.removeHeader('last-modified');
      res.setHeader('content-type', 'text/css; charset=utf-8');
      return res.send(rewriteCss(decode(buf, type), finalUrl));
    }

    return res.send(buf);
  } catch (err) {
    return sendError(res, err.status || 502, err.status ? err.message : 'The site could not be reached.');
  }
}
