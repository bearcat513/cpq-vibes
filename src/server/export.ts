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
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  agingBucketFor,
  daysOverdue,
  invoiceStatus,
  today,
  type AgingReport,
} from "../lib/receivable";
import type { Invoice, InvoiceCredit, InvoicePayment, InvoiceSummary, Product, Quote } from "../lib/types";

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

/* ------------------------------ receivables ------------------------------ */

/**
 * One row per invoice, with its derived condition worked out here.
 *
 * `status` and `daysOverdue` are not stored anywhere — see
 * src/lib/receivable.ts for why — so an export that left them out would hand
 * a finance team a spreadsheet they had to re-derive the whole point of.
 */
export function invoiceRows(invoices: (Invoice | InvoiceSummary)[], asOf: string = today()): Row[] {
  return invoices.map(invoice => ({
    invoice: invoice.number,
    quote: invoice.quoteNumber,
    customer: invoice.customer.name,
    contact: invoice.customer.contactEmail,
    poNumber: invoice.poNumber,
    currency: invoice.currency,
    state: invoice.state,
    status: invoiceStatus(invoice, asOf),
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    paymentTermDays: invoice.paymentTermDays,
    daysOverdue: daysOverdue(invoice, asOf),
    agingBucket: agingBucketFor(daysOverdue(invoice, asOf)),
    subtotal: invoice.totals.subtotal,
    tax: invoice.totals.taxAmount,
    total: invoice.totals.total,
    paid: invoice.totals.paidAmount,
    credited: invoice.totals.creditedAmount,
    balance: invoice.totals.balance,
  }));
}

/** One row per line, for an invoice being reconciled line by line. */
export function invoiceLineRows(invoice: Invoice): Row[] {
  return invoice.lines.map((line, index) => ({
    invoice: invoice.number,
    customer: invoice.customer.name,
    currency: invoice.currency,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lineNumber: index + 1,
    sku: line.sku,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    amount: line.amount,
    taxPercent: line.taxPercent,
    taxAmount: line.taxAmount,
  }));
}

/**
 * Cash received, one row per payment.
 *
 * The report a bank reconciliation is done against, which is why the
 * reference is a column of its own: it is the only thing tying a row here to
 * a line on a statement.
 */
export function paymentRows(payments: InvoicePayment[], invoices: InvoiceSummary[] = []): Row[] {
  const byId = new Map(invoices.map(invoice => [invoice.id, invoice]));

  return payments.map(payment => {
    const invoice = byId.get(payment.invoiceId);
    return {
      receivedOn: payment.receivedOn,
      invoice: invoice?.number ?? payment.invoiceId,
      customer: invoice?.customer.name ?? "",
      currency: invoice?.currency ?? "",
      amount: payment.amount,
      method: payment.method,
      reference: payment.reference,
      note: payment.note,
      recordedOn: payment.createdAt.slice(0, 10),
    };
  });
}

/** Credits and write-offs, one row each. What was given away, and why. */
export function creditRows(credits: InvoiceCredit[], invoices: InvoiceSummary[] = []): Row[] {
  const byId = new Map(invoices.map(invoice => [invoice.id, invoice]));

  return credits.map(credit => {
    const invoice = byId.get(credit.invoiceId);
    return {
      issuedOn: credit.issuedOn,
      invoice: invoice?.number ?? credit.invoiceId,
      customer: invoice?.customer.name ?? "",
      currency: invoice?.currency ?? "",
      amount: credit.amount,
      reason: credit.reason,
      note: credit.note,
      recordedOn: credit.createdAt.slice(0, 10),
    };
  });
}

/**
 * The aging report as a spreadsheet: one row per bucket, then a total.
 *
 * A total row in a CSV is usually a mistake — it breaks every pivot table —
 * but an aging report is read as a report rather than pivoted, and the number
 * everybody wants first is the one at the bottom.
 */
export function agingRows(report: AgingReport): Row[] {
  return [
    ...AGING_BUCKETS.map(bucket => ({
      bucket: AGING_BUCKET_LABELS[bucket],
      invoices: report.buckets[bucket].count,
      amount: report.buckets[bucket].amount,
      currency: report.currency,
      asOf: report.asOf,
    })),
    {
      bucket: "Total outstanding",
      invoices: report.invoiceCount,
      amount: report.outstanding,
      currency: report.currency,
      asOf: report.asOf,
    },
  ];
}

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
    quantityIncrement: (product.quantityIncrement ?? 0) > 1 ? product.quantityIncrement : "",
    availableFrom: product.availableFrom ?? "",
    availableTo: product.availableTo ?? "",
    floorDiscountPercent: product.floorDiscountPercent,
    optionGroups: product.optionGroups
      .map(group => `${group.name} (${group.options.length})${group.visibleWhen ? ` when ${group.visibleWhen}` : ""}`)
      .join("; "),
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

export const describeInvoice = (invoice: Invoice): string =>
  `${invoice.number} · ${invoice.customer.name || "no customer"} · ` +
  `${formatMoney(invoice.totals.balance, invoice.currency)} of ${formatMoney(invoice.totals.total, invoice.currency)} outstanding`;
