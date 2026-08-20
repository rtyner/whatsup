export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Error carrying the HTTP status so callers can treat 429/404 differently. */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Escalating waits for rate limits — Eventbrite starts 429ing after a few
// dozen page loads, and only a long pause clears it.
const RATE_LIMIT_BACKOFF = [6000, 20000, 45000, 90000];

/** Fetch with retries, browser-ish headers, backoff and a hard timeout. */
export async function get(url, { headers = {}, tries = 3, timeout = 45000, json = false } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          'accept-language': 'en-US,en;q=0.9,de;q=0.8',
          accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
          ...headers,
        },
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
          const wait = Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1000, 120000)
            : RATE_LIMIT_BACKOFF[Math.min(i, RATE_LIMIT_BACKOFF.length - 1)];
          clearTimeout(t);
          await sleep(wait);
          continue;
        }
        throw new HttpError(res.status, url);
      }
      return json ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/**
 * Pull a JS object literal out of an HTML page by brace matching.
 * More robust than a lazy regex when the payload contains `};\n`.
 */
export function extractObjectAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = html.indexOf('{', at + marker.length);
  if (start === -1) return null;
  let depth = 0, inStr = false, quote = '', esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** All parsed <script type="application/ld+json"> payloads, flattened. */
export function jsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const d = JSON.parse(m[1].trim());
      out.push(...(Array.isArray(d) ? d : [d]));
    } catch { /* ignore malformed blocks */ }
  }
  return out;
}

export function stripHtml(s, max = 400) {
  if (!s) return '';
  const text = String(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** Text out of a value that may be a string or Eventbrite's {text} shape. */
export function textOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.text || v.html || '';
  return String(v);
}

export const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
