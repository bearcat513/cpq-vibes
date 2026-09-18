/**
 * Preferences are read back from a JSON blob that a request body wrote, so the
 * normalizer is the only thing standing between a stored value and the UI
 * rendering it. It has to always produce a complete, in-range set.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFERENCES, PREFERENCE_LIMITS, normalizePreferences } from "./preferences";

describe("normalizePreferences", () => {
  test("anything unusable becomes the defaults", () => {
    for (const input of [null, undefined, "nonsense", 42, [], { theme: "chartreuse" }]) {
      expect(normalizePreferences(input)).toEqual(DEFAULT_PREFERENCES);
    }
  });

  test("a complete set survives unchanged", () => {
    const set = { ...DEFAULT_PREFERENCES, theme: "dark" as const, showMargin: true, locale: "en-GB" };
    expect(normalizePreferences(set)).toEqual(set);
  });

  test("out-of-range numbers are clamped, not rejected", () => {
    const result = normalizePreferences({
      defaultTermMonths: 99_999,
      quoteValidDays: -5,
      quoteListLimit: 1,
      defaultTaxPercent: 250,
    });

    expect(result.defaultTermMonths).toBe(PREFERENCE_LIMITS.termMonths.max);
    expect(result.quoteValidDays).toBe(PREFERENCE_LIMITS.validDays.min);
    expect(result.quoteListLimit).toBe(PREFERENCE_LIMITS.quoteList.min);
    expect(result.defaultTaxPercent).toBe(100);
  });

  test("a tax rate keeps its decimals; a term does not", () => {
    const result = normalizePreferences({ defaultTaxPercent: 8.25, defaultTermMonths: 12.7 });
    expect(result.defaultTaxPercent).toBe(8.25);
    expect(result.defaultTermMonths).toBe(12);
  });

  test("unknown keys are dropped", () => {
    expect(normalizePreferences({ ...DEFAULT_PREFERENCES, mischief: true })).not.toHaveProperty("mischief");
  });

  test("a currency this app cannot price in falls back", () => {
    expect(normalizePreferences({ defaultCurrency: "XYZ" }).defaultCurrency).toBe(DEFAULT_PREFERENCES.defaultCurrency);
    expect(normalizePreferences({ defaultCurrency: "EUR" }).defaultCurrency).toBe("EUR");
  });

  test("a malformed record id is discarded, a plausible one is kept", () => {
    // A stale id is harmless — it falls back to "the first one" wherever it is
    // used — but a malformed one should never be stored.
    expect(normalizePreferences({ defaultPriceBookId: "../../etc" }).defaultPriceBookId).toBe("");
    expect(normalizePreferences({ defaultPriceBookId: "pb_1a2b3c4d" }).defaultPriceBookId).toBe("pb_1a2b3c4d");
  });

  test("a locale Intl cannot parse is discarded", () => {
    // It would otherwise throw on every formatted number on the page.
    expect(normalizePreferences({ locale: "not a locale!" }).locale).toBe("");
    expect(normalizePreferences({ locale: "de-DE" }).locale).toBe("de-DE");
  });

  test("the navigation starts expanded, and remembers being collapsed", () => {
    expect(normalizePreferences({}).navCollapsed).toBe(false);
    expect(normalizePreferences({ navCollapsed: true }).navCollapsed).toBe(true);
    expect(normalizePreferences({ navCollapsed: "yes" }).navCollapsed).toBe(false);
  });

  test("the two booleans default the safe way round", () => {
    // Confirmations on, margin off — the latter because it is the number
    // nobody wants on screen in front of a customer.
    expect(normalizePreferences({}).confirmDestructive).toBe(true);
    expect(normalizePreferences({}).showMargin).toBe(false);
    expect(normalizePreferences({ confirmDestructive: false }).confirmDestructive).toBe(false);
    expect(normalizePreferences({ showMargin: "yes" }).showMargin).toBe(false);
  });
});
