#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGIONS, RADIUS_KM, WINDOW_DAYS } from './config.mjs';
import { Geocoder, haversineKm } from './lib/geo.mjs';
import { toUtcMs, isAllDay, localDay } from './lib/time.mjs';
import { fetchEventbrite } from './sources/eventbrite.mjs';
import { fetchMeetup } from './sources/meetup.mjs';
import { fetchBodensee } from './sources/ueberlingen.mjs';
import { fetchTicketmaster } from './sources/ticketmaster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const NOW = Date.now();
const WINDOW_END = NOW + WINDOW_DAYS * 864e5;
const GRACE = 6 * 36e5; // keep things that started earlier today

const log = (...a) => console.log(...a);

/**
 * Collapse the same event arriving from two sources. Keyed on the local
 * calendar day rather than the raw start string, since Meetup reports UTC
 * instants and the others report local wall-clock time.
 */
function dedupeKey(e) {
  const title = e.title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return `${title}|${e.day}`;
}

async function runSource(report, name, fn) {
  const t0 = Date.now();
  try {
    const { events, notes = [], skipped } = await fn();
    report.push({
      name, ok: true, skipped: !!skipped, count: events.length,
      seconds: +((Date.now() - t0) / 1000).toFixed(1), notes,
    });
    log(`  ${name}: ${events.length} events${notes.length ? ` (${notes.length} notes)` : ''}`);
    return events;
  } catch (err) {
    report.push({ name, ok: false, count: 0, error: err.message, notes: [] });
    log(`  ${name}: FAILED — ${err.message}`);
    return [];
  }
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const geocoder = new Geocoder(path.join(DATA, 'geocache.json'), { maxLookups: Number(process.env.MAX_GEOCODE_LOOKUPS || 400) });
  const tmKey = process.env.TICKETMASTER_API_KEY || '';
  const regionsOut = [];
  const sourceReport = [];

  for (const region of REGIONS) {
    log(`\n${region.name}`);
    const report = [];
    const collected = [
      ...(await runSource(report, `Eventbrite (${region.key})`, () =>
        fetchEventbrite(region.eventbrite))),
      ...(await runSource(report, `Meetup (${region.key})`, () =>
        fetchMeetup({ seeds: region.meetup }))),
      ...(region.bodensee.length
        ? await runSource(report, `Bodensee tourism (${region.key})`, () =>
            fetchBodensee({ portals: region.bodensee }))
        : []),
      ...(await runSource(report, `Ticketmaster (${region.key})`, () =>
        fetchTicketmaster({
          apiKey: tmKey, spots: region.ticketmaster,
          radiusMiles: 50, days: WINDOW_DAYS,
        }))),
    ];
    sourceReport.push(...report.map((r) => ({ ...r, region: region.key })));

    // Fill in coordinates for sources that only give us a place name.
    // The disk cache means this is only slow the first time a venue appears.
    const needsGeocode = collected.filter((e) => e.lat == null || e.lon == null);
    let geocoded = 0;
    for (const e of needsGeocode) {
      const hint = e.geocodeHint || [e.venue, e.city, e.country].filter(Boolean).join(', ');
      const hit = await geocoder.lookup([hint]);
      if (hit) {
        e.lat = hit.lat;
        e.lon = hit.lon;
        e.approxLocation = true;
        geocoded++;
      }
    }
    if (needsGeocode.length) {
      log(`  geocoded ${geocoded}/${needsGeocode.length} events by place name` +
        (geocoder.exhausted ? ' (lookup budget exhausted — rerun to finish)' : ''));
    }

    const kept = new Map();
    let noCoords = 0, tooFar = 0, outOfWindow = 0;

    for (const e of collected) {
      if (e.lat == null || e.lon == null) { noCoords++; continue; }
      const distanceKm = haversineKm(region.center, { lat: e.lat, lon: e.lon });
      if (distanceKm > RADIUS_KM) { tooFar++; continue; }

      const tz = e.timezone || region.timezone;
      const startMs = toUtcMs(e.start, tz);
      if (startMs == null) { outOfWindow++; continue; }
      const endMs = e.end ? toUtcMs(e.end, tz) : null;
      // Multi-day runs (exhibitions, fairs) stay listed while they're ongoing.
      const stillRunning = endMs != null && endMs >= NOW - GRACE;
      if (startMs > WINDOW_END) { outOfWindow++; continue; }
      if (startMs < NOW - GRACE && !stillRunning) { outOfWindow++; continue; }

      // A run that began before today is listed under today, not its opening
      // night, so `day`/`sortMs` are clamped and the card says "Ongoing".
      const ongoing = startMs < NOW - GRACE;
      const shownMs = ongoing ? NOW : startMs;
      const record = {
        ...e,
        distanceKm: +distanceKm.toFixed(1),
        startUtc: new Date(startMs).toISOString(),
        endUtc: endMs != null ? new Date(endMs).toISOString() : null,
        allDay: isAllDay(e.start),
        ongoing,
        day: localDay(shownMs, tz),
        sortMs: shownMs,
      };
      delete record.geocodeHint;

      const key = dedupeKey(record);
      const prior = kept.get(key);
      // Prefer the copy with exact coordinates, then the richer description.
      if (!prior ||
          (prior.approxLocation && !record.approxLocation) ||
          (!record.approxLocation && (record.description?.length || 0) > (prior.description?.length || 0))) {
        kept.set(key, record);
      }
    }

    const events = [...kept.values()].sort((a, b) => a.sortMs - b.sortMs || a.distanceKm - b.distanceKm);
    for (const e of events) delete e.sortMs;

    log(`  → ${events.length} in range (dropped: ${tooFar} far, ${outOfWindow} out of window, ${noCoords} unlocatable)`);
    regionsOut.push({
      key: region.key, name: region.name, blurb: region.blurb,
      timezone: region.timezone, center: region.center, radiusKm: RADIUS_KM,
      counts: { kept: events.length, tooFar, outOfWindow, noCoords, raw: collected.length },
      events,
    });
  }

  geocoder.save();
  const payload = {
    generatedAt: new Date(NOW).toISOString(),
    windowDays: WINDOW_DAYS,
    radiusKm: RADIUS_KM,
    regions: regionsOut,
    sources: sourceReport,
  };
  fs.writeFileSync(path.join(DATA, 'events.json'), JSON.stringify(payload, null, 1) + '\n');

  const total = regionsOut.reduce((n, r) => n + r.events.length, 0);
  log(`\nWrote data/events.json — ${total} events across ${regionsOut.length} regions.`);
  if (total === 0) {
    console.error('No events collected from any source; refusing to publish an empty calendar.');
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
