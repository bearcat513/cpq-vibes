/**
 * The healthcare sample, held to the validators, the pricing engine and the
 * workbook it came from. No PocketBase: everything here is pure, so a quote
 * that would not price fails here rather than at install time.
 */
import { describe, expect, test } from "bun:test";
import { evaluateApprovals } from "./approvals";
import { CATALOG_FILE_KIND, parseCatalogFile } from "./catalogFile";
import { priceQuote, type PriceableLine } from "./pricing";
import type { PriceBook, PricingRule, Product } from "./types";
import { readAccount, readApprovalRule, readPriceBook, readPricingRule, readProduct } from "./validate";
import {
  HEALTHCARE_ACCOUNTS,
  HEALTHCARE_PRICE_BOOKS,
  HEALTHCARE_PRICING_RULES,
  HEALTHCARE_PRODUCTS,
  HEALTHCARE_QUOTES,
  healthcareApprovalRules,
} from "./samplesHealthcare";

const stored = { ownerId: "u", sharedWith: [], createdAt: "", updatedAt: "" };

const products = HEALTHCARE_PRODUCTS.map(input => {
  const parsed = readProduct(input);
  if (!parsed.ok) throw new Error(`${input.sku}: ${parsed.error}`);
  return { ...parsed.value, ...stored, id: parsed.value.sku } as Product;
});
const bySku = new Map(products.map(product => [product.sku, product]));

const rules = HEALTHCARE_PRICING_RULES.map((input, index) => {
  const parsed = readPricingRule(input);
  if (!parsed.ok) throw new Error(`${input.name}: ${parsed.error}`);
  return { ...parsed.value, ...stored, id: `r${index}` } as PricingRule;
});

const books = new Map(
  HEALTHCARE_PRICE_BOOKS.map(input => {
    const parsed = readPriceBook(input);
    if (!parsed.ok) throw new Error(`${input.name}: ${parsed.error}`);
    return [parsed.value.name, { ...parsed.value, ...stored, id: parsed.value.name } as PriceBook];
  }),
);

function priced(name: string) {
  const quote = HEALTHCARE_QUOTES.find(one => one.name === name)!;
  const account = HEALTHCARE_ACCOUNTS.find(one => one.name === quote.accountName)!;
  const book = (account.priceBookName && books.get(account.priceBookName)) || books.get("Archive list")!;
  const lines: PriceableLine[] = quote.lines.map((line, index) => ({
    id: `l${index}`,
    productId: line.sku,
    quantity: line.quantity,
    discountPercent: line.discountPercent,
    unitPriceOverride: null,
    selectedOptions: [...line.options],
    termMonths: line.termMonths ?? 0,
    description: line.description ?? "",
    parentId: null,
    sortOrder: index,
  }));
  const header = { currency: "USD" as const, termMonths: quote.termMonths, discountPercent: quote.discountPercent ?? 0, taxPercent: 0, shipping: 0 };
  return { quote, result: priceQuote(lines, header, { products: new Map(products.map(one => [one.id, one])), priceBook: book, rules }) };
}

const lineOf = (name: string, sku: string) => priced(name).result.lines.find(line => line.sku === sku)!;

const RIVERBEND = "Riverbend - TruBridge sunset and A/R wind down";
const LAKESHORE = "Lakeshore - Q4 2026 Consolidation";
const PRAIRIE = "Prairie View - eClinicalWorks archive";
const BLUFF = "Bluff County - MEDITECH archive";
const CEDAR = "Cedar Valley - Managed Care Oversight";

