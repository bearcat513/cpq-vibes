/**
 * Quotes: the part of the server that actually decides things.
 *
 * Everything a quote *says* is derived here, never accepted from a client.
 * A request sends what the rep chose — products, quantities, options,
 * discounts — and this module loads the catalogue, prices it, runs the
 * approval rules over the result and stores what came out. A browser that
 * posts its own totals, or its own "no approvals needed", changes nothing: the
 * numbers are recomputed and overwritten every single time.
 *
 * That is the whole reason the pricing engine is pure and lives in
 * `src/lib/`. The client runs it for instant feedback, this runs it for the
 * record, and because it is the same code the two never disagree about what a
 * quote costs — only about which of them is allowed to say so.
 *
 * Access control is still PocketBase's. Nothing here selects by owner; the
 * collection rules do, evaluated against the caller's own token.
 */
import { allApproved, anyRejected, applyDecision, currentApprovers, evaluateApprovals } from "../lib/approvals";
import { priceQuote, type PriceableLine } from "../lib/pricing";
import {
  emptyCustomer,
  isEditableStatus,
  primaryContact,
  QUOTE_TRANSITIONS,
  type Account,
  type ApprovalRequest,
  type CustomerSnapshot,
  type PriceBook,
  type Product,
  type Quote,
  type QuoteStatus,
} from "../lib/types";
import type { QuoteHeaderInput } from "../lib/validate";
import { asCurrency } from "../lib/money";
import {
  createQuote,
  getAccount,
  getPriceBook,
  getQuote,
  listApprovalRules,
  listPriceBooks,
  listPricingRules,
  listProducts,
  nextQuoteNumber,
  updateQuote,
  type QuoteRecordInput,
} from "./db";
import { ApiError } from "./http";
import { stampApprovers } from "./share";

/* ------------------------------ the catalogue ---------------------------- */

export type Catalogue = {
  products: Product[];
  byId: Map<string, Product>;
  bySku: Map<string, Product>;
  priceBooks: PriceBook[];
};

/**
 * Everything the caller may price with.
 *
 * Read in one go and passed around, rather than fetched per line: a quote with
 * forty lines would otherwise be forty round trips to price, and every one of
 * them would be answering the same question.
 */
export async function loadCatalogue(token: string): Promise<Catalogue> {
  const [products, priceBooks] = await Promise.all([listProducts(token), listPriceBooks(token)]);
  return {
    products,
    byId: new Map(products.map(product => [product.id, product])),
    bySku: new Map(products.map(product => [product.sku, product])),
    priceBooks,
  };
}

/** The price book a quote should use, given what it asked for. */
export function resolvePriceBook(books: PriceBook[], requestedId: string, currency: string): PriceBook | null {
  if (requestedId) {
    const requested = books.find(book => book.id === requestedId);
    if (requested) return requested;
  }
  // Fall back to the default book for the right currency, then to any default.
  return (
    books.find(book => book.isDefault && book.active && book.currency === currency) ??
    books.find(book => book.isDefault && book.active) ??
    null
  );
}

/* ------------------------------- the customer ---------------------------- */

/**
 * The customer details a quote carries itself, copied from the account.
 *
 * Copied rather than referenced, so a quote sent last quarter still renders
 * with the address it was sent to, and a quote shared with a colleague who
 * cannot read your accounts still renders at all.
 */
export function snapshotCustomer(account: Account | null): CustomerSnapshot {
  if (!account) return emptyCustomer();
  // A document is addressed to one person, so the contact list flattens to
  // its primary here. Which one that is can change on the account tomorrow;
  // who this quote was addressed to cannot.
  const contact = primaryContact(account);
  return {
    accountId: account.id,
    name: account.name,
    contactName: contact?.name ?? "",
    contactTitle: contact?.title ?? "",
    contactEmail: contact?.email ?? "",
    contactPhone: contact?.phone ?? "",
    billingAddress: { ...account.billingAddress },
    shippingAddress: { ...account.shippingAddress },
    paymentTerms: account.paymentTerms,
  };
}

/* -------------------------------- pricing -------------------------------- */

export type RepricedQuote = {
  record: QuoteRecordInput;
  issues: string[];
  warnings: string[];
};

