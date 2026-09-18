/**
 * Money.
 *
 * A quote is arithmetic somebody checks with a calculator, so the only thing
 * that matters here is that the numbers on screen are the numbers that were
 * added up. Two rules get that:
 *
 * **Round at every step, to the currency's own precision.** Not at the end.
 * A unit price of 33.333 charged for three units is 100.00 if you round late
 * and 99.99 if you round early — but only the early one matches the line the
 * customer is reading, where the unit price says 33.33. Every function in the
 * pricing engine passes its result through `round` before handing it on.
 *
 * **Sum rounded numbers, never raw ones.** `sum` takes the values as they were
 * displayed, which is why a quote total always equals its visible lines added
 * together. A "correct" total that disagrees with the lines is a support call.
 *
 * Floating point is fine at this precision — a quote is thousands, not
 * trillions — provided the rounding is done deliberately and the half-up case
 * is handled, which `round` does. `toFixed` is not used for arithmetic: it
 * rounds half-to-even in some engines and half-away-from-zero in others.
 */
import { CURRENCY_SET, type CurrencyCode } from "./types";

// Re-exported so the pricing modules take their currency type from the same
// place they take their rounding, rather than from two imports that could
// one day disagree.
export type { CurrencyCode };

/**
 * Minor units per currency. Every currency in `CURRENCIES` needs an entry, and
 * the ones that are not two decimals are the reason this table exists: a
 * Japanese quote showing ¥1,200.00 is wrong twice over.
 */
const MINOR_UNITS: Record<CurrencyCode, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
  CHF: 2,
  SEK: 2,
  INR: 2,
  BRL: 2,
};

/** The currency a price book falls back to when none was chosen. */
export const DEFAULT_CURRENCY: CurrencyCode = "USD";

export const isCurrency = (value: unknown): value is CurrencyCode => CURRENCY_SET.has(String(value));

export const asCurrency = (value: unknown, fallback: CurrencyCode = DEFAULT_CURRENCY): CurrencyCode =>
  isCurrency(value) ? value : fallback;

export const decimalsFor = (currency: CurrencyCode): number => MINOR_UNITS[currency] ?? 2;

/**
 * Rounds to the currency's precision, half away from zero.
 *
 * The `EPSILON` nudge is the half-up fix: 1.005 is stored as 1.00499999…, and
 * `Math.round(1.005 * 100)` is 100, not 101. Scaling by `(1 + EPSILON)` before
 * rounding recovers the value a person wrote down without disturbing anything
 * that was not already within a float's width of the boundary.
 */
export function round(value: number, currency: CurrencyCode = DEFAULT_CURRENCY): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimalsFor(currency);
  const scaled = value * factor;
  const nudged = scaled * (1 + Number.EPSILON);
  return (value < 0 ? -Math.round(-nudged) : Math.round(nudged)) / factor;
}

/** Rounds a rate or percentage, where two decimals is a display convention. */
export function roundRate(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor * (1 + Number.EPSILON)) / factor;
}

/** Adds up already-rounded amounts, so a total matches its visible parts. */
export function sum(values: number[], currency: CurrencyCode = DEFAULT_CURRENCY): number {
  return round(
    values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0),
    currency,
  );
}

/** `value` less `percent` of it, rounded. Percentages outside 0-100 are clamped. */
export function applyPercent(value: number, percent: number, currency: CurrencyCode = DEFAULT_CURRENCY): number {
  return round(value * (1 - clampPercent(percent) / 100), currency);
}

/** What `percent` of `value` comes to — the discount, rather than the remainder. */
export function percentOf(value: number, percent: number, currency: CurrencyCode = DEFAULT_CURRENCY): number {
  return round((value * clampPercent(percent)) / 100, currency);
}

/** Percentages are always 0-100 here; a rule that produces 140 means 100. */
export const clampPercent = (value: number): number =>
  !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value));

/**
 * `part` as a percentage of `whole`, to two decimals.
 *
 * A zero `whole` gives 0 rather than a division by zero: a free line is 0%
 * discounted, not infinitely so, and that is what a total has to show.
 */
export function percentBetween(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return 0;
  return roundRate((part / whole) * 100);
}

/** Never negative: a quantity, a term or a price floor below zero is a bug. */
export const atLeastZero = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Formats an amount for display.
 *
 * `Intl` is used for the grouping and the symbol, with the currency's own
 * precision pinned — the default for some currencies disagrees with the table
 * above, and a formatted total that disagrees with the stored one is exactly
 * the bug this file exists to prevent.
 */
export function formatMoney(value: number, currency: CurrencyCode = DEFAULT_CURRENCY, locale?: string): string {
  const digits = decimalsFor(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number.isFinite(value) ? value : 0);
  } catch {
    // An unknown locale, or an Intl build without currency data.
    return `${currency} ${(Number.isFinite(value) ? value : 0).toFixed(digits)}`;
  }
}

/** "12.5%" — percentages lose their trailing zeros, unlike money. */
export function formatPercent(value: number, decimals = 1): string {
  const rounded = roundRate(Number.isFinite(value) ? value : 0, decimals);
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(decimals)}%`;
}
