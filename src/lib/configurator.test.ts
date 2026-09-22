/**
 * Configuration rules decide what the business is willing to sell. These tests
 * are the shapes that come up: a required choice, a cardinality bound, a
 * dependency between options, and a formula over the line.
 */
import { describe, expect, test } from "bun:test";
import { availabilityOf, defaultSelection, optionIndex, toggleOption, validateConfiguration } from "./configurator";
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


describe("visibility", () => {
  /** A product whose second group is only asked of Premium buyers. */
  const conditional = (overrides: Partial<Product> = {}) =>
    product({
      optionGroups: [
        {
          id: "g1", key: "tier", name: "Tier", select: "one", required: true,
          options: [
            { id: "o1", key: "standard", name: "Standard", priceDelta: 0, default: true },
            { id: "o2", key: "premium", name: "Premium", priceDelta: 40 },
          ],
        },
        {
          id: "g2", key: "region", name: "Region", select: "one", required: true, visibleWhen: "option.premium",
          options: [
            { id: "o3", key: "eu", name: "EU", priceDelta: 0, default: true },
            { id: "o4", key: "us", name: "US", priceDelta: 5 },
          ],
        },
      ],
      ...overrides,
    });

  test("a hidden group is not required", () => {
    // Standard is never asked where its data lives, so it cannot fail to answer.
    expect(check(conditional(), ["standard"]).valid).toBe(true);
    expect(check(conditional(), ["premium"]).errors).toEqual(["Choose an option for “Region”."]);
  });

  test("a selection inside a hidden group is dropped rather than priced", () => {
    const result = check(conditional(), ["standard", "us"]);
    expect(result.valid).toBe(true);
    expect(result.selected).toEqual(["standard"]);
    expect(result.unitDelta).toBe(0);
    expect(result.visibleGroups).toEqual(["tier"]);
  });

  test("what is offered is reported, so the configurator can draw it", () => {
    const result = check(conditional(), ["premium", "us"]);
    expect(result.visibleGroups).toEqual(["tier", "region"]);
    expect(result.visibleOptions).toEqual(["standard", "premium", "eu", "us"]);
    expect(result.unitDelta).toBe(45);
  });

  test("an option can be hidden on its own", () => {
    const p = product({
      optionGroups: [
        {
          id: "g1", key: "support", name: "Support", select: "one", required: true,
          options: [
            { id: "o1", key: "business", name: "Business hours", priceDelta: 0, default: true },
            // Round-the-clock cover is only sold at scale.
            { id: "o2", key: "always_on", name: "24×7", priceDelta: 30, visibleWhen: "quantity >= 50" },
          ],
        },
      ],
    });
    expect(check(p, ["always_on"], 10).selected).toEqual([]);
    expect(check(p, ["always_on"], 50).selected).toEqual(["always_on"]);
  });

  test("a group whose options are all hidden is not asked at all", () => {
    const p = product({
      optionGroups: [
        {
          id: "g1", key: "extras", name: "Extras", select: "one", required: true,
          options: [{ id: "o1", key: "rush", name: "Rush delivery", priceDelta: 50, visibleWhen: "quantity <= 5" }],
        },
      ],
    });
    // A required question with no possible answer is not a question.
    expect(check(p, [], 40).valid).toBe(true);
    expect(check(p, [], 40).visibleGroups).toEqual([]);
  });

  test("hiding settles when one group hides another", () => {
    // Region is only asked of Premium, and the datacentre only of US — so
    // dropping Premium has to drop both, not just the first.
    const p = conditional();
    p.optionGroups.push({
      id: "g3", key: "dc", name: "Datacentre", select: "one", required: false, visibleWhen: "option.us",
      options: [{ id: "o5", key: "iad", name: "Virginia", priceDelta: 3 }],
    });
    const result = check(p, ["standard", "us", "iad"]);
    expect(result.selected).toEqual(["standard"]);
    expect(result.unitDelta).toBe(0);
  });

  test("a formula that will not run shows the group rather than hiding it", () => {
    // `readProduct` refuses one that does not parse, so this came from
    // outside — and half a catalogue quietly disappearing is the worse bug.
    const p = conditional();
    p.optionGroups[1]!.visibleWhen = "option.premium &&&";
    expect(check(p, ["standard"]).visibleGroups).toEqual(["tier", "region"]);
  });

  test("defaults are pruned to what the line is actually offered", () => {
    // EU is the default region, but Standard is never asked.
    expect(defaultSelection(conditional())).toEqual(["standard"]);

    const premiumFirst = conditional();
    premiumFirst.optionGroups[0]!.options[0]!.default = false;
    premiumFirst.optionGroups[0]!.options[1]!.default = true;
    // Chosen first, pruned after: a group shown *because* of a default keeps its own.
    expect(defaultSelection(premiumFirst)).toEqual(["premium", "eu"]);
  });
});

describe("quantity increments", () => {
  const packed = product({ minQuantity: 4, quantityIncrement: 4, name: "Storage" });

  test("a quantity has to be a whole number of packs, and the nearest is named", () => {
    expect(check(packed, ["standard"], 4).valid).toBe(true);
    expect(check(packed, ["standard"], 60).valid).toBe(true);
    expect(check(packed, ["standard"], 6).errors).toEqual([
      "Storage is sold in multiples of 4 — 6 is not one. The nearest is 8.",
    ]);
  });

  test("an increment of 0 or 1 is any number at all", () => {
    expect(check(product({ quantityIncrement: 1 }), ["standard"], 7).valid).toBe(true);
    expect(check(product(), ["standard"], 7).valid).toBe(true);
  });
});

describe("option costs", () => {
  test("costs add up the way prices do, and default to nothing", () => {
    const p = product();
    p.optionGroups[1]!.options[0]!.costDelta = 4;
    p.optionGroups[1]!.options[1]!.costDelta = 2;
    expect(check(p, ["standard", "sso", "audit"]).unitCostDelta).toBe(6);
    expect(check(p, ["standard"]).unitCostDelta).toBe(0);
  });
});

describe("availability", () => {
  const dated = (availableFrom?: string, availableTo?: string) =>
    ({ name: "Platform", availableFrom, availableTo }) as Product;

  test("no window is always available", () => {
    expect(availabilityOf(dated(), "2026-09-22").state).toBe("available");
  });

  test("the window's own days are inside it", () => {
    expect(availabilityOf(dated("2026-09-22", "2026-12-31"), "2026-09-22").state).toBe("available");
    expect(availabilityOf(dated("2026-01-01", "2026-09-22"), "2026-09-22").state).toBe("available");
  });

  test("before and after are said in a sentence a rep can act on", () => {
    expect(availabilityOf(dated("2026-10-01"), "2026-09-22")).toEqual({
      state: "early",
      message: "Platform is not available to quote until 2026-10-01.",
    });
    expect(availabilityOf(dated("", "2026-09-21"), "2026-09-22")).toEqual({
      state: "withdrawn",
      message: "Platform was withdrawn from the catalogue on 2026-09-21.",
    });
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
