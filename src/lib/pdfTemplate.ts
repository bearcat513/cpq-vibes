/**
 * PDF proposal templates.
 *
 * The other three template formats are text with `{{token}}` holes in it,
 * which works because HTML, Markdown and plain text all decide their own
 * layout. A PDF does not: something has to say where on the page each thing
 * goes, how wide the columns are and what happens when the items run past the
 * bottom. Reusing the text format would mean rendering HTML, and rendering
 * HTML properly means shipping a browser.
 *
 * So a PDF template is a **document described as data**: page setup, then an
 * ordered list of blocks — a heading, a two-column address panel, the line
 * items, a totals table, a signature area. Every piece of text in it runs
 * through the same token vocabulary as the other formats, so
 * `{{customer.name}}` means the same thing everywhere, and the block list is
 * something a UI can edit without anyone writing JSON by hand.
 *
 * ## What the format deliberately will not do
 *
 * **It cannot show cost or margin.** `TOTALS_FIELDS` below is a closed list of
 * customer-facing numbers, and cost, margin and margin percent are not on it.
 * A proposal template is the one artefact in this app that is *designed* to be
 * sent outside the company, and the cheapest way to guarantee it never carries
 * internal numbers is to give it no way to name them.
 *
 * ## Branding
 *
 * A template *can* hold images: an `image` block in the flow, and a `header`
 * — a letterhead drawn into the top margin of every page, opposite an address
 * block. Both keep the picture in the template itself, as a `data:` URL, for
 * the same reason the rest of the document is data: a template is one record
 * that can be exported, shared and imported, and a logo held anywhere else
 * would be a reference that breaks the moment it travels.
 *
 * What may go in one is `src/lib/image.ts`'s business, and it is narrow on
 * purpose — bytes a PDF reader can take as they are, so nothing here decodes
 * a pixel.
 */
import { decodeImage, imageBox, type EmbeddableImage } from "./image";
import { formatMoney, formatPercent } from "./money";
import { DEFAULT_MARGINS, PdfDocument, type Margins, type PageSize, type TableCell, type TableColumn } from "./pdf";
import { measureText, type FontFamily } from "./pdfFonts";
import { fillTokens, lineTokenValues, proposalTokenValues, type ProposalContext } from "./proposal";
import type { PricedLine, Quote } from "./types";

/* -------------------------------- the page ------------------------------- */

export type PdfPageSetup = {
  size: PageSize;
  margins: Margins;
  family: FontFamily;
  /** Body size in points. Headings are relative to it unless one says otherwise. */
  fontSize: number;
  /** Body text. */
  textColor: string;
  /** Secondary text: labels, captions, the footer. */
  mutedColor: string;
  /** Headings, rules and the totals emphasis. */
  accentColor: string;
};

/**
 * The letterhead: a logo and a block of text in the top margin of the page.
 *
 * It lives beside the page setup rather than in the block list because it is
 * not part of the flow — it is drawn on *every* page, after the layout is
 * finished, exactly like the footer. A block would put it on page one only,
 * and a proposal whose second page is unbranded looks like a fax.
 *
 * Its whole height has to fit in the top margin, since that is the one band
 * content never occupies. A logo taller than the margin is scaled down rather
 * than allowed to print over the first paragraph; the fix is a bigger margin.
 */
export type PdfHeader = {
  /** A base64 `data:` URL. See src/lib/image.ts for what may go in one. */
  logo?: string;
  /** The logo's drawn width in points. Its height follows the picture. */
  logoWidth?: number;
  /** Which side the logo sits on; the text takes the other. */
  logoAlign?: "left" | "right";
  /** Address, tagline, registration number — tokens work here too. */
  text?: string;
  color?: string;
  /** A rule under the band, in the accent colour. */
  rule?: boolean;
  /** Letterhead on page one, plain paper after it. */
  firstPageOnly?: boolean;
};

export const DEFAULT_PAGE: PdfPageSetup = {
  size: "A4",
  margins: { ...DEFAULT_MARGINS },
  family: "helvetica",
  fontSize: 10,
  textColor: "#18181b",
  mutedColor: "#71717a",
  accentColor: "#18181b",
};

/* -------------------------------- blocks --------------------------------- */

export type BlockAlign = "left" | "center" | "right";

