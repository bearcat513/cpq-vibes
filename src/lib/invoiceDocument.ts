/**
 * Turning an invoice into the document a customer is sent.
 *
 * The app's second token vocabulary — the first is `src/lib/proposal.ts`, for
 * a quote — built on the same renderer in `src/lib/document.ts`. A template is
 * a template: the escaping, the repeating line block and the `{{lines.table}}`
 * layout are shared, and what differs is only what a token *means*.
 *
 * Two things here are not simply the quote vocabulary with the nouns changed,
 * and both come straight from src/lib/receivable.ts:
 *
 * **`{{invoice.status}}` is derived at render time**, never read off the
 * record, because nothing is stored about an invoice's condition. An invoice
 * printed the morning after it fell due says "Overdue" because the date says
 * so, not because anybody ran a job overnight.
 *
 * **`{{totals.balance}}` may be negative.** An overpaid invoice owes money
 * back, and a document that printed that as `0.00` would be the app quietly
 * losing a customer's money. It is written the way it is held.
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
import { formatMoney, formatPercent, round } from "./money";
import { daysOverdue, invoiceStatus, today } from "./receivable";
import {
  INVOICE_STATUS_LABELS,
  type CurrencyCode,
  type Invoice,
  type InvoiceLine,
  type ProposalFormat,
} from "./types";

export type InvoiceDocumentContext = {
  invoice: Invoice;
  /** Who is billing — the signed-in account. */
  sellerName: string;
  sellerEmail: string;
  /** Formatting locale for money and dates; the browser's, or the server's. */
  locale?: string;
  /**
   * The day the document is dated from, for the tokens the calendar decides.
   * Defaults to today; a test passes one so a rendered invoice is a fixture
   * rather than a thing that changes overnight.
   */
  asOf?: string;
};

/* ------------------------------ the tokens ------------------------------- */

/**
 * Every token an invoice template may use.
 *
 * The `customer.*` and `seller.*` halves are deliberately spelled exactly as
 * the quote vocabulary spells them: the same letterhead, address panel and
 * signature block should work in either kind of template, and somebody who
 * has written one proposal template already knows these.
 */
export const INVOICE_TOKENS: TokenDescription[] = [
  { token: "invoice.number", description: "The invoice's reference, e.g. INV-2026-0007" },
  { token: "invoice.status", description: "Open, part paid, paid, overdue — worked out as it renders" },
  { token: "invoice.state", description: "Draft, issued or void" },
  { token: "invoice.date", description: "The day it was issued; blank while it is a draft" },
  { token: "invoice.dueDate", description: "The day it falls due" },
  { token: "invoice.paymentTerms", description: "The terms it was raised under, e.g. Net 30" },
  { token: "invoice.daysOverdue", description: "Days past due, or 0" },
  { token: "invoice.poNumber", description: "The customer's purchase order reference" },
  { token: "invoice.quoteNumber", description: "The quote it was raised from, if any" },
  { token: "invoice.currency", description: "Currency code" },
  { token: "invoice.notes", description: "The customer-facing note on the invoice" },
  { token: "customer.name", description: "The account's name" },
  { token: "customer.contactName", description: "Who it is addressed to" },
  { token: "customer.contactTitle", description: "Their job title" },
  { token: "customer.contactEmail", description: "Their email address" },
  { token: "customer.contactPhone", description: "Their phone number" },
  { token: "customer.address", description: "Billing address, one line per part" },
  { token: "customer.shippingAddress", description: "Where it ships, one line per part" },
  { token: "customer.paymentTerms", description: "Payment terms as the customer record has them" },
  { token: "seller.name", description: "Your name" },
  { token: "seller.email", description: "Your email address" },
  { token: LINE_TABLE_TOKEN, description: "Every line as a table, in this template's format" },
  { token: "totals.subtotal", description: "Every line, before tax" },
  { token: "totals.tax", description: "Tax" },
  { token: "totals.total", description: "What was demanded" },
  { token: "totals.paid", description: "Cash received against it" },
  { token: "totals.credited", description: "Credited or written off" },
  { token: "totals.balance", description: "What is still owed — negative if it was overpaid" },
];

/** Tokens usable inside `{{#lines}}…{{/lines}}`. */
export const INVOICE_LINE_TOKENS: TokenDescription[] = [
  { token: "line.number", description: "1, 2, 3 — its position on the invoice" },
  { token: "line.sku", description: "Catalogue SKU" },
  { token: "line.description", description: "What is being billed" },
  { token: "line.quantity", description: "How many" },
  { token: "line.unitPrice", description: "Price of one" },
  { token: "line.amount", description: "Quantity × unit price, before tax" },
  { token: "line.taxPercent", description: "The rate on this line" },
  { token: "line.taxAmount", description: "Tax on this line" },
  { token: "line.total", description: "The line including its tax" },
];

/* ------------------------------- resolving ------------------------------- */

