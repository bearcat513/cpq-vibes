/**
 * The PDF writer produces a binary file that nothing in this repo can open, so
 * the tests check the two things that actually break: the file's structure
 * (a reader rejects the whole document if the cross-reference table is wrong)
 * and the text measurement everything else is laid out from.
 */
import { describe, expect, test } from "bun:test";
import { decodeImage, encodePng, toDataUrl, type EmbeddableImage } from "./image";
import { PdfDocument, parseColor } from "./pdf";
import { encodeWinAnsi, measureText, truncateToWidth, wrapText } from "./pdfFonts";

const decode = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

describe("the file", () => {
  test("is a PDF a reader will accept", () => {
    const document = new PdfDocument({ title: "Test" });
    document.text("Hello");
    const text = decode(document.toBytes());

    expect(text.startsWith("%PDF-1.7")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Type /Pages");
    expect(text).toContain("/Type /Page");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  test("the cross-reference offsets point at their objects", () => {
    // This is the part a reader checks first and the part that silently rots
    // whenever the serializer changes.
    const document = new PdfDocument();
    document.text("One");
    document.addPage();
    document.text("Two");

    const bytes = document.toBytes();
    const text = decode(bytes);

    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");

    const section = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text)!;
    const count = Number(section[1]);
    const entries = section[2]!.trim().split("\n");
    expect(entries).toHaveLength(count);

    // Entry 0 is the free head; every other offset must land on "<id> 0 obj".
    expect(entries[0]).toContain("65535 f");
    entries.slice(1).forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true);
    });
  });

  test("declares only the faces it actually used", () => {
    const document = new PdfDocument();
    document.text("plain");
    document.text("bold", { bold: true });
    const text = decode(document.toBytes());

    expect(text).toContain("/BaseFont /Helvetica ");
    expect(text).toContain("/BaseFont /Helvetica-Bold ");
    expect(text).not.toContain("Times");
    // The regression that made every face oblique: a resource name containing
    // an "i" is not a request for italics.
    expect(text).not.toContain("Oblique");
  });

  test("a page with no text still has usable resources", () => {
    const document = new PdfDocument();
    document.rule();
    const text = decode(document.toBytes());
    expect(text).toContain("/Type /Font");
  });

  test("text is escaped so a stray bracket cannot end the string early", () => {
    const document = new PdfDocument();
    document.text("Acme (Holdings) \\ Co");
    const text = decode(document.toBytes());
    expect(text).toContain("Acme \\(Holdings\\) \\\\ Co");
  });
});

describe("pagination", () => {
  test("content past the bottom margin starts a new page", () => {
    const document = new PdfDocument({ size: "A4" });
    for (let i = 0; i < 120; i++) document.text(`Line ${i}`);
    expect(document.pageCount).toBeGreaterThan(1);
  });

  test("a table repeats its header on each page", () => {
    const document = new PdfDocument();
    document.table({
      columns: [
        { header: "SKU", width: 1 },
        { header: "Total", width: 1, align: "right" },
      ],
      rows: Array.from({ length: 80 }, (_, index) => [{ text: `SKU-${index}` }, { text: "$10.00" }]),
    });

    expect(document.pageCount).toBeGreaterThan(1);
    // One "SKU" heading per page, plus the rows' own SKU-n text.
    const text = decode(document.toBytes());
    const headings = text.split("(SKU)").length - 1;
    expect(headings).toBe(document.pageCount);
  });

  test("the footer is drawn on every page, knowing the total", () => {
    const document = new PdfDocument();
    for (let i = 0; i < 120; i++) document.text(`Line ${i}`);
    document.onEachPage((doc, page, total) => doc.drawTextAt(`Page ${page} of ${total}`, doc.left, doc.y, { size: 8 }));

    const text = decode(document.toBytes());
    expect(text).toContain(`Page 1 of ${document.pageCount}`);
    expect(text).toContain(`Page ${document.pageCount} of ${document.pageCount}`);
  });

  test("two overlays both run on every page", () => {
    // A branded document has a letterhead and a footer, and neither can be
    // drawn until the page count is known.
    const document = new PdfDocument();
    for (let i = 0; i < 120; i++) document.text(`Line ${i}`);
    document.onEachPage((doc, page) => doc.drawTextAt(`head ${page}`, doc.left, 20, { size: 8 }));
    document.onEachPage((doc, page) => doc.drawTextAt(`foot ${page}`, doc.left, doc.y, { size: 8 }));

    const text = decode(document.toBytes());
    for (let page = 1; page <= document.pageCount; page++) {
      expect(text).toContain(`head ${page}`);
      expect(text).toContain(`foot ${page}`);
    }
  });

  test("a block taller than a page overflows rather than looping forever", () => {
    const document = new PdfDocument();
    // `ensureRoom` must not recurse into a fresh page it also cannot fit.
    document.ensureRoom(10_000);
    expect(document.pageCount).toBe(1);
  });
});