/** A column of the line-item table, named by the line token it shows. */
export type LineItemField =
  | "number"
  | "sku"
  | "name"
  | "description"
  | "options"
  | "quantity"
  | "unitOfMeasure"
  | "listPrice"
  | "unitPrice"
  | "discountPercent"
  | "term"
  | "billing"
  | "total";

export const LINE_ITEM_FIELDS: { field: LineItemField; label: string }[] = [
  { field: "number", label: "#" },
  { field: "sku", label: "SKU" },
  { field: "name", label: "Item" },
  { field: "description", label: "Description" },
  { field: "options", label: "Options" },
  { field: "quantity", label: "Qty" },
  { field: "unitOfMeasure", label: "Unit" },
  { field: "listPrice", label: "List price" },
  { field: "unitPrice", label: "Unit price" },
  { field: "discountPercent", label: "Discount" },
  { field: "term", label: "Term" },
  { field: "billing", label: "Billing" },
  { field: "total", label: "Total" },
];

export type LineItemColumn = {
  field: LineItemField;
  header: string;
  /** A share of the table's width, normalised across the columns. */
  width: number;
  align?: BlockAlign;
};

/**
 * The totals a template may print.
 *
 * Closed, and customer-facing only — see the note at the top of this file.
 */
export type TotalsField =
  | "listTotal"
  | "lineDiscountAmount"
  | "subtotal"
  | "quoteDiscountAmount"
  | "quoteAdjustment"
  | "totalDiscount"
  | "netTotal"
  | "shipping"
  | "taxAmount"
  | "grandTotal"
  | "oneTimeTotal"
  | "monthlyRecurringTotal"
  | "annualRecurringTotal"
  | "totalContractValue"
  | "effectiveDiscountPercent";

export const TOTALS_FIELDS: { field: TotalsField; label: string }[] = [
  { field: "listTotal", label: "List price" },
  { field: "lineDiscountAmount", label: "Line discounts" },
  { field: "subtotal", label: "Subtotal" },
  { field: "quoteDiscountAmount", label: "Quote discount" },
  { field: "quoteAdjustment", label: "Adjustments" },
  { field: "totalDiscount", label: "Total discount" },
  { field: "effectiveDiscountPercent", label: "Discount off list" },
  { field: "shipping", label: "Shipping" },
  { field: "taxAmount", label: "Tax" },
  { field: "netTotal", label: "Net total" },
  { field: "grandTotal", label: "Total" },
  { field: "oneTimeTotal", label: "One-time charges" },
  { field: "monthlyRecurringTotal", label: "Monthly recurring" },
  { field: "annualRecurringTotal", label: "Annual recurring" },
  { field: "totalContractValue", label: "Total contract value" },
];

export type TotalsRow = {
  label: string;
  field: TotalsField;
  /** Larger and bold, with a rule above. For the one line that matters. */
  emphasis?: boolean;
  /** Leave the row out when the number is zero, rather than printing "0.00". */
  omitIfZero?: boolean;
};

export type PdfBlock =
  | { type: "heading"; text: string; size?: number; align?: BlockAlign; color?: string; spaceAfter?: number }
  | {
      type: "text";
      text: string;
      size?: number;
      align?: BlockAlign;
      color?: string;
      bold?: boolean;
      italic?: boolean;
      spaceAfter?: number;
    }
  | { type: "spacer"; height: number }
  | { type: "divider"; color?: string; thickness?: number }
  | {
      type: "image";
      /** A base64 `data:` URL. */
      source: string;
      /** Drawn width in points; the height follows the picture's proportions. */
      width: number;
      align?: BlockAlign;
      /** A small line under it — a caption, a credit, a certification note. */
      caption?: string;
      spaceAfter?: number;
    }
  | { type: "columns"; gap?: number; columns: { heading?: string; text: string; align?: BlockAlign }[] }
  | { type: "fields"; align?: BlockAlign; rows: { label: string; value: string }[] }
  | {
      type: "lineItems";
      columns: LineItemColumn[];
      /** A second line under the item, listing the configured options. */
      showOptions?: boolean;
      /** A third line, with the line's own note. */
      showDescription?: boolean;
      headerFill?: string;
      zebra?: string;
      fontSize?: number;
    }
  | { type: "totals"; rows: TotalsRow[]; width?: number }
  | { type: "signatures"; parties: { label: string; caption?: string }[] }
  | { type: "pageBreak" };

