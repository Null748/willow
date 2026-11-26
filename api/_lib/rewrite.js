import { load } from 'cheerio';

const P = '/api/proxy?url=';
const SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;

/** Turns any URL found in a page into a Willow proxy URL. */
export function proxify(raw, base) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s || SKIP.test(s) || s.startsWith(P)) return raw;
  try {
    const u = new URL(s, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    const hash = u.hash;
    u.hash = '';
    return P + encodeURIComponent(u.href) + hash;
  } catch {
    return raw;
  }
}

export function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_, q, u) => `url(${q}${proxify(u, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, q, u) => `@import ${q}${proxify(u, base)}${q}`);
}

function rewriteSrcset(value, base) {
  return value
    .split(',')
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      if (bits[0]) bits[0] = proxify(bits[0], base);
      return bits.join(' ');
    })
    .join(', ');
}

const URL_ATTRS = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  script: ['src'],
  img: ['src', 'data-src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  iframe: ['src'],
  embed: ['src'],
  input: ['src'],
  form: ['action'],
};

/**
 * Runs inside the proxied page (serialised with toString), so it must stay
 * self-contained. It catches the URLs that only exist at runtime: fetch, XHR,
 * window.open, links created by scripts and GET forms.
 */
function client(BASE, PAGE) {
  var P = '/api/proxy?url=';
  var SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;

  function px(u) {
    try {
      var s = String(u).trim();
      if (!s || SKIP.test(s)) return u;
      if (s.indexOf(P) === 0 || s.indexOf(location.origin + P) === 0) return u;
      var a = new URL(s, BASE);
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return u;
      return P + encodeURIComponent(a.href);
    } catch (e) {
      return u;
    }
  }

  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) input = px(input);
        else if (input && input.url) input = new Request(px(input.url), input);
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }

  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = px(url);
    return _open.apply(this, arguments);
  };

  var _wopen = window.open;
  window.open = function (url, target, features) {
    return _wopen.call(window, url ? px(url) : url, '_self', features);
  };

  document.addEventListener(
    'click',
    function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var h = a.getAttribute('href');
      var n = px(h);
      if (n !== h) a.setAttribute('href', n);
    },
    true
  );

  document.addEventListener(
    'submit',
    function (e) {
      var f = e.target;
      if (!f || (f.getAttribute('method') || 'get').toLowerCase() !== 'get') return;
      e.preventDefault();
      var u = new URL(f.getAttribute('data-willow-action') || BASE);
      var qs = new URLSearchParams();
      new FormData(f).forEach(function (v, k) {
        if (typeof v === 'string') qs.append(k, v);
      });
      u.search = qs.toString();
      location.href = px(u.href);
    },
    true
  );

  function announce() {
    try {
      parent.postMessage({ type: 'willow:nav', url: PAGE, title: document.title }, location.origin);
    } catch (e) {}
  }
  if (parent !== window) {
    addEventListener('DOMContentLoaded', announce);
    addEventListener('load', announce);
  }
}

function clientScript(base, page) {
  const args = [base, page].map((v) => JSON.stringify(v).replace(/</g, '\\u003c')).join(',');
  return `(${client.toString()})(${args});`;
}

export function rewriteHtml(html, pageUrl) {
  const $ = load(html);

  let base = pageUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {}
  }
  $('base').remove();

  $('meta[http-equiv]').each((_, el) => {
    const kind = ($(el).attr('http-equiv') || '').toLowerCase();
    if (kind === 'content-security-policy') {
      $(el).remove();
    } else if (kind === 'refresh') {
      const content = $(el).attr('content') || '';
      $(el).attr(
        'content',
        content.replace(/(url\s*=\s*)(.+)$/i, (_, p, u) => p + proxify(u.replace(/^['"]|['"]$/g, ''), base))
      );
    }
  });

  $('link[rel~="preconnect"], link[rel~="dns-prefetch"]').remove();

  for (const [selector, attrs] of Object.entries(URL_ATTRS)) {
    $(selector).each((_, el) => {
      for (const attr of attrs) {
        const value = $(el).attr(attr);
        if (value != null) $(el).attr(attr, proxify(value, base));
      }
    });
  }

  $('img[srcset], source[srcset]').each((_, el) => {
    $(el).attr('srcset', rewriteSrcset($(el).attr('srcset'), base));
  });

  $('[style]').each((_, el) => {
    $(el).attr('style', rewriteCss($(el).attr('style'), base));
  });
  $('style').each((_, el) => {
    $(el).text(rewriteCss($(el).text(), base));
  });

  $('form').each((_, el) => {
    let abs = base;
    try {
      abs = new URL($(el).attr('action') || '', base).href;
    } catch {}
    $(el).attr('data-willow-action', abs);
    $(el).attr('action', proxify(abs, base));
  });

  $('a[target], form[target]').each((_, el) => {
    const t = ($(el).attr('target') || '').toLowerCase();
    if (['_blank', '_top', '_parent'].includes(t)) $(el).removeAttr('target');
  });

  $('[integrity]').removeAttr('integrity');
  $('[nonce]').removeAttr('nonce');
  $('link, script').removeAttr('crossorigin');

  $('head').prepend(`<script>${clientScript(base, pageUrl)}</script>`);
  return $.html();
}
