// Calendar-date helpers. Dates are plain YYYY-MM-DD strings; Date.UTC is used only as a
// calendar to step day by day, so DST and time zones can never change a night count.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DAY_MS = 86_400_000;

const parts = (d: string) => d.split("-").map(Number) as [number, number, number];

export function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = parts(s);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const monthOf = (date: string): number => Number(date.slice(5, 7));

/** Every night in the half-open stay [checkIn, checkOut). Null if longer than `max`. Inputs must be valid dates. */
export function stayNights(checkIn: string, checkOut: string, max: number): string[] | null {
  const nights: string[] = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    if (nights.length === max) return null;
    nights.push(d);
  }
  return nights;
}
