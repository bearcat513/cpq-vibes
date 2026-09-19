/**
 * Turning a quote into the document a customer reads.
 *
 * This is one of the app's two token vocabularies — `{{quote.number}}`,
 * `{{customer.name}}`, `{{totals.grandTotal}}` — and what it means to resolve
 * them against a quote. The substituting itself, the escaping and the
 * repeating line block belong to `src/lib/document.ts`, which both
 * vocabularies share; the other is `src/lib/invoiceDocument.ts`.
 *
 * Why this and not a PDF library: a proposal is something people want to edit
 * — drop it into a letterhead, paste it into an email, hand it to a designer.
 * Text out is a document anyone can take somewhere else; a rendered PDF is a
 * dead end with a dependency attached. (A `pdf` template exists too, and is
 * drawn by src/lib/pdfTemplate.ts from the same tokens.)
 */
import {
  LINE_TABLE_TOKEN,
  formatAddress,
  formatTable,
  renderTemplate,
  type DocumentSource,
  type RenderResult,
  type TokenDescription,
} from "./document";
import { formatMoney, formatPercent } from "./money";
import type { CurrencyCode, PricedLine, ProposalFormat, Quote } from "./types";

export type ProposalContext = {
  quote: Quote;
  /** Who is sending it — the signed-in account. */
  sellerName: string;
  sellerEmail: string;
  /** Formatting locale for money and dates; the browser's, or the server's. */
  locale?: string;
};

/* ------------------------------ the tokens ------------------------------- */

/**
 * Every token a quote template may use, with the sentence the editor shows
 * beside it. This list is the contract: it is what the token picker offers,
 * what the API index documents, and what `resolve` below is built from.
 */
export const PROPOSAL_TOKENS: TokenDescription[] = [
  { token: "quote.number", description: "The quote's reference, e.g. Q-2026-0007" },
  { token: "quote.name", description: "What the quote is called" },
  { token: "quote.version", description: "Revision number" },
  { token: "quote.status", description: "Where it is in its life" },
  { token: "quote.date", description: "The day it was created" },
  { token: "quote.validUntil", description: "The day the pricing expires" },
  { token: "quote.termMonths", description: "Subscription length in months" },
  { token: "quote.currency", description: "Currency code" },
  { token: "quote.notes", description: "The customer-facing note on the quote" },
  { token: "customer.name", description: "The account's name" },
  { token: "customer.contactName", description: "Who it is addressed to" },
  { token: "customer.contactTitle", description: "Their job title" },
  { token: "customer.contactEmail", description: "Their email address" },
  { token: "customer.contactPhone", description: "Their phone number" },
  { token: "customer.address", description: "Billing address, one line per part" },
  { token: "customer.shippingAddress", description: "Where it ships, one line per part" },
  { token: "customer.paymentTerms", description: "Payment terms, e.g. Net 30" },
  { token: "seller.name", description: "Your name" },
  { token: "seller.email", description: "Your email address" },
  { token: LINE_TABLE_TOKEN, description: "Every line as a table, in this template's format" },
  { token: "totals.listTotal", description: "Everything at list price" },
  { token: "totals.subtotal", description: "After line discounts" },
  { token: "totals.discount", description: "Every discount, as one amount" },
  { token: "totals.discountPercent", description: "The effective discount off list" },
  { token: "totals.shipping", description: "Shipping" },
  { token: "totals.tax", description: "Tax" },
  { token: "totals.grandTotal", description: "What the customer pays" },
  { token: "totals.mrr", description: "Monthly recurring revenue" },
  { token: "totals.arr", description: "Annual recurring revenue" },
  { token: "totals.tcv", description: "Total contract value over the term" },
  { token: "totals.oneTime", description: "Non-recurring charges" },
];

/** Tokens usable inside `{{#lines}}…{{/lines}}`. */
export const LINE_TOKENS: TokenDescription[] = [
  { token: "line.number", description: "1, 2, 3 — its position on the quote" },
  { token: "line.sku", description: "Catalogue SKU" },
  { token: "line.name", description: "Product name" },
  { token: "line.description", description: "The line note, or the catalogue description" },
  { token: "line.options", description: "Selected options, comma separated" },
  { token: "line.quantity", description: "How many" },
  { token: "line.unitOfMeasure", description: "What one is, e.g. user" },
  { token: "line.listPrice", description: "Unit price before discounts" },
  { token: "line.unitPrice", description: "Unit price charged" },
  { token: "line.discountPercent", description: "Discount on the line" },
  { token: "line.term", description: "This line's term in months" },
  { token: "line.billing", description: "How it is billed" },
  { token: "line.total", description: "What the line comes to" },
];

/* ------------------------------- resolving ------------------------------- */

const isoDate = (value: string) => (value ? value.slice(0, 10) : "");

