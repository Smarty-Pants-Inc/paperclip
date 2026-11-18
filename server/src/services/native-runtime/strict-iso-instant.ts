// A provider timestamp may prove that a predecessor Runner is gone, so it must
// be an exact calendar instant. Date.parse silently normalizes impossible dates
// (2026-02-30 becomes 2026-03-02) and reads a zone-less time as local time.

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses an ISO 8601 instant with an explicit zone ("Z" or "+hh:mm") and real
 * calendar fields to epoch milliseconds. Every field must round-trip exactly
 * through Date (no day 30 in February, no hour 24, no minute 60); anything
 * else, including a missing zone, is null: not proof of anything.
 */
export function parseStrictIsoInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone, sign, offsetHours, offsetMinutes] = match;
  const millis = Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
  const fields = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)] as const;
  const local = new Date(Date.UTC(fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], millis));
  if (local.getUTCFullYear() !== fields[0] || local.getUTCMonth() !== fields[1] || local.getUTCDate() !== fields[2]
    || local.getUTCHours() !== fields[3] || local.getUTCMinutes() !== fields[4] || local.getUTCSeconds() !== fields[5]) return null;
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(offsetHours), minutes = Number(offsetMinutes);
    if (hours > 23 || minutes > 59) return null;
    offset = (sign === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000;
  }
  const instant = local.getTime() - offset;
  return Number.isFinite(instant) ? instant : null;
}
