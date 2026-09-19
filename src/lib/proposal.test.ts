/**
 * A proposal is the one thing here a customer reads, so the tests are about
 * what reaches the page: that every token resolves, that nothing user-written
 * escapes into markup, and that an author's mistake degrades into a gap rather
 * than into `{{totals.grandTotal}}` in front of a buyer.
 */
import { describe, expect, test } from "bun:test";
import { LINES_CLOSE, LINES_OPEN, documentFileName, unknownTokensIn } from "./document";
import { LINE_TOKENS, PROPOSAL_TOKENS, renderProposal } from "./proposal";
import type { PricedLine, Quote } from "./types";

const line = (overrides: Partial<PricedLine> = {}): PricedLine =>
  ({
    id: "ln_1",
    sku: "PLAT",
    name: "Platform",
    description: "",
    optionNames: ["Premium"],
    quantity: 10,
    unitOfMeasure: "user",
    listUnitPrice: 100,
    unitPrice: 80,
    effectiveDiscountPercent: 20,
    netTotal: 9_600,
    termMonths: 12,
    chargeType: "recurring",
    billingPeriod: "monthly",
    ...overrides,
  }) as PricedLine;

const quote = (overrides: Partial<Quote> = {}): Quote =>
  ({
    id: "qte_1",
    number: "Q-2026-0001",
    name: "Expansion",
    status: "sent",
    version: 1,
    currency: "USD",
    termMonths: 12,
    validUntil: "2026-12-31",
    notes: "Thanks for your time.",
    createdAt: "2026-09-17T10:00:00.000Z",
    customer: {
      accountId: "acc_1",
      name: "Harbour Logistics",
      contactName: "Dana Okafor",
      contactTitle: "VP Operations",
      contactEmail: "dana@harbour.example.com",
      contactPhone: "+1 415 555 0142",
      billingAddress: {
        line1: "1200 Embarcadero",
        line2: "",
        city: "San Francisco",
        state: "CA",
        postalCode: "94107",
        country: "United States",
      },
      shippingAddress: {
        line1: "3400 Pier 80 Access Road",
        line2: "",
        city: "San Francisco",
        state: "CA",
        postalCode: "94124",
        country: "United States",
      },
      paymentTerms: "Net 30",
    },
    lines: [line()],
    totals: {
      currency: "USD",
      lineCount: 1,
      listTotal: 12_000,
      lineDiscountAmount: 2_400,
      subtotal: 9_600,
      quoteDiscountAmount: 0,
      quoteAdjustment: 0,
      netTotal: 9_600,
      taxAmount: 0,
      shipping: 0,
      grandTotal: 9_600,
      effectiveDiscountPercent: 20,
      costTotal: 3_600,
      margin: 6_000,
      marginPercent: 62.5,
      oneTimeTotal: 0,
      monthlyRecurringTotal: 800,
      annualRecurringTotal: 9_600,
      totalContractValue: 9_600,
    },
    ...overrides,
  }) as Quote;

const context = (overrides: Partial<Parameters<typeof renderProposal>[2]> = {}) => ({
  quote: quote(),
  sellerName: "Sam Rep",
  sellerEmail: "sam@seller.example.com",
  locale: "en-US",
  ...overrides,
});

