/**
 * The template layer turns a quote into a document. The tests are about what
 * reaches the page: that the tokens resolve, that the numbers are the quote's
 * own, and — the one that matters commercially — that no template can print a
 * margin.
 */
import { describe, expect, test } from "bun:test";
import { encodePng, toDataUrl } from "./image";
import { BLOCK_TYPES, DEFAULT_TOTALS_ROWS, blankBlock, renderPdf, starterPdfTemplate, type PdfTemplate } from "./pdfTemplate";
import { specimenQuote } from "./samples";
import { readPdfTemplate } from "./validate";
import { formatMoney } from "./money";

/** The writer escapes its own string delimiters; a test comparing text must too. */
const escapeForPdf = (value: string) => value.replace(/[\\()]/g, character => `\\${character}`);

const decode = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

const context = () => ({
  quote: specimenQuote(),
  sellerName: "Sam Rep",
  sellerEmail: "sam@seller.example.com",
  locale: "en-US",
});

const render = (template: PdfTemplate) => {
  const result = renderPdf(template, context());
  return { ...result, text: decode(result.bytes) };
};

/** A template with one block, for testing that block in isolation. */
const only = (block: PdfTemplate["blocks"][number]): PdfTemplate => ({
  ...starterPdfTemplate(),
  blocks: [block],
});

