/**
 * The portable catalogue file: `*.cpq.json`.
 *
 * One self-contained JSON document holding products, price books, pricing
 * rules and approval rules — everything that decides what a quote costs,
 * without a single quote in it. It is meant to live in a repository next to
 * the code that depends on it: a catalogue is a commercial decision, it is
 * reviewed, and it should be diffable when it changes.
 *
 * That shapes two choices:
 *
 * **Records are identified by SKU and name, never by internal id.** Ids are
 * stripped on export and minted fresh on import, so the same catalogue
 * exported from two instances produces the same bytes, and a bundle that
 * references `SUPPORT` still finds it after a round trip.
 *
 * **Nothing is stored until all of it validates.** An import that would
 * half-apply — twelve products in, the thirteenth rejected — leaves a
 * catalogue nobody can reason about. `parseCatalogFile` checks the entire
 * document first and either hands back the whole thing or one sentence
 * explaining which part stopped it.
 */
import {
  readApprovalRule,
  readPriceBook,
  readPricingRule,
  readProduct,
  type ApprovalRuleInput,
  type PriceBookInput,
  type PricingRuleInput,
  type ProductInput,
} from "./validate";
import type { ApprovalRule, PriceBook, PricingRule, Product } from "./types";

export const CATALOG_FILE_KIND = "cpq/catalog";
export const CATALOG_FILE_VERSION = 1;

export type CatalogFile = {
  kind: typeof CATALOG_FILE_KIND;
  version: number;
  name: string;
  exportedAt: string;
  products: ProductInput[];
  priceBooks: PriceBookInput[];
  pricingRules: PricingRuleInput[];
  approvalRules: ApprovalRuleInput[];
};

export type ParsedCatalog = {
  name: string;
  products: ProductInput[];
  priceBooks: PriceBookInput[];
  pricingRules: PricingRuleInput[];
  approvalRules: ApprovalRuleInput[];
  /** Things worth knowing that did not stop the import. */
  warnings: string[];
};

export type ParseResult = { ok: true; catalog: ParsedCatalog } | { ok: false; error: string };

/* -------------------------------- export --------------------------------- */

/** Drops everything instance-specific: ids, ownership, timestamps. */
const portableProduct = (product: Product): ProductInput => ({
  sku: product.sku,
  name: product.name,
  description: product.description,
  family: product.family,
  chargeType: product.chargeType,
  billingPeriod: product.billingPeriod,
  unitOfMeasure: product.unitOfMeasure,
  listPrice: product.listPrice,
  cost: product.cost,
  currency: product.currency,
  active: product.active,
  minQuantity: product.minQuantity,
  maxQuantity: product.maxQuantity,
  floorDiscountPercent: product.floorDiscountPercent,
  optionGroups: product.optionGroups,
  rules: product.rules,
  components: product.components,
  volumeTiers: product.volumeTiers,
  attributes: product.attributes,
});

const portablePriceBook = (book: PriceBook): PriceBookInput => ({
  name: book.name,
  description: book.description,
  currency: book.currency,
  isDefault: book.isDefault,
  active: book.active,
  validFrom: book.validFrom,
  validTo: book.validTo,
  entries: book.entries,
});

const portablePricingRule = (rule: PricingRule): PricingRuleInput => ({
  name: rule.name,
  description: rule.description,
  scope: rule.scope,
  condition: rule.condition,
  target: rule.target,
  expression: rule.expression,
  appliesToFamily: rule.appliesToFamily,
  appliesToSku: rule.appliesToSku,
  priority: rule.priority,
  active: rule.active,
  message: rule.message,
});

const portableApprovalRule = (rule: ApprovalRule): ApprovalRuleInput => ({
  name: rule.name,
  scope: rule.scope,
  metric: rule.metric,
  comparator: rule.comparator,
  threshold: rule.threshold,
  condition: rule.condition,
  level: rule.level,
  approvers: rule.approvers,
  approvalsRequired: rule.approvalsRequired,
  rejectionsRequired: rule.rejectionsRequired,
  message: rule.message,
  active: rule.active,
});

export type CatalogExportInput = {
  name?: string;
  products?: Product[];
  priceBooks?: PriceBook[];
  pricingRules?: PricingRule[];
  approvalRules?: ApprovalRule[];
};

export function buildCatalogFile(input: CatalogExportInput): CatalogFile {
  return {
    kind: CATALOG_FILE_KIND,
    version: CATALOG_FILE_VERSION,
    name: input.name ?? "Catalogue",
    exportedAt: new Date().toISOString(),
    products: (input.products ?? []).map(portableProduct),
    priceBooks: (input.priceBooks ?? []).map(portablePriceBook),
    pricingRules: (input.pricingRules ?? []).map(portablePricingRule),
    approvalRules: (input.approvalRules ?? []).map(portableApprovalRule),
  };
}

