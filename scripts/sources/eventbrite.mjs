import { get, extractObjectAfter, stripHtml, textOf, num, sleep, HttpError } from '../lib/util.mjs';

/**
 * Eventbrite has no open search API any more, but its city browse pages ship
 * the full result set in `window.__SERVER_DATA__` — 20 events per page,
 * each with venue coordinates.
 */
function parsePage(html) {
  const data = extractObjectAfter(html, 'window.__SERVER_DATA__');
  const bucket = data?.search_data?.events;
  return {
    results: bucket?.results ?? [],
    pageCount: bucket?.pagination?.page_count ?? 0,
  };
}

function normalize(e, origin) {
  const id = e.eventbrite_event_id || e.id;
  if (!id || !e.start_date) return null;
  const venue = e.primary_venue || {};
  const addr = venue.address || {};
  const tz = e.timezone || 'UTC';
  return {
    id: `eventbrite:${id}`,
    source: 'Eventbrite',
    title: stripHtml(textOf(e.name), 200),
    description: stripHtml(textOf(e.summary || e.description), 300),
    start: e.start_time ? `${e.start_date}T${e.start_time}` : e.start_date,
    end: e.end_date ? (e.end_time ? `${e.end_date}T${e.end_time}` : e.end_date) : null,
    timezone: tz,
    url: e.url || `https://www.eventbrite.com/e/${id}`,
    venue: venue.name || '',
    address: addr.localized_address_display || '',
    city: addr.city || '',
    country: addr.country || '',
    lat: num(addr.latitude),
    lon: num(addr.longitude),
    image: e.image?.url || e.image?.original?.url || null,
    price: e.ticket_availability?.minimum_ticket_price?.display ||
      (e.ticket_availability?.is_free ? 'Free' : ''),
    category:
      (e.tags || []).find((t) => t.prefix === 'EventbriteCategory')?.display_name || '',
    origin,
  };
}

/**
 * @param {{host:string, slugs:string[], pagesPerSlug:number, pauseMs?:number}} cfg
 */
export async function fetchEventbrite({ host, slugs, pagesPerSlug = 5, pauseMs = 1400 }) {
  const events = new Map();
  const notes = [];
  for (const slug of slugs) {
    let pages = pagesPerSlug;
    for (let page = 1; page <= pages; page++) {
      const url = `https://${host}/d/${slug}/all-events/?page=${page}`;
      let parsed;
      try {
        parsed = parsePage(await get(url, { tries: 4 }));
      } catch (err) {
        notes.push(`${slug} p${page}: ${err.message}`);
        // A 404 means the city slug is wrong; anything else may be transient,
        // so move on to the next slug rather than abandoning the whole source.
        if (err instanceof HttpError && err.status === 429) await sleep(30000);
        break;
      }
      if (page === 1) pages = Math.min(pagesPerSlug, parsed.pageCount || pagesPerSlug);
      if (!parsed.results.length) break;
      for (const raw of parsed.results) {
        const ev = normalize(raw, `eventbrite/${slug}`);
        if (ev) events.set(ev.id, ev);
      }
      await sleep(pauseMs); // be a polite scraper
    }
  }
  return { events: [...events.values()], notes };
}
