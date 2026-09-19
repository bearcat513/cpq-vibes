/**
 * Invoices: raising them, and keeping their arithmetic honest.
 *
 * The same division of labour as `src/server/quotes.ts`. A request says what
 * somebody chose — these lines, this payment, issue it today — and this module
 * recomputes every number from `src/lib/receivable.ts` and stores what came
 * out. Totals in a request body are ignored and overwritten, exactly as they
 * are for a quote, and for the sharper version of the same reason: a client
 * that could set its own balance could mark its own debts paid.
 *
 * Three rules are enforced here rather than left to the UI, because they are
 * what makes a ledger a ledger:
 *
 * **An issued invoice's lines are fixed.** Once a document has gone to an
 * accounts payable department, the way to change what is owed is a credit,
 * not an edit. Editing is a draft-only operation.
 *
 * **Only an issued invoice has a ledger.** You cannot take a payment against
 * a draft — there is nothing to pay yet — and you cannot take one against a
 * void invoice, because voiding says it never should have existed.
 *
 * **Nothing that was ever issued is deleted.** Invoice numbers are supposed to
 * be sequential and gapless; a draft may be thrown away because it was never
 * a document, and anything past that is voided instead.
 */
import {
  agingReport,
  dueDateFor,
  invoiceTotals,
  pricedLines,
  today,
  type AgingReport,
} from "../lib/receivable";
import { formatMoney } from "../lib/money";
import {
  type Invoice,
  type InvoiceCredit,
  type InvoiceLine,
  type InvoicePayment,
  type Quote,
} from "../lib/types";
import { localId, type CreditInput, type InvoiceHeaderInput, type PaymentInput } from "../lib/validate";
import {
  createInvoice as insertInvoice,
  deleteInvoice,
  getAccount,
  getInvoice,
  getQuote,
  listInvoices,
  listInvoicesForQuote,
  nextInvoiceNumber,
  updateInvoice,
  type InvoiceRecordInput,
} from "./db";
import { ApiError } from "./http";
import { snapshotCustomer } from "./quotes";

/* -------------------------------- assembling ------------------------------ */

/**
 * Everything a stored invoice needs, with its numbers worked out from scratch.
 *
 * Both the lines and the totals are replaced: what is stored on each line is
 * what the totals were added up from, so the document can never hold an
 * amount that its own subtotal disagrees with.
 */
function recompute(input: Omit<InvoiceRecordInput, "totals">): InvoiceRecordInput {
  const lines = pricedLines(input.lines, input.currency);
  return {
    ...input,
    lines,
    totals: invoiceTotals(lines, input.payments, input.credits, input.currency),
  };
}

/** The record shape of an invoice already in hand, for a partial update. */
const recordOf = (invoice: Invoice): Omit<InvoiceRecordInput, "totals"> => ({
  number: invoice.number,
  quoteId: invoice.quoteId,
  quoteNumber: invoice.quoteNumber,
  customer: invoice.customer,
  currency: invoice.currency,
  state: invoice.state,
  issueDate: invoice.issueDate,
  dueDate: invoice.dueDate,
  paymentTermDays: invoice.paymentTermDays,
  poNumber: invoice.poNumber,
  notes: invoice.notes,
  internalNotes: invoice.internalNotes,
  lines: invoice.lines,
  payments: invoice.payments,
  credits: invoice.credits,
});

/**
 * Writes an invoice back, having recomputed everything it says.
 *
 * Every mutation in this file goes through here, so there is exactly one place
 * a balance is ever calculated for storage.
 */
async function save(token: string, id: string, next: Omit<InvoiceRecordInput, "totals">): Promise<Invoice> {
  const saved = await updateInvoice(token, id, recompute(next));
  if (!saved) throw new ApiError("Invoice not found, or not yours to change.", 404);
  return saved;
}

async function load(token: string, id: string): Promise<Invoice> {
  const invoice = await getInvoice(token, id);
  if (!invoice) throw new ApiError("Invoice not found.", 404);
  return invoice;
}

/* --------------------------------- creating ------------------------------- */

export type InvoiceResult = {
  invoice: Invoice;
  /** Things worth saying out loud but not worth refusing over. */
  warnings: string[];
};

/**
 * A blank invoice for one customer.
 *
 * The customer is snapshotted the same way a quote's is — copied, not
 * referenced — and the payment terms come with them, so the due date this
 * invoice eventually gets is the terms they were on when it was raised.
 */
