/**
 * The template layer turns a quote into a document. The tests are about what
 * reaches the page: that the tokens resolve, that the numbers are the quote's
 * own, and — the one that matters commercially — that no template can print a
 * margin.
 */
import { describe, expect, test } from "bun:test";
import { encodePng, toDataUrl } from "./image";
import {
  BLOCK_TYPES,
  DEFAULT_LINE_COLUMNS,
  DEFAULT_TOTALS_ROWS,
  INVOICE_TOTALS_ROWS,
  blankBlock,
  defaultStyle,
  renderInvoicePdf,
  renderPdf,
  starterPdfTemplate,
  type PdfTemplate,
} from "./pdfTemplate";
import { SAMPLE_TEMPLATES, specimenInvoice, specimenQuote } from "./samples";
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

/* ------------------------------- invoices -------------------------------- */

const invoiceContext = () => ({
  invoice: specimenInvoice(),
  sellerName: "Sam Rep",
  sellerEmail: "sam@seller.example.com",
  locale: "en-US",
  asOf: "2026-08-15",
});

const renderInvoice = (template: PdfTemplate) => {
  const result = renderInvoicePdf(template, invoiceContext());
  return { ...result, text: decode(result.bytes) };
};

/**
 * The same renderer, the other vocabulary.
 *
 * What is worth testing twice is not the blocks — they are the same code —
 * but the seam: that an invoice template reaches the invoice's numbers, that
 * it cannot reach a quote's, and that the totals list it is held to is the
 * invoice one.
 */
