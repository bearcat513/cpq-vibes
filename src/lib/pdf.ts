/**
 * A PDF writer, written by hand.
 *
 * A quote has to leave this app as a PDF, because that is the file a customer
 * expects and a procurement system accepts. The two usual ways to produce one
 * are to drive a headless browser — which means shipping a browser in the
 * container — or to pull in a rendering library. Neither is a good trade for
 * a document whose whole vocabulary is text, rules, filled rectangles and a
 * table, so this writes the file directly.
 *
 * That is the same call this codebase already makes for the formula language
 * and for CSV: the format is small enough at the size we use it that owning it
 * costs less than depending on it. The output is a plain PDF 1.7 file using
 * only the standard 14 fonts (see ./pdfFonts.ts), so it opens anywhere and
 * weighs a few kilobytes.
 *
 * ## What is here
 *
 * `PdfDocument` is a **cursor**, not a canvas. You add blocks top to bottom —
 * a heading, a paragraph, a table — and it tracks where it is on the page,
 * starts a new one when it runs out of room, and repeats table headers across
 * the break. Coordinates are in points (72 per inch) with the origin at the
 * top left, which is the opposite of PDF's own convention; the conversion
 * happens in exactly one place, `toPdfY`.
 *
 * ## Images
 *
 * One exception to "text, rules and rectangles": a document that goes to a
 * customer carries the sender's logo on it, so `drawImage` writes an image
 * XObject. It still decodes nothing — `src/lib/image.ts` establishes that the
 * bytes are already in a filter PDF speaks, and they are copied into the file
 * as they are. The same picture used on every page is one object.
 *
 * ## What is not
 *
 * No embedded fonts, no links, no forms. Each of those is a real feature with
 * a real cost, and none of them is needed to put a priced quote in front of a
 * buyer. The omissions are deliberate rather than pending.
 */
import type { EmbeddableImage } from "./image";
import {
  baseFontName,
  encodeWinAnsi,
  fontKey,
  measureText,
  truncateToWidth,
  wrapText,
  type FontFamily,
  type FontStyle,
} from "./pdfFonts";

/* --------------------------------- paper --------------------------------- */

export type PageSize = "A4" | "Letter" | "Legal";

export const PAGE_SIZES: PageSize[] = ["A4", "Letter", "Legal"];

/** Width and height in points. */
const PAGE_DIMENSIONS: Record<PageSize, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
};

export type Margins = { top: number; right: number; bottom: number; left: number };

export type DocumentOptions = {
  size: PageSize;
  margins: Margins;
  family: FontFamily;
  /** Body size in points; headings are derived from it by the template. */
  fontSize: number;
  color: string;
  title?: string;
  author?: string;
  subject?: string;
};

export const DEFAULT_MARGINS: Margins = { top: 56, right: 48, bottom: 56, left: 48 };

/* --------------------------------- colour -------------------------------- */

/**
 * `#rgb`, `#rrggbb` or a bare name, as the three components PDF wants.
 *
 * An unreadable colour falls back to black rather than throwing: a template
 * with a typo in one swatch should still produce a document.
 */
export function parseColor(value: string | undefined, fallback = "#000000"): [number, number, number] {
  const raw = (value ?? fallback).trim();

  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (!hex) return raw === fallback ? [0, 0, 0] : parseColor(fallback, "#000000");

  const digits = hex[1]!;
  const full = digits.length === 3 ? digits.replace(/./g, char => char + char) : digits;

  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

const colorOp = (value: string | undefined, stroke = false): string => {
  const [r, g, b] = parseColor(value);
  return `${round(r)} ${round(g)} ${round(b)} ${stroke ? "RG" : "rg"}`;
};

/** PDF numbers: three decimals is far finer than a printer can resolve. */
const round = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 1000) / 1000);
};

/* ------------------------------- text styles ------------------------------ */

export type TextStyle = {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
  /** Multiplied by the font size to get the baseline-to-baseline distance. */
  lineHeight?: number;
  /** Extra space above and below the block. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Overrides the document's family for this block. */
  family?: FontFamily;
};

