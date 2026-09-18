/**
 * Exports: a quote or a catalogue as a file somebody else's software can read.
 *
 * CSV is written for the place these actually go — a spreadsheet — which means
 * one row per line item, money as bare numbers rather than formatted strings,
 * and the currency in its own column. A CSV with `$1,234.56` in a cell is a
 * CSV that sums to zero, and that is the whole reason anyone opened it.
 *
 * JSON is the quote as this app holds it, which is the shape the API returns
 * and the shape the workspace export embeds.
 */
import { formatMoney } from "../lib/money";
import type { Product, Quote } from "../lib/types";

type Row = Record<string, unknown>;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  // Union of keys, so a sparse first row cannot truncate the header.
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return [
    headers.map(csvCell).join(","),
    ...rows.map(row => headers.map(header => csvCell(row[header])).join(",")),
  ].join("\n");
}

export const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

/* --------------------------------- quotes -------------------------------- */

/**
 * One row per line, with the quote's own fields repeated on each.
 *
 * Repeated rather than split across two files or a header block: a flat table
 * is what a pivot table, a BI tool and a finance team all expect, and the
 * repetition costs nothing next to being able to group by customer.
 */
export function quoteRows(quote: Quote): Row[] {
  return quote.lines.map((line, index) => ({
    quote: quote.number,
    quoteName: quote.name,
    status: quote.status,
    version: quote.version,
    customer: quote.customer.name,
    contact: quote.customer.contactEmail,
    currency: quote.currency,
    validUntil: quote.validUntil,
    lineNumber: index + 1,
    sku: line.sku,
    product: line.name,
    family: line.family,
    options: line.optionNames.join("; "),
    description: line.description,
    chargeType: line.chargeType,
    billingPeriod: line.chargeType === "recurring" ? line.billingPeriod : "",
    termMonths: line.termMonths,
    periods: line.periods,
    quantity: line.quantity,
    unitOfMeasure: line.unitOfMeasure,
    listUnitPrice: line.listUnitPrice,
    optionsUnitDelta: line.optionsUnitDelta,
    unitPrice: line.unitPrice,
    discountPercent: line.effectiveDiscountPercent,
    listTotal: line.listTotal,
    discountAmount: line.discountAmount,
    netTotal: line.netTotal,
    unitCost: line.unitCost,
    costTotal: line.costTotal,
    margin: line.margin,
    marginPercent: line.marginPercent,
    monthlyRecurring: line.monthlyRecurring,
    appliedRules: line.appliedRules.map(applied => applied.name).join("; "),
  }));
}

/** The quote, whole — header, lines, totals and approvals. */
export const quoteJson = (quote: Quote): string => toJson(quote);

/* ------------------------------- catalogue ------------------------------- */

/**
 * The catalogue as a spreadsheet: one row per product, with the nested parts
 * flattened to something readable rather than to JSON in a cell.
 *
 * This is the export for a person; `*.cpq.json` is the export for the app, and
 * it is the one that round-trips. A catalogue edited in Excel and pasted back
 * is not a thing this file pretends to support.
 */
export function productRows(products: Product[]): Row[] {
  return products.map(product => ({
    sku: product.sku,
    name: product.name,
    family: product.family,
    description: product.description,
    chargeType: product.chargeType,
    billingPeriod: product.chargeType === "recurring" ? product.billingPeriod : "",
    unitOfMeasure: product.unitOfMeasure,
    currency: product.currency,
    listPrice: product.listPrice,
    cost: product.cost,
    marginPercent: product.listPrice ? Math.round(((product.listPrice - product.cost) / product.listPrice) * 1000) / 10 : 0,
    active: product.active,
    minQuantity: product.minQuantity,
    maxQuantity: product.maxQuantity || "",
    floorDiscountPercent: product.floorDiscountPercent,
    optionGroups: product.optionGroups.map(group => `${group.name} (${group.options.length})`).join("; "),
    options: product.optionGroups.flatMap(group => group.options.map(option => option.name)).join("; "),
    configurationRules: product.rules.length,
    bundleComponents: product.components.map(component => `${component.sku}×${component.quantity}`).join("; "),
    volumeTiers: product.volumeTiers
      .map(tier => `${tier.minQuantity}-${tier.maxQuantity ?? "∞"}: ${tier.kind} ${tier.value}`)
      .join("; "),
    attributes: Object.entries(product.attributes)
      .map(([key, value]) => `${key}=${value}`)
      .join("; "),
  }));
}

/* ------------------------------- responses ------------------------------- */

const safeName = (name: string, fallback: string) =>
  name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || fallback;

export function fileResponse(body: string, contentType: string, fileName: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

export function exportResponse(rows: Row[], format: "csv" | "json", baseName: string, whole?: unknown): Response {
  const name = safeName(baseName, "export");
  return format === "csv"
    ? fileResponse(toCsv(rows), "text/csv; charset=utf-8", `${name}.csv`)
    : fileResponse(toJson(whole ?? rows), "application/json; charset=utf-8", `${name}.json`);
}

/** A one-line summary for a log or a flash message. */
export const describeQuote = (quote: Quote): string =>
  `${quote.number} · ${quote.customer.name || "no customer"} · ${formatMoney(quote.totals.grandTotal, quote.currency)}`;