describe("tokens", () => {
  test("the scalar tokens resolve", () => {
    const { text } = renderProposal(
      "{{quote.number}} for {{customer.name}}, {{totals.grandTotal}}, from {{seller.name}}",
      "text",
      context(),
    );
    expect(text).toBe("Q-2026-0001 for Harbour Logistics, $9,600.00, from Sam Rep");
  });

  test("the repeating block runs once per line", () => {
    const body = `${LINES_OPEN}{{line.number}}. {{line.name}} × {{line.quantity}} = {{line.total}}\n${LINES_CLOSE}`;
    const { text } = renderProposal(body, "text", context({ quote: quote({ lines: [line(), line({ id: "ln_2", name: "Storage", netTotal: 1_000 })] }) }));

    expect(text).toBe("1. Platform × 10 = $9,600.00\n2. Storage × 10 = $1,000.00\n");
  });

  test("{{lines.table}} renders in the template's own format", () => {
    expect(renderProposal("{{lines.table}}", "markdown", context()).text).toContain("| SKU | Item |");
    expect(renderProposal("{{lines.table}}", "html", context()).text).toContain("<table");
    // Plain text lines the columns up, so it survives a monospaced email.
    expect(renderProposal("{{lines.table}}", "text", context()).text).toContain("SKU");
  });

  test("an address takes the format's own line break", () => {
    expect(renderProposal("{{customer.address}}", "html", context()).text).toContain("<br />");
    expect(renderProposal("{{customer.address}}", "text", context()).text).toContain("\n");
  });

  test("where it ships is a separate token from where the invoice goes", () => {
    // The two are the same on most customers and emphatically not on some,
    // which is the whole reason a document can name both.
    expect(renderProposal("{{customer.address}}", "text", context()).text).toContain("1200 Embarcadero");
    const shipping = renderProposal("{{customer.shippingAddress}}", "text", context()).text;
    expect(shipping).toContain("3400 Pier 80 Access Road");
    expect(shipping).not.toContain("1200 Embarcadero");
    expect(renderProposal("{{customer.shippingAddress}}", "html", context()).text).toContain("<br />");
  });

  test("a customer with no shipping address renders a blank, not a crash", () => {
    // A quote stored before the field existed comes back without it.
    const older = quote();
    delete (older.customer as Partial<Quote["customer"]>).shippingAddress;

    const result = renderProposal("[{{customer.shippingAddress}}]", "text", { ...context(), quote: older });
    expect(result.text).toBe("[]");
    expect(result.unknownTokens).toEqual([]);
  });

  test("the contact's job title is addressable", () => {
    expect(renderProposal("{{customer.contactName}}, {{customer.contactTitle}}", "text", context()).text).toBe(
      "Dana Okafor, VP Operations",
    );
  });

  test("a token this app does not know renders as a blank, and is reported", () => {
    // Better a gap the author notices in preview than `{{invoice.terms}}` in
    // a document that has already been sent.
    const result = renderProposal("Terms: {{invoice.terms}}.", "text", context());
    expect(result.text).toBe("Terms: .");
    expect(result.unknownTokens).toEqual(["invoice.terms"]);
  });

  test("a line token outside the block is unknown rather than silently blank", () => {
    expect(renderProposal("{{line.sku}}", "text", context()).unknownTokens).toEqual(["line.sku"]);
  });

  test("unknownTokensIn warns the editor before anything is rendered", () => {
    expect(unknownTokensIn("{{quote.number}} {{nope}} {{line.sku}}", [PROPOSAL_TOKENS, LINE_TOKENS])).toEqual(["nope"]);
  });
});

describe("escaping", () => {
  const nasty = quote({
    customer: { ...quote().customer, name: 'Acme <script>alert("x")</script> & Co' },
    lines: [line({ name: "AC/DC <5kW>" })],
  });

  test("HTML templates escape every value that came from data", () => {
    const { text } = renderProposal("<p>{{customer.name}}</p>{{lines.table}}", "html", context({ quote: nasty }));

    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("AC/DC &lt;5kW&gt;");
    // The table's own markup survives — it is generated, not user-written.
    expect(text).toContain("<table");
  });

  test("Markdown escapes what would break a table", () => {
    const piped = quote({ customer: { ...quote().customer, name: "A | B" } });
    expect(renderProposal("{{customer.name}}", "markdown", context({ quote: piped })).text).toBe("A \\| B");
  });

  test("a value containing $& is not treated as a replacement pattern", () => {
    const dollars = quote({ notes: "Save $& more" });
    expect(renderProposal("{{quote.notes}}", "text", context({ quote: dollars })).text).toBe("Save $& more");
  });
});

describe("robustness", () => {
  test("an unclosed block drops the marker rather than the document", () => {
    const { text } = renderProposal(`Header\n${LINES_OPEN}{{line.sku}}`, "text", context());
    expect(text).toContain("Header");
    expect(text).not.toContain(LINES_OPEN);
  });

  test("a quote with no lines still renders", () => {
    const empty = renderProposal(`{{lines.table}}${LINES_OPEN}x${LINES_CLOSE}`, "text", context({ quote: quote({ lines: [] }) }));
    expect(empty.text).toBe("No items.");
  });

  test("file names are slugged, with the format's extension", () => {
    expect(documentFileName("Q-2026-0001 — Harbour Logistics", "html")).toBe("q-2026-0001-harbour-logistics.html");
    // A record with nothing to slug falls back to what the caller calls it.
    expect(documentFileName("", "markdown")).toBe("document.md");
    expect(documentFileName("", "text", "invoice")).toBe("invoice.txt");
    expect(documentFileName("Quote", "text")).toBe("quote.txt");
  });
});