export type TableColumn = {
  /** Heading text. Empty renders a heading-less column. */
  header: string;
  /** Share of the available width. Normalised across the row. */
  width: number;
  align?: "left" | "center" | "right";
};

export type TableCell = {
  text: string;
  /** A second, smaller line under the main one — options, a note. */
  detail?: string;
  bold?: boolean;
  color?: string;
};

export type TableOptions = {
  columns: TableColumn[];
  rows: TableCell[][];
  fontSize?: number;
  headerFill?: string;
  headerColor?: string;
  /** Tint every other row, which is what makes a wide table readable. */
  zebra?: string;
  gridColor?: string;
  /** Draw a rule under each row. */
  rowLines?: boolean;
  cellPadding?: number;
};

/* -------------------------------- the file ------------------------------- */

/**
 * One indirect object, held as bytes so binary content streams and ASCII
 * dictionaries can sit in the same array without an encoding step later.
 */
type PdfObject = { id: number; bytes: number[] };

const ascii = (text: string): number[] => {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  return bytes;
};

/** `(…)` string literal: the three characters PDF treats specially. */
function pdfString(text: string): number[] {
  const bytes: number[] = [0x28]; // (
  for (const byte of encodeWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c); // \
    bytes.push(byte);
  }
  bytes.push(0x29); // )
  return bytes;
}

/** A date in PDF's own format: `D:YYYYMMDDHHmmSS+00'00'`. */
function pdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

type Page = {
  /** Content stream operators, joined at the end. */
  operators: string[];
  /** Font keys used, so the page's resource dictionary is minimal. */
  fonts: Set<string>;
  /** Image resource names used, for the same reason. */
  images: Set<string>;
};

/** A hex string literal, which is how a palette reaches the file. */
const pdfHex = (bytes: Uint8Array): string => {
  let text = "<";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return `${text}>`;
};

export class PdfDocument {
  readonly width: number;
  readonly height: number;
  readonly margins: Margins;
  readonly family: FontFamily;
  readonly fontSize: number;
  readonly color: string;

  private readonly options: DocumentOptions;
  private readonly pages: Page[] = [];
  private page: Page;

  /**
   * Every face the document has drawn with, by resource name.
   *
   * Kept as a record rather than recovered from the name later: the name is
   * for the PDF's benefit, and reading style bits back out of it is how
   * "helvetica" comes out italic because it contains an "i".
   */
  private readonly faces = new Map<string, { family: FontFamily; style: FontStyle }>();

  /**
   * Every image drawn, and the resource name it was given.
   *
   * A letterhead is the same picture on all eight pages of a proposal, so one
   * entry per distinct image is the difference between a 30 kB file and a
   * 240 kB one. Keyed on the decoded image *itself* rather than on anything
   * about its bytes: the caller decodes each source once and hands the same
   * object back, and two different logos that happened to agree on type, size
   * and byte count would otherwise print as one.
   */
  private readonly pictures = new Map<EmbeddableImage, string>();

  /** Distance from the top of the page to the next thing drawn. */
  private cursor: number;

  /**
   * Drawn onto every page once the document is finished.
   *
   * A list rather than one callback, because a branded document has two of
   * them — a letterhead at the top and a footer at the bottom — and neither
   * can be drawn while the page count is still unknown.
   */
  private readonly overlays: ((document: PdfDocument, page: number, total: number) => void)[] = [];

  constructor(options: Partial<DocumentOptions> = {}) {
    this.options = {
      size: options.size ?? "A4",
      margins: { ...DEFAULT_MARGINS, ...(options.margins ?? {}) },
      family: options.family ?? "helvetica",
      fontSize: options.fontSize ?? 10,
      color: options.color ?? "#111111",
      title: options.title,
      author: options.author,
      subject: options.subject,
    };

    const dimensions = PAGE_DIMENSIONS[this.options.size];
    this.width = dimensions.width;
    this.height = dimensions.height;
    this.margins = this.options.margins;
    this.family = this.options.family;
    this.fontSize = this.options.fontSize;
    this.color = this.options.color;

    this.page = { operators: [], fonts: new Set(), images: new Set() };
    this.pages.push(this.page);
    this.cursor = this.margins.top;
  }

