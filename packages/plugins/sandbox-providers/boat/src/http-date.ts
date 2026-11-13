const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** RFC 7231 section 7.1.1.1: IMF-fixdate and the two obsolete recipient forms.
 * Never normalize impossible dates or use Date.parse's non-HTTP grammar. A
 * provider observation must be post-epoch and at most 24 hours in the future;
 * clocks outside that conservative range are unavailable, not authoritative.
 */
export function parseHttpDate(value: string | null, now = Date.now()): string | null {
  if (value === null) return null;
  let weekday: number, day: number, month: number, year: number, hour: number, minute: number, second: number;
  const imf = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const rfc850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (imf || rfc850) {
    const match = (imf || rfc850)!;
    weekday = (imf ? DAYS : LONG_DAYS).indexOf(match[1]);
    day = Number(match[2]); month = MONTHS.indexOf(match[3]); year = Number(match[4]);
    hour = Number(match[5]); minute = Number(match[6]); second = Number(match[7]);
    if (rfc850) {
      const currentYear = new Date(now).getUTCFullYear();
      year += Math.floor(currentYear / 100) * 100;
      // RFC 7231 requires a date >50 years ahead to mean the previous century.
      if (year > currentYear + 50) year -= 100;
    }
  } else if (asctime) {
    weekday = DAYS.indexOf(asctime[1]); month = MONTHS.indexOf(asctime[2]); day = Number(asctime[3]);
    hour = Number(asctime[4]); minute = Number(asctime[5]); second = Number(asctime[6]); year = Number(asctime[7]);
  } else return null;
  if (year < 1970 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now + 86_400_000) return null;
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCDay() !== weekday) return null;
  return date.toISOString();
}