export const serializeCatalogFile = (input: CatalogExportInput): string =>
  JSON.stringify(buildCatalogFile(input), null, 2);

/** "Hardware catalogue" -> "hardware-catalogue.cpq.json" */
export function catalogFileName(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "catalog";
  return `${slug}.cpq.json`;
}

/* -------------------------------- import --------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Reads a catalogue file.
 *
 * `kind` and `version` are optional: a hand-written file with nothing but a
 * `products` array is a perfectly good catalogue, and demanding an envelope
 * would make the format harder to produce than to consume. A file from a
 * *newer* version is refused, because the only honest thing to say about a
 * format this code has not seen is that it has not seen it.
 */
export function parseCatalogFile(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, error: "That file is not a JSON object." };

  if (raw.kind !== undefined && raw.kind !== CATALOG_FILE_KIND) {
    return { ok: false, error: `This is a "${String(raw.kind)}" file, not a ${CATALOG_FILE_KIND} file.` };
  }

  const version = Number(raw.version ?? CATALOG_FILE_VERSION);
  if (Number.isFinite(version) && version > CATALOG_FILE_VERSION) {
    return {
      ok: false,
      error: `This file is version ${version}; this app understands up to ${CATALOG_FILE_VERSION}.`,
    };
  }

  const warnings: string[] = [];

  /* --- products --- */

  const rawProducts = Array.isArray(raw.products) ? raw.products : raw.product ? [raw.product] : [];
  const products: ProductInput[] = [];
  const skus = new Set<string>();

  for (const [index, entry] of rawProducts.entries()) {
    const parsed = readProduct(entry);
    if (!parsed.ok) return { ok: false, error: `Product ${index + 1}: ${parsed.error}` };
    if (skus.has(parsed.value.sku)) {
      return { ok: false, error: `Two products share the SKU ${parsed.value.sku}; a SKU identifies one product.` };
    }
    skus.add(parsed.value.sku);
    products.push(parsed.value);
  }

  /* --- price books --- */

  const priceBooks: PriceBookInput[] = [];
  for (const [index, entry] of (Array.isArray(raw.priceBooks) ? raw.priceBooks : []).entries()) {
    const parsed = readPriceBook(entry);
    if (!parsed.ok) return { ok: false, error: `Price book ${index + 1}: ${parsed.error}` };
    priceBooks.push(parsed.value);
  }

  /* --- rules --- */

  const pricingRules: PricingRuleInput[] = [];
  for (const [index, entry] of (Array.isArray(raw.pricingRules) ? raw.pricingRules : []).entries()) {
    const parsed = readPricingRule(entry);
    if (!parsed.ok) return { ok: false, error: `Pricing rule ${index + 1}: ${parsed.error}` };
    pricingRules.push(parsed.value);
  }

  const approvalRules: ApprovalRuleInput[] = [];
  for (const [index, entry] of (Array.isArray(raw.approvalRules) ? raw.approvalRules : []).entries()) {
    const parsed = readApprovalRule(entry);
    if (!parsed.ok) return { ok: false, error: `Approval rule ${index + 1}: ${parsed.error}` };
    approvalRules.push(parsed.value);
  }

  if (!products.length && !priceBooks.length && !pricingRules.length && !approvalRules.length) {
    return { ok: false, error: "There is nothing in this file to import." };
  }

  /* --- cross-references, which warn rather than refuse --- */

  // A bundle or a price-book entry may legitimately point at a SKU that is
  // already in the catalogue and not in this file, so a dangling reference is
  // reported rather than rejected.
  for (const product of products) {
    for (const component of product.components) {
      if (!skus.has(component.sku)) {
        warnings.push(`${product.sku} bundles ${component.sku}, which is not in this file.`);
      }
    }
  }

  for (const book of priceBooks) {
    const missing = book.entries.filter(entry => !skus.has(entry.sku)).map(entry => entry.sku);
    if (missing.length) {
      warnings.push(
        `Price book "${book.name}" prices ${missing.length} SKU${missing.length === 1 ? "" : "s"} not in this file` +
          ` (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}).`,
      );
    }
  }

  const defaults = priceBooks.filter(book => book.isDefault);
  if (defaults.length > 1) {
    warnings.push(`${defaults.length} price books are marked default; the last one imported will win.`);
  }

  return {
    ok: true,
    catalog: {
      name: String(raw.name ?? "Catalogue").trim().slice(0, 200) || "Catalogue",
      products,
      priceBooks,
      pricingRules,
      approvalRules,
      warnings,
    },
  };
}
