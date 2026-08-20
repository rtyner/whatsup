import { get, jsonLd, stripHtml, sleep } from '../lib/util.mjs';

/**
 * Meetup's find page server-renders JSON-LD for the first screen of results.
 * There are no coordinates, so events come back with a place string for the
 * caller to geocode.
 */
function normalize(e, origin) {
  if (!e?.url || !e?.startDate) return null;
  const loc = e.location || {};
  const addr = loc.address || {};
  const online =
    typeof e.eventAttendanceMode === 'string' && e.eventAttendanceMode.includes('Online');
  if (online) return null;
  const city = addr.addressLocality || '';
  const region = addr.addressRegion || '';
  const country = (addr.addressCountry || '').toUpperCase();
  return {
    id: `meetup:${e.url.match(/events\/(\d+)/)?.[1] || e.url}`,
    source: 'Meetup',
    title: stripHtml(e.name, 200),
    description: stripHtml(e.description, 300),
    start: e.startDate,
    end: e.endDate || null,
    // Meetup emits an absolute UTC instant, so the instant needs no timezone —
    // but the local day label does, and that is the region's, not UTC. Leaving
    // this null lets the caller apply the region timezone; claiming 'UTC' here
    // put late-evening events on the following day and split the day headings.
    timezone: null,
    url: e.url.split('?')[0],
    venue: loc.name || '',
    address: addr.streetAddress || '',
    city,
    country,
    lat: null,
    lon: null,
    geocodeHint: [addr.streetAddress || city, region, country].filter(Boolean).join(', '),
    image: e.image && e.image.startsWith('http') ? e.image : null,
    price: '',
    category: 'Community',
    organizer: e.organizer?.name || '',
    origin,
  };
}

/** @param {{seeds:{location:string,label:string}[]}} cfg */
export async function fetchMeetup({ seeds }) {
  const events = new Map();
  const notes = [];
  for (const seed of seeds) {
    const url =
      `https://www.meetup.com/find/?location=${encodeURIComponent(seed.location)}` +
      `&source=EVENTS&distance=fiftyMiles&eventType=inPerson`;
    try {
      const blocks = jsonLd(await get(url)).filter((d) => d['@type'] === 'Event');
      for (const raw of blocks) {
        const ev = normalize(raw, `meetup/${seed.label}`);
        if (ev) events.set(ev.id, ev);
      }
      if (!blocks.length) notes.push(`${seed.label}: no JSON-LD events`);
    } catch (err) {
      notes.push(`${seed.label}: ${err.message}`);
    }
    await sleep(900);
  }
  return { events: [...events.values()], notes };
}
