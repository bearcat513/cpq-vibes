/**
 * Per-account preferences: what a new quote starts as, and what the app shows
 * while you work on one.
 *
 * They are stored as one JSON blob on the account's own `users` record, so
 * they travel with the account and need no collection of their own. That blob
 * is whatever was written the day it was written — a key may be missing,
 * stale, or (since a request body wrote it) nonsense — so every read goes
 * through `normalizePreferences`, the single place that decides what a valid
 * preference set looks like. The server normalizes before storing and the UI
 * normalizes before sending, so both agree on the clamped value without a
 * round trip.
 */
import { asCurrency, DEFAULT_CURRENCY } from "./money";
import { CURRENCIES, type CurrencyCode } from "./types";

export type Theme = "system" | "light" | "dark";

export type Preferences = {
  /** "system" follows the OS; the other two override it. */
  theme: Theme;
  /** The currency a new quote is denominated in. */
  defaultCurrency: CurrencyCode;
  /** The price book a new quote starts on; empty means the default book. */
  defaultPriceBookId: string;
  /** Subscription length a new quote starts with, in months. */
  defaultTermMonths: number;
  /** Tax applied to a new quote when the account names none, 0-100. */
  defaultTaxPercent: number;
  /** How long a new quote's pricing is good for, in days. */
  quoteValidDays: number;
  /** The proposal template preselected when rendering; empty means the first. */
  defaultProposalTemplateId: string;
  /** How many quotes the sidebar lists. */
  quoteListLimit: number;
  /**
   * Whether cost and margin are on screen.
   *
   * Off by default, and worth the switch: margin is the number nobody wants
   * over their shoulder in front of a customer, and a rep sharing their screen
   * on a call should be able to put it away in one click.
   */
  showMargin: boolean;
  /** Formatting locale for money and dates. Empty follows the browser. */
  locale: string;
  /**
   * Whether the left-hand navigation is collapsed to its icons.
   *
   * Here rather than in browser storage because this app keeps everything
   * that persists on the account — a preference follows you to another
   * machine, and nothing else in the UI reaches for `localStorage`.
   */
  navCollapsed: boolean;
  /** Ask before deleting anything. It is the only confirmation there is. */
  confirmDestructive: boolean;
};

/** Bounds shared by the settings inputs and the normalizer below. */
export const PREFERENCE_LIMITS = {
  termMonths: { min: 0, max: 600 },
  validDays: { min: 1, max: 365 },
  quoteList: { min: 5, max: 200 },
  taxPercent: { min: 0, max: 100 },
} as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  defaultCurrency: DEFAULT_CURRENCY,
  defaultPriceBookId: "",
  defaultTermMonths: 12,
  defaultTaxPercent: 0,
  quoteValidDays: 30,
  defaultProposalTemplateId: "",
  quoteListLimit: 50,
  showMargin: false,
  locale: "",
  navCollapsed: false,
  confirmDestructive: true,
};

export const THEMES: Theme[] = ["system", "light", "dark"];

export { CURRENCIES };

/** Record ids are minted by `newId()` in src/server/db.ts: `pb_1a2b3c4d`. */
const RECORD_ID = /^[a-z0-9_]{3,40}$/;

/** A BCP-47 tag, loosely — enough to keep junk out of `Intl`. */
const LOCALE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/;

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(Math.max(value, min), max);

function asNumber(value: unknown, fallback: number, bounds: { min: number; max: number }, whole = true): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = clamp(parsed, bounds);
  return whole ? Math.trunc(clamped) : clamped;
}

/** An id that has since been deleted is harmless — it falls back to "the first
 * one" wherever it is used — so only a malformed id is discarded here. */
const asRecordId = (value: unknown): string => {
  const id = String(value ?? "").trim();
  return RECORD_ID.test(id) ? id : "";
};

/**
 * Every unknown key is dropped and every bad value falls back to its default,
 * so a preference set is always complete and always in range: the UI renders
 * it without a guard and the app reads it without one.
 */
export function normalizePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PREFERENCES };
  const input = raw as Record<string, unknown>;

  const locale = String(input.locale ?? "").trim().slice(0, 35);

  return {
    theme: THEMES.includes(input.theme as Theme) ? (input.theme as Theme) : DEFAULT_PREFERENCES.theme,
    defaultCurrency: asCurrency(input.defaultCurrency, DEFAULT_PREFERENCES.defaultCurrency),
    defaultPriceBookId: asRecordId(input.defaultPriceBookId),
    defaultTermMonths: asNumber(input.defaultTermMonths, DEFAULT_PREFERENCES.defaultTermMonths, PREFERENCE_LIMITS.termMonths),
    defaultTaxPercent: asNumber(
      input.defaultTaxPercent,
      DEFAULT_PREFERENCES.defaultTaxPercent,
      PREFERENCE_LIMITS.taxPercent,
      false,
    ),
    quoteValidDays: asNumber(input.quoteValidDays, DEFAULT_PREFERENCES.quoteValidDays, PREFERENCE_LIMITS.validDays),
    defaultProposalTemplateId: asRecordId(input.defaultProposalTemplateId),
    quoteListLimit: asNumber(input.quoteListLimit, DEFAULT_PREFERENCES.quoteListLimit, PREFERENCE_LIMITS.quoteList),
    showMargin: input.showMargin === true,
    // A locale `Intl` cannot parse would throw on every formatted number.
    locale: LOCALE.test(locale) ? locale : "",
    navCollapsed: input.navCollapsed === true,
    confirmDestructive: input.confirmDestructive !== false,
  };
}
