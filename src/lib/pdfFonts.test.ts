import { describe, expect, test } from "bun:test";
import { formatMoney } from "./money";
import { encodeWinAnsi } from "./pdfFonts";
import { CURRENCIES } from "./types";

/** What a PDF would print: the WinAnsi bytes, read back. */
const printed = (text: string) => String.fromCharCode(...encodeWinAnsi(text));

describe("money on a PDF", () => {
  // Every locale the app offers a picker entry for is not the point; a spread
  // that exercises every separator and symbol style is.
  const LOCALES = [undefined, "en-US", "en-GB", "en-IN", "de-DE", "fr-FR", "fr-CH", "sv-SE", "ja-JP", "pt-BR", "hi-IN"];

  for (const currency of CURRENCIES) {
    test(`${currency} prints without a missing glyph in any locale`, () => {
      for (const locale of LOCALES) {
        const amount = formatMoney(-1234567.891, currency, locale);
        const out = printed(amount);
        // A "?" is what encodeWinAnsi writes for a character it cannot map.
        expect({ locale, amount, out, missing: out.includes("?") }).toMatchObject({ missing: false });
      }
    });
  }

  test("the rupee sign is written out as Rs", () => {
    expect(printed(formatMoney(100000, "INR", "en-IN"))).toStartWith("Rs ");
  });
});
