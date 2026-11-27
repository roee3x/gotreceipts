/**
 * Time, as every part of the tool reads it.
 *
 * A record and an approval each carry the time they were made, and both count only for a
 * while. So "how old is it" and "is it dated in the future" are asked in several places.
 * They are answered here, so that every place gives the same answer.
 */

const HOUR_MS = 3_600_000;

/**
 * How far ahead of the clock a time may lie before it is distrusted. Two machines never agree
 * on the time to the second, so a record that was made on one and is read on another may look
 * a little ahead.
 */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

/** True when `time` lies further ahead of `now` than two clocks may disagree. Both in milliseconds. */
export function isInTheFuture(time: number, now: number): boolean {
  return time > now + CLOCK_TOLERANCE_MS;
}

/** The hours from `time` to `now`. Below zero when `time` lies ahead. */
export function hoursSince(time: number, now: number): number {
  return (now - time) / HOUR_MS;
}

/** An age as it is shown. A time a little ahead of the clock is shown as 0.0, not as a negative age. */
export function shownAge(hours: number): string {
  return Math.max(0, hours).toFixed(1);
}

/** A time in UTC, written the one way this tool writes it: 2026-01-31T12:00:00.000Z. */
export const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** True for a text that is written that way and is a real time: not the 31st of February. */
export function isUtcTime(text: string): boolean {
  return UTC_TIME.test(text) && !Number.isNaN(Date.parse(text));
}