type RepriceInput = {
  header: QuoteHeaderInput;
  lines: PriceableLine[];
  existing?: Quote | null;
  number: string;
  status: QuoteStatus;
  version: number;
  supersedesId: string | null;
  customer: CustomerSnapshot;
  approvals: ApprovalRequest[];
  approverIds: string[];
  sentAt?: string;
  decidedAt?: string;
};

/**
 * Prices a quote and returns the record to store. Pure once the catalogue is
 * in hand, which is what makes it safe to call on every save.
 */
export function repriceQuote(input: RepriceInput, catalogue: Catalogue, rules: Awaited<ReturnType<typeof listPricingRules>>): RepricedQuote {
  const currency = asCurrency(input.header.currency);
  const priceBook = resolvePriceBook(catalogue.priceBooks, input.header.priceBookId, currency);

  const priced = priceQuote(
    input.lines,
    {
      currency,
      termMonths: input.header.termMonths,
      discountPercent: input.header.discountPercent,
      taxPercent: input.header.taxPercent,
      shipping: input.header.shipping,
    },
    { products: catalogue.byId, priceBook, rules },
  );

  return {
    record: {
      number: input.number,
      name: input.header.name,
      status: input.status,
      version: input.version,
      supersedesId: input.supersedesId,
      customer: input.customer,
      priceBookId: priceBook?.id ?? "",
      currency,
      termMonths: input.header.termMonths,
      discountPercent: input.header.discountPercent,
      taxPercent: input.header.taxPercent,
      shipping: input.header.shipping,
      validUntil: input.header.validUntil,
      notes: input.header.notes,
      internalNotes: input.header.internalNotes,
      lines: priced.lines,
      totals: priced.totals,
      approvals: input.approvals,
      approverIds: input.approverIds,
      ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      ...(input.decidedAt !== undefined ? { decidedAt: input.decidedAt } : {}),
    },
    issues: priced.issues,
    warnings: priced.warnings,
  };
}

/** `validUntil` + N days from today, as an ISO date. */
export function defaultValidUntil(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Math.max(1, days));
  return date.toISOString().slice(0, 10);
}

/**
 * A quote past its own expiry date reads as expired.
 *
 * Computed on read rather than written by a job: "expired" is a fact about the
 * calendar, and a status that only becomes true when something happens to
 * sweep it is a status that lies between sweeps. The stored value is left
 * alone, so reopening the quote (`draft`) restores it exactly.
 */
export function withExpiry<T extends { status: QuoteStatus; validUntil: string }>(quote: T, today = new Date()): T {
  if (quote.status !== "sent" || !quote.validUntil) return quote;
  return quote.validUntil < today.toISOString().slice(0, 10) ? { ...quote, status: "expired" as QuoteStatus } : quote;
}

/* ------------------------------- creating -------------------------------- */

export type CreateQuoteResult = { quote: Quote; issues: string[]; warnings: string[] };

/**
 * Creates a quote.
 *
 * The number is derived from how many quotes the caller has, so two created in
 * the same second can collide on the unique index. That is retried rather than
 * locked against: the number is a label, and a retry costs less than the
 * machinery that would make a counter authoritative.
 */
export async function createPricedQuote(
  token: string,
  header: QuoteHeaderInput,
  lines: PriceableLine[],
  validDays: number,
): Promise<CreateQuoteResult> {
  const [catalogue, rules, account] = await Promise.all([
    loadCatalogue(token),
    listPricingRules(token),
    header.accountId ? getAccount(token, header.accountId) : Promise.resolve(null),
  ]);

  if (header.accountId && !account) throw new ApiError("That account does not exist, or is not yours.", 404);

  const resolved: QuoteHeaderInput = {
    ...header,
    validUntil: header.validUntil || defaultValidUntil(validDays),
    // The account's own tax and discount are the starting point, since they
    // are facts about the customer rather than about this quote.
    taxPercent: account?.taxExempt ? 0 : (header.taxPercent || account?.taxPercent) ?? header.taxPercent,
    priceBookId: header.priceBookId || account?.priceBookId || "",
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    const number = await nextQuoteNumber(token, attempt);
    const priced = repriceQuote(
      {
        header: resolved,
        lines,
        number,
        status: "draft",
        version: 1,
        supersedesId: null,
        customer: snapshotCustomer(account),
        approvals: [],
        approverIds: [],
        sentAt: "",
        decidedAt: "",
      },
      catalogue,
      rules,
    );

    try {
      return { quote: await createQuote(token, priced.record), issues: priced.issues, warnings: priced.warnings };
    } catch (error) {
      // A duplicate number is the one failure worth another go.
      if (attempt < 4 && error instanceof ApiError && /number/i.test(error.message)) continue;
      throw error;
    }
  }

  throw new ApiError("Could not allocate a quote number. Try again.", 409);
}