export const BLOCK_TYPES: { type: PdfBlock["type"]; label: string; description: string }[] = [
  { type: "heading", label: "Heading", description: "A title line, larger than the body" },
  { type: "text", label: "Text", description: "A paragraph, wrapped to the page" },
  { type: "image", label: "Image", description: "A picture in the flow — a logo, a diagram, a signature" },
  { type: "columns", label: "Columns", description: "Side-by-side panels — prepared for / prepared by" },
  { type: "fields", label: "Field list", description: "Label and value pairs, one per line" },
  { type: "lineItems", label: "Line items", description: "The quote's lines as a table" },
  { type: "totals", label: "Totals", description: "A totals table, right-aligned" },
  { type: "signatures", label: "Signatures", description: "Ruled areas for names and dates" },
  { type: "divider", label: "Divider", description: "A horizontal rule" },
  { type: "spacer", label: "Spacer", description: "Vertical space" },
  { type: "pageBreak", label: "Page break", description: "Start the next page" },
];

export type PdfTemplate = {
  page: PdfPageSetup;
  /** The letterhead. Absent is a document on plain paper. */
  header?: PdfHeader;
  blocks: PdfBlock[];
  footer: {
    text: string;
    showPageNumbers: boolean;
  };
};

/* ------------------------------- rendering ------------------------------- */

/**
 * Totals that come *off* the price, and so are printed with a minus.
 *
 * "Discount $124,717.92" on a line of its own reads as something being added.
 * The sign is not decoration — it is the difference between a total a customer
 * can follow down the page and one they have to ask about.
 */
const SUBTRACTIVE: ReadonlySet<TotalsField> = new Set<TotalsField>([
  "lineDiscountAmount",
  "quoteDiscountAmount",
  "totalDiscount",
]);

/** The numeric value behind a totals field, for formatting and zero checks. */
function totalsValue(quote: Quote, field: TotalsField): number {
  const totals = quote.totals;
  switch (field) {
    case "totalDiscount":
      return totals.listTotal - totals.netTotal;
    case "effectiveDiscountPercent":
      return totals.effectiveDiscountPercent;
    default:
      return totals[field] ?? 0;
  }
}

/** The line token behind a line-item column. */
const lineValue = (values: Record<string, string>, field: LineItemField): string => values[`line.${field}`] ?? "";

const alignOf = (align: BlockAlign | undefined): "left" | "center" | "right" => align ?? "left";

export type PdfRenderResult = {
  bytes: Uint8Array;
  /** Tokens the template used that this app does not know. Rendered as blank. */
  unknownTokens: string[];
  /**
   * Images that could not be embedded, each as a sentence.
   *
   * Left out of the page rather than failing the render: a document missing
   * its logo can still be read, and the person who can fix it is the one
   * looking at the editor, not the customer waiting for the quote.
   */
  imageProblems: string[];
  pageCount: number;
};

/**
 * Renders a quote through a PDF template.
 *
 * Pure, and it runs in both places for the same reason the pricing engine
 * does: the browser renders it into an iframe so a template can be designed
 * against a live preview, and the server renders it for the file a customer
 * receives. One implementation, so the preview cannot lie.
 */
