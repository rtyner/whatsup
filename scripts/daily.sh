#!/usr/bin/env bash
# Refresh the calendar and publish it.
#
# This runs on a local machine rather than in CI on purpose: Eventbrite answers
# GitHub's datacenter IPs with HTTP 405, so a CI run can only ever carry over
# stale Eventbrite listings. From a residential IP the scrape works normally.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "starting refresh in $REPO"

# Don't build on top of someone else's push, and never clobber local edits.
if ! git diff --quiet -- data/; then
  log "WARNING: uncommitted changes under data/ — stashing them"
  git stash push -q -- data/
fi
git pull --rebase --quiet origin main

if ! node scripts/fetch.mjs; then
  log "fetch failed; leaving the published calendar untouched"
  exit 1
fi

git add data/events.json data/geocache.json
if git diff --cached --quiet; then
  log "no change in event data"
  exit 0
fi

git -c user.name="whatsup-bot" -c user.email="rusty@rtyner.com" \
  commit -q -m "data: refresh events for $(date -u +%Y-%m-%d)"
git push --quiet origin main
log "pushed; GitHub Pages will redeploy"
