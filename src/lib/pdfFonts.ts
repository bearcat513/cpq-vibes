/**
 * Font metrics and text encoding for the PDF writer.
 *
 * Only the PDF standard 14 fonts are used — Helvetica, Times and Courier, in
 * their four styles each. Every PDF reader has them built in, which means a
 * quote is a few kilobytes rather than a few hundred, and it renders the same
 * everywhere without embedding anything. The cost is that this file has to
 * know how wide each glyph is, because nothing else can measure text for us:
 * wrapping a paragraph, right-aligning a column of money and fitting a table
 * to the page all need a width in advance.
 *
 * The numbers below are Adobe's own AFM widths, in 1/1000 em. Two facts keep
 * the tables small:
 *
 * - The oblique and italic *Helvetica* faces have the same advance widths as
 *   their upright counterparts, so they share a table.
 * - An accented Latin letter has the same advance width as the letter it is
 *   built on — `é` is exactly as wide as `e` — so the high range is a
 *   character map rather than another 224 numbers per face.
 *
 * Text is encoded as WinAnsi, which is what the font dictionaries declare. It
 * covers Latin-1 plus the punctuation this app actually emits — the em dashes,
 * curly quotes, `·` and `×` that run through the rest of the UI, and the €, £
 * and ¥ symbols the currency formatter produces.
 */

export type FontFamily = "helvetica" | "times" | "courier";

export const FONT_FAMILIES: FontFamily[] = ["helvetica", "times", "courier"];

/** A resolved face: the family plus the two style bits. */
export type FontStyle = { bold?: boolean; italic?: boolean };

/* ------------------------------- the widths ------------------------------ */

/**
 * Widths for codes 32-126, in order. Everything outside that range is handled
 * by `ACCENT_BASE` (accented letters) or `EXTRA_WIDTHS` (punctuation).
 */
// prettier-ignore
const HELVETICA = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];

// prettier-ignore
const HELVETICA_BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
];

// prettier-ignore
const TIMES = [
  250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,
  921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,
  556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,
  333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,
  500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,
];

// prettier-ignore
const TIMES_BOLD = [
  250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,
  930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,
  611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,
  333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,
  556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,
];

// prettier-ignore
const TIMES_ITALIC = [
  250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,
  920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,
  611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,
  333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,
  500,500,389,389,278,500,444,667,444,444,389,400,275,400,541,
];

// prettier-ignore
const TIMES_BOLD_ITALIC = [
  250,389,555,500,500,833,778,278,333,333,500,570,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,
  832,667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,
  611,722,667,556,611,722,667,889,667,611,611,333,278,333,570,500,
  333,500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,
  500,500,389,389,278,556,444,667,500,444,389,348,220,348,570,
];

/** Courier is monospaced: every glyph, in every style, is 600. */
const COURIER_WIDTH = 600;

/* --------------------------- the WinAnsi extras -------------------------- */

/**
 * An accented letter advances exactly as far as its base letter in all of
 * these faces, so the high range costs one lookup rather than another table.
 * Keyed by WinAnsi byte.
 */
// prettier-ignore
const ACCENT_BASE: Record<number, string> = {
  0xc0:"A",0xc1:"A",0xc2:"A",0xc3:"A",0xc4:"A",0xc5:"A",0xc7:"C",
  0xc8:"E",0xc9:"E",0xca:"E",0xcb:"E",0xcc:"I",0xcd:"I",0xce:"I",0xcf:"I",
  0xd1:"N",0xd2:"O",0xd3:"O",0xd4:"O",0xd5:"O",0xd6:"O",0xd8:"O",
  0xd9:"U",0xda:"U",0xdb:"U",0xdc:"U",0xdd:"Y",0xde:"P",
  0xe0:"a",0xe1:"a",0xe2:"a",0xe3:"a",0xe4:"a",0xe5:"a",0xe7:"c",
  0xe8:"e",0xe9:"e",0xea:"e",0xeb:"e",0xec:"i",0xed:"i",0xee:"i",0xef:"i",
  0xf1:"n",0xf2:"o",0xf3:"o",0xf4:"o",0xf5:"o",0xf6:"o",0xf8:"o",
  0xf9:"u",0xfa:"u",0xfb:"u",0xfc:"u",0xfd:"y",0xfe:"p",0xff:"y",
  0xdf:"B",0x8a:"S",0x9a:"s",0x8e:"Z",0x9e:"z",0x9f:"Y",0x83:"f",
  0xa0:" ",0xad:"-",
};

/**
 * Punctuation and symbols with no base letter. Helvetica and Times differ
 * enough here to be worth splitting; Courier does not care.
 */
