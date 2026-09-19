/**
 * Turning a quote into the document a customer reads.
 *
 * A proposal template is text — HTML, Markdown or plain — with `{{token}}`
 * placeholders and one repeating block for the line items. Rendering
 * substitutes strings and nothing else: there is no expression evaluation
 * here, no template language to escape out of, and nothing in a template can
 * reach the quote beyond the tokens listed in `PROPOSAL_TOKENS`.
 *
 * HTML templates have their values escaped on the way in. A product called
 * `AC/DC <5kW>` must render as those characters in the document rather than
 * as broken markup, and the same escaping is what stops a catalogue entry
 * from carrying markup into a file somebody opens in a browser.
 *
 * Why this and not a PDF library: a proposal is something people want to edit
 * — drop it into a letterhead, paste it into an email, hand it to a designer.
 * Text out is a document anyone can take somewhere else; a rendered PDF is a
 * dead end with a dependency attached.
 */
import { formatMoney, formatPercent } from "./money";
import type { Address, CurrencyCode, PricedLine, ProposalFormat, Quote } from "./types";

export const MAX_TEMPLATE_NAME_LENGTH = 120;
export const MAX_TEMPLATE_BODY_LENGTH = 200_000;

/**
 * A PDF template gets a great deal more room, because its body is JSON that
 * carries its own pictures: a letterhead is a few hundred kilobytes of base64
 * inside the document description. Prose never needs it — 200,000 characters
 * is already a book — so the two limits are separate rather than one raised
 * to the larger.
 */
export const MAX_PDF_TEMPLATE_BODY_LENGTH = 3_000_000;

/** The repeating block: everything between these is rendered once per line. */
export const LINES_OPEN = "{{#lines}}";
export const LINES_CLOSE = "{{/lines}}";

/** A ready-made line table, for a template that does not want the block form. */
export const LINE_TABLE_TOKEN = "lines.table";

export type ProposalContext = {
  quote: Quote;
  /** Who is sending it — the signed-in account. */
  sellerName: string;
  sellerEmail: string;
  /** Formatting locale for money and dates; the browser's, or the server's. */
  locale?: string;
};

export type RenderResult = {
  text: string;
  /** Tokens the template used that this app does not know. Rendered as blank. */
  unknownTokens: string[];
};

/* ------------------------------ the tokens ------------------------------- */

/**
 * Every token a template may use, with the sentence the editor shows beside
 * it. This list is the contract: it is what the token picker offers, what the
 * API index documents, and what `resolve` below is built from.
 */
export const PROPOSAL_TOKENS: { token: string; description: string }[] = [
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
export const LINE_TOKENS: { token: string; description: string }[] = [
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

/* ------------------------------- escaping -------------------------------- */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]!);

/**
 * Markdown's escape is narrower on purpose: a pipe breaks a table and a
 * newline breaks a row, and everything else is a product name that should read
 * the way it was written.
 */
const escapeMarkdown = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const escaper = (format: ProposalFormat) =>
  format === "html" ? escapeHtml : format === "markdown" ? escapeMarkdown : (value: string) => value;

/* ------------------------------- rendering ------------------------------- */

const isoDate = (value: string) => (value ? value.slice(0, 10) : "");

function addressLines(address: Address | undefined): string[] {
  if (!address) return [];
  return [
    address.line1,
    address.line2,
    [address.city, address.state, address.postalCode].filter(Boolean).join(" "),
    address.country,
  ].filter(part => part.trim() !== "");
}