export function renderPdf(template: PdfTemplate, context: ProposalContext): PdfRenderResult {
  const { quote, locale } = context;
  const page = { ...DEFAULT_PAGE, ...template.page, margins: { ...DEFAULT_MARGINS, ...template.page?.margins } };
  const unknown = new Set<string>();

  const values = proposalTokenValues(context);
  const fill = (text: string) => fillTokens(text, values, unknown);
  const money = (value: number) => formatMoney(value, quote.currency, locale);

  /*
   * Decoded once per render, however many blocks and pages use a picture: the
   * work is header parsing, but the base64 behind a letterhead is not free.
   *
   * A failure is cached as its own message rather than as a null, so a second
   * block using the same broken picture is reported against *that* block and
   * the first one is not reported twice.
   */
  const pictures = new Map<string, EmbeddableImage | string>();
  const problems = new Set<string>();
  const picture = (source: string, what: string): EmbeddableImage | null => {
    if (!source) return null;

    let entry = pictures.get(source);
    if (entry === undefined) {
      const decoded = decodeImage(source);
      entry = decoded.ok ? decoded.image : decoded.error;
      pictures.set(source, entry);
    }

    if (typeof entry === "string") {
      problems.add(`${what}: ${entry}`);
      return null;
    }
    return entry;
  };

  const document = new PdfDocument({
    size: page.size,
    margins: page.margins,
    family: page.family,
    fontSize: page.fontSize,
    color: page.textColor,
    title: `${quote.number} — ${quote.name}`,
    author: context.sellerName || context.sellerEmail,
    subject: quote.customer.name ? `Quote for ${quote.customer.name}` : "Quote",
  });

  for (const block of template.blocks) {
    renderBlock(block, { document, page, quote, fill, money, locale, unknown, picture });
  }

  /* --- the letterhead and the footer, once the page count is known --- */

  renderHeader(template.header, { document, page, fill, picture });

  const footerText = template.footer?.text ? fill(template.footer.text) : "";
  const showPageNumbers = template.footer?.showPageNumbers !== false;

  if (footerText || showPageNumbers) {
    document.onEachPage((doc, current, total) => {
      const y = doc.y;
      if (footerText) {
        doc.drawTextAt(footerText, doc.left, y, { size: page.fontSize - 2, color: page.mutedColor });
      }
      if (showPageNumbers) {
        const label = `Page ${current} of ${total}`;
        // Drawn directly rather than through `text`, which would move a cursor
        // that is deliberately parked in the bottom margin.
        const size = page.fontSize - 2;
        doc.drawTextAt(label, doc.left + doc.contentWidth - measureText(label, page.family, size), y, {
          size,
          color: page.mutedColor,
        });
      }
    });
  }

  const bytes = document.toBytes();
  return {
    bytes,
    unknownTokens: [...unknown].sort(),
    imageProblems: [...problems].sort(),
    pageCount: document.pageCount,
  };
}

/** Resolves a `data:` URL, remembering both the picture and what went wrong. */
type PictureResolver = (source: string, what: string) => EmbeddableImage | null;

type RenderContext = {
  document: PdfDocument;
  page: PdfPageSetup;
  quote: Quote;
  fill: (text: string) => string;
  money: (value: number) => string;
  locale?: string;
  unknown: Set<string>;
  picture: PictureResolver;
};

/* ------------------------------ the letterhead --------------------------- */

/**
 * Space kept between the letterhead and the first line of content.
 *
 * Enough that a rule drawn under the band has air on both sides of it: the
 * band is the top margin less this, the rule sits a third of the way down,
 * and the rest is the gap a reader sees.
 */
const HEADER_GAP = 20;

/**
 * Draws the letterhead into the top margin of every page.
 *
 * Deferred like the footer, and for the same reason: `firstPageOnly` cannot
 * be decided while page one is still being laid out. Both halves are bottom
 * aligned to the same line, so a tall logo and a three-line address sit on a
 * common baseline rather than drifting apart.
 */
function renderHeader(
  header: PdfHeader | undefined,
  context: { document: PdfDocument; page: PdfPageSetup; fill: (text: string) => string; picture: PictureResolver },
): void {
  const { document, page, fill } = context;
  if (!header) return;

  const text = header.text ? fill(header.text) : "";
  const logo = header.logo ? context.picture(header.logo, "The letterhead logo") : null;
  if (!logo && !text && !header.rule) return;

  // The band is the top margin less the gap: anything taller would print over
  // the first block on the page.
  const band = Math.max(0, page.margins.top - HEADER_GAP);
  const baseline = page.margins.top - HEADER_GAP;

  const logoOnLeft = header.logoAlign !== "right";
  const size = Math.max(6, page.fontSize - 1.5);
  const lineHeight = size * 1.35;
  const lines = text ? text.split("\n") : [];
  const textHeight = lines.length * lineHeight;

  let logoWidth = 0;
  let logoHeight = 0;
  if (logo) {
    const box = imageBox(logo, Math.min(header.logoWidth ?? 110, document.contentWidth));
    // A logo the top margin cannot hold is scaled to fit rather than allowed
    // to run into the page.
    const scale = box.height > band && band > 0 ? band / box.height : 1;
    logoWidth = box.width * scale;
    logoHeight = box.height * scale;
  }

  document.onEachPage((doc, current) => {
    if (header.firstPageOnly && current !== 1) return;

    if (logo && logoHeight > 0) {
      const x = logoOnLeft ? doc.left : doc.left + doc.contentWidth - logoWidth;
      doc.drawImageAt(logo, x, baseline - logoHeight, logoWidth, logoHeight);
    }

    lines.forEach((line, index) => {
      const width = measureText(line, page.family, size);
      const x = logoOnLeft ? doc.left + doc.contentWidth - width : doc.left;
      doc.drawTextAt(line, x, baseline - textHeight + index * lineHeight, {
        size,
        color: header.color ?? page.mutedColor,
      });
    });

    if (header.rule) {
      doc.drawRule(baseline + HEADER_GAP / 3, { color: page.accentColor, thickness: 0.75 });
    }
  });
}

