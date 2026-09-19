/**
 * The invoice a customer receives.
 *
 * A proposal that renders badly costs a deal; an invoice that renders badly
 * costs an argument about money. So the tests here are about the three things
 * that are specific to billing rather than to documents in general: that the
 * status on the page is worked out from the calendar as it renders, that an
 * overpaid invoice says so instead of printing zero, and that the tax on a
 * line survives onto the paper.
 *
 * The substituting, escaping and repeating-block behaviour is the shared
 * renderer's, and is tested once in proposal.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { LINES_CLOSE, LINES_OPEN, unknownTokensIn } from "./document";
import {
  INVOICE_LINE_TOKENS,
  INVOICE_TOKENS,
  renderInvoiceDocument,
  type InvoiceDocumentContext,
} from "./invoiceDocument";
import { lineAmounts, invoiceTotals } from "./receivable";
import type { Invoice, InvoiceCredit, InvoiceLine, InvoicePayment } from "./types";

/** A line with its own arithmetic filled in, the way the server stores one. */
const line = (overrides: Partial<InvoiceLine> = {}): InvoiceLine => {
  const base: InvoiceLine = {
    id: "iln_1",
    sourceLineId: null,
    sku: "PLAT",
    description: "Platform subscription",
    quantity: 10,
    unitPrice: 100,
    amount: 0,
    taxPercent: 8.5,
    taxAmount: 0,
    ...overrides,
  };
  return { ...base, ...lineAmounts(base, "USD") };
};

const invoice = (overrides: Partial<Invoice> = {}): Invoice => {
  const lines = overrides.lines ?? [line()];
  const payments = (overrides.payments ?? []) as InvoicePayment[];
  const credits = (overrides.credits ?? []) as InvoiceCredit[];

  return {
    id: "inv_1",
    number: "INV-2026-0001",
    quoteId: "qte_1",
    quoteNumber: "Q-2026-0001",
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
        line1: "1200 Embarcadero",
        line2: "",
        city: "San Francisco",
        state: "CA",
        postalCode: "94107",
        country: "United States",
      },
      paymentTerms: "Net 30",
    },
    currency: "USD",
    state: "issued",
    issueDate: "2026-08-01",
    dueDate: "2026-08-31",
    paymentTermDays: 30,
    poNumber: "PO-88417",
    notes: "Payable by transfer.",
    internalNotes: "Chase Dana if it slips.",
    lines,
    payments,
    credits,
    totals: invoiceTotals(lines, payments, credits, "USD"),
    ownerId: "u",
    sharedWith: [],
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  } as Invoice;
};

const context = (overrides: Partial<InvoiceDocumentContext> = {}): InvoiceDocumentContext => ({
  invoice: invoice(),
  sellerName: "Sam Rep",
  sellerEmail: "sam@seller.example.com",
  locale: "en-US",
  // Pinned, so a rendered invoice is a fixture rather than a thing that
  // changes overnight — which is exactly the behaviour being tested below.
  asOf: "2026-08-15",
  ...overrides,
});

const everyToken = INVOICE_TOKENS.map(entry => `{{${entry.token}}}`).join("\n");

describe("the invoice vocabulary", () => {
  test("every token it offers resolves to something", () => {
    const result = renderInvoiceDocument(everyToken, "text", context());

    expect(result.unknownTokens).toEqual([]);
    // Not one of them is left as its own name, which is what an editor that
    // offered a token the renderer did not know would look like.
    expect(result.text).not.toContain("{{");
  });

  test("the invoice's own details reach the page", () => {
    const result = renderInvoiceDocument(
      "{{invoice.number}} {{invoice.dueDate}} {{invoice.paymentTerms}} {{invoice.poNumber}} {{customer.name}}",
      "text",
      context(),
    );

    expect(result.text).toBe("INV-2026-0001 2026-08-31 Net 30 PO-88417 Harbour Logistics");
  });

  test("the internal note has no token at all", () => {
    // The collections note is the one thing on an invoice the customer must
    // never read, so it is absent from the vocabulary rather than merely
    // left out of the templates that ship.
    expect(INVOICE_TOKENS.some(entry => entry.token.includes("internal"))).toBe(false);
    expect(renderInvoiceDocument("{{invoice.internalNotes}}", "text", context()).unknownTokens).toEqual([
      "invoice.internalNotes",
    ]);
  });

  test("a line's tax survives onto the paper, line by line", () => {
    const result = renderInvoiceDocument(
      `${LINES_OPEN}{{line.description}}|{{line.amount}}|{{line.taxPercent}}|{{line.taxAmount}}|{{line.total}}\n${LINES_CLOSE}`,
      "text",
      context({
        invoice: invoice({
          lines: [
            line(),
            // Zero-rated beside standard-rated: the case a single rate per
            // invoice cannot express.
            line({ id: "iln_2", sku: "ONBOARD", description: "Onboarding", quantity: 1, unitPrice: 500, taxPercent: 0 }),
          ],
        }),
      }),
    );

    expect(result.text).toContain("Platform subscription|$1,000.00|8.5%|$85.00|$1,085.00");
    expect(result.text).toContain("Onboarding|$500.00|0%|$0.00|$500.00");
  });
});