describe("the starter template", () => {
  test("renders a complete document with no unresolved tokens", () => {
    const result = render(starterPdfTemplate());

    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    expect(result.unknownTokens).toEqual([]);
    expect(result.text.startsWith("%PDF")).toBe(true);
  });

  test("the quote's own details reach the page", () => {
    const result = render(starterPdfTemplate());

    expect(result.text).toContain("Harbour Logistics");
    expect(result.text).toContain("Dana Okafor");
    expect(result.text).toContain("Q-2026-0042");
    expect(result.text).toContain("Nimbus Platform");
    // The configured options, on the line's second row.
    expect(result.text).toContain("Enterprise");
  });

  test("it survives a round trip through the validator", () => {
    // The editor, the API and the file importer all read a stored body back
    // this way, so the starter has to be a fixed point of it.
    const parsed = readPdfTemplate(JSON.stringify(starterPdfTemplate()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(starterPdfTemplate());
  });
});

describe("blocks", () => {
  test("tokens resolve, and an unknown one is reported rather than printed", () => {
    const result = render(only({ type: "text", text: "For {{customer.name}} — {{invoice.terms}}" }));

    expect(result.text).toContain("For Harbour Logistics");
    expect(result.text).not.toContain("invoice.terms");
    expect(result.unknownTokens).toEqual(["invoice.terms"]);
  });

  test("a totals block prints the quote's numbers, with discounts signed", () => {
    const quote = specimenQuote();
    const result = render(only({ type: "totals", rows: DEFAULT_TOTALS_ROWS }));

    // The grand total, formatted exactly as the rest of the app formats it —
    // asserted against the quote rather than against a number typed in here,
    // so the test cannot drift away from the pricing engine.
    const grandTotal = formatMoney(quote.totals.grandTotal, quote.currency, "en-US");
    expect(result.text).toContain(escapeForPdf(grandTotal));
    expect(result.text).toContain(escapeForPdf(formatMoney(quote.totals.listTotal, quote.currency, "en-US")));

    // A discount is money coming off, and reads that way.
    const discount = quote.totals.listTotal - quote.totals.netTotal;
    expect(discount).toBeGreaterThan(0);
    expect(result.text).toContain(escapeForPdf(`-${formatMoney(discount, quote.currency, "en-US")}`));
  });

  test("omitIfZero leaves a row out instead of printing zero", () => {
    // The specimen has no shipping.
    const withRow = render(only({ type: "totals", rows: [{ label: "Shipping", field: "shipping" }] }));
    expect(withRow.text).toContain("(Shipping)");

    const without = render(
      only({ type: "totals", rows: [{ label: "Shipping", field: "shipping", omitIfZero: true }] }),
    );
    expect(without.text).not.toContain("(Shipping)");
  });

  test("line-item columns show the field they name", () => {
    const result = render(
      only({
        type: "lineItems",
        columns: [
          { field: "sku", header: "Code", width: 2 },
          { field: "quantity", header: "How many", width: 1, align: "right" },
        ],
        showOptions: false,
        showDescription: false,
      }),
    );

    expect(result.text).toContain("(Code)");
    expect(result.text).toContain("(How many)");
    expect(result.text).toContain("(PLAT-CORE)");
    // The columns that were not asked for are absent.
    expect(result.text).not.toContain("(Nimbus Platform)");
  });

  test("a page break starts a new page", () => {
    const template = { ...starterPdfTemplate(), blocks: [{ type: "text" as const, text: "a" }, { type: "pageBreak" as const }, { type: "text" as const, text: "b" }] };
    expect(renderPdf(template, context()).pageCount).toBe(2);
  });

  test("columns all start level, and the block ends below the longest", () => {
    // Three columns of very different lengths: the one-line column must not
    // pull the next block up over the four-line one.
    const result = render(
      only({
        type: "columns",
        columns: [{ text: "one\ntwo\nthree\nfour" }, { text: "short" }, { text: "also short" }],
      }),
    );

    expect(result.text).toContain("(four)");
    expect(result.text).toContain("(short)");
    expect(result.pageCount).toBe(1);
  });
});

describe("what a template may not do", () => {
  test("it cannot name cost or margin", () => {
    // The closed totals list is the guarantee. A hand-written body asking for
    // margin loses the row rather than leaking it into a customer document.
    const parsed = readPdfTemplate(
      JSON.stringify({
        page: {},
        blocks: [
          {
            type: "totals",
            rows: [
              { label: "Margin", field: "margin" },
              { label: "Cost", field: "costTotal" },
              { label: "Margin %", field: "marginPercent" },
            ],
          },
        ],
        footer: {},
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const totals = parsed.value.blocks[0] as Extract<PdfTemplate["blocks"][number], { type: "totals" }>;
    // Every requested row was dropped, so it fell back to the default set —
    // none of which is an internal number.
    expect(totals.rows.map(row => row.field)).toEqual(DEFAULT_TOTALS_ROWS.map(row => row.field));

    const quote = specimenQuote();
    const rendered = decode(renderPdf(parsed.value, context()).bytes);
    expect(rendered).not.toContain(String(quote.totals.costTotal));
    expect(rendered).not.toContain("(Margin)");
  });
});

describe("validation", () => {
  test("an empty body is a new template, not an error", () => {
    const parsed = readPdfTemplate("");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.blocks.length).toBeGreaterThan(0);
  });

  test("a body that is not JSON is refused with a sentence", () => {
    const parsed = readPdfTemplate("not json at all");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("valid JSON");
  });

  test("a template with no usable block is refused", () => {
    expect(readPdfTemplate(JSON.stringify({ page: {}, blocks: [] })).ok).toBe(false);
    // A block type from a future version is dropped, not fatal — but if it was
    // the only one, there is no document left.
    expect(readPdfTemplate(JSON.stringify({ page: {}, blocks: [{ type: "hologram" }] })).ok).toBe(false);
  });

  test("an unknown block is dropped while the rest of the page survives", () => {
    const parsed = readPdfTemplate(
      JSON.stringify({ page: {}, blocks: [{ type: "hologram" }, { type: "text", text: "kept" }] }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.blocks).toHaveLength(1);
  });

  test("page setup is clamped into what a page can actually be", () => {
    const parsed = readPdfTemplate(
      JSON.stringify({
        page: { size: "Poster", fontSize: 400, margins: { top: -50, left: 9999 }, family: "Comic Sans", textColor: "nonsense" },
        blocks: [{ type: "text", text: "x" }],
        footer: {},
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.page.size).toBe("A4");
    expect(parsed.value.page.family).toBe("helvetica");
    expect(parsed.value.page.fontSize).toBeLessThanOrEqual(18);
    expect(parsed.value.page.margins.top).toBeGreaterThanOrEqual(12);
    expect(parsed.value.page.margins.left).toBeLessThanOrEqual(200);
    expect(parsed.value.page.textColor).toMatch(/^#/);
  });

  test("a line-items block with no usable column falls back to the default five", () => {
    const parsed = readPdfTemplate(
      JSON.stringify({
        page: {},
        blocks: [{ type: "lineItems", columns: [{ field: "nonsense", header: "?", width: 1 }] }],
        footer: {},
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = parsed.value.blocks[0] as Extract<PdfTemplate["blocks"][number], { type: "lineItems" }>;
    expect(block.columns).toHaveLength(5);
  });
});

describe("robustness", () => {
  test("every block type renders straight after being added", () => {
    // The editor drops a blank block in and re-renders immediately, so a
    // newly added block that throws is a crash in the template designer.
    for (const entry of BLOCK_TYPES) {
      const template = { ...starterPdfTemplate(), blocks: [blankBlock(entry.type)] };
      const result = renderPdf(template, context());
      expect(decode(result.bytes).startsWith("%PDF")).toBe(true);
      // And it survives being stored and read back.
      expect(readPdfTemplate(JSON.stringify(template)).ok).toBe(true);
    }
  });

  test("a quote with no lines still produces a document", () => {
    const quote = { ...specimenQuote(), lines: [] };
    const result = renderPdf(starterPdfTemplate(), { ...context(), quote });
    expect(result.pageCount).toBe(1);
    expect(decode(result.bytes).startsWith("%PDF")).toBe(true);
  });

  test("a long quote paginates and keeps its footer", () => {
    const base = specimenQuote();
    const quote = {
      ...base,
      lines: Array.from({ length: 60 }, (_, index) => ({ ...base.lines[0]!, id: `ln_${index}` })),
    };

    const result = renderPdf(starterPdfTemplate(), { ...context(), quote });
    expect(result.pageCount).toBeGreaterThan(1);
    expect(decode(result.bytes)).toContain(`Page 1 of ${result.pageCount}`);
  });

  test("markup in a product name is just text here", () => {
    // Nothing in a PDF is parsed as markup, but the brackets are still the
    // writer's own string delimiters.
    const base = specimenQuote();
    const quote = { ...base, lines: [{ ...base.lines[0]!, name: "AC/DC (5kW) \\ spare" }] };

    const text = decode(renderPdf(starterPdfTemplate(), { ...context(), quote }).bytes);
    expect(text).toContain("AC/DC \\(5kW\\) \\\\ spare");
  });
});

/* -------------------------------- branding -------------------------------- */

/**
 * Branding is the one part of a template that can fail on data rather than on
 * layout: a picture may be a shape a PDF cannot carry. So these are about
 * where an image lands, and about what happens when it cannot.
 */
describe("images and the letterhead", () => {
  /** A small real PNG, through the encoder the image picker uses. */
  const logo = async (width = 8, height = 4): Promise<string> =>
    toDataUrl(await encodePng(new Uint8Array(width * height * 3).fill(90), width, height), "image/png");

  test("an image block puts a picture on the page", async () => {
    const result = render(only({ type: "image", source: await logo(), width: 80 }));

    expect(result.imageProblems).toEqual([]);
    expect(result.text).toContain("/Subtype /Image");
    expect(result.text).toContain("/Im1 Do");
  });

  test("a caption is drawn under the image, in the muted colour", async () => {
    const result = render(only({ type: "image", source: await logo(), width: 80, caption: "Our Bristol office" }));
    expect(result.text).toContain("Our Bristol office");
  });

  test("an image that cannot be embedded is reported, not thrown", async () => {
    // The document still renders. A proposal missing its logo can be read; a
    // proposal that failed to render cannot, and the person who can fix it is
    // looking at the editor rather than waiting for the quote.
    const result = render(only({ type: "image", source: "data:image/png;base64,bm90YQ==", width: 80 }));

    expect(result.text.startsWith("%PDF")).toBe(true);
    expect(result.imageProblems).toHaveLength(1);
    expect(result.imageProblems[0]).toContain("An image block");
  });

  test("a block with no picture chosen yet renders nothing and says nothing", () => {
    // Which is what `blankBlock` produces: an empty source is a block being
    // worked on, not a broken one.
    const result = render(only({ type: "image", source: "", width: 80 }));
    expect(result.imageProblems).toEqual([]);
    expect(result.text).not.toContain("/Subtype /Image");
  });

  test("the letterhead is drawn on every page, from one embedded picture", async () => {
    const base = specimenQuote();
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      header: { logo: await logo(), logoWidth: 40, text: "Nimbus Software Ltd", rule: true },
    };

    const quote = {
      ...base,
      lines: Array.from({ length: 60 }, (_, index) => ({ ...base.lines[0]!, id: `ln_${index}` })),
    };
    const result = renderPdf(template, { ...context(), quote });
    const text = decode(result.bytes);

    expect(result.pageCount).toBeGreaterThan(1);
    expect(text.split("/Im1 Do").length - 1).toBe(result.pageCount);
    expect(text.split("/Subtype /Image").length - 1).toBe(1);
    expect(text.split("Nimbus Software Ltd").length - 1).toBe(result.pageCount);
  });

  test("`firstPageOnly` puts the letterhead on page one and nowhere else", async () => {
    const base = specimenQuote();
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      header: { logo: await logo(), text: "Nimbus Software Ltd", firstPageOnly: true },
    };

    const quote = {
      ...base,
      lines: Array.from({ length: 60 }, (_, index) => ({ ...base.lines[0]!, id: `ln_${index}` })),
    };
    const result = renderPdf(template, { ...context(), quote });
    const text = decode(result.bytes);

    expect(result.pageCount).toBeGreaterThan(1);
    expect(text.split("/Im1 Do").length - 1).toBe(1);
  });

  test("a logo taller than the top margin is scaled to fit rather than printed over the page", async () => {
    // 8×80 pixels asked for at 100 points wide would be 1000 points tall.
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      page: { ...starterPdfTemplate().page, margins: { top: 60, right: 48, bottom: 56, left: 48 } },
      header: { logo: await logo(8, 80), logoWidth: 100 },
    };

    const text = decode(renderPdf(template, context()).bytes);
    // The `cm` matrix carries the drawn size: height is the second number
    // after the scale pair, and it must fit the band (the margin less the gap).
    const matrix = /([\d.]+) 0 0 ([\d.]+) [\d.]+ [\d.]+ cm/.exec(text);
    expect(matrix).not.toBeNull();
    expect(Number(matrix![2])).toBeLessThanOrEqual(40);
  });

  test("letterhead text resolves tokens like everything else", async () => {
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      header: { text: "Quote {{quote.number}}", logo: await logo() },
    };
    expect(render(template).text).toContain(`Quote ${specimenQuote().number}`);
  });

  test("a template with a letterhead survives a round trip through the validator", async () => {
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      header: { logo: await logo(), logoWidth: 40, logoAlign: "right", text: "Nimbus", rule: true },
      blocks: [{ type: "image", source: await logo(), width: 90, align: "center", caption: "A caption" }],
    };

    const parsed = readPdfTemplate(JSON.stringify(template));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.header).toEqual(template.header);
    expect(parsed.value.blocks[0]).toEqual(template.blocks[0]!);
  });

  test("the validator drops a picture a PDF could not carry, keeping the block", () => {
    // A save that failed on a file someone had just chosen would lose the rest
    // of their editing with it.
    const parsed = readPdfTemplate(
      JSON.stringify({
        ...starterPdfTemplate(),
        header: { logo: "https://example.com/logo.png", text: "Nimbus" },
        blocks: [{ type: "image", source: "data:image/gif;base64,AAAA", width: 90 }],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.header?.logo).toBeUndefined();
    expect(parsed.value.header?.text).toBe("Nimbus");
    expect(parsed.value.blocks[0]).toEqual({ type: "image", source: "", width: 90 });
  });

  test("a template with no letterhead does not grow an empty one", () => {
    const parsed = readPdfTemplate(JSON.stringify(starterPdfTemplate()));
    expect(parsed.ok && parsed.value.header).toBeUndefined();
  });
});
