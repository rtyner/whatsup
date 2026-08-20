/** Regions, their anchors, and which source seeds feed each one. */
export const RADIUS_KM = 80.5; // ~50 miles, our stand-in for a 1 hour drive
export const WINDOW_DAYS = 30;

export const REGIONS = [
  {
    key: 'lakeland',
    name: 'Lakeland, Florida',
    blurb: 'Within ~1 hour of Lakeland, FL — Polk County, Tampa Bay and the Orlando fringe.',
    timezone: 'America/New_York',
    center: { lat: 28.0395, lon: -81.9498 },
    eventbrite: {
      host: 'www.eventbrite.com',
      pagesPerSlug: 6,
      slugs: [
        'fl--lakeland', 'fl--winter-haven', 'fl--plant-city', 'fl--bartow',
        'fl--tampa', 'fl--brandon', 'fl--kissimmee', 'fl--clermont',
        'fl--lake-wales', 'fl--auburndale', 'fl--sebring', 'fl--zephyrhills',
      ],
    },
    meetup: [
      { location: 'us--fl--Lakeland', label: 'lakeland' },
      { location: 'us--fl--Tampa', label: 'tampa' },
      { location: 'us--fl--Winter%20Haven', label: 'winter-haven' },
      { location: 'us--fl--Brandon', label: 'brandon' },
    ],
    ticketmaster: [{ lat: 28.0395, lon: -81.9498, label: 'lakeland' }],
    bodensee: [],
  },
  {
    key: 'ueberlingen',
    name: 'Überlingen, Bodensee',
    blurb: 'Within ~1 hour of Überlingen — the German lakeshore plus nearby Austria and Switzerland.',
    timezone: 'Europe/Berlin',
    center: { lat: 47.7694, lon: 9.1616 },
    eventbrite: {
      host: 'www.eventbrite.de',
      pagesPerSlug: 6,
      slugs: [
        'germany--%C3%BCberlingen', 'germany--konstanz', 'germany--friedrichshafen',
        'germany--ravensburg', 'germany--singen', 'germany--radolfzell',
        'germany--lindau', 'germany--tuttlingen', 'germany--sigmaringen',
        'germany--markdorf', 'switzerland--kreuzlingen', 'switzerland--frauenfeld',
        'austria--bregenz',
      ],
    },
    meetup: [
      { location: 'de--Konstanz', label: 'konstanz' },
      { location: 'de--Friedrichshafen', label: 'friedrichshafen' },
      { location: 'de--Ravensburg', label: 'ravensburg' },
      { location: 'ch--St.%20Gallen', label: 'st-gallen' },
    ],
    ticketmaster: [{ lat: 47.7694, lon: 9.1616, label: 'ueberlingen' }],
    bodensee: [
      { url: 'https://www.ueberlingen-bodensee.de/veranstaltungen', city: 'Überlingen' },
    ],
  },
];
