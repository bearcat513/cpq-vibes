/**
 * A quote is arithmetic somebody checks with a calculator. These tests are the
 * cases where naive floating point gets it visibly wrong.
 */
import { describe, expect, test } from "bun:test";
import { applyPercent, clampPercent, formatMoney, formatPercent, percentBetween, percentOf, round, sum } from "./money";

describe("rounding", () => {
  test("half rounds away from zero, even at a float boundary", () => {
    // 1.005 is stored as 1.00499999…, so Math.round(1.005 * 100) is 100.
    expect(round(1.005)).toBe(1.01);
    expect(round(-1.005)).toBe(-1.01);
    expect(round(2.675)).toBe(2.68);
  });

  test("a currency's own precision is used", () => {
    expect(round(1_234.56, "JPY")).toBe(1_235);
    expect(round(1_234.564, "USD")).toBe(1_234.56);
  });

  test("nothing infinite or NaN escapes", () => {
    expect(round(Number.NaN)).toBe(0);
    expect(round(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("totals", () => {
  test("sums are of already-rounded numbers, so a total matches its lines", () => {
    expect(sum([0.1, 0.2])).toBe(0.3);
    expect(sum([99.99, 99.99, 99.99])).toBe(299.97);
    expect(sum([])).toBe(0);
  });

  test("percentages clamp rather than producing a negative price", () => {
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(-10)).toBe(0);
    expect(applyPercent(200, 25)).toBe(150);
    expect(percentOf(200, 25)).toBe(50);
  });

  test("a percentage of nothing is zero, not a division by zero", () => {
    // A free line is 0% discounted, not infinitely so.
    expect(percentBetween(0, 0)).toBe(0);
    expect(percentBetween(25, 200)).toBe(12.5);
  });
});

describe("formatting", () => {
  test("money carries its currency's symbol and precision", () => {
    expect(formatMoney(1_234.5, "USD", "en-US")).toBe("$1,234.50");
    expect(formatMoney(1_234.5, "JPY", "en-US")).toBe("¥1,235");
  });

  test("an unusable locale falls back rather than throwing", () => {
    expect(formatMoney(10, "USD", "!!!")).toContain("10");
  });

  test("percentages lose their trailing zeros, unlike money", () => {
    expect(formatPercent(20)).toBe("20%");
    expect(formatPercent(12.5)).toBe("12.5%");
  });
});