describe("measuring", () => {
  test("widths are the real ones, not an average", () => {
    // Helvetica: "i" is 222/1000 em and "W" is 944.
    expect(measureText("i", "helvetica", 1000)).toBe(222);
    expect(measureText("W", "helvetica", 1000)).toBe(944);
    // Courier is monospaced, so every character is the same width.
    expect(measureText("i", "courier", 1000)).toBe(600);
    expect(measureText("W", "courier", 1000)).toBe(600);
  });

  test("bold is wider than regular, and an accent costs nothing", () => {
    expect(measureText("Total", "helvetica", 10, { bold: true })).toBeGreaterThan(
      measureText("Total", "helvetica", 10),
    );
    // "é" advances exactly as far as "e" in these faces — the assumption the
    // high-range width map is built on.
    expect(measureText("é", "helvetica", 10)).toBe(measureText("e", "helvetica", 10));
  });

  test("wrapping breaks on words, and honours explicit newlines", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 60, "helvetica", 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, "helvetica", 10)).toBeLessThanOrEqual(60);

    expect(wrapText("one\ntwo", 500, "helvetica", 10)).toEqual(["one", "two"]);
  });

  test("a word wider than the line is broken rather than allowed to overrun", () => {
    const lines = wrapText("SUPERCALIFRAGILISTICEXPIALIDOCIOUS", 40, "helvetica", 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, "helvetica", 10)).toBeLessThanOrEqual(40);
  });

  test("truncation ends in an ellipsis and still fits", () => {
    const cut = truncateToWidth("A product name far too long for its column", 60, "helvetica", 10);
    expect(cut.endsWith("…")).toBe(true);
    expect(measureText(cut, "helvetica", 10)).toBeLessThanOrEqual(60);
    // Something that already fits is left alone.
    expect(truncateToWidth("short", 500, "helvetica", 10)).toBe("short");
  });
});

describe("encoding", () => {
  test("the punctuation this app emits survives", () => {
    // Every one of these appears somewhere in the UI or the formatters.
    const map = Object.fromEntries(
      [..."—–…“”·×€£¥é"].map(character => [character, encodeWinAnsi(character)[0]]),
    );

    expect(map["—"]).toBe(0x97);
    expect(map["–"]).toBe(0x96);
    expect(map["…"]).toBe(0x85);
    expect(map["·"]).toBe(0xb7);
    expect(map["×"]).toBe(0xd7);
    expect(map["€"]).toBe(0x80);
    expect(map["£"]).toBe(0xa3);
    expect(map["é"]).toBe(0xe9);
  });

  test("a minus sign is a minus, not a question mark", () => {
    // U+2212 is not in WinAnsi; a negative total is the last place a "?"
    // should turn up.
    expect(encodeWinAnsi("−1,234")).not.toContain(0x3f);
    expect(encodeWinAnsi("−")[0]).toBe(0x2d);
  });

  test("what cannot be encoded degrades to something readable", () => {
    expect(String.fromCharCode(...encodeWinAnsi("≥"))).toBe(">=");
    expect(String.fromCharCode(...encodeWinAnsi("✓"))).toBe("x");
    // And anything still unmapped is visibly wrong rather than missing.
    expect(encodeWinAnsi("中")).toEqual([0x3f]);
  });

  test("line breaks are layout, not glyphs", () => {
    expect(encodeWinAnsi("a\nb")).toEqual([0x61, 0x62]);
  });
});