export async function createBlankInvoice(
  token: string,
  header: InvoiceHeaderInput,
  lines: InvoiceLine[],
): Promise<InvoiceResult> {
  const account = header.accountId ? await getAccount(token, header.accountId) : null;
  if (header.accountId && !account) throw new ApiError("That customer does not exist.", 400);

  const termDays = account ? account.paymentTermDays : header.paymentTermDays;
  const currency = account ? account.currency : header.currency;

  const warnings: string[] = [];
  if (account && header.currency !== account.currency) {
    warnings.push(
      `${account.name} is invoiced in ${account.currency}, so this invoice was raised in ${account.currency} ` +
        `rather than ${header.currency}.`,
    );
  }

  return {
    invoice: await insert(token, {
      quoteId: null,
      quoteNumber: "",
      customer: snapshotCustomer(account),
      currency,
      state: "draft",
      issueDate: "",
      dueDate: "",
      paymentTermDays: termDays,
      poNumber: header.poNumber,
      notes: header.notes,
      internalNotes: header.internalNotes,
      lines,
      payments: [],
      credits: [],
    }),
    warnings,
  };
}

/** Inserts, retrying once or twice if two invoices raced for the same number. */
async function insert(token: string, draft: Omit<InvoiceRecordInput, "totals" | "number">): Promise<Invoice> {
  for (let attempt = 0; ; attempt++) {
    const number = await nextInvoiceNumber(token, attempt);
    try {
      return await insertInvoice(token, recompute({ ...draft, number }));
    } catch (error) {
      if (attempt < 4 && error instanceof ApiError && /number/i.test(error.message)) continue;
      throw error;
    }
  }
}

/** Quote statuses it makes sense to bill: one the customer has actually seen. */
const BILLABLE: Quote["status"][] = ["sent", "accepted"];

/**
 * Raises an invoice for a whole quote.
 *
 * `sent` as well as `accepted`, because a deposit invoice going out before the
 * signature comes back is ordinary commercial practice. Everything else is
 * refused: there is nothing to bill on a draft, and billing something that was
 * declined is a mistake worth catching here.
 *
 * ## What becomes a line
 *
 * One line per quote line, plus a line each for the quote-level discount, any
 * quote-level pricing adjustment, and shipping — because an invoice that
 * folded those into the line prices would not add up to anything the customer
 * could check against the quote they signed.
 *
 * A recurring line is billed for its whole term: `quantity × periods` at the
 * quote's unit price, with the term spelled out in the description. Invoicing
 * a 36-month subscription monthly is a billing schedule, which is the next
 * thing to build here and deliberately not this.
 *
 * ## Reconciliation
 *
 * The invoice re-totals itself from its own lines rather than copying the
 * quote's grand total, so a per-line pricing adjustment can leave the two a
 * penny or two apart. That difference is reported as a warning naming both
 * numbers, rather than hidden — an invoice that silently disagrees with the
 * quote behind it is found during a bank reconciliation, months later.
 */
export async function invoiceQuote(token: string, quoteId: string): Promise<InvoiceResult> {
  const quote = await getQuote(token, quoteId);
  if (!quote) throw new ApiError("Quote not found.", 404);

  if (!BILLABLE.includes(quote.status)) {
    throw new ApiError(
      `A quote that is ${quote.status.replace("_", " ")} cannot be invoiced — it has to be sent or accepted first.`,
      409,
    );
  }
  if (!quote.lines.length) throw new ApiError("There is nothing on this quote to invoice.", 400);

  const warnings: string[] = [];

  // Raising a second invoice for the same quote is legal — a deposit and then
  // the balance — but it is also the commonest way to double-bill somebody.
  const already = await listInvoicesForQuote(token, quote.id);
  const live = already.filter(invoice => invoice.state !== "void");
  if (live.length) {
    warnings.push(
      `${quote.number} has already been invoiced as ${live.map(invoice => invoice.number).join(", ")}. ` +
        `This is an additional invoice, not a replacement.`,
    );
  }

  const account = quote.customer.accountId ? await getAccount(token, quote.customer.accountId) : null;
  const termDays = account?.paymentTermDays ?? 30;

  const invoice = await insert(token, {
    quoteId: quote.id,
    quoteNumber: quote.number,
    // The quote's own snapshot, not the account as it stands now: the invoice
    // should be addressed exactly where the accepted quote was.
    customer: { ...quote.customer },
    currency: quote.currency,
    state: "draft",
    issueDate: "",
    dueDate: "",
    paymentTermDays: termDays,
    poNumber: "",
    notes: quote.notes,
    internalNotes: `Raised from ${quote.number}.`,
    lines: linesFromQuote(quote),
    payments: [],
    credits: [],
  });

  if (invoice.totals.total !== quote.totals.grandTotal) {
    warnings.push(
      `This invoice comes to ${formatMoney(invoice.totals.total, invoice.currency)} against the quote's ` +
        `${formatMoney(quote.totals.grandTotal, quote.currency)}. Check the lines before issuing it.`,
    );
  }

  return { invoice, warnings };
}

