/* What's Up — renders data/events.json into two region sections. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const state = { data: null, filters: { q: '', category: '', source: '', when: '30' } };

  // Headings come from the event's own `day` (YYYY-MM-DD in its local calendar),
  // not from startUtc — an ongoing run is filed under today, not its opening night.
  const fmtDay = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      .format(new Date(y, m - 1, d));
  };

  const fmtTime = (iso, tz) =>
    new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })
      .format(new Date(iso));

  const el = (tag, props = {}, children = []) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const c of [].concat(children)) if (c) n.append(c);
    return n;
  };

  /** Miles read better for Florida, kilometres for the Bodensee. */
  const distance = (km, regionKey) =>
    regionKey === 'lakeland' ? `${Math.round(km / 1.609)} mi` : `${Math.round(km)} km`;

  const driveLabel = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`);

  function matches(ev, f, cutoffMs) {
    if (Date.parse(ev.startUtc) > cutoffMs) return false;
    if (f.category && ev.category !== f.category) return false;
    if (f.source && ev.source !== f.source) return false;
    if (f.q) {
      const hay = `${ev.title} ${ev.venue} ${ev.city} ${ev.category} ${ev.description || ''}`.toLowerCase();
      if (!f.q.split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    return true;
  }

  function card(ev, region) {
    const tz = ev.timezone || region.timezone;
    const time = ev.ongoing ? 'Ongoing' : ev.allDay ? 'All day' : fmtTime(ev.startUtc, tz);
    const where = [ev.venue, ev.city].filter(Boolean).join(' · ') || ev.address || '—';

    const meta = el('p', { className: 'meta' }, [
      ev.category ? el('span', { className: 'tag', textContent: ev.category }) : null,
      el('span', { className: 'tag plain', textContent: ev.source }),
      el('span', {
        className: `dist${ev.approxLocation || ev.approxDrive ? ' approx' : ''}`,
        textContent: ev.driveMinutes != null
          ? `${driveLabel(ev.driveMinutes)} drive`
          : distance(ev.distanceKm, region.key),
        title: ev.driveMinutes != null
          ? `${driveLabel(ev.driveMinutes)} by road from ${region.name.split(',')[0]}` +
            (ev.approxLocation ? ', from an address-level location' : '')
          : `No routed answer for this venue — ${distance(ev.distanceKm, region.key)} straight line`,
      }),
    ]);

    return el('article', { className: 'card' }, [
      el('p', { className: 'time', textContent: time }),
      el('div', { className: 'body' }, [
        el('h4', {}, el('a', {
          href: ev.url, textContent: ev.title, rel: 'noopener noreferrer', target: '_blank',
        })),
        el('p', { className: 'where', textContent: where }),
        ev.description ? el('p', { className: 'blurb', textContent: ev.description }) : null,
      ]),
      meta,
    ]);
  }

  function renderRegion(region, cutoffMs) {
    const events = region.events.filter((ev) => matches(ev, state.filters, cutoffMs));
    const section = el('section', { className: 'region' });
    section.dataset.key = region.key;

    section.append(el('div', { className: 'region-head' }, [
      el('h2', { textContent: region.name }),
      el('span', {
        className: 'count',
        textContent: `${events.length} ${events.length === 1 ? 'event' : 'events'}`,
      }),
      el('p', { className: 'blurb', textContent: region.blurb }),
    ]));

    if (!events.length) {
      section.append(el('p', { className: 'empty', textContent: 'Nothing matches these filters here.' }));
      return section;
    }

    const todayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: region.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    let currentDay = null, group = null;
    for (const ev of events) {
      if (ev.day !== currentDay) {
        currentDay = ev.day;
        const heading = el('h3', {}, document.createTextNode(fmtDay(ev.day)));
        if (ev.day === todayKey) heading.append(el('span', { className: 'today', textContent: 'Today' }));
        group = el('div', { className: 'day' }, [heading, el('div', { className: 'cards' })]);
        section.append(group);
      }
      group.lastChild.append(card(ev, region));
    }
    return section;
  }

  function render() {
    const data = state.data;
    const cutoffMs = Date.now() + Number(state.filters.when) * 864e5;
    const main = $('#regions');
    main.replaceChildren(...data.regions.map((r) => renderRegion(r, cutoffMs)));
  }

  function populateFilters(data) {
    const all = data.regions.flatMap((r) => r.events);
    const fill = (sel, values) => {
      const node = $(sel);
      for (const v of [...new Set(values)].filter(Boolean).sort()) {
        node.append(el('option', { value: v, textContent: v }));
      }
    };
    fill('#category', all.map((e) => e.category));
    fill('#source', all.map((e) => e.source));
  }

  function renderHeader(data) {
    const total = data.regions.reduce((n, r) => n + r.events.length, 0);
    $('#total').textContent = total.toLocaleString();
    $('#window').textContent = `${data.windowDays} days`;
    const driveLabelEl = $('#drive-label');
    if (driveLabelEl) {
      driveLabelEl.textContent = data.routed
        ? `${data.maxDriveMinutes} min drive`
        : `${Math.round(data.radiusKm / 1.609)} mi radius`;
      driveLabelEl.title = data.routed
        ? 'Filtered on real drive times from a Valhalla routing engine'
        : 'No routing engine reachable at build time — filtered on straight-line distance';
    }
    const when = new Date(data.generatedAt);
    $('#updated').textContent = new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(when);
    $('#updated').title = when.toString();

    const sources = data.sources || [];
    const broken = sources.filter((s) => !s.ok);
    const stale = sources.filter((s) => s.stale);
    const skipped = sources.filter((s) => s.skipped);
    const bits = [];
    if (broken.length) {
      bits.push(el('span', {
        className: 'bad',
        textContent: `${broken.length} source${broken.length === 1 ? '' : 's'} failed in the last build: ${broken.map((s) => s.name).join(', ')}. `,
      }));
    }
    if (stale.length) {
      bits.push(el('span', {
        className: 'bad',
        textContent: `Showing carried-over listings for ${stale.map((s) => s.name).join(', ')} — that source did not respond to the last build. `,
      }));
    }
    if (skipped.length) bits.push(document.createTextNode(`Not configured: ${skipped.map((s) => s.name).join(', ')}.`));
    $('#source-health').replaceChildren(...bits);
  }

  function wireControls() {
    const debounce = (fn, ms) => {
      let t;
      return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    };
    const onInput = () => {
      state.filters.q = $('#q').value.trim().toLowerCase();
      state.filters.category = $('#category').value;
      state.filters.source = $('#source').value;
      state.filters.when = $('#when').value;
      render();
    };
    $('#q').addEventListener('input', debounce(onInput, 150));
    for (const id of ['#category', '#source', '#when']) $(id).addEventListener('change', onInput);
    $('#reset').addEventListener('click', () => {
      $('#controls').reset();
      onInput();
    });
  }

  fetch(`data/events.json?v=${Date.now()}`)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((data) => {
      state.data = data;
      renderHeader(data);
      populateFilters(data);
      wireControls();
      render();
    })
    .catch((err) => {
      $('#regions').replaceChildren(el('p', {
        className: 'empty',
        textContent: `Could not load the event feed (${err.message}). It is rebuilt every morning — try again shortly.`,
      }));
    });
})();