describe("an invoice template", () => {
  test("the starter renders a complete document with no unresolved tokens", () => {
    const result = renderInvoice(starterPdfTemplate("invoice"));

    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    expect(result.unknownTokens).toEqual([]);
    expect(result.text.startsWith("%PDF")).toBe(true);
  });

  test("the invoice's own details and its balance reach the page", () => {
    const invoice = specimenInvoice();
    const result = renderInvoice(starterPdfTemplate("invoice"));

    expect(result.text).toContain(escapeForPdf(invoice.number));
    expect(result.text).toContain(escapeForPdf(invoice.dueDate));
    expect(result.text).toContain("Balance due");
    expect(result.text).toContain(escapeForPdf(formatMoney(invoice.totals.balance, "USD", "en-US")));
  });

  test("what has come in is written against what was demanded", () => {
    // "Paid $5,000.00" on a line above a balance reads as an addition. The
    // sign is the difference between a total a customer can follow and one
    // they ring up about.
    const invoice = specimenInvoice();
    const result = renderInvoice(starterPdfTemplate("invoice"));

    expect(result.text).toContain(escapeForPdf(`-${formatMoney(invoice.totals.paidAmount, "USD", "en-US")}`));
  });

  test("a quote's tokens mean nothing on it, and are reported rather than printed", () => {
    const result = renderInvoice({
      ...starterPdfTemplate("invoice"),
      blocks: [{ type: "text", text: "{{quote.validUntil}} {{totals.grandTotal}}" }],
    });

    expect(result.unknownTokens).toEqual(["quote.validUntil", "totals.grandTotal"]);
  });

  test("it is held to the invoice totals list, not the quote one", () => {
    // A quote's fields are dropped exactly the way `margin` is: an invoice
    // has no list price and no contract value, and a row naming one would
    // print zero on a document about money somebody owes.
    const parsed = readPdfTemplate(
      JSON.stringify({
        page: {},
        blocks: [
          {
            type: "totals",
            rows: [
              { label: "List price", field: "listTotal" },
              { label: "Contract value", field: "totalContractValue" },
            ],
          },
        ],
        footer: {},
      }),
      "invoice",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const totals = parsed.value.blocks[0] as Extract<PdfTemplate["blocks"][number], { type: "totals" }>;
    expect(totals.rows.map(row => row.field)).toEqual(INVOICE_TOTALS_ROWS.map(row => row.field));
  });

  test("a quote line column is dropped, and the invoice columns stand in", () => {
    const parsed = readPdfTemplate(
      JSON.stringify({
        page: {},
        blocks: [
          {
            type: "lineItems",
            columns: [
              { field: "term", header: "Term", width: 2 },
              { field: "discountPercent", header: "Discount", width: 2 },
            ],
          },
        ],
        footer: {},
      }),
      "invoice",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = parsed.value.blocks[0] as Extract<PdfTemplate["blocks"][number], { type: "lineItems" }>;
    expect(block.columns.map(column => column.field)).toContain("taxAmount");
    expect(block.columns.map(column => column.field)).not.toContain("term");
  });

  test("every block type renders straight after being added to one", () => {
    for (const entry of BLOCK_TYPES) {
      const result = renderInvoice({ ...starterPdfTemplate("invoice"), blocks: [blankBlock(entry.type, "invoice")] });
      expect(result.text.startsWith("%PDF")).toBe(true);
      expect(result.unknownTokens).toEqual([]);
    }
  });

  test("it cannot name cost or margin either", () => {
    const parsed = readPdfTemplate(
      JSON.stringify({
        page: {},
        blocks: [{ type: "totals", rows: [{ label: "Margin", field: "margin" }] }],
        footer: {},
      }),
      "invoice",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const totals = parsed.value.blocks[0] as Extract<PdfTemplate["blocks"][number], { type: "totals" }>;
    expect(totals.rows.map(row => row.field)).not.toContain("margin");
  });
});

/**
 * The house style: leading, the step from body to heading, and the weight and
 * colour of every rule. All of it used to be constants in the renderer, so the
 * first thing asserted is that leaving it alone changes nothing.
 */
describe("styling", () => {
  /** The same document twice is the same bytes but for the moment it was made. */
  const withoutTheClock = (bytes: Uint8Array) => decode(bytes).replace(/\/CreationDate \([^)]*\)/, "");

  test("a template with no style renders exactly as one carrying the defaults", () => {
    const bare: PdfTemplate = { ...starterPdfTemplate(), style: undefined };
    const explicit: PdfTemplate = { ...starterPdfTemplate(), style: defaultStyle(bare.page.fontSize) };

    expect(withoutTheClock(renderPdf(explicit, context()).bytes)).toBe(
      withoutTheClock(renderPdf(bare, context()).bytes),
    );
  });

  test("the default heading scale reproduces the fixed nine-point step, whatever the body size", () => {
    for (const fontSize of [8, 10, 12, 14]) {
      // Within a hundredth of a point: the scale is rounded for the editor's
      // sake, and no printer resolves the difference.
      expect(fontSize * defaultStyle(fontSize).headingScale).toBeCloseTo(fontSize + 9, 1);
    }
  });

  test("the heading scale is what sets a heading's size", () => {
    const heading = { type: "heading" as const, text: "Terms" };

    // No size of its own: the scale decides. 10pt body × 1.9 is the old 19pt.
    expect(render({ ...only(heading), style: defaultStyle(10) }).text).toContain(" 19 Tf");
    expect(render({ ...only(heading), style: { ...defaultStyle(10), headingScale: 3 } }).text).toContain(" 30 Tf");

    // A block that names its own size still wins — the scale is a default.
    const sized = { ...only({ ...heading, size: 40 }), style: { ...defaultStyle(10), headingScale: 3 } };
    expect(render(sized).text).toContain(" 40 Tf");
  });

  test("headings can be set in their own face", () => {
    const template = {
      ...only({ type: "heading", text: "Terms" }),
      style: { ...defaultStyle(10), headingFamily: "times" as const },
    };

    const text = render(template).text;
    expect(text).toContain("/timesb");
    // The body face is still declared, because the footer is set in it.
    expect(text).toContain("/helvetica");
  });

  test("capitals are applied to the drawn text, not to the template", () => {
    const template: PdfTemplate = {
      ...only({ type: "heading", text: "Scope of work" }),
      style: { ...defaultStyle(10), headingUppercase: true },
    };

    expect(render(template).text).toContain("(SCOPE OF WORK)");
    // The template itself is untouched: turning it off gives the original back.
    expect(render({ ...template, style: defaultStyle(10) }).text).toContain("(Scope of work)");
  });

  test("leading is what decides how far a paragraph runs down the page", () => {
    const paragraph = { type: "text" as const, text: "word ".repeat(1_200) };

    const tight = renderPdf({ ...only(paragraph), style: { ...defaultStyle(10), lineHeight: 1 } }, context());
    const loose = renderPdf({ ...only(paragraph), style: { ...defaultStyle(10), lineHeight: 3 } }, context());

    expect(loose.pageCount).toBeGreaterThan(tight.pageCount);
  });

  test("the rule colour is every rule the document draws on its own account", () => {
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      blocks: [{ type: "divider" }, { type: "signatures", parties: [{ label: "Signed" }] }],
      style: { ...defaultStyle(10), ruleColor: "#ff0000" },
    };

    // Stroking red, twice: the divider and the line a signature is written on.
    expect(render(template).text.split("1 0 0 RG").length - 1).toBe(2);
  });

  test("a divider with a colour of its own keeps it", () => {
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      blocks: [{ type: "divider", color: "#0000ff" }],
      style: { ...defaultStyle(10), ruleColor: "#ff0000" },
    };

    const text = render(template).text;
    expect(text).toContain("0 0 1 RG");
    expect(text).not.toContain("1 0 0 RG");
  });
});

