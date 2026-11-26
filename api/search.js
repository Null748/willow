// Search provider is picked by which key is set in Vercel:
//   SERPER_API_KEY -> Google results via serper.dev (no credit card for the free trial)
//   BRAVE_API_KEY  -> Brave Search API
const strip = (s = '') =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function fail(status, error) {
  const e = new Error(error);
  e.status = status;
  return e;
}

async function serper(q, page, key) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: 10, page: page + 1 }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429) throw fail(429, 'Search rate limit reached. Try again in a moment.');
  if (r.status === 401 || r.status === 403) throw fail(502, 'Serper rejected the API key. Check SERPER_API_KEY.');
  if (r.status === 400) {
    const body = await r.json().catch(() => ({}));
    throw fail(502, body.message || 'Serper could not run that search (you may be out of credits).');
  }
  if (!r.ok) throw fail(502, `Serper returned an error (${r.status}).`);

  const data = await r.json();
  const results = (data.organic || []).map((x) => {
    const host = hostOf(x.link);
    return {
      title: strip(x.title) || host,
      url: x.link,
      host,
      description: strip(x.snippet),
      favicon: host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null,
      age: x.date || null,
    };
  });
  return { results, altered: null, hasMore: results.length >= 10 && page < 9 };
}

async function brave(q, page, key) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q);
  url.searchParams.set('count', '20');
  url.searchParams.set('offset', String(page));
  url.searchParams.set('safesearch', 'moderate');
  url.searchParams.set('text_decorations', 'false');

  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429) throw fail(429, 'Brave Search rate limit reached. Try again in a moment.');
  if ([401, 403, 422].includes(r.status)) throw fail(502, 'Brave Search rejected the API key. Check BRAVE_API_KEY.');
  if (!r.ok) throw fail(502, `Brave Search returned an error (${r.status}).`);

  const data = await r.json();
  const results = (data.web?.results || []).map((x) => {
    const host = hostOf(x.url);
    return {
      title: strip(x.title) || host,
      url: x.url,
      host,
      description: strip(x.description),
      favicon: x.meta_url?.favicon || null,
      age: x.age || null,
    };
  });
  return {
    results,
    altered: data.query?.altered || null,
    hasMore: Boolean(data.query?.more_results_available) && page < 9,
  };
}

export default async function handler(req, res) {
  const q = String(req.query.q || '').trim().slice(0, 400);
  const page = Math.min(9, Math.max(0, parseInt(req.query.page, 10) || 0));
  if (!q) return res.status(400).json({ error: 'Type something to search for.' });

  const serperKey = process.env.SERPER_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (!serperKey && !braveKey) {
    return res.status(500).json({
      error: 'No search key is set. Add SERPER_API_KEY (or BRAVE_API_KEY) in your Vercel project settings.',
    });
  }

  try {
    const out = serperKey ? await serper(q, page, serperKey) : await brave(q, page, braveKey);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ query: q, page, ...out });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.status ? err.message : 'Could not reach the search provider.' });
  }
}
