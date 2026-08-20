import fs from 'node:fs';
import { get, HttpError } from './util.mjs';

/**
 * Real drive times from a Valhalla instance — the same router trip-snap uses,
 * against the same two origins. Falls back to the straight-line radius when no
 * router answers, so a CI run or a downed service degrades rather than
 * publishing a wrong or empty calendar.
 */
export const VALHALLA_BASE_URL = process.env.VALHALLA_BASE_URL || 'http://localhost:8002';

// Valhalla rejects a whole batch if one target is unroutable, so keep batches
// small enough that bisecting one is cheap.
const CHUNK_SIZE = 45;

/**
 * How far Valhalla may look for a drivable road when snapping a location.
 * At radius 0 it snaps to the nearest edge of any kind, and a venue in a
 * European old town lands in a pedestrian zone that costing=auto cannot use —
 * so a hall ten minutes up the road comes back unroutable. 500 m is
 * trip-snap's measured value: it fixes the pedestrian-zone case without
 * papering over points genuinely outside the tile extract.
 */
const SNAP_RADIUS_M = 500;

const round5 = (n) => Math.round(n * 1e5) / 1e5;
const key = (p) => `${round5(p.lat)},${round5(p.lon)}`;

export async function routerAvailable() {
  try {
    const s = await get(`${VALHALLA_BASE_URL}/status`, { json: true, tries: 1, timeout: 8000 });
    return Boolean(s && s.version);
  } catch {
    return false;
  }
}

async function matrixRaw(origin, targets) {
  const res = await get(`${VALHALLA_BASE_URL}/sources_to_targets`, {
    json: true,
    tries: 2,
    timeout: 60000,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sources: [{ lat: origin.lat, lon: origin.lon, radius: SNAP_RADIUS_M }],
      targets: targets.map((t) => ({ lat: t.lat, lon: t.lon, radius: SNAP_RADIUS_M })),
      costing: 'auto',
      units: 'kilometers',
    }),
  });
  const row = res?.sources_to_targets?.[0];
  if (!Array.isArray(row) || row.length < targets.length) {
    throw new Error(`unexpected matrix shape: ${row?.length ?? 'none'} of ${targets.length}`);
  }
  return row;
}

/**
 * One matrix request, isolating unroutable targets by bisection.
 *
 * Valhalla answers 400 for the WHOLE batch when any single target has no road
 * near it, rather than nulling that one entry — so a single bad venue would
 * cost 44 good answers. A 400 is about the request, so splitting it is
 * meaningful; anything else is about the service and is rethrown, since
 * bisecting a dead router turns one failure into 2n and learns nothing.
 */
async function matrixChunk(origin, chunk) {
  try {
    const row = await matrixRaw(origin, chunk);
    return chunk.map((_, i) => {
      const e = row[i];
      return e && typeof e.time === 'number' ? e.time / 60 : null;
    });
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 400) throw err;
    if (chunk.length === 1) return [null]; // genuinely no road near this point
    const mid = Math.floor(chunk.length / 2);
    const [a, b] = await Promise.all([
      matrixChunk(origin, chunk.slice(0, mid)),
      matrixChunk(origin, chunk.slice(mid)),
    ]);
    return [...a, ...b];
  }
}

/** Disk-cached drive minutes from one origin to many points. */
export class DriveTimes {
  constructor(cachePath) {
    this.cachePath = cachePath;
    this.dirty = false;
    this.requested = 0;
    this.routed = 0;
    this.failed = false;
    try {
      this.cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  /**
   * @returns {Map<string, number|null>} coordinate key → drive minutes.
   *   `null` means the router had no answer; the caller decides what to do.
   */
  async minutesFrom(origin, points) {
    const bucket = (this.cache[key(origin)] ||= {});
    const out = new Map();
    const missing = [];
    const seen = new Set();

    for (const p of points) {
      const k = key(p);
      if (k in bucket) out.set(k, bucket[k]);
      else if (!seen.has(k)) { seen.add(k); missing.push(p); }
    }
    if (!missing.length) return out;

    this.requested += missing.length;
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      const chunk = missing.slice(i, i + CHUNK_SIZE);
      let minutes;
      try {
        minutes = await matrixChunk(origin, chunk);
      } catch {
        // Service-level failure: stop asking and let the rest fall back. Never
        // cached — an hour of downtime must not cost a week of degraded answers.
        this.failed = true;
        for (const p of missing.slice(i)) out.set(key(p), null);
        break;
      }
      chunk.forEach((p, j) => {
        const k = key(p);
        bucket[k] = minutes[j] == null ? null : Math.round(minutes[j] * 10) / 10;
        out.set(k, bucket[k]);
        if (bucket[k] != null) this.routed++;
      });
      this.dirty = true;
    }
    return out;
  }

  static keyFor(p) { return key(p); }

  save() {
    if (!this.dirty) return;
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 1) + '\n');
  }
}
