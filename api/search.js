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

export default async function handler(req, res) {
  const q = String(req.query.q || '').trim();
  const page = Math.min(9, Math.max(0, parseInt(req.query.page, 10) || 0));

  if (!q) return res.status(400).json({ error: 'Type something to search for.' });

  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'BRAVE_API_KEY is not set. Add it in your Vercel project settings.' });
  }

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q.slice(0, 400));
  url.searchParams.set('count', '20');
  url.searchParams.set('offset', String(page));
  url.searchParams.set('safesearch', 'moderate');
  url.searchParams.set('text_decorations', 'false');

  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(10000),
    });

    if (r.status === 429) return res.status(429).json({ error: 'Brave Search rate limit reached. Try again in a moment.' });
    if (r.status === 401 || r.status === 403 || r.status === 422) {
      return res.status(502).json({ error: 'Brave Search rejected the API key. Check BRAVE_API_KEY.' });
    }
    if (!r.ok) return res.status(502).json({ error: `Brave Search returned an error (${r.status}).` });

    const data = await r.json();
    const results = (data.web?.results || []).map((x) => {
      let host = '';
      try {
        host = new URL(x.url).hostname.replace(/^www\./, '');
      } catch {}
      return {
        title: strip(x.title) || host,
        url: x.url,
        host,
        description: strip(x.description),
        favicon: x.meta_url?.favicon || null,
        age: x.age || null,
      };
    });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      query: q,
      altered: data.query?.altered || null,
      page,
      hasMore: Boolean(data.query?.more_results_available) && page < 9,
      results,
    });
  } catch {
    return res.status(502).json({ error: 'Could not reach Brave Search.' });
  }
}