describe("the line-item table's style", () => {
  const table = (style: Partial<PdfTemplate["style"]> = {}): PdfTemplate => ({
    ...starterPdfTemplate(),
    blocks: [{ type: "lineItems", columns: DEFAULT_LINE_COLUMNS }],
    style: { ...defaultStyle(10), ...(style as object) } as PdfTemplate["style"],
  });

  test("column headings can be set in capitals", () => {
    const style = { ...defaultStyle(10), table: { ...defaultStyle(10).table, headerUppercase: true } };
    expect(render(table(style)).text).toContain("(UNIT PRICE)");
    expect(render(table()).text).toContain("(Unit price)");
  });

  test("turning row lines off leaves only the rule under the header", () => {
    const off = { ...defaultStyle(10), table: { ...defaultStyle(10).table, rowLines: false } };

    const ruled = render(table()).text.split(" l S").length;
    const plain = render(table(off)).text.split(" l S").length;
    expect(plain).toBeLessThan(ruled);
  });

  test("the grid is its own colour, not the document's rule colour", () => {
    // A grid is read *through* and a divider is read, so they are two
    // settings — and setting one must not quietly move the other.
    const style = {
      ...defaultStyle(10),
      ruleColor: "#ff0000",
      table: { ...defaultStyle(10).table, gridColor: "#00ff00" },
    };

    const text = render(table(style)).text;
    expect(text).toContain("0 1 0 RG");
    expect(text).not.toContain("1 0 0 RG");
  });

  test("a block's own fill beats the document's", () => {
    const style = { ...defaultStyle(10), table: { ...defaultStyle(10).table, headerFill: "#ff0000" } };

    const inherited: PdfTemplate = { ...table(style) };
    expect(render(inherited).text).toContain("1 0 0 rg");

    const overridden: PdfTemplate = {
      ...table(style),
      blocks: [{ type: "lineItems", columns: DEFAULT_LINE_COLUMNS, headerFill: "#00ff00" }],
    };
    expect(render(overridden).text).toContain("0 1 0 rg");
  });

  test("cell padding changes the height of the table, not its columns", () => {
    const tight = { ...defaultStyle(10), table: { ...defaultStyle(10).table, cellPadding: 1 } };
    const loose = { ...defaultStyle(10), table: { ...defaultStyle(10).table, cellPadding: 24 } };

    const before = render(table(tight));
    const after = render(table(loose));
    expect(after.bytes.length).not.toBe(before.bytes.length);
    expect(after.unknownTokens).toEqual([]);
  });
});

describe("the watermark", () => {
  test("is stamped on every page, under the content", () => {
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      watermark: { text: "DRAFT" },
      blocks: [
        { type: "text", text: "First page" },
        { type: "pageBreak" },
        { type: "text", text: "Second page" },
      ],
    };

    const result = render(template);
    expect(result.pageCount).toBe(2);
    expect(result.text.split("(DRAFT)").length - 1).toBe(2);
    // Under, not over: the stamp is written before the words that sit on it.
    expect(result.text.indexOf("(DRAFT)")).toBeLessThan(result.text.indexOf("(First page)"));
    // And it is see-through, or it would be a redaction rather than a stamp.
    expect(result.text).toContain("/Type /ExtGState");
  });

  test("its text resolves tokens like everything else", () => {
    const template: PdfTemplate = { ...starterPdfTemplate(), watermark: { text: "{{quote.number}}" } };
    expect(render(template).text).toContain(`(${specimenQuote().number})`);
  });

  test("an unknown token in it is reported rather than printed", () => {
    const template: PdfTemplate = { ...starterPdfTemplate(), watermark: { text: "{{quote.nonsense}}" } };
    expect(render(template).unknownTokens).toContain("quote.nonsense");
  });

  test("no watermark means no transparency in the file at all", () => {
    expect(render(starterPdfTemplate()).text).not.toContain("/ExtGState");
  });

  test("an invoice can be stamped too — one renderer, both kinds", () => {
    const template: PdfTemplate = { ...starterPdfTemplate("invoice"), watermark: { text: "COPY" } };
    expect(renderInvoice(template).text).toContain("(COPY)");
  });
});

