/**
 * The template renderer, with no opinion about what it is rendering.
 *
 * A template is text — HTML, Markdown or plain — with `{{token}}` holes in it
 * and one repeating block for the rows. This file does the substituting: it
 * escapes per format, expands the repeating block, and reports the tokens it
 * did not recognise. It knows nothing about quotes or invoices.
 *
 * What a token *means* is a **vocabulary**, and there are two:
 * `src/lib/proposal.ts` for a quote and `src/lib/invoiceDocument.ts` for an
 * invoice. A vocabulary lists its tokens, resolves them against a record, and
 * hands this file a `DocumentSource`. Splitting it that way is what stops the
 * second document type from being a copy of the first with the nouns changed:
 * the escaping rules, the repeating block and the `$&` trap below are written
 * once and are the same wherever a `{{token}}` appears.
 *
 * Rendering substitutes strings and nothing else: there is no expression
 * evaluation here, no template language to escape out of, and nothing in a
 * template can reach the record beyond the tokens its vocabulary lists.
 *
 * HTML templates have their values escaped on the way in. A product called
 * `AC/DC <5kW>` must render as those characters in the document rather than
 * as broken markup, and the same escaping is what stops a catalogue entry
 * from carrying markup into a file somebody opens in a browser.
 */
import type { Address, ProposalFormat } from "./types";

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

/** A token and the sentence the editor shows beside it. */
export type TokenDescription = { token: string; description: string };

export type RenderResult = {
  text: string;
  /** Tokens the template used that this app does not know. Rendered as blank. */
  unknownTokens: string[];
};

/**
 * What a template is rendered against.
 *
 * `values` takes the format because a few tokens are written *in* it — an
 * address is four lines, and four lines are `<br />` in HTML and newlines
 * everywhere else.
 */
export type DocumentSource = {
  values: (format: ProposalFormat) => Record<string, string>;
  /** One token map per row of the repeating block. */
  lines: Record<string, string>[];
  /** The ready-made table behind `{{lines.table}}`. */
  table: (format: ProposalFormat) => string;
};

/* ------------------------------- escaping -------------------------------- */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]!);

/**
 * Markdown's escape is narrower on purpose: a pipe breaks a table and a
 * newline breaks a row, and everything else is a product name that should read
 * the way it was written.
 */
export const escapeMarkdown = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const escaper = (format: ProposalFormat) =>
  format === "html" ? escapeHtml : format === "markdown" ? escapeMarkdown : (value: string) => value;

/* ------------------------------- addresses ------------------------------- */

export function addressLines(address: Address | undefined): string[] {
  if (!address) return [];
  return [
    address.line1,
    address.line2,
    [address.city, address.state, address.postalCode].filter(Boolean).join(" "),
    address.country,
  ].filter(part => part.trim() !== "");
}

/**
 * An address, already written in the target format — which is why the tokens
 * that carry one are in `RAW_TOKENS` below rather than escaped a second time.
 */
export const formatAddress = (address: Address | undefined, format: ProposalFormat): string =>
  addressLines(address)
    .map(part => (format === "html" ? escapeHtml(part) : part))
    .join(format === "html" ? "<br />" : "\n");

/* ------------------------------- rendering ------------------------------- */

/**
 * Tokens whose value is already written in the target format, and so must not
 * be escaped again — escaping them would turn a table's markup into visible
 * angle brackets. All of them are produced by this app, from data that was
 * escaped as it went in, so nothing user-written reaches the document
 * unescaped.
 */
export const RAW_TOKENS = new Set([LINE_TABLE_TOKEN, "customer.address", "customer.shippingAddress"]);

const TOKEN_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

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

/**
 * A table of strings, written in the target format.
 *
 * Shared by both vocabularies so that `{{lines.table}}` lays out the same way
 * whether the rows came from a quote or an invoice.
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  format: ProposalFormat,
  empty = "No items.",
): string {
  if (!rows.length) return format === "html" ? `<p>${empty}</p>` : empty;

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
  const line = (values: string[]) => values.map((value, column) => value.padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(headers), widths.map(width => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n");
}

/**
 * Renders a template body against a source.
 *
 * The repeating block is expanded first, so a `{{line.*}}` token only resolves
 * where it means something — outside the block it is unknown, and the editor
 * says so rather than quietly rendering a blank.
 */
export function renderTemplate(body: string, format: ProposalFormat, source: DocumentSource): RenderResult {
  const unknown = new Set<string>();

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
    const expanded = source.lines.map(line => substitute(block, line, format, unknown)).join("");

    text = text.slice(0, start) + expanded + text.slice(end + LINES_CLOSE.length);
  }

  // 2 — the scalar tokens, including the ready-made table.
  const values = { ...source.values(format), [LINE_TABLE_TOKEN]: source.table(format) };

  return { text: substitute(text, values, format, unknown), unknownTokens: [...unknown].sort() };
}

/* -------------------------------- the file ------------------------------- */

/** "Acme renewal" + html -> "acme-renewal.html" */
export function documentFileName(name: string, format: ProposalFormat, fallback = "document"): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback;
  const extension = format === "markdown" ? "md" : format === "text" ? "txt" : format === "pdf" ? "pdf" : "html";
  return `${slug}.${extension}`;
}

export const CONTENT_TYPES: Record<ProposalFormat, string> = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
  pdf: "application/pdf",
};

/** Tokens a template uses that its vocabulary does not know — the editor's warning. */
export function unknownTokensIn(body: string, vocabulary: TokenDescription[][]): string[] {
  const known = new Set(vocabulary.flat().map(entry => entry.token));
  const found = new Set<string>();
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const token = match[1]!;
    if (!known.has(token)) found.add(token);
  }
  return [...found].sort();
}