  /* ------------------------------ geometry ------------------------------ */

  /** Usable width between the margins. */
  get contentWidth(): number {
    return this.width - this.margins.left - this.margins.right;
  }

  /** The y at which content must stop. */
  get contentBottom(): number {
    return this.height - this.margins.bottom;
  }

  get left(): number {
    return this.margins.left;
  }

  get y(): number {
    return this.cursor;
  }

  set y(value: number) {
    this.cursor = value;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Top-left origin to PDF's bottom-left one. The only place this flips. */
  private toPdfY(y: number): number {
    return this.height - y;
  }

  get remaining(): number {
    return this.contentBottom - this.cursor;
  }

  /* ------------------------------- pages -------------------------------- */

  addPage(): void {
    this.page = { operators: [], fonts: new Set(), images: new Set() };
    this.pages.push(this.page);
    this.cursor = this.margins.top;
  }

  /**
   * Starts a new page when `height` will not fit on this one.
   *
   * Called by every block before it draws, which is what makes the cursor
   * model work: nothing has to know how tall the page is.
   */
  ensureRoom(height: number): void {
    if (this.cursor + height <= this.contentBottom) return;
    // A block taller than a whole page would loop forever; let it overflow the
    // one it starts on instead, which at least produces a readable document.
    if (height > this.contentBottom - this.margins.top) return;
    this.addPage();
  }

  moveDown(points: number): void {
    this.cursor += points;
  }

  /* ------------------------------ primitives ---------------------------- */

  private op(operator: string): void {
    this.page.operators.push(operator);
  }

  /** Draws one line of text at an absolute position. Does not move the cursor. */
  drawTextAt(text: string, x: number, y: number, style: TextStyle = {}): void {
    if (!text) return;

    const family = style.family ?? this.family;
    const size = style.size ?? this.fontSize;
    const fontStyle: FontStyle = { bold: style.bold, italic: style.italic };
    const key = fontKey(family, fontStyle);
    this.page.fonts.add(key);
    if (!this.faces.has(key)) this.faces.set(key, { family, style: fontStyle });

    // The baseline sits below the top of the line box; 0.8em is the usual
    // approximation of the cap height plus a little breathing room, and it is
    // what makes a row of text look vertically centred in its band.
    const baseline = this.toPdfY(y + size * 0.8);

    const bytes: number[] = [];
    this.op("BT");
    this.op(`/${key} ${round(size)} Tf`);
    this.op(colorOp(style.color ?? this.color));
    this.op(`1 0 0 1 ${round(x)} ${round(baseline)} Tm`);
    // The string is bytes, so it is pushed through a marker the serializer
    // replaces — see `serializeOperators`.
    for (const byte of pdfString(text)) bytes.push(byte);
    this.op(` ${bytes.join(",")}  Tj`);
    this.op("ET");
  }

  /** A horizontal rule across the content width, and past it if asked. */
  drawRule(y: number, options: { color?: string; thickness?: number; from?: number; to?: number } = {}): void {
    const from = options.from ?? this.margins.left;
    const to = options.to ?? this.width - this.margins.right;
    const pdfY = this.toPdfY(y);

    this.op("q");
    this.op(colorOp(options.color ?? "#d4d4d8", true));
    this.op(`${round(options.thickness ?? 0.75)} w`);
    this.op(`${round(from)} ${round(pdfY)} m ${round(to)} ${round(pdfY)} l S`);
    this.op("Q");
  }

  drawRect(x: number, y: number, width: number, height: number, fill: string): void {
    if (width <= 0 || height <= 0) return;
    this.op("q");
    this.op(colorOp(fill));
    this.op(`${round(x)} ${round(this.toPdfY(y + height))} ${round(width)} ${round(height)} re f`);
    this.op("Q");
  }

  /**
   * Draws an image at an absolute position. Does not move the cursor.
   *
   * An image XObject is drawn into the unit square, so the placement *is* the
   * transformation matrix: scale by the size it should occupy, translate to
   * where its bottom-left corner goes. Nothing about the picture's own pixels
   * comes into it, which is why this writer never has to decode one.
   */
  drawImageAt(image: EmbeddableImage, x: number, y: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;

    let name = this.pictures.get(image);
    if (!name) {
      name = `Im${this.pictures.size + 1}`;
      this.pictures.set(image, name);
    }
    this.page.images.add(name);

    this.op("q");
    this.op(`${round(width)} 0 0 ${round(height)} ${round(x)} ${round(this.toPdfY(y + height))} cm`);
    this.op(`/${name} Do`);
    this.op("Q");
  }

  /* -------------------------------- blocks ------------------------------- */

  /**
   * An image in the flow: placed at the cursor, which then moves past it.
   *
   * Only a width is asked for. The height follows from the picture's own
   * proportions, because a logo stretched to fill a box is the single most
   * obvious sign that a document was generated rather than designed.
   */
  image(
    image: EmbeddableImage,
    options: { width: number; align?: "left" | "center" | "right"; spaceAfter?: number } = { width: 120 },
  ): number {
    const width = Math.max(1, Math.min(options.width, this.contentWidth));
    const height = (width * image.height) / image.width;

    this.ensureRoom(height);

    const x =
      options.align === "center"
        ? this.margins.left + (this.contentWidth - width) / 2
        : options.align === "right"
          ? this.margins.left + this.contentWidth - width
          : this.margins.left;

    this.drawImageAt(image, x, this.cursor, width, height);
    this.cursor += height + (options.spaceAfter ?? 0);
    return height;
  }

  /**
   * A paragraph: wrapped, aligned, and advancing the cursor past itself.
   *
   * Returns the height it used, so a caller laying out columns can line the
   * next thing up with the tallest of them.
   */
  text(content: string, style: TextStyle = {}, options: { x?: number; width?: number; draw?: boolean } = {}): number {
    const size = style.size ?? this.fontSize;
    const lineHeight = size * (style.lineHeight ?? 1.35);
    const width = options.width ?? this.contentWidth;
    const x = options.x ?? this.margins.left;
    const draw = options.draw !== false;

    const spaceBefore = style.spaceBefore ?? 0;
    const spaceAfter = style.spaceAfter ?? 0;

    const lines = wrapText(content, width, style.family ?? this.family, size, {
      bold: style.bold,
      italic: style.italic,
    });
    const height = spaceBefore + lines.length * lineHeight + spaceAfter;

    if (!draw) return height;

    // Keep at least the first two lines together rather than orphaning one.
    this.ensureRoom(Math.min(height, spaceBefore + lineHeight * Math.min(2, lines.length)));
    this.cursor += spaceBefore;

    for (const line of lines) {
      // A page break mid-paragraph is fine; a line drawn past the margin is not.
      this.ensureRoom(lineHeight);

      const drawn = line;
      let lineX = x;
      if (style.align === "center" || style.align === "right") {
        const measured = measureText(drawn, style.family ?? this.family, size, {
          bold: style.bold,
          italic: style.italic,
        });
        lineX = style.align === "center" ? x + (width - measured) / 2 : x + width - measured;
      }

      this.drawTextAt(drawn, lineX, this.cursor, style);
      this.cursor += lineHeight;
    }

    this.cursor += spaceAfter;
    return height;
  }

  /** A rule at the cursor, with space around it. */
  rule(options: { color?: string; thickness?: number; spaceBefore?: number; spaceAfter?: number } = {}): void {
    const before = options.spaceBefore ?? 6;
    const after = options.spaceAfter ?? 6;
    this.ensureRoom(before + after + 1);
    this.cursor += before;
    this.drawRule(this.cursor, { color: options.color, thickness: options.thickness });
    this.cursor += after;
  }

  /**
   * A table, broken across pages with its header repeated.
   *
   * Column widths are shares rather than points, so a template does not have
   * to know the page size or the margins — the same table works on A4 and
   * Letter, and a wider margin narrows the columns rather than clipping them.
   */
  table(options: TableOptions): void {
    const size = options.fontSize ?? this.fontSize - 0.5;
    const padding = options.cellPadding ?? 5;
    const detailSize = size - 1.5;

    const total = options.columns.reduce((sum, column) => sum + Math.max(0, column.width), 0) || 1;
    const widths = options.columns.map(column => (Math.max(0, column.width) / total) * this.contentWidth);

    const positions: number[] = [];
    let x = this.margins.left;
    for (const width of widths) {
      positions.push(x);
      x += width;
    }

    const hasHeader = options.columns.some(column => column.header.trim() !== "");
    const headerHeight = size * 1.35 + padding * 2;

    const drawHeader = () => {
      if (!hasHeader) return;
      this.ensureRoom(headerHeight);
      if (options.headerFill) {
        this.drawRect(this.margins.left, this.cursor, this.contentWidth, headerHeight, options.headerFill);
      }

      options.columns.forEach((column, index) => {
        if (!column.header) return;
        const cellWidth = widths[index]! - padding * 2;
        const label = truncateToWidth(column.header, cellWidth, this.family, size, { bold: true });
        const measured = measureText(label, this.family, size, { bold: true });
        const cellX =
          column.align === "right"
            ? positions[index]! + widths[index]! - padding - measured
            : column.align === "center"
              ? positions[index]! + (widths[index]! - measured) / 2
              : positions[index]! + padding;

        this.drawTextAt(label, cellX, this.cursor + padding, {
          size,
          bold: true,
          color: options.headerColor ?? "#52525b",
        });
      });

      this.cursor += headerHeight;
      this.drawRule(this.cursor, { color: options.gridColor ?? "#a1a1aa", thickness: 0.75 });
    };

    drawHeader();

    options.rows.forEach((row, rowIndex) => {
      // The tallest cell decides the row: a wrapped product name must not be
      // written over by the row beneath it.
      let lines = 1;
      let hasDetail = false;
      row.forEach((cell, index) => {
        const cellWidth = (widths[index] ?? 0) - padding * 2;
        lines = Math.max(lines, wrapText(cell.text ?? "", cellWidth, this.family, size, { bold: cell.bold }).length);
        if (cell.detail) hasDetail = true;
      });

      const detailLines = hasDetail
        ? Math.max(
            ...row.map(cell =>
              cell.detail
                ? wrapText(cell.detail, (widths[row.indexOf(cell)] ?? this.contentWidth) - padding * 2, this.family, detailSize)
                    .length
                : 0,
            ),
          )
        : 0;

      const rowHeight = padding * 2 + lines * size * 1.35 + detailLines * detailSize * 1.3;

      // A row that does not fit starts the next page, under a repeated header.
      if (this.cursor + rowHeight > this.contentBottom) {
        this.addPage();
        drawHeader();
      }

      if (options.zebra && rowIndex % 2 === 1) {
        this.drawRect(this.margins.left, this.cursor, this.contentWidth, rowHeight, options.zebra);
      }

      row.forEach((cell, index) => {
        const column = options.columns[index];
        if (!column) return;

        const cellWidth = widths[index]! - padding * 2;
        const textLines = wrapText(cell.text ?? "", cellWidth, this.family, size, { bold: cell.bold });

        textLines.forEach((line, lineIndex) => {
          const measured = measureText(line, this.family, size, { bold: cell.bold });
          const cellX =
            column.align === "right"
              ? positions[index]! + widths[index]! - padding - measured
              : column.align === "center"
                ? positions[index]! + (widths[index]! - measured) / 2
                : positions[index]! + padding;

          this.drawTextAt(line, cellX, this.cursor + padding + lineIndex * size * 1.35, {
            size,
            bold: cell.bold,
            color: cell.color,
          });
        });

        if (cell.detail) {
          const detail = wrapText(cell.detail, cellWidth, this.family, detailSize);
          detail.forEach((line, lineIndex) => {
            this.drawTextAt(
              line,
              positions[index]! + padding,
              this.cursor + padding + textLines.length * size * 1.35 + lineIndex * detailSize * 1.3,
              { size: detailSize, color: "#71717a" },
            );
          });
        }
      });

      this.cursor += rowHeight;

      if (options.rowLines !== false) {
        this.drawRule(this.cursor, { color: options.gridColor ?? "#e4e4e7", thickness: 0.5 });
      }
    });
  }

  /* ---------------------------- page furniture --------------------------- */

  /**
   * Registered now, drawn once the page count is known.
   *
   * "Page 2 of 7" cannot be written while page 2 is being laid out, so
   * anything that belongs on every page is deferred to `toBytes`. The cursor
   * is parked on the footer line before each call, which is where a footer
   * wants it; a letterhead ignores it and draws into the top margin by
   * absolute coordinates, since that is the one region content never occupies.
   */
  onEachPage(draw: (document: PdfDocument, page: number, total: number) => void): void {
    this.overlays.push(draw);
  }

  private runOverlays(): void {
    if (!this.overlays.length) return;
    const total = this.pages.length;
    const saved = this.page;
    const savedCursor = this.cursor;

    this.pages.forEach((page, index) => {
      this.page = page;
      for (const overlay of this.overlays) {
        // Into the bottom margin, where content is not allowed to go.
        this.cursor = this.height - this.margins.bottom + 14;
        overlay(this, index + 1, total);
      }
    });

    this.page = saved;
    this.cursor = savedCursor;
  }

  /* ------------------------------ serializing ---------------------------- */

  /**
   * Operators are strings except for the text literals, which are byte runs
   * marked with NULs by `drawTextAt`. This turns the mix into bytes.
   */
  private serializeOperators(operators: string[]): number[] {
    const bytes: number[] = [];

    for (const operator of operators) {
      const start = operator.indexOf(" ");
      if (start === -1) {
        bytes.push(...ascii(operator));
      } else {
        const end = operator.indexOf(" ", start + 1);
        bytes.push(...ascii(operator.slice(0, start)));
        for (const part of operator.slice(start + 1, end).split(",")) bytes.push(Number(part));
        bytes.push(...ascii(operator.slice(end + 1)));
      }
      bytes.push(0x0a);
    }

    return bytes;
  }

  /** The finished file. */
  toBytes(): Uint8Array {
    this.runOverlays();

    const objects: PdfObject[] = [];
    let nextId = 1;
    const add = (bytes: number[]): number => {
      const id = nextId++;
      objects.push({ id, bytes });
      return id;
    };

    // Every face used anywhere, so pages can share the dictionaries.
    const used = new Set<string>(this.faces.keys());
    // Always at least one, so a page with no text still has valid resources.
    if (!used.size) {
      const key = fontKey(this.family);
      used.add(key);
      this.faces.set(key, { family: this.family, style: {} });
    }

    const fontIds = new Map<string, number>();
    for (const key of [...used].sort()) {
      const face = this.faces.get(key)!;
      fontIds.set(
        key,
        add(
          ascii(
            `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFontName(face.family, face.style)} ` +
              "/Encoding /WinAnsiEncoding >>",
          ),
        ),
      );
    }

    /* --- one XObject per distinct picture, however many pages use it --- */

    const imageIds = new Map<string, number>();
    for (const [image, name] of this.pictures) {
      const colorSpace =
        image.colorSpace.kind === "indexed"
          ? `[/Indexed /DeviceRGB ${image.colorSpace.hival} ${pdfHex(image.colorSpace.palette)}]`
          : image.colorSpace.kind === "rgb"
            ? "/DeviceRGB"
            : "/DeviceGray";

      // The predictor is how a PNG's own per-scanline filtering survives the
      // trip: the stream is the file's `IDAT`, and this tells the reader to
      // undo exactly what the encoder did.
      const parms = image.predictor
        ? ` /DecodeParms << /Predictor ${image.predictor.predictor} /Colors ${image.predictor.colors} ` +
          `/BitsPerComponent ${image.predictor.bitsPerComponent} /Columns ${image.predictor.columns} >>`
        : "";

      imageIds.set(
        name,
        add([
          ...ascii(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
              `/ColorSpace ${colorSpace} /BitsPerComponent ${image.bitsPerComponent} ` +
              `/Filter /${image.filter}${parms} /Length ${image.data.length} >>\nstream\n`,
          ),
          ...image.data,
          ...ascii("\nendstream"),
        ]),
      );
    }

    const pagesId = nextId++; // reserved: each page needs it as its /Parent
    const pageIds: number[] = [];

    for (const page of this.pages) {
      const content = this.serializeOperators(page.operators);
      const contentId = add([...ascii(`<< /Length ${content.length} >>\nstream\n`), ...content, ...ascii("\nendstream")]);

      const fonts = [...(page.fonts.size ? page.fonts : used)]
        .sort()
        .map(key => `/${key} ${fontIds.get(key)} 0 R`)
        .join(" ");

      const images = [...page.images]
        .sort()
        .map(name => `/${name} ${imageIds.get(name)} 0 R`)
        .join(" ");

      pageIds.push(
        add(
          ascii(
            `<< /Type /Page /Parent ${pagesId} 0 R ` +
              `/MediaBox [0 0 ${round(this.width)} ${round(this.height)}] ` +
              `/Resources << /Font << ${fonts} >>${images ? ` /XObject << ${images} >>` : ""} >> ` +
              `/Contents ${contentId} 0 R >>`,
          ),
        ),
      );
    }

    objects.push({
      id: pagesId,
      bytes: ascii(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`),
    });

    const catalogId = add(ascii(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));

    const info: number[] = [
      ...ascii("<< "),
      ...(this.options.title ? [...ascii("/Title "), ...pdfString(this.options.title), ...ascii(" ")] : []),
      ...(this.options.author ? [...ascii("/Author "), ...pdfString(this.options.author), ...ascii(" ")] : []),
      ...(this.options.subject ? [...ascii("/Subject "), ...pdfString(this.options.subject), ...ascii(" ")] : []),
      ...ascii("/Producer "),
      ...pdfString("CPQ"),
      ...ascii(" /CreationDate "),
      ...pdfString(pdfDate(new Date())),
      ...ascii(" >>"),
    ];
    const infoId = add(info);

    /* --- assemble, recording the offset of every object for the xref --- */

    const file: number[] = [];
    const push = (bytes: number[]) => file.push(...bytes);

    push(ascii("%PDF-1.7\n"));
    // A comment of high bytes, which is how a reader tells the file is binary.
    push([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);

    const offsets = new Map<number, number>();
    for (const object of [...objects].sort((a, b) => a.id - b.id)) {
      offsets.set(object.id, file.length);
      push(ascii(`${object.id} 0 obj\n`));
      push(object.bytes);
      push(ascii("\nendobj\n"));
    }

    const xrefOffset = file.length;
    const count = objects.length + 1;

    push(ascii(`xref\n0 ${count}\n`));
    push(ascii("0000000000 65535 f \n"));
    for (let id = 1; id < count; id++) {
      push(ascii(`${String(offsets.get(id) ?? 0).padStart(10, "0")} 00000 n \n`));
    }

    push(ascii(`trailer\n<< /Size ${count} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`));
    push(ascii(`startxref\n${xrefOffset}\n%%EOF\n`));

    return Uint8Array.from(file);
  }
}

/** Convenience for the routes, which answer with a `Response`. */
export const pdfResponse = (bytes: Uint8Array, fileName: string, inline = false): Response =>
  new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileName}"`,
      "Content-Length": String(bytes.length),
    },
  });
