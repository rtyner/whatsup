#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGIONS, RADIUS_KM, PREFILTER_KM, MAX_DRIVE_MINUTES, WINDOW_DAYS } from './config.mjs';
import { Geocoder, haversineKm } from './lib/geo.mjs';
import { DriveTimes, routerAvailable, VALHALLA_BASE_URL } from './lib/drivetime.mjs';
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

/** The feed from the last successful run, used to ride out a blocked source. */
function loadPrevious() {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(DATA, 'events.json'), 'utf8'));
    return new Map((prev.regions || []).map((r) => [r.key, r.events || []]));
  } catch {
    return new Map();
  }
}

/**
 * Collapse the same event arriving from two sources. Keyed on the local
 * calendar day rather than the raw start string, since Meetup reports UTC
 * instants and the others report local wall-clock time.
 */
function dedupeKey(e) {
  const title = e.title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return `${title}|${e.day}`;
}

async function runSource(report, name, label, fn) {
  const t0 = Date.now();
  try {
    const { events, notes = [], skipped } = await fn();
    report.push({
      name, label, ok: true, skipped: !!skipped, count: events.length,
      seconds: +((Date.now() - t0) / 1000).toFixed(1), notes,
    });
    log(`  ${name}: ${events.length} events${notes.length ? ` (${notes.length} notes)` : ''}`);
    return events;
  } catch (err) {
    report.push({ name, label, ok: false, count: 0, error: err.message, notes: [] });
    log(`  ${name}: FAILED — ${err.message}`);
    return [];
  }
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const geocoder = new Geocoder(path.join(DATA, 'geocache.json'), { maxLookups: Number(process.env.MAX_GEOCODE_LOOKUPS || 400) });
  const drive = new DriveTimes(path.join(DATA, 'drivecache.json'));
  const routing = await routerAvailable();
  log(routing
    ? `Routing via Valhalla at ${VALHALLA_BASE_URL} — filtering on real drive time.`
    : `No router at ${VALHALLA_BASE_URL}; falling back to a ${RADIUS_KM} km straight-line radius.`);
  const tmKey = process.env.TICKETMASTER_API_KEY || '';
  const prev = loadPrevious();
  const regionsOut = [];
  const sourceReport = [];

  for (const region of REGIONS) {
    log(`\n${region.name}`);
    const report = [];
    const collected = [
      ...(await runSource(report, `Eventbrite (${region.key})`, 'Eventbrite', () =>
        fetchEventbrite(region.eventbrite))),
      ...(await runSource(report, `Meetup (${region.key})`, 'Meetup', () =>
        fetchMeetup({ seeds: region.meetup }))),
      ...(region.bodensee.length
        ? await runSource(report, `Bodensee tourism (${region.key})`, 'Bodensee Tourismus', () =>
            fetchBodensee({ portals: region.bodensee }))
        : []),
      ...(await runSource(report, `Ticketmaster (${region.key})`, 'Ticketmaster', () =>
        fetchTicketmaster({
          apiKey: tmKey, spots: region.ticketmaster,
          radiusMiles: 50, days: WINDOW_DAYS,
        }))),
    ];

    // A source that is blocked today (Eventbrite answers datacenter IPs with a
    // 405) must not silently shrink the calendar. Reuse its last known events
    // instead; they still get re-filtered for distance and date below, so
    // nothing expired slips through — they just stop refreshing.
    const previous = prev.get(region.key) || [];
    for (const rep of report) {
      if (rep.count > 0 || rep.skipped) continue;
      const carried = previous.filter((e) => e.source === rep.label);
      if (!carried.length) continue;
      collected.push(...carried);
      rep.carriedOver = carried.length;
      rep.stale = true;
      log(`  ${rep.name}: carried over ${carried.length} events from the last run`);
    }
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

    // Straight-line gate first: it is free, and it keeps the router batch to
    // venues that could plausibly qualify.
    const nearby = [];
    let noCoords = 0, tooFar = 0, outOfWindow = 0;
    for (const e of collected) {
      if (e.lat == null || e.lon == null) { noCoords++; continue; }
      e.distanceKm = +haversineKm(region.center, { lat: e.lat, lon: e.lon }).toFixed(1);
      if (e.distanceKm > PREFILTER_KM) { tooFar++; continue; }
      nearby.push(e);
    }

    const minutes = routing
      ? await drive.minutesFrom(region.center, nearby.map((e) => ({ lat: e.lat, lon: e.lon })))
      : new Map();
    if (routing) {
      log(`  routed ${drive.routed} venues (${nearby.length} candidates)` +
        (drive.failed ? ' — router failed partway, rest fall back to radius' : ''));
    }

    const kept = new Map();
    let tooSlow = 0;

    for (const e of nearby) {
      const driveMinutes = minutes.get(DriveTimes.keyFor({ lat: e.lat, lon: e.lon }));
      // No routed answer — an out-of-extract venue, or no router at all. Fall
      // back to the radius rule and say so rather than silently dropping it.
      const approxDrive = driveMinutes == null;
      if (approxDrive) {
        if (e.distanceKm > RADIUS_KM) { tooFar++; continue; }
      } else if (driveMinutes > MAX_DRIVE_MINUTES) {
        tooSlow++;
        continue;
      }

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
        driveMinutes: approxDrive ? null : Math.round(driveMinutes),
        approxDrive,
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

    // Sort by local day first, then by instant. Sorting on the instant alone
    // interleaves days whenever two events resolve their local date in
    // different zones, which splits a day into two headings in the UI.
    const events = [...kept.values()].sort(
      (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
        a.sortMs - b.sortMs ||
        (a.driveMinutes ?? 999) - (b.driveMinutes ?? 999) ||
        a.distanceKm - b.distanceKm);
    for (const e of events) delete e.sortMs;

    log(`  → ${events.length} in range (dropped: ${tooSlow} over ${MAX_DRIVE_MINUTES} min, ` +
      `${tooFar} too far, ${outOfWindow} out of window, ${noCoords} unlocatable)`);
    regionsOut.push({
      key: region.key, name: region.name, blurb: region.blurb,
      timezone: region.timezone, center: region.center,
      maxDriveMinutes: MAX_DRIVE_MINUTES, radiusKm: RADIUS_KM, routed: routing,
      counts: { kept: events.length, tooSlow, tooFar, outOfWindow, noCoords, raw: collected.length },
      events,
    });
  }

  geocoder.save();
  drive.save();
  const payload = {
    generatedAt: new Date(NOW).toISOString(),
    windowDays: WINDOW_DAYS,
    maxDriveMinutes: MAX_DRIVE_MINUTES,
    radiusKm: RADIUS_KM,
    routed: routing,
    regions: regionsOut,
    sources: sourceReport,
  };
  fs.writeFileSync(path.join(DATA, 'events.json'), JSON.stringify(payload, null, 1) + '\n');

  const total = regionsOut.reduce((n, r) => n + r.events.length, 0);
  const stale = sourceReport.filter((s) => s.stale);
  if (stale.length) log(`\nStale sources: ${stale.map((s) => s.name).join(', ')}`);
  log(`\nWrote data/events.json — ${total} events across ${regionsOut.length} regions.`);

  // Publish nothing rather than a calendar that is obviously broken.
  const empty = regionsOut.filter((r) => r.events.length === 0);
  if (empty.length) {
    console.error(`No events at all for: ${empty.map((r) => r.key).join(', ')}. Refusing to publish.`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
