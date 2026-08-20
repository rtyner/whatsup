import fs from 'node:fs';
import { get, sleep } from './util.mjs';

const R = 6371.0088; // mean Earth radius, km
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Nominatim rejects placeholder contacts (example.com gets a 403), so the
// user agent carries the project URL as required by their usage policy.
const CONTACT = process.env.GEOCODER_CONTACT || 'https://github.com/rtyner/whatsup';
const GEO_UA = `whatsup-events/1.0 (+${CONTACT})`;

/**
 * City/address geocoder for sources that only give us a place name.
 * Every result — including misses — is cached to disk, so a steady-state
 * daily run makes almost no network calls.
 */
export class Geocoder {
  constructor(cachePath, { maxLookups = 250 } = {}) {
    this.cachePath = cachePath;
    this.maxLookups = maxLookups;
    this.lookups = 0;
    this.hits = 0;
    this.dirty = false;
    this.exhausted = false;
    try {
      this.cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  static key(parts) {
    return (Array.isArray(parts) ? parts : [parts])
      .filter(Boolean).join(', ').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  async #nominatim(q) {
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q);
    const res = await get(url, { json: true, tries: 2, headers: { 'user-agent': GEO_UA } });
    const r = Array.isArray(res) ? res[0] : null;
    return r ? { lat: parseFloat(r.lat), lon: parseFloat(r.lon) } : null;
  }

  async #photon(q) {
    const url = 'https://photon.komoot.io/api/?limit=1&q=' + encodeURIComponent(q);
    const res = await get(url, { json: true, tries: 2, headers: { 'user-agent': GEO_UA } });
    const c = res?.features?.[0]?.geometry?.coordinates;
    return Array.isArray(c) ? { lat: c[1], lon: c[0] } : null;
  }

  async lookup(parts) {
    const key = Geocoder.key(parts);
    if (!key) return null;
    if (key in this.cache) return this.cache[key]; // may be null: a known miss
    if (this.lookups >= this.maxLookups) { this.exhausted = true; return null; }

    this.lookups++;
    let hit = null;
    try {
      await sleep(1100); // Nominatim asks for <= 1 req/s
      hit = await this.#nominatim(key);
      if (!hit) hit = await this.#photon(key); // second opinion on street addresses
    } catch {
      try {
        hit = await this.#photon(key);
      } catch {
        return null; // transient failure — don't cache it as a miss
      }
    }
    if (hit && (!Number.isFinite(hit.lat) || !Number.isFinite(hit.lon))) hit = null;
    if (hit) this.hits++;
    this.cache[key] = hit;
    this.dirty = true;
    return hit;
  }

  save() {
    if (!this.dirty) return;
    const sorted = Object.fromEntries(
      Object.entries(this.cache).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    fs.writeFileSync(this.cachePath, JSON.stringify(sorted, null, 1) + '\n');
  }
}
