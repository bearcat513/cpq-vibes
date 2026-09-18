/**
 * The expression language is what commercial policy is written in, so its
 * edges matter: precedence, short-circuiting, and what happens when an
 * expression cannot produce a number.
 */
import { describe, expect, test } from "bun:test";
import { conditionHolds, evaluateFormula, parseFormula, runFormula } from "./formula";

const value = (expression: string, vars: Record<string, unknown> = {}) => {
  const result = runFormula(expression, vars);
  return result.ok ? result.value : `ERROR: ${result.error}`;
};

describe("arithmetic", () => {
  test("follows the usual precedence", () => {
    expect(value("2 + 3 * 4")).toBe(14);
    expect(value("(2 + 3) * 4")).toBe(20);
    expect(value("-2 ^ 2")).toBe(4); // unary binds tighter than the power here
    expect(value("2 ^ 3 ^ 2")).toBe(512); // right associative
    expect(value("10 - 3 - 2")).toBe(5); // left associative
  });

  test("resolves variables, coercing what it reasonably can", () => {
    expect(value("quantity * unitPrice", { quantity: 3, unitPrice: 9.5 })).toBe(28.5);
    expect(value("flag * 10", { flag: true })).toBe(10);
    expect(value("price * 2", { price: "12.5" })).toBe(25);
    // A missing variable is zero: a product simply does not have that option.
    expect(value("option.sso * 5", {})).toBe(0);
  });

  test("a bracketed name may contain spaces", () => {
    expect(value("[line total] / 2", { "line total": 50 })).toBe(25);
  });

  test("functions round, clamp and choose", () => {
    expect(value("round(10 / 3, 2)")).toBe(3.33);
    expect(value("clamp(150, 0, 100)")).toBe(100);
    expect(value("max(1, 9, 4)")).toBe(9);
    expect(value("if(1, 10, 20)")).toBe(10);
  });
});

describe("comparisons and logic", () => {
  test("produce 1 and 0, so a condition is just an expression", () => {
    expect(value("5 > 3")).toBe(1);
    expect(value("5 < 3")).toBe(0);
    expect(value("5 >= 5 && 2 != 3")).toBe(1);
    expect(value("0 || 0")).toBe(0);
    expect(value("!0")).toBe(1);
  });

  test("comparison binds looser than arithmetic", () => {
    expect(value("2 + 2 == 4")).toBe(1);
    expect(value("quantity * 2 > 10", { quantity: 6 })).toBe(1);
  });

  test("&& and || short-circuit, so a guard actually guards", () => {
    // Without short-circuiting the division would make the whole thing
    // uncomputable on exactly the rows the guard was written for.
    expect(value("quantity > 0 && total / quantity > 10", { quantity: 0, total: 5 })).toBe(0);
    expect(value("1 || total / 0", { total: 5 })).toBe(1);
  });

  test("`if` does not evaluate the branch it did not take", () => {
    expect(value("if(quantity > 0, total / quantity, 0)", { quantity: 0, total: 100 })).toBe(0);
  });
});

describe("failures", () => {
  test("an unresolvable result is null, never a wrong number", () => {
    const parsed = parseFormula("total / quantity");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(evaluateFormula(parsed.node, { total: 10, quantity: 0 })).toBeNull();
    expect(evaluateFormula(parsed.node, { total: "abc", quantity: 2 })).toBeNull();
    expect(evaluateFormula(parsed.node, { total: 10, quantity: 4 })).toBe(2.5);
  });

  test("unknown variables are caught when the expression is written", () => {
    const result = parseFormula("quantitty * 2", ["quantity", "unitPrice"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unknown variable: "quantitty"');
  });

  test("the common slips get their own message", () => {
    expect(value("quantity = 5")).toContain('Use "==" to compare');
    expect(value("a & b")).toContain('Use "&&"');
    expect(value("round()")).toContain("takes 1 to 2 arguments");
    expect(value("nope(1)")).toContain('Unknown function "nope"');
    expect(value("2 +")).toContain("Unexpected end of expression");
    expect(value("")).toContain("Enter an expression");
  });

  test("a condition that cannot be computed does not fire", () => {
    // Firing is the side that changes a price, so an unusable condition has
    // to mean "no".
    expect(conditionHolds("total / 0 > 1", { total: 5 })).toBe(false);
    expect(conditionHolds("nonsense $$", {})).toBe(false);
    // An empty condition means "always", which is how every rule editor
    // presents a blank box.
    expect(conditionHolds("", {})).toBe(true);
  });

  test("there is no way to reach anything but the variables passed in", () => {
    for (const attempt of [
      "constructor",
      "globalThis",
      "process.env",
      "this.x",
      "(() => 1)()",
      "eval(1)",
      "[1].map(x)",
    ]) {
      const result = runFormula(attempt, {});
      // Either it does not parse, or it resolves to an unknown variable — 0.
      expect(result.ok === false || result.value === 0 || result.value === null).toBe(true);
    }
  });
});