describe("colour", () => {
  test("hex in both lengths, with or without the hash", () => {
    expect(parseColor("#ffffff")).toEqual([1, 1, 1]);
    expect(parseColor("000000")).toEqual([0, 0, 0]);
    expect(parseColor("#f00")).toEqual([1, 0, 0]);
  });

  test("an unreadable colour falls back rather than throwing", () => {
    // A typo in one swatch should not cost the whole document.
    expect(parseColor("rebeccapurple")).toEqual([0, 0, 0]);
    expect(parseColor(undefined)).toEqual([0, 0, 0]);
  });
});

/* --------------------------------- images --------------------------------- */

/** A small real PNG, through the same encoder the image picker uses. */
async function picture(width = 8, height = 4): Promise<EmbeddableImage> {
  const rgb = new Uint8Array(width * height * 3).fill(120);
  const decoded = decodeImage(toDataUrl(await encodePng(rgb, width, height), "image/png"));
  if (!decoded.ok) throw new Error(decoded.error);
  return decoded.image;
}

describe("images", () => {
  test("an image becomes an XObject the page's resources point at", async () => {
    const document = new PdfDocument();
    document.image(await picture(), { width: 60 });
    const text = decode(document.toBytes());

    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/Width 8");
    expect(text).toContain("/Height 4");
    expect(text).toContain("/ColorSpace /DeviceRGB");
    // The PNG goes in as its own bytes, with the predictor that undoes its
    // per-scanline filtering.
    expect(text).toContain("/Filter /FlateDecode");
    expect(text).toContain("/Predictor 15");
    expect(text).toMatch(/\/XObject << \/Im1 \d+ 0 R >>/);
    expect(text).toContain("/Im1 Do");
  });

  test("the same picture on forty pages is one object", async () => {
    const logo = await picture();
    const document = new PdfDocument();
    for (let page = 0; page < 40; page++) {
      document.drawImageAt(logo, 40, 40, 30, 15);
      document.addPage();
    }

    const text = decode(document.toBytes());
    expect(text.split("/Subtype /Image").length - 1).toBe(1);
    // A letterhead that cost 40 copies of itself would be the difference
    // between a 30 kB file and a 240 kB one.
    expect(text.split("/Im1 Do").length - 1).toBe(40);
  });

  test("a page with no picture declares no XObject at all", async () => {
    const document = new PdfDocument();
    document.text("first");
    document.addPage();
    document.image(await picture(), { width: 40 });

    const pages = decode(document.toBytes()).split("/Type /Page ").slice(1);
    expect(pages[0]).not.toContain("/XObject");
    expect(pages[1]).toContain("/XObject");
  });

  test("the drawn height follows the picture, and the cursor moves past it", async () => {
    const document = new PdfDocument();
    const before = document.y;
    // 8×4 pixels drawn 60 points wide is 30 points tall, whatever the template
    // hoped for: a stretched logo is the most obvious sign of a generated file.
    const height = document.image(await picture(8, 4), { width: 60 });
    expect(height).toBe(30);
    expect(document.y).toBe(before + 30);
  });

  test("an image wider than the page is fitted to it rather than clipped", async () => {
    const document = new PdfDocument();
    const height = document.image(await picture(100, 50), { width: 5_000 });
    expect(height).toBeCloseTo(document.contentWidth / 2, 3);
  });
});