/** The quote, turned into billable lines. */
export function linesFromQuote(quote: Quote): InvoiceLine[] {
  const tax = quote.taxPercent;
  const lines: InvoiceLine[] = [];

  for (const line of quote.lines) {
    const recurring = line.chargeType === "recurring" && line.periods > 1;
    const detail = [line.optionNames.join(", "), recurring ? `${line.termMonths} months` : ""]
      .filter(Boolean)
      .join(" · ");

    lines.push({
      id: localId("inl"),
      sourceLineId: line.id,
      sku: line.sku,
      description: [line.description || line.name, detail].filter(Boolean).join(" — "),
      // A recurring line is billed for every period of its term, which is what
      // makes the line's amount equal the value the quote committed to.
      quantity: line.quantity * Math.max(1, line.periods),
      unitPrice: line.unitPrice,
      amount: 0,
      taxPercent: tax,
      taxAmount: 0,
    });
  }

  const extra = (description: string, unitPrice: number, taxPercent = tax): void => {
    lines.push({
      id: localId("inl"),
      sourceLineId: null,
      sku: "",
      description,
      quantity: 1,
      unitPrice,
      amount: 0,
      taxPercent,
      taxAmount: 0,
    });
  };

  // Quote-level amounts become their own lines. Folding them into the unit
  // prices would make the invoice impossible to check against the quote.
  if (quote.totals.quoteDiscountAmount > 0) {
    extra(`Quote discount (${quote.discountPercent}%)`, -quote.totals.quoteDiscountAmount);
  }
  if (quote.totals.quoteAdjustment !== 0) {
    extra("Adjustment", quote.totals.quoteAdjustment);
  }
  if (quote.totals.shipping > 0) {
    extra("Shipping", quote.totals.shipping);
  }

  return lines;
}

/* --------------------------------- editing -------------------------------- */

/** Refuses anything that would change a document somebody has already been sent. */
function requireDraft(invoice: Invoice, what: string): void {
  if (invoice.state === "draft") return;
  throw new ApiError(
    invoice.state === "void"
      ? `${invoice.number} is void, so ${what} is no longer possible.`
      : `${invoice.number} has been issued, so ${what} would change a document the customer already has. ` +
        `Raise a credit against it instead.`,
    409,
  );
}

export async function saveInvoice(
  token: string,
  id: string,
  header: InvoiceHeaderInput,
  lines: InvoiceLine[],
): Promise<InvoiceResult> {
  const existing = await load(token, id);
  requireDraft(existing, "editing it");

  const warnings: string[] = [];

  // Re-attaching the customer re-snapshots them, which is the only way to
  // correct an invoice raised against the wrong account.
  let customer = existing.customer;
  let termDays = header.paymentTermDays;
  let currency = header.currency;

  if (header.accountId && header.accountId !== existing.customer.accountId) {
    const account = await getAccount(token, header.accountId);
    if (!account) throw new ApiError("That customer does not exist.", 400);
    customer = snapshotCustomer(account);
    termDays = account.paymentTermDays;
    currency = account.currency;
    warnings.push(`Re-addressed to ${account.name}, on their ${account.paymentTerms || `${termDays}-day`} terms.`);
  }

  return {
    invoice: await save(token, id, {
      ...recordOf(existing),
      customer,
      currency,
      paymentTermDays: termDays,
      poNumber: header.poNumber,
      notes: header.notes,
      internalNotes: header.internalNotes,
      lines,
    }),
    warnings,
  };
}

/* ------------------------------- the lifecycle ---------------------------- */

/**
 * Issues a draft: dates it, works out when it falls due, and makes it a
 * receivable.
 *
 * The due date is computed once, here, from the terms the invoice is carrying
 * — not read from the account every time it is displayed. Moving a customer to
 * Net 60 must not move a date their accounts payable team has diarised.
 */
export async function issueInvoice(token: string, id: string, on?: string): Promise<Invoice> {
  const invoice = await load(token, id);
  requireDraft(invoice, "issuing it");

  if (!invoice.lines.length) throw new ApiError("There is nothing on this invoice to issue.", 400);
  if (invoice.totals.total === 0) {
    throw new ApiError("This invoice comes to nothing. Add a line, or delete it.", 400);
  }

  const issueDate = on || today();
  return save(token, id, {
    ...recordOf(invoice),
    state: "issued",
    issueDate,
    dueDate: dueDateFor(issueDate, invoice.paymentTermDays),
  });
}

/**
 * Voids an invoice — the admission that it should never have been raised.
 *
 * Refused once any money has been taken against it. An invoice that was paid
 * and then went wrong is a refund or a credit, both of which leave a trail;
 * voiding it would erase a payment that is sitting on a bank statement.
 */
export async function voidInvoice(token: string, id: string): Promise<Invoice> {
  const invoice = await load(token, id);

  if (invoice.state === "void") return invoice;
  if (invoice.payments.length) {
    throw new ApiError(
      `${invoice.number} has ${invoice.payments.length} payment${invoice.payments.length === 1 ? "" : "s"} ` +
        `recorded against it and cannot be voided. Credit it instead.`,
      409,
    );
  }

  return save(token, id, { ...recordOf(invoice), state: "void" });
}

