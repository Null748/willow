// Search provider is picked by which key is set in Vercel:
//   SERPER_API_KEY -> Google results via serper.dev (web + images)
//   BRAVE_API_KEY  -> Brave Search API (web only)
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

// Backstop for SafeSearch: drops obvious adult sites even if the provider lets them through.
const BAD_HOST = /(^|\.)(pornhub|xvideos|xnxx|xhamster|redtube|youporn|spankbang|chaturbate|stripchat|onlyfans|rule34|nhentai|e-hentai|hentaihaven|brazzers|bangbros)\./i;
const BAD_WORD = /\b(porn|porno|xxx|hentai|nsfw|onlyfans|sex ?cams?)\b/i;
const isAdult = (...parts) => {
  const text = parts.filter(Boolean).join(' ');
  return BAD_HOST.test(hostOf(parts[0] || '') + '.') || BAD_HOST.test(text.replace(/^https?:\/\//, '')) || BAD_WORD.test(text);
};

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

async function serperCall(endpoint, body, key) {
  return fetch(`https://google.serper.dev/${endpoint}`, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

async function serper({ q, page, type, safe, key }) {
  const images = type === 'images';
  const endpoint = images ? 'images' : 'search';
  const num = images ? 20 : 10;
  const body = { q, num, page: page + 1, safe: safe ? 'active' : 'off' };

  let r = await serperCall(endpoint, body, key);
  if (r.status === 400) {
    // If Serper rejects the safe-search field, try again without it.
    const { safe: _drop, ...rest } = body;
    r = await serperCall(endpoint, rest, key);
  }

  if (r.status === 429) throw fail(429, 'Search rate limit reached. Try again in a moment.');
  if (r.status === 401 || r.status === 403) throw fail(502, 'Serper rejected the API key. Check SERPER_API_KEY.');
  if (r.status === 400) {
    const err = await r.json().catch(() => ({}));
    throw fail(502, err.message || 'Serper could not run that search (you may be out of credits).');
  }
  if (!r.ok) throw fail(502, `Serper returned an error (${r.status}).`);

  const data = await r.json();

  if (images) {
    let results = (data.images || [])
      .map((x) => ({
        title: strip(x.title),
        url: x.imageUrl,
        thumb: x.thumbnailUrl,
        width: x.imageWidth || null,
        height: x.imageHeight || null,
        source: x.source || x.domain || hostOf(x.link),
        pageUrl: isHttp(x.link) ? x.link : null,
      }))
      .filter((x) => isHttp(x.url) || isHttp(x.thumb));
    if (safe) results = results.filter((x) => !isAdult(x.pageUrl, x.title, x.url));
    return { results, altered: null, hasMore: (data.images || []).length >= num && page < 9 };
  }

  let results = (data.organic || []).map((x) => {
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
  if (safe) results = results.filter((x) => !isAdult(x.url, x.title));
  return { results, altered: null, hasMore: (data.organic || []).length >= 10 && page < 9 };
}

async function brave({ q, page, type, safe, key }) {
  if (type === 'images') throw fail(501, 'Image search needs a SERPER_API_KEY.');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q);
  url.searchParams.set('count', '20');
  url.searchParams.set('offset', String(page));
  url.searchParams.set('safesearch', safe ? 'strict' : 'off');
  url.searchParams.set('text_decorations', 'false');

  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429) throw fail(429, 'Brave Search rate limit reached. Try again in a moment.');
  if ([401, 403, 422].includes(r.status)) throw fail(502, 'Brave Search rejected the API key. Check BRAVE_API_KEY.');
  if (!r.ok) throw fail(502, `Brave Search returned an error (${r.status}).`);

  const data = await r.json();
  let results = (data.web?.results || []).map((x) => {
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
  if (safe) results = results.filter((x) => !isAdult(x.url, x.title));
  return {
    results,
    altered: data.query?.altered || null,
    hasMore: Boolean(data.query?.more_results_available) && page < 9,
  };
}

export default async function handler(req, res) {
  const q = String(req.query.q || '').trim().slice(0, 400);
  const page = Math.min(9, Math.max(0, parseInt(req.query.page, 10) || 0));
  const type = req.query.type === 'images' ? 'images' : 'web';
  const safe = req.query.safe !== '0';
  if (!q) return res.status(400).json({ error: 'Type something to search for.' });

  const serperKey = process.env.SERPER_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (!serperKey && !braveKey) {
    return res.status(500).json({
      error: 'No search key is set. Add SERPER_API_KEY (or BRAVE_API_KEY) in your Vercel project settings.',
    });
  }

  try {
    const out = serperKey
      ? await serper({ q, page, type, safe, key: serperKey })
      : await brave({ q, page, type, safe, key: braveKey });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ query: q, page, type, ...out });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.status ? err.message : 'Could not reach the search provider.' });
  }
}