function renderBlock(block: PdfBlock, context: RenderContext): void {
  const { document, page, quote, fill, money } = context;

  switch (block.type) {
    case "heading": {
      document.text(fill(block.text), {
        size: block.size ?? page.fontSize + 9,
        bold: true,
        color: block.color ?? page.accentColor,
        align: alignOf(block.align),
        spaceAfter: block.spaceAfter ?? 4,
        lineHeight: 1.25,
      });
      break;
    }

    case "text": {
      document.text(fill(block.text), {
        size: block.size ?? page.fontSize,
        bold: block.bold,
        italic: block.italic,
        color: block.color ?? page.textColor,
        align: alignOf(block.align),
        spaceAfter: block.spaceAfter ?? 4,
      });
      break;
    }

    case "image": {
      const image = context.picture(block.source, "An image block");
      if (!image) break;

      document.image(image, {
        width: block.width || 120,
        align: alignOf(block.align),
        spaceAfter: block.caption ? 2 : (block.spaceAfter ?? 6),
      });

      if (block.caption) {
        document.text(fill(block.caption), {
          size: page.fontSize - 2,
          color: page.mutedColor,
          align: alignOf(block.align),
          spaceAfter: block.spaceAfter ?? 6,
        });
      }
      break;
    }

    case "spacer": {
      document.moveDown(Math.max(0, Math.min(block.height, 400)));
      break;
    }

    case "divider": {
      document.rule({ color: block.color ?? "#d4d4d8", thickness: block.thickness ?? 0.75 });
      break;
    }

    case "columns": {
      const columns = block.columns.length ? block.columns : [{ text: "" }];
      const gap = block.gap ?? 16;
      const width = (document.contentWidth - gap * (columns.length - 1)) / columns.length;
      const top = document.y;
      let tallest = 0;

      columns.forEach((column, index) => {
        const x = document.left + index * (width + gap);
        document.y = top;

        if (column.heading) {
          document.text(
            fill(column.heading),
            {
              size: page.fontSize - 1.5,
              bold: true,
              color: page.mutedColor,
              align: alignOf(column.align),
              spaceAfter: 2,
            },
            { x, width },
          );
        }

        document.text(
          fill(column.text),
          { size: page.fontSize, color: page.textColor, align: alignOf(column.align), lineHeight: 1.4 },
          { x, width },
        );

        tallest = Math.max(tallest, document.y - top);
      });

      // Every column started at the same y, so the block ends below the
      // longest of them rather than below whichever was rendered last.
      document.y = top + tallest;
      document.moveDown(6);
      break;
    }

    case "fields": {
      const rows = block.rows.filter(row => row.label || row.value);
      if (!rows.length) break;

      const labelWidth = Math.min(160, document.contentWidth * 0.35);
      const valueWidth = document.contentWidth - labelWidth;

      for (const row of rows) {
        const minimum = page.fontSize * 1.5;
        document.ensureRoom(minimum);
        const y = document.y;

        document.drawTextAt(fill(row.label), document.left, y, {
          size: page.fontSize,
          color: page.mutedColor,
        });

        // The value goes through `text` rather than `drawTextAt`, because a
        // value can be a whole address: `{{customer.address}}` is four lines
        // with newlines in it, and drawn as one string those lines would be
        // run together into "Suite 400San Francisco".
        document.y = y;
        document.text(
          fill(row.value),
          { size: page.fontSize, color: page.textColor, lineHeight: 1.5 },
          { x: document.left + labelWidth, width: valueWidth },
        );

        document.y = Math.max(document.y, y + minimum);
      }
      document.moveDown(4);
      break;
    }

    case "lineItems": {
      const columns: LineItemColumn[] = block.columns.length ? block.columns : DEFAULT_LINE_COLUMNS;

      const tableColumns: TableColumn[] = columns.map(column => ({
        header: fill(column.header),
        width: column.width,
        align: alignOf(column.align),
      }));

      // The item column is where the option list and the note belong; without
      // one there is nowhere sensible to hang them.
      const detailColumn = columns.findIndex(column => column.field === "name");

      const rows: TableCell[][] = quote.lines.map((line, index) => {
        const lineValues = lineTokenValues(line, index, quote.currency, context.locale);

        return columns.map((column, columnIndex): TableCell => {
          const detail =
            columnIndex === detailColumn ? detailFor(line, block.showOptions, block.showDescription) : undefined;

          return {
            text: lineValue(lineValues, column.field),
            detail,
            bold: column.field === "total",
            color: page.textColor,
          };
        });
      });

      document.table({
        columns: tableColumns,
        rows,
        fontSize: block.fontSize ?? page.fontSize - 0.5,
        headerFill: block.headerFill,
        headerColor: page.mutedColor,
        zebra: block.zebra,
        gridColor: "#e4e4e7",
      });

      document.moveDown(6);
      break;
    }

    case "totals": {
      const rows = (block.rows.length ? block.rows : DEFAULT_TOTALS_ROWS).filter(row => {
        if (!row.omitIfZero) return true;
        return Math.abs(totalsValue(quote, row.field)) > 0.0001;
      });
      if (!rows.length) break;

      // Right-aligned panel: a totals block belongs under the table's money
      // column, not across the whole page.
      const width = Math.min(document.contentWidth, Math.max(180, block.width ?? 260));
      const x = document.left + document.contentWidth - width;

      for (const row of rows) {
        const size = row.emphasis ? page.fontSize + 2 : page.fontSize;
        const height = size * 1.7;
        document.ensureRoom(height + (row.emphasis ? 8 : 0));

        if (row.emphasis) {
          document.moveDown(4);
          document.drawRule(document.y, { color: page.accentColor, thickness: 1, from: x, to: x + width });
          document.moveDown(4);
        }

        const y = document.y;
        const raw = totalsValue(quote, row.field);
        const value =
          row.field === "effectiveDiscountPercent"
            ? formatPercent(raw)
            : SUBTRACTIVE.has(row.field) && raw > 0
              ? `-${money(raw)}`
              : money(raw);

        document.drawTextAt(fill(row.label), x, y, {
          size,
          bold: row.emphasis,
          color: row.emphasis ? page.accentColor : page.mutedColor,
        });

        const measured = measureText(value, page.family, size);
        document.drawTextAt(value, x + width - measured, y, {
          size,
          bold: row.emphasis,
          color: row.emphasis ? page.accentColor : page.textColor,
        });

        document.y = y + height;
      }

      document.moveDown(6);
      break;
    }

    case "signatures": {
      const parties = block.parties.length ? block.parties : [{ label: "Signature" }];
      const gap = 24;
      const width = (document.contentWidth - gap * (parties.length - 1)) / parties.length;

      // A signature block split across a page break is useless, so it moves
      // whole or not at all.
      document.ensureRoom(58);
      document.moveDown(18);
      const top = document.y;

      parties.forEach((party, index) => {
        const x = document.left + index * (width + gap);
        document.drawRule(top, { color: "#a1a1aa", thickness: 0.75, from: x, to: x + width });
        document.drawTextAt(fill(party.label), x, top + 5, { size: page.fontSize - 1, color: page.textColor });
        if (party.caption) {
          document.drawTextAt(fill(party.caption), x, top + 5 + page.fontSize * 1.4, {
            size: page.fontSize - 2,
            color: page.mutedColor,
          });
        }
      });

      document.y = top + 34;
      break;
    }

    case "pageBreak": {
      document.addPage();
      break;
    }
  }
}