// prettier-ignore
const EXTRA_WIDTHS: Record<"helvetica" | "times", Record<number, number>> = {
  helvetica: {
    0x80:556,0x82:222,0x84:333,0x85:1000,0x86:556,0x87:556,0x88:333,0x89:1000,
    0x8b:333,0x8c:1000,0x91:222,0x92:222,0x93:333,0x94:333,0x95:350,0x96:556,
    0x97:1000,0x98:333,0x99:1000,0x9b:333,0x9c:944,
    0xa1:333,0xa2:556,0xa3:556,0xa4:556,0xa5:556,0xa6:260,0xa7:556,0xa8:333,
    0xa9:737,0xaa:370,0xab:556,0xac:584,0xae:737,0xaf:333,0xb0:400,0xb1:584,
    0xb2:333,0xb3:333,0xb4:333,0xb5:556,0xb6:537,0xb7:278,0xb8:333,0xb9:333,
    0xba:365,0xbb:556,0xbc:834,0xbd:834,0xbe:834,0xbf:611,0xc6:1000,0xd0:722,
    0xd7:584,0xe6:889,0xf0:556,0xf7:584,
  },
  times: {
    0x80:500,0x82:333,0x84:444,0x85:1000,0x86:500,0x87:500,0x88:333,0x89:1000,
    0x8b:333,0x8c:889,0x91:333,0x92:333,0x93:444,0x94:444,0x95:350,0x96:500,
    0x97:1000,0x98:333,0x99:980,0x9b:333,0x9c:722,
    0xa1:333,0xa2:500,0xa3:500,0xa4:500,0xa5:500,0xa6:200,0xa7:500,0xa8:333,
    0xa9:760,0xaa:276,0xab:500,0xac:564,0xae:760,0xaf:333,0xb0:400,0xb1:564,
    0xb2:300,0xb3:300,0xb4:333,0xb5:500,0xb6:453,0xb7:250,0xb8:333,0xb9:300,
    0xba:310,0xbb:500,0xbc:750,0xbd:750,0xbe:750,0xbf:444,0xc6:889,0xd0:722,
    0xd7:564,0xe6:667,0xf0:500,0xf7:564,
  },
};

/* -------------------------------- encoding ------------------------------- */

/**
 * The WinAnsi slots that are not Latin-1. Everything else in 0x20-0xFF maps to
 * its own code point, which is what makes this map short.
 */
// prettier-ignore
const WIN_ANSI_SPECIALS: Record<number, number> = {
  0x20ac:0x80, 0x201a:0x82, 0x0192:0x83, 0x201e:0x84, 0x2026:0x85, 0x2020:0x86,
  0x2021:0x87, 0x02c6:0x88, 0x2030:0x89, 0x0160:0x8a, 0x2039:0x8b, 0x0152:0x8c,
  0x017d:0x8e, 0x2018:0x91, 0x2019:0x92, 0x201c:0x93, 0x201d:0x94, 0x2022:0x95,
  0x2013:0x96, 0x2014:0x97, 0x02dc:0x98, 0x2122:0x99, 0x0161:0x9a, 0x203a:0x9b,
  0x0153:0x9c, 0x017e:0x9e, 0x0178:0x9f,
};

/**
 * Characters WinAnsi cannot hold, spelled the closest way it can.
 *
 * A quote is a commercial document, so a glyph that cannot be encoded should
 * degrade to something a reader understands rather than to a black box: `✓`
 * becomes `x`, `≥` becomes `>=`. Anything still unmapped becomes `?`, which is
 * at least visibly wrong rather than silently missing.
 */
const TRANSLITERATIONS: Record<string, string> = {
  // U+2212 MINUS SIGN is not in WinAnsi, and a negative total is the last
  // place a "?" should turn up.
  "−": "-",
  "‒": "-",
  "―": "—",
  "→": "->",
  "←": "<-",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "✓": "x",
  "✔": "x",
  "✗": "x",
  "∞": "inf",
  " ": " ",
  " ": " ",
  " ": " ",
  "​": "",
  "\t": "    ",
};

/**
 * Encodes a string to WinAnsi bytes.
 *
 * Returned as a byte array rather than a string because the content stream is
 * assembled as bytes — a PDF is a binary file, and treating a `é` as a UTF-16
 * code unit somewhere along the way is how the byte offsets in the cross
 * reference table stop matching the file.
 */
export function encodeWinAnsi(text: string): number[] {
  const bytes: number[] = [];

  for (const character of text) {
    const replacement = TRANSLITERATIONS[character];
    if (replacement !== undefined) {
      for (const plain of replacement) bytes.push(plain.charCodeAt(0));
      continue;
    }

    const code = character.codePointAt(0)!;
    if (code === 0x0a || code === 0x0d) continue; // line breaks are layout, not glyphs

    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
    } else if (code >= 0xa0 && code <= 0xff) {
      bytes.push(code);
    } else {
      const special = WIN_ANSI_SPECIALS[code];
      bytes.push(special ?? 0x3f); // "?"
    }
  }

  return bytes;
}

