/**
 * Convert an event's local wall-clock time into a UTC instant.
 * Sources give us either an absolute instant (trailing Z / offset) or a naive
 * local string plus a tz name, so resolve the offset with Intl.
 */
const OFFSET_CACHE = new Map();

function tzOffsetMinutes(utcMs, timeZone) {
  const key = `${timeZone}|${Math.floor(utcMs / 36e5)}`;
  if (OFFSET_CACHE.has(key)) return OFFSET_CACHE.get(key);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const off = (asUtc - Math.floor(utcMs / 1000) * 1000) / 60000;
  OFFSET_CACHE.set(key, off);
  return off;
}

/** @returns {number|null} epoch ms */
export function toUtcMs(value, timeZone = 'UTC') {
  if (!value) return null;
  const s = String(value).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const [, y, mo, d, h = '00', mi = '00', sec = '00'] = m;
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  let guess = naive;
  // Two passes settle DST boundaries.
  for (let i = 0; i < 2; i++) guess = naive - tzOffsetMinutes(guess, timeZone) * 60000;
  return guess;
}

export const isAllDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

/** Local YYYY-MM-DD for grouping, in the event's own timezone. */
export function localDay(utcMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(utcMs));
}
