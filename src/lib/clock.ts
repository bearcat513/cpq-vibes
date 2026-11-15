/**
 * What day it is — in the organization's calendar, not the server's.
 *
 * Everything dated in this app is a *day*: a quote is valid until a date, an
 * invoice falls due on one, a payment arrives on one. Reading "today" off the
 * UTC clock put a Sydney office a day ahead every morning and a San Francisco
 * one a day behind every afternoon, so an invoice could be overdue on the
 * server before it was due at the desk that issued it.
 *
 * So "today" is asked of a provider. The browser sets one from the signed-in
 * organization's time zone; the Bun server sets one that reads the zone of
 * the request it is serving (src/server/context.ts). With no provider, or no
 * zone, it is UTC — which is what every test and every pure caller gets, and
 * what this app did before.
 *
 * Pure: no I/O, and the clock itself can be passed in.
 */

let provider: () => string | undefined = () => undefined;

/** Where `today()` reads its time zone from. Set once, at start-up. */
export function setTimeZoneProvider(next: () => string | undefined): void {
  provider = next;
}

/** True for a zone this runtime can format in, such as `Europe/London`. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The date `now` falls on in `timeZone`, as `YYYY-MM-DD`. An unknown zone is UTC. */
export function todayIn(timeZone: string | undefined, now: Date = new Date()): string {
  if (!timeZone || !isTimeZone(timeZone)) return now.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Today as `YYYY-MM-DD`, in the current organization's time zone. */
export const today = (now: Date = new Date()): string => todayIn(provider(), now);

/** The calendar year numbers are issued in. */
export const currentYear = (now: Date = new Date()): number => Number(today(now).slice(0, 4));

/** `YYYY-MM-DD` plus a number of days, with no time zone involved at all. */
export function addDaysTo(iso: string, days: number): string {
  const start = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + Math.trunc(days));
  return start.toISOString().slice(0, 10);
}

/** Every zone the runtime knows, for a picker. Falls back to a short list. */
export function timeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      const zones = supported("timeZone");
      return zones.includes("UTC") ? zones : ["UTC", ...zones];
    } catch {
      // Fall through.
    }
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];
}