/** Deletes a draft. Anything that was ever issued is voided instead. */
export async function discardInvoice(token: string, id: string): Promise<void> {
  const invoice = await load(token, id);
  if (invoice.state !== "draft") {
    throw new ApiError(
      `${invoice.number} has been issued, and an issued invoice is never deleted — invoice numbers have to be ` +
        `gapless. Void it instead.`,
      409,
    );
  }
  if (!(await deleteInvoice(token, id))) throw new ApiError("Invoice not found, or not yours to delete.", 404);
}

/* --------------------------------- the ledger ----------------------------- */

/** Refuses a ledger entry against something that has no ledger. */
function requireIssued(invoice: Invoice, what: string): void {
  if (invoice.state === "issued") return;
  throw new ApiError(
    invoice.state === "draft"
      ? `${invoice.number} has not been issued yet, so there is nothing to ${what} against.`
      : `${invoice.number} is void, so nothing can be ${what === "pay" ? "paid" : "credited"} against it.`,
    409,
  );
}

export async function recordPayment(token: string, id: string, input: PaymentInput): Promise<InvoiceResult> {
  const invoice = await load(token, id);
  requireIssued(invoice, "pay");

  const payment: InvoicePayment = { id: localId("pmt"), recordedAt: new Date().toISOString(), ...input };

  const warnings: string[] = [];
  // An overpayment is recorded, not refused: the money is in the bank whether
  // or not the invoice expected it, and the balance goes negative to say so.
  if (payment.amount > invoice.totals.balance) {
    warnings.push(
      `${formatMoney(payment.amount, invoice.currency)} is more than the ` +
        `${formatMoney(invoice.totals.balance, invoice.currency)} outstanding. ` +
        `${invoice.number} will be overpaid by ${formatMoney(payment.amount - invoice.totals.balance, invoice.currency)}.`,
    );
  }

  return {
    invoice: await save(token, id, { ...recordOf(invoice), payments: [...invoice.payments, payment] }),
    warnings,
  };
}

/**
 * Removes a payment — for the one recorded against the wrong invoice, or
 * twice. Not a refund: a refund is money leaving, and this is the correction
 * of a bookkeeping entry that should not have existed.
 */
export async function removePayment(token: string, id: string, paymentId: string): Promise<Invoice> {
  const invoice = await load(token, id);
  const payments = invoice.payments.filter(payment => payment.id !== paymentId);
  if (payments.length === invoice.payments.length) {
    throw new ApiError("No such payment on this invoice.", 404);
  }
  return save(token, id, { ...recordOf(invoice), payments });
}

/**
 * Credits an invoice: an adjustment, a return, a goodwill gesture, or the
 * admission that the money is not coming.
 *
 * Refused when it exceeds what is still owed. An overpayment is the bank
 * telling you something happened; an over-credit is only ever a typo on your
 * own side, and letting one through would show a customer as being owed money
 * they were never charged.
 */
export async function recordCredit(token: string, id: string, input: CreditInput): Promise<InvoiceResult> {
  const invoice = await load(token, id);
  requireIssued(invoice, "credit");

  if (input.amount > invoice.totals.balance) {
    throw new ApiError(
      `A credit of ${formatMoney(input.amount, invoice.currency)} is more than the ` +
        `${formatMoney(invoice.totals.balance, invoice.currency)} still owed on ${invoice.number}.`,
      400,
    );
  }

  const credit: InvoiceCredit = { id: localId("crd"), recordedAt: new Date().toISOString(), ...input };
  const saved = await save(token, id, { ...recordOf(invoice), credits: [...invoice.credits, credit] });

  const warnings: string[] =
    input.reason === "write_off"
      ? [`${formatMoney(input.amount, invoice.currency)} written off against ${invoice.number}.`]
      : [];

  return { invoice: saved, warnings };
}

export async function removeCredit(token: string, id: string, creditId: string): Promise<Invoice> {
  const invoice = await load(token, id);
  const credits = invoice.credits.filter(credit => credit.id !== creditId);
  if (credits.length === invoice.credits.length) {
    throw new ApiError("No such credit on this invoice.", 404);
  }
  return save(token, id, { ...recordOf(invoice), credits });
}

/* --------------------------------- reporting ------------------------------ */

/**
 * The aging report, in one currency, as of a date.
 *
 * Built from every invoice rather than a page of them: understating what you
 * are owed is the one direction a finance number must not be wrong in.
 */
export async function ageReceivables(
  token: string,
  currency: Invoice["currency"],
  asOf?: string,
): Promise<AgingReport> {
  return agingReport(await listInvoices(token), currency, asOf || today());
}
