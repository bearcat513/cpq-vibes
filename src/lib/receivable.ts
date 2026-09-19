/**
 * Accounts receivable: what is owed, by whom, and for how long.
 *
 * Everything in here is pure, for the same reason the pricing engine is — the
 * browser runs it to show a balance the instant a payment is typed, and the
 * server runs the same functions to decide what to store. An invoice whose
 * balance depends on which of the two you ask is not a receivable, it is an
 * argument.
 *
 * Three rules carry the file.
 *
 * **Nothing about an invoice's condition is stored.** `state` is recorded —
 * draft, issued, void — and that is all. Open, part paid, paid and overdue
 * are worked out from the ledger and the date by `invoiceStatus`, every time
 * they are asked for. A stored "overdue" flag is wrong the morning after it
 * is written, and a stored "paid" that disagrees with the arithmetic is the
 * one bug a finance team will never trust the system again over.
 *
 * **Round at every step, then sum the rounded numbers** — `src/lib/money.ts`
 * explains why. An invoice is the document somebody reconciles against a bank
 * statement, so its total has to equal its visible lines added up.
 *
 * **Never add two currencies.** An account is denominated in one, but it can
 * hold invoices in another, and an aging report that quietly summed them
 * would be a confident wrong number. Those are counted and reported, never
 * added — the same discipline `src/lib/customers.ts` keeps.
 */
import { percentOf, round, sum, type CurrencyCode } from "./money";
import type {
  Invoice,
  InvoiceCredit,
  InvoiceLine,
  InvoicePayment,
  InvoiceStatus,
  InvoiceSummary,
  InvoiceTotals,
} from "./types";

/* --------------------------------- dates -------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Today as `YYYY-MM-DD`, which is the only date shape anything here takes. */
export const today = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/**
 * Days since the epoch, or null for anything unparseable.
 *
 * Parsed at UTC midnight rather than local, so a due date never moves by a
 * day because the person reading it is in Auckland. An invoice is due on a
 * date, not at an instant.
 */
