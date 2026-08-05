#!/usr/bin/env node
/**
 * Regenerate test/fixtures/activities.json.
 *
 * The fixture is a generated file rather than hand-written because it needs 201 padding
 * rides to force multi-page pagination, and because the expected totals must be derived
 * from the same data they describe -- a hand-typed expectation drifts the moment a case
 * is added, and then the test that was supposed to catch a mileage bug just encodes it.
 *
 *   node test/fixtures/build-activities.mjs
 *
 * Competition window assumed: 2026-06-01 .. 2026-08-31 (see testConfig()).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const START = '2026-06-01';
const END = '2026-08-31';
const COUNTED = new Set(['Ride', 'GravelRide', 'MountainBikeRide', 'VirtualRide']);
const MILE = 1609.344;

let nextId = 15000000000;
const id = () => ++nextId;

/**
 * @param {object} o
 * @param {string} o.localDate  date portion of start_date_local -- what the race judges on
 * @param {string} [o.utc]      true UTC instant; defaults to the same wall clock (UTC rider)
 */
function ride({ sportType, meters, localDate, localTime = '08:00:00', utc = null, why, ...rest }) {
  const startLocal = `${localDate}T${localTime}Z`;
  return {
    id: id(),
    name: why,
    sport_type: sportType,
    distance: meters,
    moving_time: 3600,
    elapsed_time: 3700,
    total_elevation_gain: 120,
    start_date: utc ?? startLocal,
    start_date_local: startLocal,
    timezone: '(GMT-05:00) America/New_York',
    trainer: false,
    manual: false,
    private: false,
    type: sportType,
    _why: why,
    ...rest,
  };
}

const named = [
  ride({ sportType: 'Ride', meters: MILE, localDate: '2026-07-01', why: 'plain Ride, counts' }),
  ride({ sportType: 'GravelRide', meters: MILE * 10, localDate: '2026-07-02', type: 'Ride',
    why: 'GravelRide reports legacy type "Ride"; counts on sport_type' }),
  ride({ sportType: 'MountainBikeRide', meters: MILE * 5, localDate: '2026-07-03', type: 'Ride',
    why: 'MountainBikeRide, counts' }),
  ride({ sportType: 'VirtualRide', meters: MILE * 2, localDate: '2026-07-04', trainer: true,
    why: 'VirtualRide on a trainer, counts (trainer is not an exclusion)' }),

  ride({ sportType: 'EBikeRide', meters: MILE * 50, localDate: '2026-07-05', type: 'EBikeRide',
    why: 'EXCLUDED: e-bike' }),
  // The canary. A filter keyed on the legacy `type` field counts this as a pedal ride.
  ride({ sportType: 'EMountainBikeRide', meters: MILE * 40, localDate: '2026-07-06', type: 'Ride',
    why: 'EXCLUDED: e-MTB, but legacy type says "Ride" -- catches a type-based filter' }),
  ride({ sportType: 'Run', meters: MILE * 6, localDate: '2026-07-07', type: 'Run',
    why: 'EXCLUDED: not a bike ride' }),

  ride({ sportType: 'Ride', meters: MILE * 99, localDate: '2026-05-31', why: 'EXCLUDED: day before START' }),
  ride({ sportType: 'Ride', meters: MILE, localDate: START, why: 'START boundary, INCLUSIVE, counts' }),
  ride({ sportType: 'Ride', meters: MILE, localDate: END, why: 'END boundary, INCLUSIVE, counts' }),
  ride({ sportType: 'Ride', meters: MILE * 99, localDate: '2026-09-01', why: 'EXCLUDED: day after END' }),

  // The timezone edge. In Auckland (UTC+13) it is already 2026-06-01 locally while UTC is
  // still 2026-05-31. Judging on start_date_local counts it; judging on UTC drops it.
  ride({ sportType: 'Ride', meters: MILE, localDate: START, localTime: '00:30:00',
    utc: '2026-05-31T11:30:00Z', timezone: '(GMT+12:00) Pacific/Auckland',
    why: 'UTC+13 edge: local date is inside the window, UTC date is not. Counts.' }),

  ride({ sportType: 'Ride', meters: MILE, localDate: '2026-07-08', private: true,
    why: 'private ride: counts toward totals, never itemized publicly' }),
  ride({ sportType: 'Ride', meters: MILE * 300, localDate: '2026-07-09', manual: true,
    why: 'EXCLUDED by default: manual entry, free-text distance, needs admin approval' }),
];

// Absent `timezone` and `type`. Proves the ?? null coalescing: `undefined` cannot be bound
// to SQLite at all, so a missing field must become an explicit null before it reaches the
// driver. A pure mapper test never catches this.
const sparse = ride({ sportType: 'Ride', meters: MILE, localDate: '2026-07-10',
  why: 'timezone and type both absent -- must become SQL NULLs, not undefined' });
delete sparse.timezone;
delete sparse.type;
named.push(sparse);

// 201 padding rides: forces pagination past a 200-per-page boundary and exercises
// short-page termination.
const padding = [];
for (let i = 0; i < 201; i++) {
  const day = 10 + (i % 20);
  padding.push(ride({
    sportType: 'Ride', meters: MILE, localDate: `2026-08-${String(day).padStart(2, '0')}`,
    why: `padding ride ${i + 1}/201 (pagination)`,
  }));
}

const activities = [...named, ...padding];

// Records that MUST throw rather than silently write NaN or a partial row.
const malformed = [
  { id: id(), sport_type: 'Ride', start_date: '2026-07-01T08:00:00Z',
    start_date_local: '2026-07-01T08:00:00Z', moving_time: 3600,
    _why: 'distance absent -- must throw, never store NaN' },
  { id: id(), sport_type: 'Ride', distance: 'twelve', start_date: '2026-07-01T08:00:00Z',
    start_date_local: '2026-07-01T08:00:00Z', _why: 'distance is a string -- must throw' },
  { sport_type: 'Ride', distance: MILE, start_date: '2026-07-01T08:00:00Z',
    start_date_local: '2026-07-01T08:00:00Z', _why: 'id absent -- must throw' },
];

// Expected totals derived from the data above, not typed by hand.
const counted = activities.filter((a) => {
  const localDate = a.start_date_local.slice(0, 10);
  return COUNTED.has(a.sport_type) && localDate >= START && localDate <= END && !a.manual;
});
const countedMeters = counted.reduce((s, a) => s + a.distance, 0);

const fixture = {
  _readme:
    'Generated by test/fixtures/build-activities.mjs. Every entry carries a _why explaining ' +
    'which bug it catches. Do not edit by hand -- edit the generator and re-run it.',
  window: { start: START, end: END },
  allowed_sport_types: [...COUNTED],
  count_manual: false,
  activities,
  malformed,
  expected: {
    total_records: activities.length,
    counted_records: counted.length,
    counted_meters: countedMeters,
    counted_miles: Math.round((countedMeters / MILE) * 10) / 10,
    excluded_ids: activities.filter((a) => !counted.includes(a)).map((a) => a.id),
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), 'activities.json');
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(
  `wrote ${out}\n` +
    `  ${fixture.expected.total_records} records, ${fixture.expected.counted_records} counted, ` +
    `${fixture.expected.counted_miles} mi\n`,
);