/** The scalar tokens, resolved once per render. */
function resolve(context: ProposalContext, format: ProposalFormat): Record<string, string> {
  const { quote, locale } = context;
  const currency: CurrencyCode = quote.currency;
  const money = (value: number) => formatMoney(value, currency, locale);
  const totals = quote.totals;

  /** A multi-line address, already written in the target format. */
  const address = (value: Address) =>
    addressLines(value)
      .map(part => (format === "html" ? escapeHtml(part) : part))
      .join(format === "html" ? "<br />" : "\n");

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
    // see RAW_TOKENS below.
    "customer.address": address(quote.customer.billingAddress),
    "customer.shippingAddress": address(quote.customer.shippingAddress),
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

/**
 * Tokens whose value is already written in the target format, and so must not
 * be escaped again — escaping them would turn a table's markup into visible
 * angle brackets. Both are produced by this file, from data that was escaped
 * as it went in, so nothing user-written reaches the document unescaped.
 */
const RAW_TOKENS = new Set([LINE_TABLE_TOKEN, "customer.address", "customer.shippingAddress"]);

const TOKEN_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

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

/**
 * Substitutes tokens into one string, unescaped, collecting the ones this app
 * does not know so a caller can warn about them.
 */
export function fillTokens(text: string, values: Record<string, string>, unknown?: Set<string>): string {
  return text.replace(TOKEN_PATTERN, (_match, token: string) => {
    const value = values[token];
    if (value === undefined) {
      unknown?.add(token);
      return "";
    }
    return value;
  });
}

/**
 * Substitutes the tokens in one chunk of text.
 *
 * Deliberately `replace` with a function rather than a chain of string
 * replacements: a value containing `$&` would otherwise be treated as a
 * replacement pattern and corrupt the document, and customer data is exactly
 * where a stray `$` turns up.
 */
function substitute(
  text: string,
  values: Record<string, string>,
  format: ProposalFormat,
  unknown: Set<string>,
): string {
  const escape = escaper(format);
  return text.replace(TOKEN_PATTERN, (_match, token: string) => {
    const value = values[token];
    if (value === undefined) {
      unknown.add(token);
      // A blank, not the raw token: an unresolved `{{foo}}` in a document sent
      // to a customer is worse than a gap the author will notice in preview.
      return "";
    }
    return RAW_TOKENS.has(token) ? value : escape(value);
  });
}

/** The default line table, for templates that use `{{lines.table}}`. */
function lineTable(lines: PricedLine[], currency: CurrencyCode, format: ProposalFormat, locale?: string): string {
  if (!lines.length) return format === "html" ? "<p>No items.</p>" : "No items.";

  const money = (value: number) => formatMoney(value, currency, locale);
  const describe = (line: PricedLine) =>
    [line.name, line.optionNames.length ? `(${line.optionNames.join(", ")})` : ""].filter(Boolean).join(" ");

  const rows = lines.map(line => [
    line.sku,
    describe(line),
    String(line.quantity),
    money(line.unitPrice),
    money(line.netTotal),
  ]);
  const headers = ["SKU", "Item", "Qty", "Unit price", "Total"];

  if (format === "html") {
    const cells = (values: string[], tag: "th" | "td") =>
      values.map(value => `<${tag}>${escapeHtml(value)}</${tag}>`).join("");
    return [
      '<table class="quote-lines">',
      `  <thead><tr>${cells(headers, "th")}</tr></thead>`,
      "  <tbody>",
      ...rows.map(row => `    <tr>${cells(row, "td")}</tr>`),
      "  </tbody>",
      "</table>",
    ].join("\n");
  }

  if (format === "markdown") {
    return [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map(row => `| ${row.map(escapeMarkdown).join(" | ")} |`),
    ].join("\n");
  }

  // Plain text: fixed columns, so it still lines up in a monospaced email.
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? "").length)),
  );
  const row = (values: string[]) => values.map((value, column) => value.padEnd(widths[column]!)).join("  ").trimEnd();
  return [row(headers), widths.map(width => "-".repeat(width)).join("  "), ...rows.map(row)].join("\n");
}

/**
 * Renders a template against a quote.
 *
 * The repeating block is expanded first, so a `{{line.*}}` token only resolves
 * where it means something — outside the block it is unknown, and the editor
 * says so rather than quietly rendering a blank.
 */
export function renderProposal(body: string, format: ProposalFormat, context: ProposalContext): RenderResult {
  const unknown = new Set<string>();
  const { quote, locale } = context;

  // 1 — the repeating block.
  let text = body;
  for (;;) {
    const start = text.indexOf(LINES_OPEN);
    if (start === -1) break;
    const end = text.indexOf(LINES_CLOSE, start);
    if (end === -1) {
      // An unclosed block is an authoring mistake, not a reason to refuse the
      // document: the marker is dropped and the rest renders.
      text = text.replace(LINES_OPEN, "");
      break;
    }

    const block = text.slice(start + LINES_OPEN.length, end);
    const expanded = quote.lines
      .map((line, index) => substitute(block, resolveLine(line, index, quote.currency, locale), format, unknown))
      .join("");

    text = text.slice(0, start) + expanded + text.slice(end + LINES_CLOSE.length);
  }

  // 2 — the scalar tokens, including the ready-made table.
  const values = {
    ...resolve(context, format),
    [LINE_TABLE_TOKEN]: lineTable(quote.lines, quote.currency, format, locale),
  };

  return { text: substitute(text, values, format, unknown), unknownTokens: [...unknown].sort() };
}

/** "Acme renewal" + html -> "acme-renewal.html" */
export function proposalFileName(name: string, format: ProposalFormat): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "proposal";
  const extension = format === "markdown" ? "md" : format === "text" ? "txt" : format === "pdf" ? "pdf" : "html";
  return `${slug}.${extension}`;
}

export const CONTENT_TYPES: Record<ProposalFormat, string> = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
  pdf: "application/pdf",
};

/** Tokens a template uses that this app does not know — the editor's warning. */
export function unknownTokensIn(body: string): string[] {
  const known = new Set([...PROPOSAL_TOKENS.map(entry => entry.token), ...LINE_TOKENS.map(entry => entry.token)]);
  const found = new Set<string>();
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const token = match[1]!;
    if (!known.has(token)) found.add(token);
  }
  return [...found].sort();
}