/* -------------------------------- editing -------------------------------- */

/**
 * Saves an edit.
 *
 * Only a quote that is still the rep's to edit — draft, or one an approver
 * sent back — can be written to. A quote in review is being looked at by
 * somebody, and a sent quote is a document that exists in someone else's inbox
 * with a number on it; changing either underneath its readers is how a CPQ
 * stops being trustworthy. `revise` is the supported way forward from there.
 */
export async function saveQuote(
  token: string,
  id: string,
  header: QuoteHeaderInput,
  lines: PriceableLine[],
): Promise<CreateQuoteResult> {
  const existing = await getQuote(token, id);
  if (!existing) throw new ApiError("Quote not found, or not yours to change.", 404);

  if (!isEditableStatus(existing.status)) {
    throw new ApiError(
      `This quote is ${existing.status.replace("_", " ")}, so it cannot be edited. ` +
        "Reopen it as a draft, or create a new revision.",
      409,
    );
  }

  const [catalogue, rules, account] = await Promise.all([
    loadCatalogue(token),
    listPricingRules(token),
    header.accountId ? getAccount(token, header.accountId) : Promise.resolve(null),
  ]);

  if (header.accountId && !account) throw new ApiError("That account does not exist, or is not yours.", 404);

  // Re-snapshot only when the account actually changed; otherwise the quote
  // keeps the details it was written against.
  const customer =
    header.accountId && header.accountId !== existing.customer.accountId
      ? snapshotCustomer(account)
      : header.accountId
        ? existing.customer
        : emptyCustomer();

  const priced = repriceQuote(
    {
      header,
      lines,
      number: existing.number,
      // Editing a rejected quote puts it back in the rep's hands, and drops
      // the decisions that were made about numbers that no longer apply.
      status: "draft",
      version: existing.version,
      supersedesId: existing.supersedesId,
      customer,
      approvals: [],
      approverIds: [],
    },
    catalogue,
    rules,
  );

  const quote = await updateQuote(token, id, priced.record);
  if (!quote) throw new ApiError("Quote not found, or not yours to change.", 404);

  // The approver list goes with the approvals that are no longer there.
  await stampApprovers(token, id, []).catch(() => undefined);

  return { quote, issues: priced.issues, warnings: priced.warnings };
}

/* ------------------------------- approvals ------------------------------- */

export type SubmitResult = {
  quote: Quote;
  /** Approvals the quote now needs. Empty when it was cleared outright. */
  required: ApprovalRequest[];
  /** Approvers whose address does not match an account here. */
  unresolved: string[];
  issues: string[];
  warnings: string[];
};

/**
 * Submits a quote for approval.
 *
 * The quote is repriced first, against the catalogue as it stands now — the
 * thing being approved has to be the thing that will be sent, and a quote
 * priced a week ago against products that have since changed is neither.
 *
 * A quote that trips no rule is approved outright rather than sitting in a
 * queue nobody needs to look at.
 */
