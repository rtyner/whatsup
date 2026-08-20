import { get, stripHtml, num, sleep } from '../lib/util.mjs';

/**
 * Optional: set TICKETMASTER_API_KEY (free at developer.ticketmaster.com) to
 * add arena/theatre listings. Without a key this source is skipped cleanly.
 */
function normalize(e, origin) {
  const v = e._embedded?.venues?.[0] || {};
  const start = e.dates?.start;
  if (!start?.localDate) return null;
  const loc = v.location || {};
  return {
    id: `ticketmaster:${e.id}`,
    source: 'Ticketmaster',
    title: stripHtml(e.name, 200),
    description: stripHtml(e.info || e.pleaseNote, 300),
    start: start.localTime ? `${start.localDate}T${start.localTime}` : start.localDate,
    end: e.dates?.end?.localDate || null,
    timezone: e.dates?.timezone || v.timezone || 'UTC',
    url: e.url,
    venue: v.name || '',
    address: [v.address?.line1, v.city?.name, v.state?.stateCode, v.postalCode]
      .filter(Boolean).join(', '),
    city: v.city?.name || '',
    country: v.country?.countryCode || '',
    lat: num(loc.latitude),
    lon: num(loc.longitude),
    image: (e.images || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null,
    price: e.priceRanges?.[0]
      ? `${e.priceRanges[0].min}–${e.priceRanges[0].max} ${e.priceRanges[0].currency}`
      : '',
    category: e.classifications?.[0]?.segment?.name || '',
    origin,
  };
}

/** @param {{apiKey:string, spots:{lat:number,lon:number,label:string,countryCode?:string}[], radiusMiles:number, days:number}} cfg */
export async function fetchTicketmaster({ apiKey, spots, radiusMiles = 50, days = 30 }) {
  if (!apiKey) return { events: [], notes: ['skipped: no TICKETMASTER_API_KEY'], skipped: true };
  const events = new Map();
  const notes = [];
  const now = new Date();
  const end = new Date(now.getTime() + days * 864e5);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  for (const spot of spots) {
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({
        apikey: apiKey,
        latlong: `${spot.lat},${spot.lon}`,
        radius: String(radiusMiles),
        unit: 'miles',
        startDateTime: iso(now),
        endDateTime: iso(end),
        size: '200',
        page: String(page),
        sort: 'date,asc',
      });
      let body;
      try {
        body = await get(`https://app.ticketmaster.com/discovery/v2/events.json?${qs}`, { json: true });
      } catch (err) {
        notes.push(`${spot.label} p${page}: ${err.message}`);
        break;
      }
      const list = body?._embedded?.events || [];
      for (const raw of list) {
        const ev = normalize(raw, `ticketmaster/${spot.label}`);
        if (ev) events.set(ev.id, ev);
      }
      const totalPages = body?.page?.totalPages ?? 1;
      // Discovery caps deep paging at 1000 results.
      if (list.length === 0 || page + 1 >= Math.min(totalPages, 5)) break;
      await sleep(300);
    }
  }
  return { events: [...events.values()], notes };
}