/* -------------------------------- metrics -------------------------------- */

/** The `/BaseFont` name PDF wants, for a family and its style bits. */
export function baseFontName(family: FontFamily, style: FontStyle = {}): string {
  const bold = style.bold === true;
  const italic = style.italic === true;

  if (family === "courier") {
    if (bold && italic) return "Courier-BoldOblique";
    if (bold) return "Courier-Bold";
    if (italic) return "Courier-Oblique";
    return "Courier";
  }

  if (family === "times") {
    if (bold && italic) return "Times-BoldItalic";
    if (bold) return "Times-Bold";
    if (italic) return "Times-Italic";
    return "Times-Roman";
  }

  if (bold && italic) return "Helvetica-BoldOblique";
  if (bold) return "Helvetica-Bold";
  if (italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/** A stable key for the font, used to name the resource in the page. */
export const fontKey = (family: FontFamily, style: FontStyle = {}): string =>
  `${family}${style.bold ? "b" : ""}${style.italic ? "i" : ""}`;

function widthTable(family: FontFamily, style: FontStyle): number[] | null {
  if (family === "courier") return null; // monospaced

  if (family === "times") {
    if (style.bold && style.italic) return TIMES_BOLD_ITALIC;
    if (style.bold) return TIMES_BOLD;
    if (style.italic) return TIMES_ITALIC;
    return TIMES;
  }

  // Helvetica's oblique faces share the upright widths.
  return style.bold ? HELVETICA_BOLD : HELVETICA;
}

/** One glyph's advance width, in 1/1000 em. */
function glyphWidth(byte: number, family: FontFamily, style: FontStyle): number {
  if (family === "courier") return COURIER_WIDTH;

  const table = widthTable(family, style)!;
  if (byte >= 32 && byte <= 126) return table[byte - 32]!;

  const base = ACCENT_BASE[byte];
  if (base !== undefined) {
    const code = base.charCodeAt(0);
    if (code >= 32 && code <= 126) return table[code - 32]!;
  }

  const extra = EXTRA_WIDTHS[family === "times" ? "times" : "helvetica"][byte];
  if (extra !== undefined) return extra;

  // An unknown glyph is rare and its width is only used for layout, so the
  // width of "n" is a better guess than zero — a zero would let text overrun.
  return table["n".charCodeAt(0) - 32]!;
}

/**
 * How wide `text` is when set in this face at this size, in points.
 *
 * This is what wrapping, right-alignment and column fitting all call, so it is
 * the hottest function in the writer — hence the plain loop.
 */
export function measureText(text: string, family: FontFamily, size: number, style: FontStyle = {}): number {
  const bytes = encodeWinAnsi(text);
  let total = 0;
  for (const byte of bytes) total += glyphWidth(byte, family, style);
  return (total * size) / 1000;
}

/**
 * Cuts `text` to fit `maxWidth`, ending in an ellipsis when it had to.
 *
 * Used where wrapping would break a layout — a table cell that must stay one
 * line — so that a long product name shortens rather than colliding with the
 * column beside it.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  family: FontFamily,
  size: number,
  style: FontStyle = {},
): string {
  if (measureText(text, family, size, style) <= maxWidth) return text;

  const ellipsis = "…";
  const room = maxWidth - measureText(ellipsis, family, size, style);
  if (room <= 0) return "";

  // Linear from the end: a cell is short enough that bisecting would cost more
  // in code than it saves in time.
  let cut = text.length;
  while (cut > 0 && measureText(text.slice(0, cut), family, size, style) > room) cut--;

  return text.slice(0, cut).trimEnd() + ellipsis;
}

/**
 * Breaks `text` into lines that fit `maxWidth`.
 *
 * Explicit newlines are honoured first, so a template's own line breaks
 * survive. A single word longer than the line — a URL, a long SKU — is split
 * mid-word rather than being allowed to run into the margin.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  family: FontFamily,
  size: number,
  style: FontStyle = {},
): string[] {
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, family, size, style) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) lines.push(current);

      if (measureText(word, family, size, style) <= maxWidth) {
        current = word;
        continue;
      }

      // The word alone is too wide: break it at the last character that fits.
      let rest = word;
      while (measureText(rest, family, size, style) > maxWidth && rest.length > 1) {
        let cut = rest.length;
        while (cut > 1 && measureText(rest.slice(0, cut), family, size, style) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      current = rest;
    }

    lines.push(current);
  }

  return lines;
}
