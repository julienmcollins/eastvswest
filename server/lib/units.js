import { METERS_PER_MILE } from '../contracts.js';

/**
 * Convert meters to miles. Callers must pass a finite number of meters; the guard is here
 * because a NaN slipping into a total is silent and poisons the whole leaderboard.
 *
 * @param {number} meters
 * @returns {number} miles, unrounded
 */
export function metersToMiles(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) {
    throw new TypeError(`metersToMiles: expected a finite number, got ${String(meters)}`);
  }
  return meters / METERS_PER_MILE;
}

/**
 * Round to one decimal place, returning a Number (not a string).
 *
 * `Math.round(x * 10) / 10` rather than `toFixed`, because toFixed yields a string and
 * a string silently concatenates in any arithmetic downstream.
 */
export function round1(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError(`round1: expected a finite number, got ${String(n)}`);
  }
  return Math.round(n * 10) / 10;
}

/** meters -> miles rounded to 1dp, the shape the API always sends. */
export function milesFromMeters(meters) {
  return round1(metersToMiles(meters));
}

/**
 * Fraction of `total` that `part` represents, as a 0..1 Number rounded to 3dp.
 * Both shares come back 0.5 when the total is zero, so the split bar is even at the
 * start of a competition rather than collapsed or NaN.
 */
export function share(part, total) {
  if (total === 0) return 0.5;
  return Math.round((part / total) * 1000) / 1000;
}