/** The scalar tokens, resolved once per render. */
function resolve(context: ProposalContext, format: ProposalFormat): Record<string, string> {
  const { quote, locale } = context;
  const currency: CurrencyCode = quote.currency;
  const money = (value: number) => formatMoney(value, currency, locale);
  const totals = quote.totals;

  return {
    "quote.number": quote.number,
    "quote.name": quote.name,
    "quote.version": String(quote.version),
    "quote.status": quote.status.replace("_", " "),
    "quote.date": isoDate(quote.createdAt),
    "quote.validUntil": isoDate(quote.validUntil),
    "quote.termMonths": String(quote.termMonths),
    "quote.currency": currency,
    "quote.notes": quote.notes,
    "customer.name": quote.customer.name,
    "customer.contactName": quote.customer.contactName,
    "customer.contactTitle": quote.customer.contactTitle,
    "customer.contactEmail": quote.customer.contactEmail,
    "customer.contactPhone": quote.customer.contactPhone,
    // Already carries the format's own line break, so it is rendered raw —
    // see RAW_TOKENS in src/lib/document.ts.
    "customer.address": formatAddress(quote.customer.billingAddress, format),
    "customer.shippingAddress": formatAddress(quote.customer.shippingAddress, format),
    "customer.paymentTerms": quote.customer.paymentTerms,
    "seller.name": context.sellerName,
    "seller.email": context.sellerEmail,
    "totals.listTotal": money(totals.listTotal),
    "totals.subtotal": money(totals.subtotal),
    "totals.discount": money(totals.listTotal - totals.netTotal),
    "totals.discountPercent": formatPercent(totals.effectiveDiscountPercent),
    "totals.shipping": money(totals.shipping),
    "totals.tax": money(totals.taxAmount),
    "totals.grandTotal": money(totals.grandTotal),
    "totals.mrr": money(totals.monthlyRecurringTotal),
    "totals.arr": money(totals.annualRecurringTotal),
    "totals.tcv": money(totals.totalContractValue),
    "totals.oneTime": money(totals.oneTimeTotal),
  };
}

/** One line's tokens. */
function resolveLine(line: PricedLine, index: number, currency: CurrencyCode, locale?: string): Record<string, string> {
  const money = (value: number) => formatMoney(value, currency, locale);
  return {
    "line.number": String(index + 1),
    "line.sku": line.sku,
    "line.name": line.name,
    "line.description": line.description,
    "line.options": line.optionNames.join(", "),
    "line.quantity": String(line.quantity),
    "line.unitOfMeasure": line.unitOfMeasure,
    "line.listPrice": money(line.listUnitPrice),
    "line.unitPrice": money(line.unitPrice),
    "line.discountPercent": formatPercent(line.effectiveDiscountPercent),
    "line.term": line.chargeType === "recurring" ? `${line.termMonths} months` : "—",
    "line.billing": line.chargeType === "recurring" ? line.billingPeriod : line.chargeType,
    "line.total": money(line.netTotal),
  };
}

/* ---------------------------- for the PDF renderer ----------------------- */

/**
 * The same token vocabulary, resolved for a renderer that draws strings
 * rather than emitting markup.
 *
 * `src/lib/pdfTemplate.ts` positions text on a page, so there is no format to
 * escape for — but there is every reason for `{{customer.name}}` to mean the
 * same thing in a PDF template as in an HTML one. Exporting the resolution
 * rather than duplicating it is what keeps the two from drifting.
 */
export const proposalTokenValues = (context: ProposalContext): Record<string, string> => resolve(context, "text");

export const lineTokenValues = (
  line: PricedLine,
  index: number,
  currency: CurrencyCode,
  locale?: string,
): Record<string, string> => resolveLine(line, index, currency, locale);

/* ------------------------------- rendering ------------------------------- */

/** The default line table, for templates that use `{{lines.table}}`. */
function lineTable(lines: PricedLine[], currency: CurrencyCode, format: ProposalFormat, locale?: string): string {
  const money = (value: number) => formatMoney(value, currency, locale);
  const describe = (line: PricedLine) =>
    [line.name, line.optionNames.length ? `(${line.optionNames.join(", ")})` : ""].filter(Boolean).join(" ");

  return formatTable(
    ["SKU", "Item", "Qty", "Unit price", "Total"],
    lines.map(line => [
      line.sku,
      describe(line),
      String(line.quantity),
      money(line.unitPrice),
      money(line.netTotal),
    ]),
    format,
  );
}

/** What a quote template is rendered against. */
export const quoteSource = (context: ProposalContext): DocumentSource => ({
  values: format => resolve(context, format),
  lines: context.quote.lines.map((line, index) => resolveLine(line, index, context.quote.currency, context.locale)),
  table: format => lineTable(context.quote.lines, context.quote.currency, format, context.locale),
});

/** Renders a template against a quote. */
export function renderProposal(body: string, format: ProposalFormat, context: ProposalContext): RenderResult {
  return renderTemplate(body, format, quoteSource(context));
}
