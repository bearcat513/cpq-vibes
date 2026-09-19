/**
 * The receivables arithmetic.
 *
 * Three things in here are worth asserting rather than trusting: the day an
 * invoice becomes overdue, what an aging report actually counts, and what
 * happens when a customer pays the wrong amount. All three are invisible on
 * screen until a finance team finds them, by which point the number has been
 * in a board pack.
 */
import { describe, expect, test } from "bun:test";
import {
  addDays,
  agingBucketFor,
  agingReport,
  creditPosition,
  daysBetween,
  daysOverdue,
  dueDateFor,
  invoiceStatus,
  invoiceTotals,
  isOutstanding,
  lineAmounts,
  pricedLines,
} from "./receivable";
import {
  emptyCustomer,
  type CurrencyCode,
  type InvoiceCredit,
  type InvoiceLine,
  type InvoicePayment,
  type InvoiceState,
  type InvoiceStatus,
  type InvoiceSummary,
} from "./types";

/* ------------------------------- fixtures -------------------------------- */

const line = (quantity: number, unitPrice: number, taxPercent = 0): InvoiceLine => ({
  id: `inl_${quantity}_${unitPrice}_${taxPercent}`,
  sourceLineId: null,
  sku: "PLAT",
  description: "Platform",
  quantity,
  unitPrice,
  amount: 0,
  taxPercent,
  taxAmount: 0,
});

const payment = (amount: number, receivedOn = "2026-02-01"): InvoicePayment => ({
  id: `pmt_${amount}`,
  receivedOn,
  amount,
  method: "bank_transfer",
  reference: "",
  note: "",
  recordedAt: "2026-02-01T00:00:00Z",
});

const credit = (amount: number): InvoiceCredit => ({
  id: `crd_${amount}`,
  issuedOn: "2026-02-01",
  amount,
  reason: "adjustment",
  note: "",
  recordedAt: "2026-02-01T00:00:00Z",
});

/** An invoice summary, built from what actually moves the arithmetic. */
const invoice = (
  state: InvoiceState,
  dueDate: string,
  total: number,
  paid = 0,
  credited = 0,
  currency: CurrencyCode = "USD",
): InvoiceSummary =>
  ({
    id: `inv_${dueDate}_${total}_${paid}`,
    number: "INV-2026-0001",
    quoteId: null,
    quoteNumber: "",
    customer: emptyCustomer(),
    currency,
    state,
    issueDate: dueDate ? addDays(dueDate, -30) : "",
    dueDate,
    paymentTermDays: 30,
    poNumber: "",
    notes: "",
    internalNotes: "",
    totals: {
      currency,
      lineCount: 1,
      subtotal: total,
      taxAmount: 0,
      total,
      paidAmount: paid,
      creditedAmount: credited,
      balance: total - paid - credited,
    },
    ownerId: "u",
    sharedWith: [],
    createdAt: "",
    updatedAt: "",
    lineCount: 1,
    paymentCount: paid ? 1 : 0,
  }) as InvoiceSummary;

/* --------------------------------- dates --------------------------------- */

describe("the calendar", () => {
  test("adding days crosses months, years and a leap day", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    // 2028 is a leap year, so the 28th plus one is the 29th, not March.
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  test("a date nothing can read gives an empty string, not an Invalid Date", () => {
    expect(addDays("", 30)).toBe("");
    expect(addDays("not a date", 30)).toBe("");
    expect(daysBetween("", "2026-01-01")).toBe(0);
  });

  test("days between is signed and counts whole days", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
    expect(daysBetween("2026-01-01", "2026-01-01")).toBe(0);
  });

  test("a draft has no due date, because an unsent invoice cannot be late", () => {
    expect(dueDateFor("", 30)).toBe("");
    expect(dueDateFor("2026-01-01", 30)).toBe("2026-01-31");
    expect(dueDateFor("2026-01-01", 0)).toBe("2026-01-01");
  });
});

/* -------------------------------- the maths ------------------------------ */