describe("what the ledger and the calendar decide", () => {
  test("the status is worked out as it renders, not read off the record", () => {
    const unpaid = invoice();

    // The same invoice, the same stored state, two days either side of its
    // due date. Nothing about the record changes; the document does.
    expect(renderInvoiceDocument("{{invoice.status}}", "text", context({ invoice: unpaid })).text).toBe("Open");
    expect(
      renderInvoiceDocument("{{invoice.status}}", "text", context({ invoice: unpaid, asOf: "2026-09-04" })).text,
    ).toBe("Overdue");
    expect(
      renderInvoiceDocument("{{invoice.daysOverdue}}", "text", context({ invoice: unpaid, asOf: "2026-09-04" })).text,
    ).toBe("4");
  });

  test("a part payment shows as paid, credited and a balance that is the difference", () => {
    const part = invoice({
      payments: [{ id: "pay_1", invoiceId: "inv_1", receivedOn: "2026-08-10", amount: 500, method: "bank_transfer", reference: "", note: "", ownerId: "u", createdAt: "", updatedAt: "" }],
      credits: [{ id: "crd_1", invoiceId: "inv_1", issuedOn: "2026-08-11", amount: 85, reason: "goodwill", note: "", ownerId: "u", createdAt: "", updatedAt: "" }],
    });

    const result = renderInvoiceDocument(
      "{{totals.total}} {{totals.paid}} {{totals.credited}} {{totals.balance}} {{invoice.status}}",
      "text",
      context({ invoice: part }),
    );

    expect(result.text).toBe("$1,085.00 $500.00 $85.00 $500.00 Part paid");
  });

  test("an overpaid invoice prints what it owes back, not zero", () => {
    // Clamping here would be the document quietly losing a customer's money.
    const overpaid = invoice({
      payments: [{ id: "pay_1", invoiceId: "inv_1", receivedOn: "2026-08-10", amount: 1_200, method: "bank_transfer", reference: "", note: "", ownerId: "u", createdAt: "", updatedAt: "" }],
    });

    const result = renderInvoiceDocument("{{totals.balance}} {{invoice.status}}", "text", context({ invoice: overpaid }));

    expect(result.text).toBe("-$115.00 Paid");
  });
});

describe("the documents themselves", () => {
  test("the ready-made table carries every line, with its tax", () => {
    const result = renderInvoiceDocument("{{lines.table}}", "markdown", context());

    expect(result.text).toContain("| SKU | Description | Qty | Unit price | Tax | Total |");
    expect(result.text).toContain("| PLAT | Platform subscription | 10 | $100.00 | $85.00 | $1,085.00 |");
  });

  test("an invoice with no lines still produces a document", () => {
    const result = renderInvoiceDocument("{{lines.table}}", "text", context({ invoice: invoice({ lines: [] }) }));
    expect(result.text).toBe("No lines.");
  });

  test("markup in a description is text, not markup", () => {
    const result = renderInvoiceDocument(
      "{{line.description}}",
      "html",
      // Rendered outside the line block on purpose: the token is unknown
      // there, so this is about the *description* token in the table.
      context({ invoice: invoice({ lines: [line({ description: "AC/DC <5kW> & spares" })] }) }),
    );
    expect(result.unknownTokens).toEqual(["line.description"]);

    const table = renderInvoiceDocument(
      "{{lines.table}}",
      "html",
      context({ invoice: invoice({ lines: [line({ description: "AC/DC <5kW> & spares" })] }) }),
    );
    expect(table.text).toContain("AC/DC &lt;5kW&gt; &amp; spares");
    expect(table.text).not.toContain("<5kW>");
  });

  test("an unknown token is a gap, and the editor is told which", () => {
    expect(unknownTokensIn("{{invoice.number}} {{quote.validUntil}}", [INVOICE_TOKENS, INVOICE_LINE_TOKENS])).toEqual([
      "quote.validUntil",
    ]);
  });
});