describe("validating the style and the stamp", () => {
  const parse = (body: Record<string, unknown>) =>
    readPdfTemplate(JSON.stringify({ page: {}, blocks: [{ type: "text", text: "x" }], footer: {}, ...body }));

  test("a style is written down even when the template did not carry one", () => {
    const parsed = parse({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.style).toEqual(defaultStyle(parsed.value.page.fontSize));
  });

  test("the stored heading scale is read against the template's own body size", () => {
    const parsed = parse({ page: { fontSize: 12 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.page.fontSize * parsed.value.style!.headingScale).toBeCloseTo(21, 5);
  });

  test("nonsense is clamped into what a document can be set in", () => {
    const parsed = parse({
      style: {
        lineHeight: 99,
        paragraphSpacing: -40,
        headingScale: 0.1,
        headingFamily: "Comic Sans",
        ruleColor: "not a colour",
        table: { cellPadding: 900, gridColor: "#zzz", zebra: "" },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const style = parsed.value.style!;

    expect(style.lineHeight).toBeLessThanOrEqual(3);
    expect(style.paragraphSpacing).toBeGreaterThanOrEqual(0);
    expect(style.headingScale).toBeGreaterThanOrEqual(1);
    expect(style.headingFamily).toBeUndefined();
    expect(style.ruleColor).toBe(defaultStyle(10).ruleColor);
    expect(style.table.cellPadding).toBeLessThanOrEqual(24);
    // The grid always has a colour, so nonsense falls back to the default one.
    expect(style.table.gridColor).toBe(defaultStyle(10).table.gridColor);
    // A *fill* is different: "none" has to stay expressible, so an unreadable
    // one is absent rather than black. A zebra nobody asked for is worse than
    // no zebra.
    expect(style.table.zebra).toBeUndefined();
  });

  test("a watermark with no text is no watermark, and is not stored as an empty one", () => {
    const parsed = parse({ watermark: { text: "   ", opacity: 0.5 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.watermark).toBeUndefined();
    expect(JSON.stringify(parsed.value)).not.toContain("watermark");
  });

  test("a watermark's numbers are clamped and its text is kept", () => {
    const parsed = parse({ watermark: { text: "DRAFT", opacity: 40, angle: 900, size: 9_000 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const watermark = parsed.value.watermark!;
    expect(watermark.text).toBe("DRAFT");
    expect(watermark.opacity).toBeLessThanOrEqual(1);
    expect(watermark.angle).toBeLessThanOrEqual(90);
    expect(watermark.size).toBeLessThanOrEqual(400);
  });

  test("a styled, stamped template survives a round trip", () => {
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      style: {
        ...defaultStyle(10),
        lineHeight: 1.6,
        headingUppercase: true,
        headingFamily: "times",
        ruleColor: "#334155",
        table: {
          headerFill: "#f1f5f9",
          headerUppercase: true,
          zebra: "#f8fafc",
          gridColor: "#e2e8f0",
          rowLines: false,
          cellPadding: 7,
        },
      },
      watermark: { text: "DRAFT", opacity: 0.12, angle: 30 },
    };

    const parsed = readPdfTemplate(JSON.stringify(template));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.style).toEqual(template.style!);
    expect(parsed.value.watermark).toEqual(template.watermark!);
    expect(renderPdf(parsed.value, context()).unknownTokens).toEqual([]);
  });
});

/**
 * The sample workspace ships these, so a typo in one is a typo every new
 * account starts with — and nothing else renders them.
 */
describe("the sample templates", () => {
  const pdfSamples = SAMPLE_TEMPLATES.filter(sample => sample.format === "pdf");

  test("there are some, or this file is asserting nothing", () => {
    expect(pdfSamples.length).toBeGreaterThan(0);
  });

  for (const sample of pdfSamples) {
    test(`"${sample.name}" is valid, and renders with every token resolved`, () => {
      const parsed = readPdfTemplate(sample.body, sample.kind);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const result =
        sample.kind === "invoice"
          ? renderInvoicePdf(parsed.value, invoiceContext())
          : renderPdf(parsed.value, context());

      expect(result.pageCount).toBeGreaterThanOrEqual(1);
      expect(result.unknownTokens).toEqual([]);
      expect(result.imageProblems).toEqual([]);
    });
  }

  test("the branded proposal carries a house style, and the order form a stamp", () => {
    // Not decoration in a test: they are the only worked examples of either,
    // and a sample that quietly loses the feature it demonstrates is how a
    // feature stops being discoverable.
    const branded = readPdfTemplate(pdfSamples.find(one => one.name.includes("branded"))!.body);
    const order = readPdfTemplate(pdfSamples.find(one => one.name.includes("Order form"))!.body);

    expect(branded.ok && branded.value.style?.table.headerFill).toBeTruthy();
    expect(order.ok && order.value.watermark?.text).toBeTruthy();
  });
});

describe("the stamp's capitals", () => {
  test("uppercase is applied after the token resolves, not to the template", () => {
    const template: PdfTemplate = {
      ...starterPdfTemplate(),
      watermark: { text: "{{quote.status}}", uppercase: true },
    };

    // The status is stored lower case, which is exactly why the option exists.
    expect(render(template).text).toContain(`(${specimenQuote().status.replace("_", " ").toUpperCase()})`);
  });

  test("off leaves the text as written, because a stamp can be a sentence", () => {
    const template: PdfTemplate = { ...starterPdfTemplate(), watermark: { text: "Not for distribution" } };
    expect(render(template).text).toContain("(Not for distribution)");
  });
});
