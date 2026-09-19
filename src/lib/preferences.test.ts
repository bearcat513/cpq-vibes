/**
 * Preferences are read back from a JSON blob that a request body wrote, so the
 * normalizer is the only thing standing between a stored value and the UI
 * rendering it. It has to always produce a complete, in-range set.
 */
import { describe, expect, test } from "bun:test";
import { ACCENTS, DEFAULT_PREFERENCES, FONTS, PREFERENCE_LIMITS, normalizePreferences } from "./preferences";

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

  test("an accent or a face this app cannot dress in falls back", () => {
    expect(normalizePreferences({ accent: "neon" }).accent).toBe(DEFAULT_PREFERENCES.accent);
    expect(normalizePreferences({ accent: "slate" }).accent).toBe("slate");
    expect(normalizePreferences({ font: "comic" }).font).toBe(DEFAULT_PREFERENCES.font);
    expect(normalizePreferences({ font: "mono" }).font).toBe("mono");
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

/**
 * The look is chosen here and drawn in styles/globals.css, and neither half
 * can see the other: an accent added to the list above with no hue behind it
 * would offer a swatch that paints nothing and a setting that does nothing.
 * The stylesheet is the only place either is written down, so it is the thing
 * asserted against.
 */
describe("what the stylesheet has to know about", () => {
  const css = Bun.file(new URL("../../styles/globals.css", import.meta.url)).text();

  test("every accent is a hue in the stylesheet", async () => {
    for (const accent of ACCENTS) expect(await css).toContain(`[data-accent="${accent.id}"]`);
  });

  test("every face is a stack in the stylesheet", async () => {
    for (const font of FONTS) expect(await css).toContain(`[data-font="${font.id}"]`);
  });

  test("the seven are seven, and named once each", () => {
    expect(ACCENTS).toHaveLength(7);
    expect(new Set(ACCENTS.map(one => one.id)).size).toBe(ACCENTS.length);
    expect(new Set(FONTS.map(one => one.id)).size).toBe(FONTS.length);
  });
});