/** The option list and line note that hang under an item's name. */
function detailFor(line: PricedLine, showOptions?: boolean, showDescription?: boolean): string | undefined {
  const parts: string[] = [];
  if (showOptions !== false && line.optionNames.length) parts.push(line.optionNames.join(", "));
  if (showDescription !== false && line.description) parts.push(line.description);
  return parts.length ? parts.join("\n") : undefined;
}

/* ------------------------------- the default ----------------------------- */

export const DEFAULT_LINE_COLUMNS: LineItemColumn[] = [
  { field: "sku", header: "SKU", width: 2 },
  { field: "name", header: "Item", width: 6 },
  { field: "quantity", header: "Qty", width: 1.2, align: "right" },
  { field: "unitPrice", header: "Unit price", width: 2.2, align: "right" },
  { field: "total", header: "Total", width: 2.6, align: "right" },
];

export const DEFAULT_TOTALS_ROWS: TotalsRow[] = [
  { label: "List price", field: "listTotal" },
  { label: "Discount", field: "totalDiscount", omitIfZero: true },
  { label: "Shipping", field: "shipping", omitIfZero: true },
  { label: "Tax", field: "taxAmount", omitIfZero: true },
  { label: "Total", field: "grandTotal", emphasis: true },
];

/**
 * What a brand-new PDF template starts as: a complete, sendable proposal.
 *
 * Starting from a blank page would mean everyone's first template is an
 * afternoon's work; starting from this means the first one is an edit.
 */