export async function submitQuote(token: string, id: string): Promise<SubmitResult> {
  const existing = await getQuote(token, id);
  if (!existing) throw new ApiError("Quote not found.", 404);
  if (!isEditableStatus(existing.status)) {
    throw new ApiError(`A quote that is ${existing.status.replace("_", " ")} cannot be submitted again.`, 409);
  }
  if (!existing.lines.length) throw new ApiError("Add at least one line before submitting this quote.", 400);

  const [catalogue, pricing, approvalRules] = await Promise.all([
    loadCatalogue(token),
    listPricingRules(token),
    listApprovalRules(token),
  ]);

  const priced = repriceQuote(
    {
      header: headerOf(existing),
      lines: existing.lines,
      number: existing.number,
      status: "draft",
      version: existing.version,
      supersedesId: existing.supersedesId,
      customer: existing.customer,
      approvals: [],
      approverIds: [],
    },
    catalogue,
    pricing,
  );

  // A quote that will not price is not a quote anyone can approve.
  if (priced.issues.length) {
    throw new ApiError(`This quote has problems that must be fixed first: ${priced.issues[0]}`, 409);
  }

  // Each line's product ceiling, which the `floorBreach` metric needs.
  const floorByLineId = new Map(
    priced.record.lines.map(line => [line.id, catalogue.byId.get(line.productId)?.floorDiscountPercent ?? 0]),
  );

  const outcome = evaluateApprovals(
    { totals: priced.record.totals, lines: priced.record.lines, termMonths: priced.record.termMonths, floorByLineId },
    approvalRules,
  );

  const record: QuoteRecordInput = {
    ...priced.record,
    status: outcome.autoApproved ? "approved" : "in_review",
    approvals: outcome.required,
    approverIds: [],
  };

  const saved = await updateQuote(token, id, record);
  if (!saved) throw new ApiError("Quote not found, or not yours to submit.", 404);

  // Resolving an address to an account needs to read the user list, which no
  // user token may do — so PocketBase does it, the same way sharing does.
  const stamped = outcome.required.length
    ? await stampApprovers(token, id, currentApprovers(outcome.required))
    : await stampApprovers(token, id, []).catch(() => ({ resolved: [], unresolved: [] }));

  return {
    quote: { ...saved, approverIds: stamped.resolved },
    required: outcome.required,
    unresolved: stamped.unresolved,
    issues: priced.issues,
    warnings: priced.warnings,
  };
}

/**
 * Records an approver's decision.
 *
 * The caller must be one of the people the quote is currently waiting on —
 * which PocketBase enforces, not this function: the update rule lets an
 * approver write a quote, and a hook restricts them to the approval fields.
 * This decides *what* changes; PocketBase decides whether they may.
 */
export async function decideQuote(
  token: string,
  id: string,
  approverEmail: string,
  decision: "approved" | "rejected",
  comment: string,
): Promise<{ quote: Quote; changed: number }> {
  const existing = await getQuote(token, id);
  if (!existing) throw new ApiError("Quote not found.", 404);
  if (existing.status !== "in_review") {
    throw new ApiError(`This quote is ${existing.status.replace("_", " ")}, so there is nothing to decide.`, 409);
  }

  const { approvals, changed } = applyDecision(existing.approvals, approverEmail, decision, comment);
  if (!changed) {
    throw new ApiError("There is no approval on this quote waiting for you right now.", 403);
  }

  const status: QuoteStatus = anyRejected(approvals) ? "rejected" : allApproved(approvals) ? "approved" : "in_review";

  const record: QuoteRecordInput = {
    ...recordOf(existing),
    status,
    approvals,
    // Whoever is next in the ladder; nobody, once it is settled.
    approverIds: existing.approverIds,
    decidedAt: status === "in_review" ? "" : new Date().toISOString(),
  };

  const saved = await updateQuote(token, id, record);
  if (!saved) throw new ApiError("Quote not found, or not yours to decide.", 404);

  // The next rung of the ladder, stamped by the owner's own hook route. An
  // approver cannot change the relation themselves, so this is best-effort:
  // when it fails the owner's next submit or save puts it right.
  const next = currentApprovers(approvals);
  const stamped = await stampApprovers(token, id, next).catch(() => null);

  return { quote: { ...saved, approverIds: stamped?.resolved ?? saved.approverIds }, changed };
}

/* ------------------------------ transitions ------------------------------ */

/** The header fields, pulled back out of a stored quote. */
const headerOf = (quote: Quote): QuoteHeaderInput => ({
  name: quote.name,
  accountId: quote.customer.accountId,
  priceBookId: quote.priceBookId,
  currency: quote.currency,
  termMonths: quote.termMonths,
  discountPercent: quote.discountPercent,
  taxPercent: quote.taxPercent,
  shipping: quote.shipping,
  validUntil: quote.validUntil,
  notes: quote.notes,
  internalNotes: quote.internalNotes,
});