describe("what an invoice comes to", () => {
  test("a line is quantity times unit price, rounded to the currency", () => {
    expect(lineAmounts({ quantity: 3, unitPrice: 33.333, taxPercent: 0 }, "USD").amount).toBe(99.99);
    // Yen has no minor unit: a price of 33.333 is ¥33, and three are ¥99.
    expect(lineAmounts({ quantity: 3, unitPrice: 33.333, taxPercent: 0 }, "JPY").amount).toBe(99);
  });

  test("tax is per line, so one invoice can mix rates", () => {
    const totals = invoiceTotals([line(1, 100, 20), line(1, 100, 0)], [], [], "GBP");
    expect(totals.subtotal).toBe(200);
    expect(totals.taxAmount).toBe(20);
    expect(totals.total).toBe(220);
  });

  test("the total equals the lines a reader can see, added up", () => {
    // The rule from money.ts: sum the rounded numbers, never the raw ones.
    const lines = [line(3, 33.333), line(3, 33.333), line(3, 33.333)];
    const priced = pricedLines(lines, "USD");
    const totals = invoiceTotals(lines, [], [], "USD");

    expect(priced.map(entry => entry.amount)).toEqual([99.99, 99.99, 99.99]);
    expect(totals.subtotal).toBe(299.97);
  });

  test("payments and credits both come off the balance", () => {
    const totals = invoiceTotals([line(1, 1000)], [payment(400)], [credit(100)], "USD");
    expect(totals.paidAmount).toBe(400);
    expect(totals.creditedAmount).toBe(100);
    expect(totals.balance).toBe(500);
  });

  test("an overpaid invoice goes negative rather than losing the money", () => {
    // Clamping at zero would be the app quietly forgetting it owes £40 back.
    const totals = invoiceTotals([line(1, 100)], [payment(140)], [], "GBP");
    expect(totals.balance).toBe(-40);
  });

  test("a negative line is legal — it is how a discount appears on an invoice", () => {
    const totals = invoiceTotals([line(1, 1000), line(1, -150)], [], [], "USD");
    expect(totals.subtotal).toBe(850);
  });

  test("a whole realistic invoice, end to end", () => {
    // The shape `invoiceQuote` produces: a charge, the quote's discount as its
    // own negative line, one rate across both — then part paid and credited.
    // Every figure a finance person would check, in one assertion.
    const totals = invoiceTotals(
      [line(1, 9_500, 8.5), line(1, -950, 8.5)],
      [payment(4_000)],
      [credit(250)],
      "USD",
    );

    expect(totals).toMatchObject({
      subtotal: 8_550,
      // Tax is charged per line, so the discount line relieves tax too:
      // 807.50 on the charge, −80.75 on the discount.
      taxAmount: 726.75,
      total: 9_276.75,
      paidAmount: 4_000,
      creditedAmount: 250,
      balance: 5_026.75,
    });
  });
});

/* ------------------------------ the condition ---------------------------- */

describe("what an invoice is, as opposed to what it says", () => {
  const asOf = "2026-06-15";

  test("void and draft answer before the numbers are even looked at", () => {
    expect(invoiceStatus(invoice("void", "2020-01-01", 100), asOf)).toBe("void");
    expect(invoiceStatus(invoice("draft", "", 100), asOf)).toBe("draft");
  });

  test("a settled balance is paid, however late it was", () => {
    expect(invoiceStatus(invoice("issued", "2020-01-01", 100, 100), asOf)).toBe("paid");
    // Settled by a credit rather than by cash is still settled.
    expect(invoiceStatus(invoice("issued", "2020-01-01", 100, 0, 100), asOf)).toBe("paid");
    // And so is overpaid.
    expect(invoiceStatus(invoice("issued", "2020-01-01", 100, 140), asOf)).toBe("paid");
  });

  test("an invoice falls overdue the day after it is due, not on it", () => {
    // The customer has the whole of the due date to pay. Off-by-one here is
    // a dunning letter sent to somebody who was never late.
    expect(invoiceStatus(invoice("issued", "2026-06-16", 100), asOf)).toBe("open");
    expect(invoiceStatus(invoice("issued", "2026-06-15", 100), asOf)).toBe("open");
    expect(invoiceStatus(invoice("issued", "2026-06-14", 100), asOf)).toBe("overdue");
  });

  test("part paid is for one in hand; late and part paid reads as overdue", () => {
    expect(invoiceStatus(invoice("issued", "2026-07-01", 100, 40), asOf)).toBe("part_paid");
    // Being late is the more urgent fact, so it wins the label.
    expect(invoiceStatus(invoice("issued", "2026-01-01", 100, 40), asOf)).toBe("overdue");
  });

  test("days overdue never goes negative", () => {
    expect(daysOverdue({ dueDate: "2026-06-01" }, asOf)).toBe(14);
    expect(daysOverdue({ dueDate: "2026-07-01" }, asOf)).toBe(0);
    expect(daysOverdue({ dueDate: "" }, asOf)).toBe(0);
  });

  test("outstanding is the three that still owe money", () => {
    const owed: InvoiceStatus[] = ["open", "part_paid", "overdue"];
    const settled: InvoiceStatus[] = ["draft", "paid", "void"];
    expect(owed.every(isOutstanding)).toBe(true);
    expect(settled.some(isOutstanding)).toBe(false);
  });
});

/* --------------------------------- aging --------------------------------- */