export function starterPdfTemplate(): PdfTemplate {
  return {
    page: { ...DEFAULT_PAGE, margins: { ...DEFAULT_MARGINS } },
    blocks: [
      { type: "heading", text: "{{quote.name}}", size: 20 },
      {
        type: "text",
        text: "Quote {{quote.number}} · revision {{quote.version}} · {{quote.date}}",
        color: "#71717a",
        size: 9,
      },
      { type: "divider" },
      { type: "spacer", height: 6 },
      {
        type: "columns",
        columns: [
          {
            heading: "PREPARED FOR",
            text: "{{customer.name}}\n{{customer.contactName}}\n{{customer.address}}",
          },
          {
            heading: "PREPARED BY",
            text: "{{seller.name}}\n{{seller.email}}\nPayment terms: {{customer.paymentTerms}}",
          },
          {
            heading: "VALID UNTIL",
            text: "{{quote.validUntil}}\nTerm: {{quote.termMonths}} months\nCurrency: {{quote.currency}}",
            align: "right",
          },
        ],
      },
      { type: "spacer", height: 10 },
      {
        type: "lineItems",
        columns: DEFAULT_LINE_COLUMNS,
        showOptions: true,
        showDescription: true,
        headerFill: "#f4f4f5",
        zebra: "#fafafa",
      },
      { type: "totals", rows: DEFAULT_TOTALS_ROWS, width: 250 },
      { type: "spacer", height: 8 },
      { type: "text", text: "{{quote.notes}}", size: 9, color: "#52525b" },
      {
        type: "signatures",
        parties: [
          { label: "{{customer.name}}", caption: "Name, title and date" },
          { label: "{{seller.name}}", caption: "Name, title and date" },
        ],
      },
    ],
    footer: {
      text: "{{quote.number}} · {{customer.name}}",
      showPageNumbers: true,
    },
  };
}

/* --------------------------------- blanks -------------------------------- */

/*
 * What each block type starts as when it is added to a template.
 *
 * Here rather than in the editor because it is a fact about the format — a
 * freshly added block has to be one the renderer can draw, and that is worth
 * a test rather than a careful reading of the component.
 */

export function blankBlock(type: PdfBlock["type"]): PdfBlock {
  switch (type) {
    case "heading":
      return { type: "heading", text: "{{quote.name}}", size: 18 };
    case "text":
      return { type: "text", text: "" };
    // A picture has to be chosen; an empty source renders as nothing at all,
    // which is the right blank state for a block the editor opens on.
    case "image":
      return { type: "image", source: "", width: 140 };
    case "spacer":
      return { type: "spacer", height: 12 };
    case "divider":
      return { type: "divider" };
    case "columns":
      return {
        type: "columns",
        columns: [
          { heading: "PREPARED FOR", text: "{{customer.name}}\n{{customer.address}}" },
          { heading: "PREPARED BY", text: "{{seller.name}}\n{{seller.email}}" },
        ],
      };
    case "fields":
      return { type: "fields", rows: [{ label: "Quote", value: "{{quote.number}}" }] };
    case "lineItems":
      return {
        type: "lineItems",
        columns: structuredClone(DEFAULT_LINE_COLUMNS),
        showOptions: true,
        showDescription: true,
        headerFill: "#f4f4f5",
      };
    case "totals":
      return { type: "totals", rows: structuredClone(DEFAULT_TOTALS_ROWS), width: 250 };
    case "signatures":
      return {
        type: "signatures",
        parties: [
          { label: "{{customer.name}}", caption: "Name, title and date" },
          { label: "{{seller.name}}", caption: "Name, title and date" },
        ],
      };
    case "pageBreak":
      return { type: "pageBreak" };
  }
}