/** A stored quote, as the shape `updateQuote` wants back. */
const recordOf = (quote: Quote): QuoteRecordInput => ({
  number: quote.number,
  name: quote.name,
  status: quote.status,
  version: quote.version,
  supersedesId: quote.supersedesId,
  customer: quote.customer,
  priceBookId: quote.priceBookId,
  currency: quote.currency,
  termMonths: quote.termMonths,
  discountPercent: quote.discountPercent,
  taxPercent: quote.taxPercent,
  shipping: quote.shipping,
  validUntil: quote.validUntil,
  notes: quote.notes,
  internalNotes: quote.internalNotes,
  lines: quote.lines,
  totals: quote.totals,
  approvals: quote.approvals,
  approverIds: quote.approverIds,
});

/**
 * Moves a quote along its life.
 *
 * The legal moves are in `QUOTE_TRANSITIONS`, shared with the UI so the
 * buttons on screen and the transitions the server will accept are the same
 * list. Two of them carry an extra condition, checked here because they are
 * the ones with consequences outside the app.
 */
export async function transitionQuote(token: string, id: string, to: QuoteStatus): Promise<Quote> {
  const existing = await getQuote(token, id);
  if (!existing) throw new ApiError("Quote not found.", 404);

  const from = withExpiry(existing).status;
  if (!QUOTE_TRANSITIONS[from]?.includes(to)) {
    const allowed = QUOTE_TRANSITIONS[from] ?? [];
    throw new ApiError(
      allowed.length
        ? `A quote that is ${from.replace("_", " ")} can only become ${allowed.join(" or ")}.`
        : `A quote that is ${from.replace("_", " ")} cannot be changed.`,
      409,
    );
  }

  if (to === "sent") {
    // Sending is the point of no return, so the approvals have to be real.
    const pending = existing.approvals.filter(request => request.status === "pending");
    if (pending.length) {
      throw new ApiError(
        `This quote is waiting on ${pending.length} approval${pending.length === 1 ? "" : "s"}.`,
        409,
      );
    }
    if (from === "draft") {
      const rules = (await listApprovalRules(token)).filter(
      rule => rule.active && rule.approvers.some(email => email.trim()),
    );
      if (rules.length) {
        throw new ApiError(
          "Submit this quote for approval before sending it — there are approval rules that have not been run against it.",
          409,
        );
      }
    }
    if (!existing.lines.length) throw new ApiError("There is nothing on this quote to send.", 400);
  }

  const record: QuoteRecordInput = {
    ...recordOf(existing),
    status: to,
    // Reopening starts the approval story over rather than carrying decisions
    // forward onto numbers that are about to change.
    ...(to === "draft" ? { approvals: [], approverIds: [] } : {}),
    ...(to === "sent" ? { sentAt: new Date().toISOString() } : {}),
    ...(to === "accepted" || to === "declined" ? { decidedAt: new Date().toISOString() } : {}),
  };

  const saved = await updateQuote(token, id, record);
  if (!saved) throw new ApiError("Quote not found, or not yours to change.", 404);

  if (to === "draft") await stampApprovers(token, id, []).catch(() => undefined);

  return saved;
}

/**
 * Creates the next revision of a quote.
 *
 * A new record rather than an edit: the quote that was sent stays exactly as
 * it was sent, with its own number and its own approvals, and the new one says
 * what it supersedes. That is what makes "which version did they sign" a
 * question with an answer.
 */
export async function reviseQuote(token: string, id: string): Promise<CreateQuoteResult> {
  const existing = await getQuote(token, id);
  if (!existing) throw new ApiError("Quote not found.", 404);

  const [catalogue, rules] = await Promise.all([loadCatalogue(token), listPricingRules(token)]);

  const priced = repriceQuote(
    {
      header: headerOf(existing),
      lines: existing.lines,
      // The number carries the revision, so the two documents are obviously
      // the same deal and obviously not the same document.
      number: `${existing.number}-r${existing.version + 1}`,
      status: "draft",
      version: existing.version + 1,
      supersedesId: existing.id,
      customer: existing.customer,
      approvals: [],
      approverIds: [],
      sentAt: "",
      decidedAt: "",
    },
    catalogue,
    rules,
  );

  const quote = await createQuote(token, priced.record);
  return { quote, issues: priced.issues, warnings: priced.warnings };
}

/** Re-exported for the route table, which reports them alongside a save. */
export { currentApprovers };