const isoDate = (value: string) => (value ? value.slice(0, 10) : "");

/** "Net 30", from the number of days the invoice was actually raised under. */
const termsLabel = (days: number) => (days > 0 ? `Net ${days}` : "Due on receipt");

/** The scalar tokens, resolved once per render. */
function resolve(context: InvoiceDocumentContext, format: ProposalFormat): Record<string, string> {
  const { invoice, locale } = context;
  const asOf = context.asOf || today();
  const currency: CurrencyCode = invoice.currency;
  const money = (value: number) => formatMoney(value, currency, locale);
  const totals = invoice.totals;

  return {
    "invoice.number": invoice.number,
    // Derived, never stored — see the note at the top of this file.
    "invoice.status": INVOICE_STATUS_LABELS[invoiceStatus(invoice, asOf)],
    "invoice.state": invoice.state,
    "invoice.date": isoDate(invoice.issueDate),
    "invoice.dueDate": isoDate(invoice.dueDate),
    "invoice.paymentTerms": termsLabel(invoice.paymentTermDays),
    "invoice.daysOverdue": String(daysOverdue(invoice, asOf)),
    "invoice.poNumber": invoice.poNumber,
    "invoice.quoteNumber": invoice.quoteNumber,
    "invoice.currency": currency,
    "invoice.notes": invoice.notes,
    "customer.name": invoice.customer.name,
    "customer.contactName": invoice.customer.contactName,
    "customer.contactTitle": invoice.customer.contactTitle,
    "customer.contactEmail": invoice.customer.contactEmail,
    "customer.contactPhone": invoice.customer.contactPhone,
    // Already carries the format's own line break, so it is rendered raw —
    // see RAW_TOKENS in src/lib/document.ts.
    "customer.address": formatAddress(invoice.customer.billingAddress, format),
    "customer.shippingAddress": formatAddress(invoice.customer.shippingAddress, format),
    "customer.paymentTerms": invoice.customer.paymentTerms,
    "seller.name": context.sellerName,
    "seller.email": context.sellerEmail,
    "totals.subtotal": money(totals.subtotal),
    "totals.tax": money(totals.taxAmount),
    "totals.total": money(totals.total),
    "totals.paid": money(totals.paidAmount),
    "totals.credited": money(totals.creditedAmount),
    "totals.balance": money(totals.balance),
  };
}

/** What one line comes to with its tax — two rounded numbers, added. */
export const lineWithTax = (line: InvoiceLine, currency: CurrencyCode): number =>
  round(line.amount + line.taxAmount, currency);

/** One line's tokens. */
function resolveLine(
  line: InvoiceLine,
  index: number,
  currency: CurrencyCode,
  locale?: string,
): Record<string, string> {
  const money = (value: number) => formatMoney(value, currency, locale);
  return {
    "line.number": String(index + 1),
    "line.sku": line.sku,
    "line.description": line.description,
    "line.quantity": String(line.quantity),
    "line.unitPrice": money(line.unitPrice),
    "line.amount": money(line.amount),
    "line.taxPercent": formatPercent(line.taxPercent),
    "line.taxAmount": money(line.taxAmount),
    "line.total": money(lineWithTax(line, currency)),
  };
}

/* ---------------------------- for the PDF renderer ----------------------- */

/** The same vocabulary, for a renderer that draws strings rather than markup. */
export const invoiceTokenValues = (context: InvoiceDocumentContext): Record<string, string> =>
  resolve(context, "text");

export const invoiceLineTokenValues = (
  line: InvoiceLine,
  index: number,
  currency: CurrencyCode,
  locale?: string,
): Record<string, string> => resolveLine(line, index, currency, locale);

/* ------------------------------- rendering ------------------------------- */

/** The default line table, for templates that use `{{lines.table}}`. */
function lineTable(lines: InvoiceLine[], currency: CurrencyCode, format: ProposalFormat, locale?: string): string {
  const money = (value: number) => formatMoney(value, currency, locale);

  return formatTable(
    ["SKU", "Description", "Qty", "Unit price", "Tax", "Total"],
    lines.map(line => [
      line.sku,
      line.description,
      String(line.quantity),
      money(line.unitPrice),
      money(line.taxAmount),
      money(lineWithTax(line, currency)),
    ]),
    format,
    "No lines.",
  );
}

/** What an invoice template is rendered against. */
export const invoiceSource = (context: InvoiceDocumentContext): DocumentSource => ({
  values: format => resolve(context, format),
  lines: context.invoice.lines.map((line, index) =>
    resolveLine(line, index, context.invoice.currency, context.locale),
  ),
  table: format => lineTable(context.invoice.lines, context.invoice.currency, format, context.locale),
});

/** Renders a template against an invoice. */
export function renderInvoiceDocument(
  body: string,
  format: ProposalFormat,
  context: InvoiceDocumentContext,
): RenderResult {
  return renderTemplate(body, format, invoiceSource(context));
}