function dayNumber(iso: string): number | null {
  const raw = String(iso ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : Math.floor(time / MS_PER_DAY);
}

/** Whole days from `from` to `to`; negative when `to` is the earlier one. */
export function daysBetween(from: string, to: string): number {
  const start = dayNumber(from);
  const end = dayNumber(to);
  return start === null || end === null ? 0 : end - start;
}

/** `2026-01-31` plus 30 days. Returns "" for a date it could not read. */
export function addDays(iso: string, days: number): string {
  const start = dayNumber(iso);
  if (start === null) return "";
  return new Date((start + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * When an invoice issued on `issueDate` falls due.
 *
 * A draft has no issue date and therefore no due date — an invoice nobody has
 * sent cannot be late, and giving it a due date anyway is how a draft ends up
 * in an aging report.
 */
export const dueDateFor = (issueDate: string, paymentTermDays: number): string =>
  issueDate ? addDays(issueDate, Math.max(0, Math.trunc(paymentTermDays))) : "";

/* -------------------------------- the maths ------------------------------ */

/** One line's own arithmetic: what it comes to, and the tax on it. */
export function lineAmounts(
  line: Pick<InvoiceLine, "quantity" | "unitPrice" | "taxPercent">,
  currency: CurrencyCode,
): { amount: number; taxAmount: number } {
  const amount = round(round(line.unitPrice, currency) * line.quantity, currency);
  return { amount, taxAmount: percentOf(amount, line.taxPercent, currency) };
}

/** Every line with its own numbers filled in, in the order given. */
export const pricedLines = (lines: InvoiceLine[], currency: CurrencyCode): InvoiceLine[] =>
  lines.map(line => ({ ...line, ...lineAmounts(line, currency) }));

/**
 * The line half of the totals: what was demanded.
 *
 * A pure function of the invoice's own lines, which is why this half is
 * stored with the invoice while the other half is not.
 */
export type LineTotals = Pick<InvoiceTotals, "currency" | "lineCount" | "subtotal" | "taxAmount" | "total">;

export function lineTotals(lines: InvoiceLine[], currency: CurrencyCode): LineTotals {
  const priced = pricedLines(lines, currency);

  const subtotal = sum(
    priced.map(line => line.amount),
    currency,
  );
  const taxAmount = sum(
    priced.map(line => line.taxAmount),
    currency,
  );

  return {
    currency,
    lineCount: priced.length,
    subtotal,
    taxAmount,
    total: round(subtotal + taxAmount, currency),
  };
}

/**
 * The ledger half: what has come back against what was demanded.
 *
 * Kept separate because the ledger lives in its own collections now, so this
 * is computed on every read of an invoice rather than cached on it. One
 * function, called from the one place an invoice is assembled, is what keeps
 * a balance from ever disagreeing with the payments behind it.
 */
export type Settlement = Pick<InvoiceTotals, "paidAmount" | "creditedAmount" | "balance">;

export function settlement(
  total: number,
  payments: Pick<InvoicePayment, "amount">[],
  credits: Pick<InvoiceCredit, "amount">[],
  currency: CurrencyCode,
): Settlement {
  const paidAmount = sum(
    payments.map(payment => round(payment.amount, currency)),
    currency,
  );
  const creditedAmount = sum(
    credits.map(credit => round(credit.amount, currency)),
    currency,
  );

  return {
    paidAmount,
    creditedAmount,
    // Deliberately not clamped at zero — see InvoiceTotals.
    balance: round(round(total, currency) - paidAmount - creditedAmount, currency),
  };
}

/**
 * The whole invoice, added up — both halves, from the parts in hand.
 *
 * What the browser draws a live total with while an invoice is being typed,
 * and what the tests pin the arithmetic down with. The server assembles the
 * same number out of `lineTotals` and `settlement` separately, because it
 * stores one half and computes the other.
 */
export function invoiceTotals(
  lines: InvoiceLine[],
  payments: Pick<InvoicePayment, "amount">[],
  credits: Pick<InvoiceCredit, "amount">[],
  currency: CurrencyCode,
): InvoiceTotals {
  const totals = lineTotals(lines, currency);
  return { ...totals, ...settlement(totals.total, payments, credits, currency) };
}

/* ------------------------------ the condition ---------------------------- */

/** The shape `invoiceStatus` needs, which both an Invoice and a summary have. */
type Condition = Pick<Invoice, "state" | "dueDate" | "totals">;

/**
 * What an invoice is, right now.
 *
 * The order matters and is the order a person would reason in: a void
 * invoice is nothing regardless of its numbers, a draft is not a receivable,
 * a settled balance is paid however late it was, and only then does the
 * calendar get a say.
 */
export function invoiceStatus(invoice: Condition, asOf: string = today()): InvoiceStatus {
  if (invoice.state === "void") return "void";
  if (invoice.state === "draft") return "draft";

  const { balance, paidAmount, creditedAmount } = invoice.totals;

  // `<= 0` rather than `=== 0`: an overpaid invoice is settled too, and it
  // should not sit in the aging report waiting for a payment of −40.
  if (balance <= 0) return "paid";

  const late = invoice.dueDate ? daysBetween(invoice.dueDate, asOf) > 0 : false;
  if (late) return "overdue";
  return paidAmount > 0 || creditedAmount > 0 ? "part_paid" : "open";
}

/** How far past its due date, or 0 for one that is not late. */
export function daysOverdue(invoice: Pick<Invoice, "dueDate">, asOf: string = today()): number {
  if (!invoice.dueDate) return 0;
  return Math.max(0, daysBetween(invoice.dueDate, asOf));
}

/** Statuses that represent money still owed — what an aging report is of. */
const OUTSTANDING: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>(["open", "part_paid", "overdue"]);

export const isOutstanding = (status: InvoiceStatus): boolean => OUTSTANDING.has(status);

/* --------------------------------- aging --------------------------------- */

/**
 * The classic five columns.
 *
 * `current` is money owed but not yet late, which is the healthy kind and
 * belongs in the report precisely so the other four can be read against it.
 */
export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export const AGING_BUCKETS: AgingBucket[] = ["current", "1-30", "31-60", "61-90", "90+"];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Not yet due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

export function agingBucketFor(overdueDays: number): AgingBucket {
  if (overdueDays <= 0) return "current";
  if (overdueDays <= 30) return "1-30";
  if (overdueDays <= 60) return "31-60";
  if (overdueDays <= 90) return "61-90";
  return "90+";
}

export type AgingTotals = { amount: number; count: number };

export type AgingReport = {
  currency: CurrencyCode;
  /** The date everything was aged against, so a stale report says it is stale. */
  asOf: string;
  buckets: Record<AgingBucket, AgingTotals>;
  /** Every balance still owed: the five buckets added up. */
  outstanding: number;
  /** The part of it that is late — everything but `current`. */
  overdue: number;
  /** Invoices with a balance, in this currency. */
  invoiceCount: number;
  /** Raised but not issued. Not a receivable yet, which is the point of saying so. */
  draftCount: number;
  draftAmount: number;
  /** Settled, in this currency — what collection actually achieved. */
  paidAmount: number;
  /** Invoices in some other currency: counted, never added up. */
  otherCurrencyCount: number;
  /** The earliest due date still unpaid, and how far past it today is. */
  oldestDueDate: string;
  maxDaysOverdue: number;
};

const emptyBuckets = (): Record<AgingBucket, AgingTotals> => ({
  current: { amount: 0, count: 0 },
  "1-30": { amount: 0, count: 0 },
  "31-60": { amount: 0, count: 0 },
  "61-90": { amount: 0, count: 0 },
  "90+": { amount: 0, count: 0 },
});

export const emptyAging = (currency: CurrencyCode, asOf: string = today()): AgingReport => ({
  currency,
  asOf,
  buckets: emptyBuckets(),
  outstanding: 0,
  overdue: 0,
  invoiceCount: 0,
  draftCount: 0,
  draftAmount: 0,
  paidAmount: 0,
  otherCurrencyCount: 0,
  oldestDueDate: "",
  maxDaysOverdue: 0,
});

/**
 * Ages a set of invoices — the whole workspace's, or one customer's.
 *
 * What is bucketed is the **balance**, not the invoice total: a £10,000
 * invoice with £9,000 paid is £1,000 of exposure, and reporting the £10,000
 * would overstate the book by an order of magnitude on a well-collected
 * ledger. Voided invoices are not in it at all, and drafts are counted
 * separately rather than aged, because neither is money anyone is owed.
 */
export function agingReport(
  invoices: (Invoice | InvoiceSummary)[],
  currency: CurrencyCode,
  asOf: string = today(),
): AgingReport {
  const report = emptyAging(currency, asOf);
  const perBucket: Record<AgingBucket, number[]> = {
    current: [],
    "1-30": [],
    "31-60": [],
    "61-90": [],
    "90+": [],
  };
  const paid: number[] = [];
  const drafts: number[] = [];

  for (const invoice of invoices) {
    const status = invoiceStatus(invoice, asOf);
    if (status === "void") continue;

    if (invoice.currency !== currency) {
      report.otherCurrencyCount += 1;
      continue;
    }

    if (status === "draft") {
      report.draftCount += 1;
      drafts.push(round(invoice.totals.total, currency));
      continue;
    }

    if (status === "paid") {
      paid.push(round(invoice.totals.paidAmount, currency));
      continue;
    }

    const overdue = daysOverdue(invoice, asOf);
    const bucket = agingBucketFor(overdue);

    perBucket[bucket].push(round(invoice.totals.balance, currency));
    report.buckets[bucket].count += 1;
    report.invoiceCount += 1;

    if (invoice.dueDate && (!report.oldestDueDate || invoice.dueDate < report.oldestDueDate)) {
      report.oldestDueDate = invoice.dueDate;
    }
    if (overdue > report.maxDaysOverdue) report.maxDaysOverdue = overdue;
  }

  for (const bucket of AGING_BUCKETS) {
    report.buckets[bucket].amount = sum(perBucket[bucket], currency);
  }

  report.outstanding = sum(
    AGING_BUCKETS.map(bucket => report.buckets[bucket].amount),
    currency,
  );
  report.overdue = sum(
    AGING_BUCKETS.filter(bucket => bucket !== "current").map(bucket => report.buckets[bucket].amount),
    currency,
  );
  report.paidAmount = sum(paid, currency);
  report.draftAmount = sum(drafts, currency);

  return report;
}

/* ------------------------------ credit limit ----------------------------- */

export type CreditPosition = {
  /** 0 means nobody has set one, which is not the same as a limit of nothing. */
  limit: number;
  outstanding: number;
  /** `limit − outstanding`. Negative means they are over it. */
  available: number;
  /** Whether a limit is set at all, and whether it has been passed. */
  hasLimit: boolean;
  overLimit: boolean;
  /** Where they are against it, 0–100+, for something to draw. 0 with no limit. */
  usedPercent: number;
};

/**
 * A customer's exposure against their credit limit.
 *
 * Deliberately advisory: nothing in this app refuses to quote a customer who
 * is over their limit. A credit limit is a conversation to have before
 * sending the next invoice, not a machine that stops the sale, and a CPQ that
 * blocked a deal on a number somebody typed in last year would be wrong far
 * more often than it was right.
 */
export function creditPosition(limit: number, outstanding: number, currency: CurrencyCode): CreditPosition {
  const clean = round(Math.max(0, limit), currency);
  const owed = round(outstanding, currency);
  return {
    limit: clean,
    outstanding: owed,
    available: round(clean - owed, currency),
    hasLimit: clean > 0,
    overLimit: clean > 0 && owed > clean,
    usedPercent: clean > 0 ? Math.round((owed / clean) * 1000) / 10 : 0,
  };
}
