# What's Up

A daily-refreshed calendar of events happening within about an hour's drive of
**Lakeland, Florida** and **Überlingen** on Lake Constance — two sections, one page.

Live site: enable GitHub Pages for this repo (Settings → Pages → *GitHub Actions*).

## How it works

A systemd timer on a local machine runs `scripts/daily.sh` every morning at
06:15 local time. That script runs `scripts/fetch.mjs`, which pulls from several
public sources, keeps everything within 80.5 km (~50 miles) of each town centre
and starting in the next 30 days, writes `data/events.json`, and pushes it. The
push triggers the Pages workflow, which redeploys the site. The static page in
`index.html` renders that file — no server, no build step, no dependencies.

### Why the refresh runs locally, not in CI

Eventbrite answers requests from GitHub's datacenter IPs with `HTTP 405`. From a
residential IP the same request works fine. A CI run therefore loses the largest
source for both regions, so the daily job runs on a real machine instead.
`.github/workflows/update.yml` keeps a manual-dispatch fallback for when the
local machine is down; it will carry over the last known Eventbrite listings
rather than dropping them.

```
scripts/
  config.mjs            regions, anchors, per-source seeds
  daily.sh              pull, fetch, commit, push — what the timer runs
  fetch.mjs             orchestrator: fetch → geocode → filter → dedupe → write
  lib/util.mjs          fetch with backoff, HTML/JSON-LD extraction
  lib/geo.mjs           haversine + cached Nominatim/Photon geocoding
  lib/time.mjs          local-wall-clock → UTC via Intl
  sources/*.mjs         one adapter per source
data/events.json        the published feed (committed by CI)
data/geocache.json      place → coordinates cache (committed by CI)
```

### Sources

| Source | Coverage | Notes |
| --- | --- | --- |
| Eventbrite | both regions | City browse pages; events carry venue coordinates. |
| Meetup | both regions | JSON-LD on the find page; city-level location, geocoded. |
| Bodensee tourism | Überlingen | `ueberlingen-bodensee.de` — ~1000 listings from the official portal. |
| Ticketmaster | both regions | Optional. Skipped unless `TICKETMASTER_API_KEY` is set. |

Eventbrite and Meetup have no open search API for this any more, so those two
adapters read the structured data those pages already ship to browsers, at a
deliberately slow request rate.

### Adding Ticketmaster

Get a free key at [developer.ticketmaster.com](https://developer.ticketmaster.com/),
then add it as a repository secret named `TICKETMASTER_API_KEY`. Without it the
run still succeeds and the site notes the source as *not configured*.

## Running locally

Node 22+, no dependencies:

```bash
node scripts/fetch.mjs        # ~5 min warm, longer on a cold geocode cache
python3 -m http.server 8000   # then open http://localhost:8000
```

### The daily timer

```bash
systemctl --user list-timers whatsup.timer   # when it next runs
systemctl --user start whatsup.service       # refresh and publish right now
journalctl --user -u whatsup.service -n 50   # what the last run did
```

Units live in `~/.config/systemd/user/`. `loginctl enable-linger` is required so
the timer keeps running when you are not logged in — it is already enabled on
this machine.

Useful environment variables:

- `TICKETMASTER_API_KEY` — enables the Ticketmaster source.
- `GEOCODER_CONTACT` — contact URL sent to Nominatim, whose policy rejects
  placeholder user agents.
- `MAX_GEOCODE_LOOKUPS` — per-run cap on new geocoding calls (default 400).

## Changing the regions

Edit `scripts/config.mjs`. Each region has a centre, a timezone and a list of
seeds per source; `RADIUS_KM` and `WINDOW_DAYS` at the top of that file control
the drive-time stand-in and how far ahead the calendar looks.

## Caveats

- "One hour's drive" is approximated as a 50 mile straight-line radius. That is
  a decent proxy around Lakeland, but it flatters the Bodensee: Zürich is 64 km
  across the map and comfortably over an hour by road, because the lake forces
  the drive the long way round. Real drive-time isochrones would need a routing
  API key (OpenRouteService and Mapbox both have free tiers).
- Events located only by city or street address are marked with a `~` on the
  distance; their coordinates come from geocoding, not the source.
- Scraped sources can change their markup or start blocking. A source that
  returns nothing has its previous events carried over rather than shrinking the
  calendar; those are still re-filtered for distance and date, so nothing expired
  survives, they just stop refreshing. The footer names any source in that state,
  and the fetch script exits non-zero rather than publishing an empty region.
