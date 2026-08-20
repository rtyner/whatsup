import { get, stripHtml, num, sleep } from '../lib/util.mjs';

/**
 * The official Bodensee tourism portals run on Next.js and embed their whole
 * event list (~1000 entries, with coordinates) in __NEXT_DATA__ under an
 * `eventFilter` slice. One parser covers every site on that platform.
 */
function nextData(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function eventSlice(data) {
  const slices = data?.props?.pageProps?.page?.content;
  if (!Array.isArray(slices)) return [];
  for (const s of slices) {
    if (s?.sliceType === 'eventFilter' && Array.isArray(s?.props?.events)) return s.props.events;
  }
  return [];
}

function normalize(e, origin, fallbackCity) {
  if (!e?.title || !e?.startAt) return null;
  const [lat, lon] = Array.isArray(e.latlng) ? e.latlng : [null, null];
  return {
    id: `bodensee:${e.id}`,
    source: 'Bodensee Tourismus',
    title: stripHtml(e.title, 200),
    description: stripHtml(e.body, 300),
    start: e.startAt,
    end: e.endAt || null,
    timezone: 'Europe/Berlin', // portal emits local wall-clock times
    url: e.url || origin,
    venue: e.location || '',
    address: e.addressLine || '',
    city: e.city || fallbackCity,
    country: 'DE',
    lat: num(lat),
    lon: num(lon),
    geocodeHint: [e.addressLine || e.location, e.city || fallbackCity, 'Germany']
      .filter(Boolean).join(', '),
    image: e.image?.small || e.additionalImages?.[0]?.url || null,
    price: stripHtml(e.priceInfo, 90),
    category: e.category || (e.categories || [])[0] || '',
    organizer: e.company || '',
    origin,
  };
}

/** @param {{portals:{url:string,city:string}[]}} cfg */
export async function fetchBodensee({ portals }) {
  const events = new Map();
  const notes = [];
  for (const portal of portals) {
    try {
      const data = nextData(await get(portal.url, { timeout: 60000 }));
      const raw = eventSlice(data);
      if (!raw.length) notes.push(`${portal.city}: no eventFilter slice`);
      for (const r of raw) {
        const ev = normalize(r, portal.url, portal.city);
        if (ev) events.set(ev.id, ev);
      }
    } catch (err) {
      notes.push(`${portal.city}: ${err.message}`);
    }
    await sleep(800);
  }
  return { events: [...events.values()], notes };
}