describe("the catalogue", () => {
  test("every row of the workbook's Products sheet is here", () => {
    expect(products).toHaveLength(42);
    expect(new Set(products.map(product => product.sku)).size).toBe(42);
  });

  test("a block is a flat price for the range, at the workbook's numbers", () => {
    const price = (sku: string, key: string) => {
      const option = bySku.get(sku)!.optionGroups[0]!.options.find(one => one.key === key)!;
      return bySku.get(sku)!.listPrice + option.priceDelta;
    };
    expect(price("ARC-TBR-CPSI", "bed_1")).toBe(18_000);
    expect(price("ARC-TBR-CPSI", "bed_601")).toBe(185_000);
    expect(price("ARC-EPC", "bed_301")).toBe(150_000);
    expect(price("ARC-TBR-CPSI-CLN", "bed_26")).toBe(18_900);
    expect(price("ARC-TBR-CPSI-RCM", "bed_101")).toBe(35_100);
    expect(price("ARC-ECW", "provider_151")).toBe(88_000);
    expect(price("ADD-ARM", "bed_301")).toBe(84_000);
  });

  test("every other record passes the same validators an import does", () => {
    for (const input of HEALTHCARE_ACCOUNTS) expect(readAccount(input).ok).toBe(true);
    for (const input of healthcareApprovalRules("a@example.com")) expect(readApprovalRule(input).ok).toBe(true);
  });

  test("it survives export and re-import", () => {
    const parsed = parseCatalogFile({
      kind: CATALOG_FILE_KIND,
      version: 1,
      products: HEALTHCARE_PRODUCTS,
      priceBooks: HEALTHCARE_PRICE_BOOKS,
      pricingRules: HEALTHCARE_PRICING_RULES,
      approvalRules: healthcareApprovalRules("a@example.com"),
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("the quotes", () => {
  test("all of them price without a problem or a warning", () => {
    for (const quote of HEALTHCARE_QUOTES) {
      const { result } = priced(quote.name);
      expect(result.issues).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });

  test("a percent line's quantity is the list value of what it is a percentage of", () => {
    for (const quote of HEALTHCARE_QUOTES) {
      const { result } = priced(quote.name);
      for (const line of quote.lines) {
        if (!line.basis) continue;
        const basis = result.lines
          .filter(one => line.basis!.includes(one.sku))
          .reduce((total, one) => total + one.listTotal / (one.periods || 1), 0);
        expect(`${quote.name} ${line.sku} ${line.quantity}`).toBe(`${quote.name} ${line.sku} ${basis}`);
      }
    }
  });

  test("a parent named by a line is on the quote", () => {
    for (const quote of HEALTHCARE_QUOTES) {
      for (const line of quote.lines) {
        if (line.parentSku) expect(quote.lines.some(one => one.sku === line.parentSku)).toBe(true);
      }
    }
  });

  test("a contract book beats the catalogue, and the published tiers do not undo it", () => {
    expect(lineOf(RIVERBEND, "HST-HOT").unitPrice).toBe(240);
    expect(lineOf(LAKESHORE, "HST-HOT").listUnitPrice).toBe(325);
    expect(lineOf(PRAIRIE, "SUP-STD").unitPrice).toBe(0.16);
    expect(lineOf(LAKESHORE, "SVC-EXT-STD").listUnitPrice).toBe(19_500);
  });

  test("the automatic discounts land", () => {
    // 11-50 TB rate, then 8% for the 60-month term.
    expect(lineOf(LAKESHORE, "HST-HOT").unitPrice).toBe(253);
    // Five source systems.
    expect(lineOf(LAKESHORE, "SVC-EXT-STD").unitPrice).toBe(17_160);
    // The $15,000 credit, exactly.
    expect(lineOf(RIVERBEND, "ARC-TBR-CPSI").discountAmount).toBe(15_000);
  });

  test("a recurring line can run shorter than the quote", () => {
    expect(lineOf(RIVERBEND, "ADD-ARM").netTotal).toBe(126_000);
    expect(lineOf(RIVERBEND, "SUP-STD").netTotal).toBe(146_475);
  });

  test("each quote climbs the ladder as far as its stage needs", () => {
    const required = (name: string) => {
      const { result, quote } = priced(name);
      const floorByLineId = new Map(result.lines.map(line => [line.id, bySku.get(line.sku)!.floorDiscountPercent]));
      const approvals = healthcareApprovalRules("a@example.com").map((rule, index) => {
        const parsed = readApprovalRule(rule);
        if (!parsed.ok) throw new Error(parsed.error);
        return { ...parsed.value, ...stored, id: `a${index}` };
      });
      const outcome = evaluateApprovals(
        { totals: result.totals, lines: result.lines, termMonths: quote.termMonths, floorByLineId },
        approvals as never,
      );
      return outcome.required.map(request => request.level);
    };

    // Auto-approved: nothing to walk before they go out.
    expect(required(RIVERBEND)).toEqual([]);
    expect(required(PRAIRIE)).toEqual([]);
    expect(required(CEDAR)).toEqual([]);
    // VP only, and left waiting.
    expect(new Set(required(BLUFF))).toEqual(new Set([1]));
    // VP then CRO, walked to approved.
    expect(new Set(required(LAKESHORE))).toEqual(new Set([1, 2]));
  });
});
