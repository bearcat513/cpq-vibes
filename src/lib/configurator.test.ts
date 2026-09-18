/**
 * Configuration rules decide what the business is willing to sell. These tests
 * are the shapes that come up: a required choice, a cardinality bound, a
 * dependency between options, and a formula over the line.
 */
import { describe, expect, test } from "bun:test";
import { defaultSelection, optionIndex, toggleOption, validateConfiguration } from "./configurator";
import type { Product } from "./types";

const product = (overrides: Partial<Product> = {}): Product =>
  ({
    name: "Platform",
    minQuantity: 1,
    maxQuantity: 0,
    optionGroups: [
      {
        id: "g1",
        key: "tier",
        name: "Tier",
        select: "one",
        required: true,
        options: [
          { id: "o1", key: "standard", name: "Standard", priceDelta: 0, default: true },
          { id: "o2", key: "premium", name: "Premium", priceDelta: 0, priceFactor: 1.5 },
        ],
      },
      {
        id: "g2",
        key: "addons",
        name: "Add-ons",
        select: "many",
        required: false,
        maxSelect: 2,
        options: [
          { id: "o3", key: "sso", name: "SSO", priceDelta: 15 },
          { id: "o4", key: "audit", name: "Audit log", priceDelta: 8 },
          { id: "o5", key: "hsm", name: "Customer keys", priceDelta: 25 },
        ],
      },
    ],
    rules: [],
    ...overrides,
  }) as Product;

const check = (p: Product, selectedOptions: string[], quantity = 10, termMonths = 12) =>
  validateConfiguration(p, { selectedOptions, quantity, termMonths }, "USD");

describe("defaults", () => {
  test("a required single-select starts on its default, or its first option", () => {
    expect(defaultSelection(product())).toEqual(["standard"]);

    const noDefault = product({
      optionGroups: [
        { id: "g1", key: "t", name: "Tier", select: "one", required: true, options: [
          { id: "o1", key: "a", name: "A", priceDelta: 0 },
          { id: "o2", key: "b", name: "B", priceDelta: 0 },
        ] },
      ],
    });
    // A line born invalid is a worse first impression than a defensible guess.
    expect(defaultSelection(noDefault)).toEqual(["a"]);
  });

  test("an optional group with no default starts empty", () => {
    expect(defaultSelection(product()).includes("sso")).toBe(false);
  });
});

describe("cardinality", () => {
  test("a required group must be answered", () => {
    expect(check(product(), []).errors).toEqual(["Choose an option for “Tier”."]);
  });

  test("a single-select keeps the first choice and says so", () => {
    const result = check(product(), ["standard", "premium"]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("takes one choice");
    expect(result.selected).toEqual(["standard"]);
  });

  test("a maxSelect is enforced", () => {
    expect(check(product(), ["standard", "sso", "audit", "hsm"]).errors[0]).toContain("at most 2");
  });

  test("quantity bounds come from the product", () => {
    const bounded = product({ minQuantity: 5, maxQuantity: 50 });
    expect(check(bounded, ["standard"], 2).errors[0]).toContain("minimum of 5");
    expect(check(bounded, ["standard"], 80).errors[0]).toContain("maximum of 50");
    expect(check(bounded, ["standard"], 0).errors[0]).toContain("greater than zero");
  });
});

describe("rules", () => {
  const ruled = product({
    rules: [
      { id: "r1", kind: "requires", when: ["hsm"], then: ["premium"], message: "" },
      { id: "r2", kind: "excludes", when: ["sso"], then: ["audit"], message: "SSO already covers auditing." },
      { id: "r3", kind: "recommend", when: ["premium"], then: ["sso"], message: "Premium buyers want SSO." },
      { id: "r4", kind: "validate", when: ["premium"], then: [], expression: "quantity >= 25", message: "Premium starts at 25." },
    ],
  });

  test("requires names what is missing when no message was written", () => {
    expect(check(ruled, ["standard", "hsm"]).errors).toEqual(["Customer keys requires Premium."]);
  });

  test("excludes uses the message it was given", () => {
    expect(check(ruled, ["standard", "sso", "audit"]).errors).toContain("SSO already covers auditing.");
  });

  test("recommend warns without blocking", () => {
    const result = check(ruled, ["premium"], 30);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(["Premium buyers want SSO."]);
  });

  test("a validate rule only checks once its trigger is met", () => {
    expect(check(ruled, ["premium"], 10).errors).toContain("Premium starts at 25.");
    expect(check(ruled, ["premium"], 30).errors).toEqual([]);
    // Not Premium, so the rule is not asked at all.
    expect(check(ruled, ["standard"], 1).errors).toEqual([]);
  });
});

describe("price impact", () => {
  test("deltas add and factors multiply", () => {
    const result = check(product(), ["premium", "sso", "audit"]);
    expect(result.unitDelta).toBe(23);
    expect(result.unitFactor).toBe(1.5);
    expect(result.optionNames).toEqual(["Premium", "SSO", "Audit log"]);
  });

  test("selections are returned in group order, not click order", () => {
    // Two lines with the same options must read the same way on the quote.
    expect(check(product(), ["hsm", "standard", "sso"]).selected).toEqual(["standard", "sso", "hsm"]);
  });

  test("an option the product no longer has is dropped silently", () => {
    // The line was valid when it was written; a retired option is the
    // catalogue's change to explain, not this line's error.
    const result = check(product(), ["standard", "retired_option"]);
    expect(result.valid).toBe(true);
    expect(result.selected).toEqual(["standard"]);
  });
});

describe("toggling", () => {
  test("choosing in a radio group unchooses its siblings", () => {
    expect(toggleOption(product(), ["standard", "sso"], "premium", true).sort()).toEqual(["premium", "sso"]);
  });

  test("a checkbox group accumulates", () => {
    expect(toggleOption(product(), ["standard", "sso"], "audit", true).sort()).toEqual(["audit", "sso", "standard"]);
  });

  test("an unknown key changes nothing", () => {
    expect(toggleOption(product(), ["standard"], "nope", true)).toEqual(["standard"]);
  });

  test("optionIndex keeps the first definition of a duplicated key", () => {
    expect(optionIndex(product()).get("sso")?.group.name).toBe("Add-ons");
  });
});
