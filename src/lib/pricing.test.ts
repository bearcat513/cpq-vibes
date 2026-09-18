/**
 * The pricing engine is the part of this app that is allowed to be wrong in
 * the most expensive way, so the tests below are written as the questions a
 * finance team would ask: does the total equal the lines, does a floor hold,
 * does a rule fire when it should and only then.
 */
import { describe, expect, test } from "bun:test";
import { expandBundle, periodsFor, priceQuote, tierFor, type PricingContext, type QuoteHeader } from "./pricing";
import type { PriceBook, PricingRule, Product, QuoteLineInput } from "./types";

/* -------------------------------- fixtures ------------------------------- */

const product = (overrides: Partial<Product> = {}): Product => ({
  id: "prd_platform",
  sku: "PLAT",
  name: "Platform",
  description: "",
  family: "Software",
  chargeType: "recurring",
  billingPeriod: "monthly",
  unitOfMeasure: "user",
  listPrice: 100,
  cost: 30,
  currency: "USD",
  active: true,
  minQuantity: 1,
  maxQuantity: 0,
  floorDiscountPercent: 20,
  optionGroups: [],
  rules: [],
  components: [],
  volumeTiers: [],
  attributes: {},
  ownerId: "u1",
  sharedWith: [],
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const line = (overrides: Partial<QuoteLineInput> = {}): QuoteLineInput => ({
  id: "ln_1",
  productId: "prd_platform",
  quantity: 10,
  discountPercent: 0,
  unitPriceOverride: null,
  selectedOptions: [],
  termMonths: 12,
  description: "",
  parentId: null,
  sortOrder: 0,
  ...overrides,
});

const header = (overrides: Partial<QuoteHeader> = {}): QuoteHeader => ({
  currency: "USD",
  termMonths: 12,
  discountPercent: 0,
  taxPercent: 0,
  shipping: 0,
  ...overrides,
});

const context = (products: Product[], rules: PricingRule[] = [], priceBook: PriceBook | null = null): PricingContext => ({
  products: new Map(products.map(entry => [entry.id, entry])),
  priceBook,
  rules,
});

const rule = (overrides: Partial<PricingRule> = {}): PricingRule => ({
  id: "rul_1",
  name: "Rule",
  description: "",
  scope: "line",
  condition: "",
  target: "discountPercent",
  expression: "10",
  appliesToFamily: "",
  appliesToSku: "",
  priority: 10,
  active: true,
  message: "",
  ownerId: "u1",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

/* --------------------------------- basics -------------------------------- */

describe("a line's price", () => {
  test("a monthly subscription is priced across the whole term", () => {
    const priced = priceQuote([line()], header(), context([product()]));
    const only = priced.lines[0]!;

    expect(only.periods).toBe(12);
    expect(only.unitPrice).toBe(100);
    // 100/user/month × 10 users × 12 months
    expect(only.netTotal).toBe(12_000);
    expect(only.monthlyRecurring).toBe(1_000);
    expect(only.annualRecurring).toBe(12_000);
    expect(only.oneTime).toBe(0);
  });

  test("a one-time product bills once, whatever the term says", () => {
    const setup = product({ id: "prd_setup", sku: "SETUP", chargeType: "one-time", listPrice: 2_500, cost: 1_000 });
    const priced = priceQuote(
      [line({ productId: "prd_setup", quantity: 1 })],
      header({ termMonths: 36 }),
      context([setup]),
    );

    expect(priced.lines[0]!.periods).toBe(1);
    expect(priced.lines[0]!.netTotal).toBe(2_500);
    expect(priced.totals.oneTimeTotal).toBe(2_500);
    expect(priced.totals.monthlyRecurringTotal).toBe(0);
  });

  test("annual billing over an 18-month term is a period and a half", () => {
    const annual = product({ billingPeriod: "annual", listPrice: 1_200 });
    const priced = priceQuote([line({ quantity: 1, termMonths: 18 })], header(), context([annual]));

    expect(priced.lines[0]!.periods).toBe(1.5);
    expect(priced.lines[0]!.netTotal).toBe(1_800);
  });

  test("margin comes off cost, not off list", () => {
    const priced = priceQuote([line({ discountPercent: 25 })], header(), context([product()]));
    const only = priced.lines[0]!;

    expect(only.netTotal).toBe(9_000); // 75 × 10 × 12
    expect(only.costTotal).toBe(3_600); // 30 × 10 × 12
    expect(only.margin).toBe(5_400);
    expect(only.marginPercent).toBe(60);
  });
});

/* -------------------------------- options -------------------------------- */

describe("configured options", () => {
  const configurable = product({
    optionGroups: [
      {
        id: "g1",
        key: "tier",
        name: "Tier",
        select: "one",
        required: true,
        options: [
          { id: "o1", key: "std", name: "Standard", priceDelta: 0, default: true },
          { id: "o2", key: "prem", name: "Premium", priceDelta: 0, priceFactor: 1.4 },
        ],
      },
      {
        id: "g2",
        key: "addons",
        name: "Add-ons",
        select: "many",
        required: false,
        options: [{ id: "o3", key: "sso", name: "SSO", priceDelta: 15 }],
      },
    ],
  });

  test("a factor scales the list price and a delta is added after it", () => {
    const priced = priceQuote(
      [line({ selectedOptions: ["prem", "sso"], quantity: 1, termMonths: 1 })],
      header(),
      context([configurable]),
    );
    const only = priced.lines[0]!;

    // 100 × 1.4 = 140, then +15 — not (100 + 15) × 1.4.
    expect(only.optionsUnitDelta).toBe(55);
    expect(only.unitPrice).toBe(155);
    expect(only.optionNames).toEqual(["Premium", "SSO"]);
  });

  test("the list baseline includes the options, so a discount is never negative", () => {
    // The bug this guards: with the baseline taken before options, a line
    // whose options add value reads as a *markup* — the quote's list total
    // lands below its own subtotal and "% off list" comes out negative.
    const priced = priceQuote(
      [line({ selectedOptions: ["prem", "sso"], quantity: 10, discountPercent: 20, termMonths: 1 })],
      header(),
      context([configurable]),
    );
    const only = priced.lines[0]!;

    // 100 × 1.4 + 15 = 155 at list, 124 after the 20% discount.
    expect(only.listUnitPrice).toBe(100);
    expect(only.listTotal).toBe(1_550);
    expect(only.unitPrice).toBe(124);
    expect(only.netTotal).toBe(1_240);
    expect(only.effectiveDiscountPercent).toBe(20);

    expect(priced.totals.listTotal).toBeGreaterThanOrEqual(priced.totals.subtotal);
    expect(priced.totals.effectiveDiscountPercent).toBe(20);
  });

  test("an invalid configuration prices, and says what is wrong", () => {
    const priced = priceQuote([line({ selectedOptions: [] })], header(), context([configurable]));

    expect(priced.lines[0]!.issues).toEqual(["Choose an option for “Tier”."]);
    expect(priced.issues.length).toBe(1);
    // It still produces a number: a rep needs to see the consequence of the
    // thing they have half-finished.
    expect(priced.lines[0]!.netTotal).toBe(12_000);
  });
});

/* -------------------------------- tiers ---------------------------------- */

describe("volume tiers", () => {
  const tiered = product({
    volumeTiers: [
      { minQuantity: 1, maxQuantity: 99, kind: "percent", value: 0 },
      { minQuantity: 100, maxQuantity: 499, kind: "percent", value: 10 },
      { minQuantity: 500, maxQuantity: null, kind: "override", value: 75 },
    ],
  });

  test("the band a quantity lands in sets the whole line's price", () => {
    const mid = priceQuote([line({ quantity: 200, termMonths: 1 })], header(), context([tiered]));
    expect(mid.lines[0]!.unitPrice).toBe(90);
    expect(mid.lines[0]!.netTotal).toBe(18_000);

    const top = priceQuote([line({ quantity: 500, termMonths: 1 })], header(), context([tiered]));
    expect(top.lines[0]!.unitPrice).toBe(75);
    expect(top.lines[0]!.tier?.kind).toBe("override");
  });

  test("tierFor treats a null upper bound as 'and above'", () => {
    expect(tierFor(tiered.volumeTiers, 10_000)?.value).toBe(75);
    expect(tierFor([], 10)).toBeNull();
  });

  test("periodsFor refuses to invent a term", () => {
    expect(periodsFor("recurring", "monthly", 0)).toBe(0);
    expect(periodsFor("usage", "monthly", 24)).toBe(1);
  });
});

/* ------------------------------ price books ------------------------------ */

describe("price books", () => {
  const book: PriceBook = {
    id: "pb_eu",
    name: "EU list",
    description: "",
    currency: "USD",
    isDefault: false,
    active: true,
    validFrom: "",
    validTo: "",
    entries: [{ sku: "PLAT", unitPrice: 80, minPrice: 60 }],
    ownerId: "u1",
    sharedWith: [],
    createdAt: "",
    updatedAt: "",
  };

  test("an entry replaces the catalogue price", () => {
    const priced = priceQuote([line({ termMonths: 1 })], header(), context([product()], [], book));
    expect(priced.lines[0]!.listUnitPrice).toBe(80);
    expect(priced.lines[0]!.netTotal).toBe(800);
  });

  test("nothing may price below the book's floor", () => {
    const priced = priceQuote([line({ discountPercent: 50, termMonths: 1 })], header(), context([product()], [], book));
    const only = priced.lines[0]!;

    expect(only.unitPrice).toBe(60); // 80 − 50% would be 40
    // A warning, not an error: the floor has already done its job, so the
    // quote is correct and sendable — the rep just needs to know their
    // discount did not land in full.
    expect(only.issues).toEqual([]);
    expect(only.warnings[0]).toContain("may not be sold below 60");
  });

  test("a quote in a currency the product is not priced in is refused, not guessed", () => {
    const priced = priceQuote([line()], header({ currency: "EUR" }), context([product()]));
    expect(priced.issues[0]).toContain("priced in USD and this quote is in EUR");
  });
});

/* ------------------------------ pricing rules ---------------------------- */

describe("pricing rules", () => {
  test("a condition decides whether a rule fires", () => {
    const volume = rule({
      name: "Volume break",
      condition: "quantity >= 100",
      target: "discountPercent",
      expression: "15",
      message: "100+ seats",
    });

    const small = priceQuote([line({ quantity: 10, termMonths: 1 })], header(), context([product()], [volume]));
    expect(small.lines[0]!.unitPrice).toBe(100);
    expect(small.lines[0]!.appliedRules).toEqual([]);

    const large = priceQuote([line({ quantity: 100, termMonths: 1 })], header(), context([product()], [volume]));
    expect(large.lines[0]!.unitPrice).toBe(85);
    expect(large.lines[0]!.appliedRules[0]).toMatchObject({ name: "Volume break", from: 0, to: 15 });
  });

  test("rules chain in priority order, each seeing the last one's work", () => {
    const rules = [
      rule({ id: "r2", name: "Second", priority: 20, target: "unitPrice", expression: "unitPrice - 10" }),
      rule({ id: "r1", name: "First", priority: 10, target: "unitPrice", expression: "unitPrice * 0.9" }),
    ];
    const priced = priceQuote([line({ quantity: 1, termMonths: 1 })], header(), context([product()], rules));

    // 100 × 0.9 = 90, then − 10 = 80. The other order would give 81.
    expect(priced.lines[0]!.unitPrice).toBe(80);
    expect(priced.lines[0]!.appliedRules.map(applied => applied.name)).toEqual(["First", "Second"]);
  });

  test("a rule scoped to another family leaves the line alone", () => {
    const services = rule({ appliesToFamily: "Services", expression: "50" });
    const priced = priceQuote([line({ termMonths: 1 })], header(), context([product()], [services]));
    expect(priced.lines[0]!.unitPrice).toBe(100);
  });

  test("a rule that does not parse is reported, not silently inert", () => {
    const broken = rule({ name: "Broken", expression: "quantity *" });
    const priced = priceQuote([line()], header(), context([product()], [broken]));
    expect(priced.warnings[0]).toContain("“Broken” was skipped");
  });

  test("a quote-scoped adjustment is not a negative discount", () => {
    const uplift = rule({ scope: "quote", target: "adjustment", expression: "500", name: "Onboarding uplift" });
    const priced = priceQuote([line({ termMonths: 1 })], header(), context([product()], [uplift]));

    expect(priced.totals.subtotal).toBe(1_000);
    expect(priced.totals.quoteDiscountAmount).toBe(0);
    expect(priced.totals.quoteAdjustment).toBe(500);
    expect(priced.totals.netTotal).toBe(1_500);
  });
});

/* -------------------------------- totals --------------------------------- */

describe("quote totals", () => {
  test("the total is the lines added up, and tax comes last", () => {
    const setup = product({ id: "prd_setup", sku: "SETUP", chargeType: "one-time", listPrice: 2_500, cost: 500 });
    const priced = priceQuote(
      [line({ quantity: 10, termMonths: 12 }), line({ id: "ln_2", productId: "prd_setup", quantity: 1, sortOrder: 1 })],
      header({ discountPercent: 10, taxPercent: 8.25, shipping: 100 }),
      context([product(), setup]),
    );

    const totals = priced.totals;
    expect(totals.subtotal).toBe(14_500); // 12,000 + 2,500
    expect(totals.quoteDiscountAmount).toBe(1_450);
    expect(totals.netTotal).toBe(13_050);
    expect(totals.taxAmount).toBe(1_084.88); // 8.25% of 13,150, half up
    expect(totals.grandTotal).toBe(14_234.88);
    expect(totals.totalContractValue).toBe(13_050);
  });

  test("the effective discount is what an approver actually reads", () => {
    const priced = priceQuote(
      [line({ quantity: 10, discountPercent: 20, termMonths: 1 })],
      header({ discountPercent: 10 }),
      context([product()]),
    );

    expect(priced.totals.listTotal).toBe(1_000);
    expect(priced.totals.netTotal).toBe(720); // 20% then 10%
    expect(priced.totals.effectiveDiscountPercent).toBe(28);
  });

  test("an empty quote totals to zero rather than to NaN", () => {
    const priced = priceQuote([], header({ taxPercent: 20 }), context([product()]));
    expect(priced.totals.grandTotal).toBe(0);
    expect(priced.totals.marginPercent).toBe(0);
    expect(priced.totals.effectiveDiscountPercent).toBe(0);
  });

  test("a deleted product does not take the quote down with it", () => {
    const priced = priceQuote([line({ unitPriceOverride: 42 })], header(), context([]));

    expect(priced.lines[0]!.name).toBe("Unknown product");
    expect(priced.lines[0]!.netTotal).toBe(420);
    expect(priced.issues[0]).toContain("no longer in the catalogue");
  });
});

/* -------------------------------- bundles -------------------------------- */

describe("bundles", () => {
  test("components arrive as their own lines, at their bundle discount", () => {
    const support = product({ id: "prd_support", sku: "SUPPORT", name: "Support", listPrice: 20 });
    const suite = product({
      id: "prd_suite",
      sku: "SUITE",
      components: [{ id: "c1", sku: "SUPPORT", quantity: 1, required: true, discountPercent: 50 }],
    });

    let counter = 0;
    const parent = line({ id: "ln_parent", productId: "prd_suite", quantity: 3, termMonths: 1 });
    const children = expandBundle(parent, suite, new Map([["SUPPORT", support]]), () => `ln_c${++counter}`);

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ productId: "prd_support", quantity: 3, discountPercent: 50, parentId: "ln_parent" });

    const priced = priceQuote([parent, ...children], header({ termMonths: 1 }), context([suite, support]));
    expect(priced.lines[1]!.netTotal).toBe(30); // 20 × 3 × 50% × 1 month
    expect(priced.totals.subtotal).toBe(330);
  });

  test("a component whose product is missing is skipped, not faked", () => {
    const suite = product({ id: "prd_suite", components: [{ id: "c1", sku: "GONE", quantity: 1, required: true }] });
    expect(expandBundle(line(), suite, new Map(), () => "x")).toEqual([]);
  });
});

/* -------------------------------- rounding ------------------------------- */

describe("rounding", () => {
  test("the total equals the visible lines, to the cent", () => {
    const odd = product({ listPrice: 33.333, cost: 0, chargeType: "one-time" });
    const priced = priceQuote(
      [line({ quantity: 3, termMonths: 0 }), line({ id: "ln_2", quantity: 3, sortOrder: 1 })],
      header(),
      context([odd]),
    );

    // Each line is 33.33 × 3 = 99.99, and the quote is the two of them.
    expect(priced.lines[0]!.netTotal).toBe(99.99);
    expect(priced.totals.subtotal).toBe(199.98);
  });

  test("a zero-decimal currency carries no decimals at all", () => {
    const yen = product({ listPrice: 1_234.5, currency: "JPY", chargeType: "one-time" });
    const priced = priceQuote([line({ quantity: 1 })], header({ currency: "JPY" }), context([yen]));
    expect(priced.lines[0]!.netTotal).toBe(1_235);
  });
});