describe("the aging report", () => {
  const asOf = "2026-06-15";

  test("the buckets are boundaries anyone can check", () => {
    expect(agingBucketFor(0)).toBe("current");
    expect(agingBucketFor(1)).toBe("1-30");
    expect(agingBucketFor(30)).toBe("1-30");
    expect(agingBucketFor(31)).toBe("31-60");
    expect(agingBucketFor(60)).toBe("31-60");
    expect(agingBucketFor(61)).toBe("61-90");
    expect(agingBucketFor(90)).toBe("61-90");
    expect(agingBucketFor(91)).toBe("90+");
  });

  test("what is aged is the balance, not the invoice total", () => {
    // £10,000 invoiced with £9,000 paid is £1,000 of exposure. Reporting the
    // £10,000 would overstate a well-collected book tenfold.
    const report = agingReport([invoice("issued", "2026-05-01", 10_000, 9_000)], "USD", asOf);

    expect(report.outstanding).toBe(1_000);
    expect(report.buckets["31-60"].amount).toBe(1_000);
    expect(report.buckets["31-60"].count).toBe(1);
  });

  test("drafts, voids and settled invoices are not receivables", () => {
    const report = agingReport(
      [
        invoice("draft", "", 500),
        invoice("void", "2026-01-01", 900),
        invoice("issued", "2026-01-01", 700, 700),
        invoice("issued", "2026-06-30", 100),
      ],
      "USD",
      asOf,
    );

    expect(report.outstanding).toBe(100);
    expect(report.invoiceCount).toBe(1);
    // A draft is counted separately, because it is a nudge rather than an asset.
    expect(report.draftCount).toBe(1);
    expect(report.draftAmount).toBe(500);
    // And what was collected is reported rather than thrown away.
    expect(report.paidAmount).toBe(700);
  });

  test("it lands in the right columns and totals both ways", () => {
    const report = agingReport(
      [
        invoice("issued", "2026-07-01", 100), // not yet due
        invoice("issued", "2026-06-01", 200), // 14 days
        invoice("issued", "2026-05-01", 400), // 45 days
        invoice("issued", "2026-04-01", 800), // 75 days
        invoice("issued", "2025-01-01", 1_600), // well past 90
      ],
      "USD",
      asOf,
    );

    expect(report.buckets.current.amount).toBe(100);
    expect(report.buckets["1-30"].amount).toBe(200);
    expect(report.buckets["31-60"].amount).toBe(400);
    expect(report.buckets["61-90"].amount).toBe(800);
    expect(report.buckets["90+"].amount).toBe(1_600);

    expect(report.outstanding).toBe(3_100);
    // Overdue is everything but the healthy column.
    expect(report.overdue).toBe(3_000);
    expect(report.oldestDueDate).toBe("2025-01-01");
    expect(report.maxDaysOverdue).toBe(530);
  });

  test("an invoice in another currency is counted, never added", () => {
    const report = agingReport(
      [invoice("issued", "2026-05-01", 100), invoice("issued", "2026-05-01", 9_999, 0, 0, "JPY")],
      "USD",
      asOf,
    );

    expect(report.outstanding).toBe(100);
    expect(report.otherCurrencyCount).toBe(1);
    expect(report.invoiceCount).toBe(1);
  });

  test("an empty book reports zeroes and says what it was aged against", () => {
    const report = agingReport([], "EUR", asOf);
    expect(report.outstanding).toBe(0);
    expect(report.overdue).toBe(0);
    expect(report.asOf).toBe(asOf);
    expect(report.oldestDueDate).toBe("");
  });

  test("an overpayment nets against the book rather than inflating it", () => {
    // The overpaid invoice is settled, so it leaves the aging entirely — its
    // −40 does not quietly reduce what other customers owe.
    const report = agingReport(
      [invoice("issued", "2026-05-01", 100, 140), invoice("issued", "2026-05-01", 300)],
      "USD",
      asOf,
    );
    expect(report.outstanding).toBe(300);
  });
});

/* ------------------------------ credit limit ----------------------------- */

describe("a customer's credit position", () => {
  test("no limit set is not the same as a limit of nothing", () => {
    const position = creditPosition(0, 5_000, "USD");
    expect(position.hasLimit).toBe(false);
    expect(position.overLimit).toBe(false);
    expect(position.usedPercent).toBe(0);
  });

  test("available is what is left, and goes negative when they are over", () => {
    expect(creditPosition(10_000, 4_000, "USD")).toMatchObject({
      available: 6_000,
      hasLimit: true,
      overLimit: false,
      usedPercent: 40,
    });
    expect(creditPosition(10_000, 12_500, "USD")).toMatchObject({
      available: -2_500,
      overLimit: true,
      usedPercent: 125,
    });
  });

  test("exactly at the limit is not over it", () => {
    expect(creditPosition(10_000, 10_000, "USD").overLimit).toBe(false);
  });
});
