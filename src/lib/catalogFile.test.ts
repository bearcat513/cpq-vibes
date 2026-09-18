/**
 * The catalogue file is meant to live in a repository and be reviewed, so the
 * two properties that matter are that it round-trips exactly and that a bad
 * file is refused whole rather than half-applied.
 */
import { describe, expect, test } from "bun:test";
import { CATALOG_FILE_KIND, buildCatalogFile, catalogFileName, parseCatalogFile, serializeCatalogFile } from "./catalogFile";
import { SAMPLE_PRICE_BOOKS, SAMPLE_PRICING_RULES, SAMPLE_PRODUCTS, sampleApprovalRules } from "./samples";
import type { Product } from "./types";

const product = (overrides: Record<string, unknown> = {}) => ({
  sku: "PLAT",
  name: "Platform",
  listPrice: 100,
  cost: 30,
  currency: "USD",
  chargeType: "recurring",
  billingPeriod: "monthly",
  ...overrides,
});

const file = (overrides: Record<string, unknown> = {}) => ({
  kind: CATALOG_FILE_KIND,
  version: 1,
  products: [product()],
  ...overrides,
});

describe("reading a file", () => {
  test("a minimal hand-written file is accepted", () => {
    // No envelope at all — just the products. Demanding `kind` would make the
    // format harder to produce than to consume.
    const result = parseCatalogFile({ products: [product()] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.catalog.products[0]!.sku).toBe("PLAT");
  });

  test("defaults are filled in so a partial product is complete", () => {
    const result = parseCatalogFile({ products: [{ sku: "x", name: "X" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const only = result.catalog.products[0]!;
    expect(only.sku).toBe("X");
    expect(only.active).toBe(true);
    expect(only.unitOfMeasure).toBe("unit");
    expect(only.optionGroups).toEqual([]);
  });

  test("unknown keys are dropped rather than stored", () => {
    const result = parseCatalogFile({ products: [{ ...product(), mischief: "hello" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.catalog.products[0]).not.toHaveProperty("mischief");
  });

  test("a file from a newer version is refused", () => {
    const result = parseCatalogFile(file({ version: 99 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("version 99");
  });

  test("a file of the wrong kind is refused", () => {
    const result = parseCatalogFile({ kind: "something/else", products: [] });
    expect(result.ok).toBe(false);
  });

  test("an empty file says so", () => {
    const result = parseCatalogFile({ kind: CATALOG_FILE_KIND, products: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nothing in this file");
  });
});

describe("what it refuses", () => {
  test("two products claiming one SKU", () => {
    const result = parseCatalogFile(file({ products: [product(), product({ name: "Other" })] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("share the SKU");
  });

  test("a product with no SKU, and one with an unusable SKU", () => {
    expect(parseCatalogFile({ products: [{ name: "Nameless" }] }).ok).toBe(false);
    const bad = parseCatalogFile({ products: [{ name: "X", sku: "a/b c" }] });
    expect(bad.ok).toBe(false);
  });

  test("a rule pointing at an option that does not exist", () => {
    const result = parseCatalogFile(
      file({
        products: [
          {
            ...product(),
            optionGroups: [{ key: "t", name: "Tier", select: "one", options: [{ key: "std", name: "Standard" }] }],
            rules: [{ kind: "requires", when: ["std"], then: ["ghost"] }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("option that does not exist");
  });

  test("a validation formula that will not parse", () => {
    const result = parseCatalogFile(
      file({
        products: [{ ...product(), rules: [{ kind: "validate", when: [], expression: "quantity >" }] }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("a price book floor above its own price, and a duplicated SKU in one book", () => {
    expect(
      parseCatalogFile(file({ priceBooks: [{ name: "B", entries: [{ sku: "PLAT", unitPrice: 50, minPrice: 80 }] }] })).ok,
    ).toBe(false);

    expect(
      parseCatalogFile(
        file({ priceBooks: [{ name: "B", entries: [{ sku: "PLAT", unitPrice: 50 }, { sku: "PLAT", unitPrice: 60 }] }] }),
      ).ok,
    ).toBe(false);
  });

  test("a pricing rule referencing a variable its scope does not have", () => {
    const result = parseCatalogFile(
      file({ pricingRules: [{ name: "R", scope: "quote", target: "discountPercent", expression: "unitPrice * 2" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown variable");
  });

  test("an approval rule with no approver", () => {
    const result = parseCatalogFile(file({ approvalRules: [{ name: "Nobody", metric: "discountPercent" }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("approver");
  });
});

describe("what it warns about", () => {
  test("a bundle or price book naming a SKU that is not in the file", () => {
    // Legitimate — the SKU may already be in the catalogue — so it is a
    // warning, not a refusal.
    const result = parseCatalogFile(
      file({
        products: [{ ...product(), components: [{ sku: "ELSEWHERE", quantity: 1 }] }],
        priceBooks: [{ name: "B", entries: [{ sku: "ALSO-ELSEWHERE", unitPrice: 1 }] }],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.warnings.join(" ")).toContain("ELSEWHERE");
    expect(result.catalog.warnings.join(" ")).toContain("ALSO-ELSEWHERE");
  });
});

describe("round trip", () => {
  test("the sample catalogue survives export and re-import unchanged", () => {
    // The sample exercises every feature the format has to carry: options,
    // configuration rules, tiers, bundles and both kinds of policy.
    const parsed = parseCatalogFile({
      kind: CATALOG_FILE_KIND,
      version: 1,
      products: SAMPLE_PRODUCTS,
      priceBooks: SAMPLE_PRICE_BOOKS,
      pricingRules: SAMPLE_PRICING_RULES,
      approvalRules: sampleApprovalRules("approver@example.com"),
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.catalog.products).toHaveLength(SAMPLE_PRODUCTS.length);
    expect(parsed.catalog.warnings).toEqual([]);

    const again = parseCatalogFile(JSON.parse(JSON.stringify({ kind: CATALOG_FILE_KIND, version: 1, ...parsed.catalog })));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.catalog.products).toEqual(parsed.catalog.products);
  });

  test("ids are stripped on export, so the file stays diffable", () => {
    const built = buildCatalogFile({
      products: [{ ...product(), id: "prd_1", ownerId: "u1", sharedWith: [], createdAt: "x", updatedAt: "y" } as unknown as Product],
    });

    expect(built.products[0]).not.toHaveProperty("id");
    expect(built.products[0]).not.toHaveProperty("ownerId");
    expect(serializeCatalogFile({ products: [] })).toContain(CATALOG_FILE_KIND);
  });

  test("file names are slugged", () => {
    expect(catalogFileName("Hardware catalogue")).toBe("hardware-catalogue.cpq.json");
    expect(catalogFileName("")).toBe("catalog.cpq.json");
  });
});
