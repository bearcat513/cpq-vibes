/**
 * Storage, backed by PocketBase.
 *
 * Seven collections — `accounts`, `products`, `price_books`, `pricing_rules`,
 * `approval_rules`, `quotes`, `proposal_templates` — defined in
 * docker/pb_migrations/.
 *
 * Every function takes the caller's token and does its work as that user.
 * Nothing here filters by owner: the collection rules do that inside
 * PocketBase, so a missing `WHERE` in this file cannot leak another account's
 * records. A product or price book shared with the caller comes back from a
 * read and is refused by a write, for the same reason, and a quote awaiting
 * someone's approval is readable by that approver and by nobody else new.
 *
 * Record ids are minted here rather than by PocketBase, so they stay readable
 * and type-tagged — `prd_…`, `pb_…`, `qte_…` — in the REST API, in exported
 * files and in the UI. The migration widens PocketBase's fixed-length id
 * field to allow them.
 */
import { normalizePreferences } from "../lib/preferences";
import { EMPTY_ADDRESS, emptyCustomer, primaryContact } from "../lib/types";
import type {
  Account,
  AccountContact,
  ApprovalDecision,
  Invoice,
  InvoiceCredit,
  InvoiceLine,
  InvoicePayment,
  InvoiceSummary,
  InvoiceTotals,
  ApprovalRequest,
  ApprovalRule,
  PriceBook,
  PricedLine,
  PricingRule,
  Product,
  ProposalTemplate,
  Quote,
  QuoteStatus,
  QuoteSummary,
  QuoteTotals,
} from "../lib/types";
import { lineTotals, settlement, type LineTotals } from "../lib/receivable";
import { readPaymentTermDays } from "../lib/validate";
import type {
  AccountInput,
  CreditInput,
  PaymentInput,
  ApprovalRuleInput,
  PriceBookInput,
  PricingRuleInput,
  ProductInput,
  ProposalTemplateInput,
} from "../lib/validate";
import { asCurrency } from "../lib/money";
import { ApiError } from "./http";
import {
  POCKETBASE_URL,
  clientFor,
  countRecords,
  isNotFound,
  pocketbaseStatus,
  toApiError,
  toIso,
} from "./pocketbase";

/** PocketBase rejects a `perPage` above this, so larger reads are paged. */
const MAX_PER_PAGE = 500;

/**
 * Matches `maxSize` on the `lines` JSON field in the migration. Checked here
 * so an enormous quote fails with a sentence about the quote rather than
 * PocketBase's generic field error.
 */
const MAX_QUOTE_BYTES = 4 * 1024 * 1024;

type Record_ = globalThis.Record<string, unknown>;

/* ------------------------------- helpers -------------------------------- */

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

async function readOne(token: string, collection: string, id: string, options?: { fields?: string }): Promise<Record_ | null> {
  try {
    return await clientFor(token).collection(collection).getOne(id, options);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw toApiError(error, `Could not read ${collection}`);
  }
}

/**
 * Lists records. `limit <= 0` means everything; anything above a single page
 * is fetched in batches, since PocketBase caps `perPage`.
 */
async function readMany(
  token: string,
  collection: string,
  { limit, sort, fields, filter }: { limit: number; sort: string; fields?: string; filter?: string },
): Promise<Record_[]> {
  try {
    const records = clientFor(token).collection(collection);
    if (limit > 0 && limit <= MAX_PER_PAGE) return (await records.getList(1, limit, { sort, fields, filter })).items;

    const all = await records.getFullList({ batch: MAX_PER_PAGE, sort, fields, filter });
    return limit > 0 ? all.slice(0, limit) : all;
  } catch (error) {
    throw toApiError(error, `Could not list ${collection}`);
  }
}

async function write(
  token: string,
  collection: string,
  id: string | null,
  body: Record_,
  what: string,
): Promise<Record_ | null> {
  try {
    const records = clientFor(token).collection(collection);
    return id === null ? await records.create(body) : await records.update(id, body);
  } catch (error) {
    // 404 covers both "no such record" and "not yours to change": PocketBase
    // answers a rule miss the same way, and so does this API.
    if (id !== null && isNotFound(error)) return null;
    throw toApiError(error, what);
  }
}

async function remove(token: string, collection: string, id: string): Promise<boolean> {
  try {
    await clientFor(token).collection(collection).delete(id);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw toApiError(error, `Could not delete from ${collection}`);
  }
}

/* -------------------------------- mapping -------------------------------- */

/** Relation fields come back as "" / [] when empty. */
const relationId = (value: unknown): string => (typeof value === "string" ? value : "");
const relationIds = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

const jsonArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const jsonObject = <T>(value: unknown, fallback: T): T =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as T) : fallback;

const stamps = (row: Record_) => ({ createdAt: toIso(row.created), updatedAt: toIso(row.updated) });

const ownership = (row: Record_) => ({ ownerId: relationId(row.owner), sharedWith: relationIds(row.sharedWith) });

function toProduct(row: Record_): Product {
  const definition = jsonObject<Partial<Product>>(row.definition, {});
  return {
    id: String(row.id),
    sku: String(row.sku ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    family: String(row.family ?? ""),
    chargeType: (definition.chargeType ?? "one-time") as Product["chargeType"],
    billingPeriod: (definition.billingPeriod ?? "monthly") as Product["billingPeriod"],
    unitOfMeasure: definition.unitOfMeasure ?? "unit",
    listPrice: Number(row.listPrice ?? 0),
    cost: Number(row.cost ?? 0),
    currency: asCurrency(row.currency),
    active: row.active !== false,
    minQuantity: Number(definition.minQuantity ?? 1),
    maxQuantity: Number(definition.maxQuantity ?? 0),
    floorDiscountPercent: Number(definition.floorDiscountPercent ?? 0),
    optionGroups: definition.optionGroups ?? [],
    rules: definition.rules ?? [],
    components: definition.components ?? [],
    volumeTiers: definition.volumeTiers ?? [],
    attributes: definition.attributes ?? {},
    ...ownership(row),
    ...stamps(row),
  };
}

function toPriceBook(row: Record_): PriceBook {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    currency: asCurrency(row.currency),
    isDefault: row.isDefault === true,
    active: row.active !== false,
    validFrom: String(row.validFrom ?? ""),
    validTo: String(row.validTo ?? ""),
    entries: jsonArray(row.entries),
    ...ownership(row),
    ...stamps(row),
  };
}

function toPricingRule(row: Record_): PricingRule {
  const definition = jsonObject<Partial<PricingRule>>(row.definition, {});
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: definition.description ?? "",
    scope: (definition.scope ?? "line") as PricingRule["scope"],
    condition: definition.condition ?? "",
    target: (definition.target ?? "discountPercent") as PricingRule["target"],
    expression: definition.expression ?? "",
    appliesToFamily: definition.appliesToFamily ?? "",
    appliesToSku: definition.appliesToSku ?? "",
    priority: Number(row.priority ?? 100),
    active: row.active !== false,
    message: definition.message ?? "",
    ownerId: relationId(row.owner),
    ...stamps(row),
  };
}

function toApprovalRule(row: Record_): ApprovalRule {
  const definition = jsonObject<Partial<ApprovalRule>>(row.definition, {});
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    scope: (definition.scope ?? "quote") as ApprovalRule["scope"],
    metric: (definition.metric ?? "discountPercent") as ApprovalRule["metric"],
    comparator: (definition.comparator ?? ">") as ApprovalRule["comparator"],
    threshold: Number(definition.threshold ?? 0),
    condition: definition.condition ?? "",
    level: Number(row.level ?? 1),
    // `approverEmail` was the single-approver column this collection started
    // with; a record written before the quorum migration still reads.
    approvers: Array.isArray(definition.approvers)
      ? definition.approvers.map(String)
      : row.approverEmail
        ? [String(row.approverEmail)]
        : [],
    approvalsRequired: Number(definition.approvalsRequired ?? 1),
    rejectionsRequired: Number(definition.rejectionsRequired ?? 1),
    message: definition.message ?? "",
    active: row.active !== false,
    ownerId: relationId(row.owner),
    ...stamps(row),
  };
}

/**
 * An account's contact list, including one written before the list existed.
 *
 * Records saved by an earlier version carry a single contact spread across
 * `details.contactName`, `details.contactPhone` and the `contactEmail`
 * column. Reading them as a one-contact list is what lets the contact list
 * ship without a data migration: the next save writes the new shape, and a
 * record nobody edits keeps working in the meantime.
 */
function toContacts(row: Record_, details: Record<string, unknown>): AccountContact[] {
  const stored = details.contacts;
  if (Array.isArray(stored)) return stored as AccountContact[];

  const name = String(details.contactName ?? "");
  const email = String(row.contactEmail ?? "");
  const phone = String(details.contactPhone ?? "");
  if (!name && !email && !phone) return [];

  return [{ id: "con_legacy", name, title: "", email, phone, role: "commercial", primary: true }];
}

function toAccount(row: Record_): Account {
  const details = jsonObject<Partial<Account> & Record<string, unknown>>(row.details, {});
  const billingAddress = details.billingAddress ?? { ...EMPTY_ADDRESS };
  const shippingSameAsBilling = details.shippingSameAsBilling !== false;

  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    industry: details.industry ?? "",
    website: details.website ?? "",
    status: (details.status ?? "prospect") as Account["status"],
    tags: jsonArray<string>(details.tags),
    contacts: toContacts(row, details),
    billingAddress,
    shippingAddress: shippingSameAsBilling ? { ...billingAddress } : (details.shippingAddress ?? { ...EMPTY_ADDRESS }),
    shippingSameAsBilling,
    currency: asCurrency(row.currency),
    priceBookId: relationId(row.priceBook),
    paymentTerms: details.paymentTerms ?? "",
    // Seeded from the terms text for a row written before receivables, the
    // same way the validator does it for a body from the same era.
    paymentTermDays: readPaymentTermDays(details.paymentTermDays, String(details.paymentTerms ?? "")),
    creditLimit: Number(details.creditLimit ?? 0),
    defaultDiscountPercent: Number(details.defaultDiscountPercent ?? 0),
    taxExempt: details.taxExempt === true,
    taxPercent: Number(details.taxPercent ?? 0),
    notes: details.notes ?? "",
    ownerId: relationId(row.owner),
    ...stamps(row),
  };
}

function toProposalTemplate(row: Record_): ProposalTemplate {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    // A row written before invoice templates existed has no kind, and is a
    // quote's — the column was backfilled, and this is the same answer for
    // anything that slipped past it.
    kind: row.kind === "invoice" ? "invoice" : "quote",
    format: (String(row.format ?? "html") || "html") as ProposalTemplate["format"],
    body: String(row.body ?? ""),
    ...ownership(row),
    ...stamps(row),
  };
}

/**
 * An approval request as stored, upgraded if it predates multiple approvers.
 *
 * A quote sitting in review when this changed still has to open, and its
 * single `approverEmail` plus `decidedBy` is enough to rebuild the newer
 * shape exactly.
 */
function toApprovalRequest(raw: unknown): ApprovalRequest {
  const input = jsonObject<Record_>(raw, {});

  const emails = Array.isArray(input.approverEmails)
    ? input.approverEmails.map(String)
    : input.approverEmail
      ? [String(input.approverEmail)]
      : [];

  const decisions: ApprovalDecision[] = Array.isArray(input.decisions)
    ? (input.decisions as ApprovalDecision[])
    : input.decidedBy
      ? [
          {
            approverEmail: String(input.decidedBy),
            decision: input.status === "rejected" ? "rejected" : "approved",
            decidedAt: String(input.decidedAt ?? ""),
            comment: String(input.comment ?? ""),
          },
        ]
      : [];

  return {
    id: String(input.id ?? ""),
    ruleId: String(input.ruleId ?? ""),
    ruleName: String(input.ruleName ?? ""),
    level: Number(input.level ?? 1),
    approverEmails: emails,
    approvalsRequired: Number(input.approvalsRequired ?? 1),
    rejectionsRequired: Number(input.rejectionsRequired ?? 1),
    reason: String(input.reason ?? ""),
    status: (String(input.status ?? "pending") || "pending") as ApprovalRequest["status"],
    lineId: (input.lineId as string | null) ?? null,
    decisions,
    requestedAt: String(input.requestedAt ?? ""),
  };
}

function toQuote(row: Record_): Quote {
  const header = jsonObject<Partial<Quote>>(row.header, {});
  return {
    id: String(row.id),
    number: String(row.number ?? ""),
    name: String(row.name ?? ""),
    status: (String(row.status ?? "draft") || "draft") as QuoteStatus,
    version: Number(row.version ?? 1),
    supersedesId: relationId(row.supersedes) || null,
    // Spread over the empty snapshot rather than trusting what is stored: a
    // quote written before shipping addresses existed has a header with
    // fewer keys, and everything downstream reads the fields unguarded.
    customer: { ...emptyCustomer(), ...(header.customer ?? {}) },
    priceBookId: relationId(row.priceBook),
    currency: asCurrency(row.currency),
    termMonths: Number(header.termMonths ?? 0),
    discountPercent: Number(header.discountPercent ?? 0),
    taxPercent: Number(header.taxPercent ?? 0),
    shipping: Number(header.shipping ?? 0),
    validUntil: String(row.validUntil ?? ""),
    notes: header.notes ?? "",
    internalNotes: header.internalNotes ?? "",
    lines: jsonArray<PricedLine>(row.lines),
    totals: jsonObject<QuoteTotals>(row.totals, {} as QuoteTotals),
    approvals: jsonArray<unknown>(row.approvals).map(toApprovalRequest),
    approverIds: relationIds(row.approvers),
    ownerId: relationId(row.owner),
    sharedWith: relationIds(row.sharedWith),
    sentAt: toIso(row.sentAt),
    decidedAt: toIso(row.decidedAt),
    ...stamps(row),
  };
}

/** The list view: everything but the lines, which are the bulk of a quote. */
function toQuoteSummary(row: Record_): QuoteSummary {
  const quote = toQuote(row);
  const { lines, approvals, ...rest } = quote;
  return {
    ...rest,
    lineCount: Number(row.lineCount ?? lines.length),
    pendingApprovals: approvals.filter(request => request.status === "pending").length,
  };
}

/* -------------------------------- products ------------------------------- */

/**
 * The columns are the ones something queries, sorts or filters on; everything
 * else rides in one `definition` JSON field.
 *
 * This is deliberate. A product's shape — option groups, rules, tiers — is
 * nested, versioned by the app and read whole or not at all, so spreading it
 * across thirty PocketBase fields would buy nothing and cost a migration
 * every time the domain grew a feature. What stays a real column is what the
 * database has to *do* something with: find by SKU, sort by name, filter the
 * inactive ones out.
 */
const productBody = (input: ProductInput): Record_ => ({
  sku: input.sku,
  name: input.name,
  description: input.description,
  family: input.family,
  listPrice: input.listPrice,
  cost: input.cost,
  currency: input.currency,
  active: input.active,
  definition: {
    chargeType: input.chargeType,
    billingPeriod: input.billingPeriod,
    unitOfMeasure: input.unitOfMeasure,
    minQuantity: input.minQuantity,
    maxQuantity: input.maxQuantity,
    floorDiscountPercent: input.floorDiscountPercent,
    optionGroups: input.optionGroups,
    rules: input.rules,
    components: input.components,
    volumeTiers: input.volumeTiers,
    attributes: input.attributes,
  },
});

export const listProducts = async (token: string): Promise<Product[]> =>
  (await readMany(token, "products", { limit: 0, sort: "family,name" })).map(toProduct);

export async function getProduct(token: string, id: string): Promise<Product | null> {
  const row = await readOne(token, "products", id);
  return row ? toProduct(row) : null;
}

export async function createProduct(token: string, input: ProductInput): Promise<Product> {
  const row = await write(token, "products", null, { id: newId("prd"), ...productBody(input) }, "Could not save the product");
  return toProduct(row!);
}

export async function updateProduct(token: string, id: string, input: ProductInput): Promise<Product | null> {
  const row = await write(token, "products", id, productBody(input), "Could not update the product");
  return row ? toProduct(row) : null;
}

export const deleteProduct = (token: string, id: string) => remove(token, "products", id);

/* ------------------------------ price books ------------------------------ */

const priceBookBody = (input: PriceBookInput): Record_ => ({
  name: input.name,
  description: input.description,
  currency: input.currency,
  isDefault: input.isDefault,
  active: input.active,
  validFrom: input.validFrom,
  validTo: input.validTo,
  entries: input.entries,
});

export const listPriceBooks = async (token: string): Promise<PriceBook[]> =>
  (await readMany(token, "price_books", { limit: 0, sort: "-isDefault,name" })).map(toPriceBook);

export async function getPriceBook(token: string, id: string): Promise<PriceBook | null> {
  const row = await readOne(token, "price_books", id);
  return row ? toPriceBook(row) : null;
}

export async function createPriceBook(token: string, input: PriceBookInput): Promise<PriceBook> {
  const row = await write(token, "price_books", null, { id: newId("pb"), ...priceBookBody(input) }, "Could not save the price book");
  return toPriceBook(row!);
}

export async function updatePriceBook(token: string, id: string, input: PriceBookInput): Promise<PriceBook | null> {
  const row = await write(token, "price_books", id, priceBookBody(input), "Could not update the price book");
  return row ? toPriceBook(row) : null;
}

export const deletePriceBook = (token: string, id: string) => remove(token, "price_books", id);

/* ----------------------------- pricing rules ----------------------------- */

const pricingRuleBody = (input: PricingRuleInput): Record_ => ({
  name: input.name,
  priority: input.priority,
  active: input.active,
  definition: {
    description: input.description,
    scope: input.scope,
    condition: input.condition,
    target: input.target,
    expression: input.expression,
    appliesToFamily: input.appliesToFamily,
    appliesToSku: input.appliesToSku,
    message: input.message,
  },
});

export const listPricingRules = async (token: string): Promise<PricingRule[]> =>
  (await readMany(token, "pricing_rules", { limit: 0, sort: "priority,name" })).map(toPricingRule);

export async function getPricingRule(token: string, id: string): Promise<PricingRule | null> {
  const row = await readOne(token, "pricing_rules", id);
  return row ? toPricingRule(row) : null;
}

export async function createPricingRule(token: string, input: PricingRuleInput): Promise<PricingRule> {
  const row = await write(token, "pricing_rules", null, { id: newId("prc"), ...pricingRuleBody(input) }, "Could not save the pricing rule");
  return toPricingRule(row!);
}

export async function updatePricingRule(token: string, id: string, input: PricingRuleInput): Promise<PricingRule | null> {
  const row = await write(token, "pricing_rules", id, pricingRuleBody(input), "Could not update the pricing rule");
  return row ? toPricingRule(row) : null;
}

export const deletePricingRule = (token: string, id: string) => remove(token, "pricing_rules", id);

/* ---------------------------- approval rules ----------------------------- */

const approvalRuleBody = (input: ApprovalRuleInput): Record_ => ({
  name: input.name,
  level: input.level,
  active: input.active,
  definition: {
    scope: input.scope,
    metric: input.metric,
    comparator: input.comparator,
    threshold: input.threshold,
    condition: input.condition,
    message: input.message,
    // The approver list is not something the database queries on, so it lives
    // in the definition with the rest of the rule rather than in a column.
    approvers: input.approvers,
    approvalsRequired: input.approvalsRequired,
    rejectionsRequired: input.rejectionsRequired,
  },
});

export const listApprovalRules = async (token: string): Promise<ApprovalRule[]> =>
  (await readMany(token, "approval_rules", { limit: 0, sort: "level,name" })).map(toApprovalRule);

export async function getApprovalRule(token: string, id: string): Promise<ApprovalRule | null> {
  const row = await readOne(token, "approval_rules", id);
  return row ? toApprovalRule(row) : null;
}

export async function createApprovalRule(token: string, input: ApprovalRuleInput): Promise<ApprovalRule> {
  const row = await write(token, "approval_rules", null, { id: newId("apv"), ...approvalRuleBody(input) }, "Could not save the approval rule");
  return toApprovalRule(row!);
}

export async function updateApprovalRule(token: string, id: string, input: ApprovalRuleInput): Promise<ApprovalRule | null> {
  const row = await write(token, "approval_rules", id, approvalRuleBody(input), "Could not update the approval rule");
  return row ? toApprovalRule(row) : null;
}

export const deleteApprovalRule = (token: string, id: string) => remove(token, "approval_rules", id);

/* -------------------------------- accounts ------------------------------- */

const accountBody = (input: AccountInput): Record_ => ({
  name: input.name,
  // The column holds the primary contact's address, which is the one anything
  // outside the app would mean by "the account's email".
  contactEmail: primaryContact(input)?.email ?? "",
  currency: input.currency,
  // PocketBase wants "" for an unset relation, not null.
  priceBook: input.priceBookId || "",
  details: {
    industry: input.industry,
    website: input.website,
    status: input.status,
    tags: input.tags,
    contacts: input.contacts,
    billingAddress: input.billingAddress,
    shippingAddress: input.shippingAddress,
    shippingSameAsBilling: input.shippingSameAsBilling,
    paymentTerms: input.paymentTerms,
    paymentTermDays: input.paymentTermDays,
    creditLimit: input.creditLimit,
    defaultDiscountPercent: input.defaultDiscountPercent,
    taxExempt: input.taxExempt,
    taxPercent: input.taxPercent,
    notes: input.notes,
  },
});

export const listAccounts = async (token: string): Promise<Account[]> =>
  (await readMany(token, "accounts", { limit: 0, sort: "name" })).map(toAccount);

export async function getAccount(token: string, id: string): Promise<Account | null> {
  const row = await readOne(token, "accounts", id);
  return row ? toAccount(row) : null;
}

export async function createAccount(token: string, input: AccountInput): Promise<Account> {
  const row = await write(token, "accounts", null, { id: newId("acc"), ...accountBody(input) }, "Could not save the account");
  return toAccount(row!);
}

export async function updateAccount(token: string, id: string, input: AccountInput): Promise<Account | null> {
  const row = await write(token, "accounts", id, accountBody(input), "Could not update the account");
  return row ? toAccount(row) : null;
}

export const deleteAccount = (token: string, id: string) => remove(token, "accounts", id);

/* --------------------------- proposal templates -------------------------- */

export const listProposalTemplates = async (token: string): Promise<ProposalTemplate[]> =>
  (await readMany(token, "proposal_templates", { limit: 0, sort: "-updated" })).map(toProposalTemplate);

export async function getProposalTemplate(token: string, id: string): Promise<ProposalTemplate | null> {
  const row = await readOne(token, "proposal_templates", id);
  return row ? toProposalTemplate(row) : null;
}

export async function createProposalTemplate(token: string, input: ProposalTemplateInput): Promise<ProposalTemplate> {
  const row = await write(token, "proposal_templates", null, { id: newId("tpl"), ...input }, "Could not save the template");
  return toProposalTemplate(row!);
}

export async function updateProposalTemplate(
  token: string,
  id: string,
  input: ProposalTemplateInput,
): Promise<ProposalTemplate | null> {
  const row = await write(token, "proposal_templates", id, { ...input }, "Could not update the template");
  return row ? toProposalTemplate(row) : null;
}

export const deleteProposalTemplate = (token: string, id: string) => remove(token, "proposal_templates", id);

/* --------------------------------- quotes -------------------------------- */

/** Everything but `lines`, `totals` and `approvals` — the bulk of a quote. */
const QUOTE_SUMMARY_FIELDS =
  "id,number,name,status,version,supersedes,priceBook,currency,validUntil,header,totals,approvals,approvers,owner,sharedWith,sentAt,decidedAt,created,updated,lineCount";

export type QuoteRecordInput = {
  number: string;
  name: string;
  status: QuoteStatus;
  version: number;
  supersedesId: string | null;
  customer: Quote["customer"];
  priceBookId: string;
  currency: Quote["currency"];
  termMonths: number;
  discountPercent: number;
  taxPercent: number;
  shipping: number;
  validUntil: string;
  notes: string;
  internalNotes: string;
  lines: PricedLine[];
  totals: QuoteTotals;
  approvals: ApprovalRequest[];
  /** User ids the approval engine resolved — what the read rule matches on. */
  approverIds: string[];
  sentAt?: string;
  decidedAt?: string;
};

function quoteBody(input: QuoteRecordInput): Record_ {
  const lines = JSON.stringify(input.lines);
  if (lines.length > MAX_QUOTE_BYTES) {
    throw new ApiError(
      `This quote is ${(lines.length / 1024 / 1024).toFixed(1)} MB of line items, over the ` +
        `${MAX_QUOTE_BYTES / 1024 / 1024} MB a stored quote may occupy. Split it into several quotes.`,
      413,
    );
  }

  return {
    number: input.number,
    name: input.name,
    status: input.status,
    version: input.version,
    supersedes: input.supersedesId ?? "",
    priceBook: input.priceBookId || "",
    currency: input.currency,
    validUntil: input.validUntil,
    lineCount: input.lines.length,
    lines: input.lines,
    totals: input.totals,
    approvals: input.approvals,
    approvers: input.approverIds,
    header: {
      customer: input.customer,
      termMonths: input.termMonths,
      discountPercent: input.discountPercent,
      taxPercent: input.taxPercent,
      shipping: input.shipping,
      notes: input.notes,
      internalNotes: input.internalNotes,
    },
    ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
    ...(input.decidedAt !== undefined ? { decidedAt: input.decidedAt } : {}),
  };
}

export const listQuotes = async (token: string, limit = 50): Promise<QuoteSummary[]> =>
  (await readMany(token, "quotes", { limit, sort: "-updated", fields: QUOTE_SUMMARY_FIELDS })).map(toQuoteSummary);

/**
 * Every quote written for one customer, newest first.
 *
 * The customer lives inside the quote's `header` JSON rather than in a column
 * — a quote carries a snapshot, not a relation, precisely so it keeps
 * rendering after the account changes or goes away — so this filters on the
 * JSON path. PocketBase reads that with SQLite's `json_extract`, which is a
 * scan; it is a page of quotes for one account, not a report, and the
 * alternative is a column that would have to be kept honest on every save.
 *
 * Unfiltered by owner, like everything else here: the collection rules decide
 * which of them the caller may see.
 */
export const listQuotesForAccount = async (token: string, accountId: string, limit = 0): Promise<QuoteSummary[]> =>
  (
    await readMany(token, "quotes", {
      limit,
      sort: "-updated",
      fields: QUOTE_SUMMARY_FIELDS,
      filter: `header.customer.accountId = "${accountId.replace(/"/g, "")}"`,
    })
  ).map(toQuoteSummary);

/** Quotes waiting on this caller, for the approvals queue. */
export const listQuotesAwaiting = async (token: string, userId: string): Promise<QuoteSummary[]> =>
  (
    await readMany(token, "quotes", {
      limit: 0,
      sort: "-updated",
      fields: QUOTE_SUMMARY_FIELDS,
      filter: `status = "in_review" && approvers.id ?= "${userId.replace(/"/g, "")}"`,
    })
  ).map(toQuoteSummary);

export async function getQuote(token: string, id: string): Promise<Quote | null> {
  const row = await readOne(token, "quotes", id);
  return row ? toQuote(row) : null;
}

export async function createQuote(token: string, input: QuoteRecordInput): Promise<Quote> {
  const row = await write(token, "quotes", null, { id: newId("qte"), ...quoteBody(input) }, "Could not save the quote");
  return toQuote(row!);
}

export async function updateQuote(token: string, id: string, input: QuoteRecordInput): Promise<Quote | null> {
  const row = await write(token, "quotes", id, quoteBody(input), "Could not update the quote");
  return row ? toQuote(row) : null;
}

export const deleteQuote = (token: string, id: string) => remove(token, "quotes", id);

/**
 * The next quote number for this account: `Q-2026-0007`.
 *
 * Derived from how many quotes the caller already has rather than from a
 * counter, because a counter would need a collection of its own and a lock to
 * go with it. Two quotes created in the same second could collide; the unique
 * index on (owner, number) catches that, and `src/server/quotes.ts` retries.
 * The number is a label, not an identity — `id` is the identity.
 */
export async function nextQuoteNumber(token: string, attempt = 0): Promise<string> {
  const year = new Date().getFullYear();
  let count = 0;
  try {
    count = await countRecords(token, "quotes");
  } catch (error) {
    throw toApiError(error, "Could not work out the next quote number");
  }
  return `Q-${year}-${String(count + 1 + attempt).padStart(4, "0")}`;
}

/* ---------------------------------- meta --------------------------------- */

export const databaseUrl = (): string => POCKETBASE_URL;

/**
 * Backs `GET /api/meta`: where the data lives and how much of it this account
 * can see. The counts come through the same rules as every other read, so they
 * include whatever has been shared with the caller.
 */
export async function databaseMeta(token: string) {
  const status = await pocketbaseStatus();
  if (!status.reachable) {
    return {
      ...status,
      accounts: null,
      products: null,
      priceBooks: null,
      quotes: null,
      invoices: null,
      proposalTemplates: null,
    };
  }

  try {
    const [accounts, products, priceBooks, quotes, invoices, proposalTemplates] = await Promise.all([
      countRecords(token, "accounts"),
      countRecords(token, "products"),
      countRecords(token, "price_books"),
      countRecords(token, "quotes"),
      countRecords(token, "invoices"),
      countRecords(token, "proposal_templates"),
    ]);
    return { ...status, accounts, products, priceBooks, quotes, invoices, proposalTemplates };
  } catch (error) {
    throw toApiError(error, "Could not read the record counts");
  }
}

/** Re-exported so callers reading a session get a normalized preference set. */
export { normalizePreferences };

/* ------------------------------ receivables ------------------------------ */

/**
 * Matches `maxSize` on the invoices `lines` field in the migration. Checked
 * here so an enormous invoice fails with a sentence about the invoice.
 */
const MAX_INVOICE_BYTES = 1024 * 1024;

const INVOICE_SUMMARY_FIELDS =
  "id,number,state,currency,issueDate,dueDate,total,lineCount,quote,header,totals,owner,sharedWith,created,updated";

/* ----------------------------- the subledger ----------------------------- */

function toPayment(row: Record_): InvoicePayment {
  return {
    id: String(row.id),
    invoiceId: relationId(row.invoice),
    receivedOn: String(row.receivedOn ?? ""),
    amount: Number(row.amount ?? 0),
    method: (String(row.method ?? "bank_transfer") || "bank_transfer") as InvoicePayment["method"],
    reference: String(row.reference ?? ""),
    note: String(row.note ?? ""),
    ownerId: relationId(row.owner),
    ...stamps(row),
  };
}

function toCredit(row: Record_): InvoiceCredit {
  return {
    id: String(row.id),
    invoiceId: relationId(row.invoice),
    issuedOn: String(row.issuedOn ?? ""),
    amount: Number(row.amount ?? 0),
    reason: (String(row.reason ?? "adjustment") || "adjustment") as InvoiceCredit["reason"],
    note: String(row.note ?? ""),
    ownerId: relationId(row.owner),
    ...stamps(row),
  };
}

/** Oldest first, which is the order a ledger is read in. */
const LEDGER_SORT = "created";

export const listPayments = async (token: string, filter?: string): Promise<InvoicePayment[]> =>
  (await readMany(token, "payments", { limit: 0, sort: LEDGER_SORT, filter })).map(toPayment);

export const listCredits = async (token: string, filter?: string): Promise<InvoiceCredit[]> =>
  (await readMany(token, "credits", { limit: 0, sort: LEDGER_SORT, filter })).map(toCredit);

const forInvoice = (invoiceId: string) => `invoice = "${invoiceId.replace(/"/g, "")}"`;

/**
 * One invoice's ledger.
 *
 * Two queries, in parallel. The alternative — a `payments` and a `credits`
 * array on the invoice — is what this collection replaced, and it cost a
 * rewrite of the whole invoice every time somebody banked a cheque.
 */
export async function readLedger(
  token: string,
  invoiceId: string,
): Promise<{ payments: InvoicePayment[]; credits: InvoiceCredit[] }> {
  const [payments, credits] = await Promise.all([
    listPayments(token, forInvoice(invoiceId)),
    listCredits(token, forInvoice(invoiceId)),
  ]);
  return { payments, credits };
}

/**
 * Ledgers grouped by invoice — two queries however many invoices there are.
 *
 * `invoiceIds` narrows it to the invoices actually in hand; omit it for the
 * whole book. Two queries either way, which is the point: the alternative is
 * two per invoice, and a list of fifty invoices is not worth a hundred round
 * trips.
 */
export async function readLedgers(
  token: string,
  invoiceIds?: string[],
): Promise<{
  payments: Map<string, InvoicePayment[]>;
  credits: Map<string, InvoiceCredit[]>;
}> {
  // No invoices means no ledger to read, and a filter of `||` over an empty
  // list would be a syntax error rather than "nothing".
  if (invoiceIds && invoiceIds.length === 0) return { payments: new Map(), credits: new Map() };

  const filter = invoiceIds?.map(forInvoice).join(" || ");
  const [payments, credits] = await Promise.all([listPayments(token, filter), listCredits(token, filter)]);

  const group = <T extends { invoiceId: string }>(rows: T[]): Map<string, T[]> => {
    const byInvoice = new Map<string, T[]>();
    for (const row of rows) {
      const existing = byInvoice.get(row.invoiceId);
      if (existing) existing.push(row);
      else byInvoice.set(row.invoiceId, [row]);
    }
    return byInvoice;
  };

  return { payments: group(payments), credits: group(credits) };
}

export async function createPayment(
  token: string,
  invoiceId: string,
  input: PaymentInput,
): Promise<InvoicePayment> {
  const row = await write(
    token,
    "payments",
    null,
    { id: newId("pmt"), invoice: invoiceId, ...input },
    "Could not record the payment",
  );
  return toPayment(row!);
}

export async function createCredit(token: string, invoiceId: string, input: CreditInput): Promise<InvoiceCredit> {
  const row = await write(
    token,
    "credits",
    null,
    { id: newId("crd"), invoice: invoiceId, ...input },
    "Could not record the credit",
  );
  return toCredit(row!);
}

export const deletePayment = (token: string, id: string) => remove(token, "payments", id);
export const deleteCredit = (token: string, id: string) => remove(token, "credits", id);

export async function getPayment(token: string, id: string): Promise<InvoicePayment | null> {
  const row = await readOne(token, "payments", id);
  return row ? toPayment(row) : null;
}

export async function getCredit(token: string, id: string): Promise<InvoiceCredit | null> {
  const row = await readOne(token, "credits", id);
  return row ? toCredit(row) : null;
}

/* -------------------------------- invoices ------------------------------- */

/**
 * An invoice, with the ledger it was read alongside.
 *
 * The ledger is passed in rather than fetched here, because the list endpoint
 * reads every payment in the workspace once and hands each invoice its share
 * — two queries for a page rather than two per invoice.
 */
function toInvoice(row: Record_, payments: InvoicePayment[], credits: InvoiceCredit[]): Invoice {
  const header = jsonObject<Record<string, unknown>>(row.header, {});
  const stored = jsonObject<Partial<InvoiceTotals>>(row.totals, {});
  const currency = asCurrency(row.currency);
  const lines = jsonArray<InvoiceLine>(row.lines);

  return {
    id: String(row.id),
    number: String(row.number ?? ""),
    quoteId: relationId(row.quote) || null,
    quoteNumber: String(header.quoteNumber ?? ""),
    // Spread over a blank one, so an invoice stored before a snapshot field
    // existed still has every key the renderers read unguarded.
    customer: { ...emptyCustomer(), ...jsonObject<Record<string, unknown>>(header.customer, {}) },
    currency,
    state: (String(row.state ?? "draft") || "draft") as Invoice["state"],
    issueDate: String(row.issueDate ?? ""),
    dueDate: String(row.dueDate ?? ""),
    paymentTermDays: Number(header.paymentTermDays ?? 30),
    poNumber: String(header.poNumber ?? ""),
    notes: String(header.notes ?? ""),
    internalNotes: String(header.internalNotes ?? ""),
    lines,
    payments,
    credits,
    // The line half comes from storage; the ledger half is added up here, so
    // a balance can never disagree with the payments behind it.
    totals: {
      currency,
      lineCount: Number(stored.lineCount ?? lines.length),
      subtotal: Number(stored.subtotal ?? 0),
      taxAmount: Number(stored.taxAmount ?? 0),
      total: Number(stored.total ?? 0),
      ...settlement(Number(stored.total ?? 0), payments, credits, currency),
    },
    ...ownership(row),
    ...stamps(row),
  };
}

function toInvoiceSummary(row: Record_, payments: InvoicePayment[], credits: InvoiceCredit[]): InvoiceSummary {
  const invoice = toInvoice(row, payments, credits);
  const { lines, payments: paid, credits: credited, ...rest } = invoice;
  return {
    ...rest,
    lineCount: Number(row.lineCount ?? lines.length),
    paymentCount: paid.length,
    creditCount: credited.length,
  };
}

/**
 * Everything an invoice record holds.
 *
 * No ledger: payments and credits are their own records now, written through
 * `createPayment` and `createCredit`. Totals are the server's, never a
 * client's, and only the line half of them is stored.
 */
export type InvoiceRecordInput = {
  number: string;
  quoteId: string | null;
  quoteNumber: string;
  customer: Invoice["customer"];
  currency: Invoice["currency"];
  state: Invoice["state"];
  issueDate: string;
  dueDate: string;
  paymentTermDays: number;
  poNumber: string;
  notes: string;
  internalNotes: string;
  lines: InvoiceLine[];
  /** The line half only — see `lineTotals` in src/lib/receivable.ts. */
  totals: LineTotals;
};

function invoiceBody(input: InvoiceRecordInput): Record_ {
  const lines = JSON.stringify(input.lines);
  if (lines.length > MAX_INVOICE_BYTES) {
    throw new ApiError(
      `This invoice is ${(lines.length / 1024).toFixed(0)} KB of line items, over the ` +
        `${MAX_INVOICE_BYTES / 1024} KB a stored invoice may occupy. Split it into several invoices.`,
      413,
    );
  }

  return {
    number: input.number,
    state: input.state,
    currency: input.currency,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    // Denormalised for sorting and filtering by the size of the demand. The
    // *balance* deliberately is not: it depends on records in two other
    // collections, and a cached one is a number that can go wrong quietly.
    total: input.totals.total,
    lineCount: input.lines.length,
    quote: input.quoteId ?? "",
    lines: input.lines,
    totals: input.totals,
    header: {
      customer: input.customer,
      quoteNumber: input.quoteNumber,
      paymentTermDays: input.paymentTermDays,
      poNumber: input.poNumber,
      notes: input.notes,
      internalNotes: input.internalNotes,
    },
  };
}

/**
 * Invoices, newest first.
 *
 * Unlike quotes this defaults to everything: an aging report that silently
 * stopped at fifty invoices would understate the book, and understating what
 * you are owed is the one direction a finance number must not be wrong in.
 */
/**
 * Attaches each row's ledger and turns it into a summary.
 *
 * Every list of invoices goes through here, so no caller can accidentally
 * produce a summary whose balance ignores the payments against it.
 */
async function withLedgers(token: string, rows: Record_[], all = false): Promise<InvoiceSummary[]> {
  const ledgers = await readLedgers(token, all ? undefined : rows.map(row => String(row.id)));
  return rows.map(row =>
    toInvoiceSummary(row, ledgers.payments.get(String(row.id)) ?? [], ledgers.credits.get(String(row.id)) ?? []),
  );
}

export async function listInvoices(token: string, limit = 0): Promise<InvoiceSummary[]> {
  const rows = await readMany(token, "invoices", { limit, sort: "-created", fields: INVOICE_SUMMARY_FIELDS });
  // The whole book: one unfiltered ledger read beats a filter naming every
  // invoice in the workspace.
  return withLedgers(token, rows, limit <= 0);
}

/**
 * One customer's invoices. Filtered on the snapshot inside `header`, the same
 * way `listQuotesForAccount` is and for the same reason: an invoice carries
 * its customer rather than pointing at one.
 */
export async function listInvoicesForAccount(token: string, accountId: string): Promise<InvoiceSummary[]> {
  const rows = await readMany(token, "invoices", {
    limit: 0,
    sort: "-created",
    fields: INVOICE_SUMMARY_FIELDS,
    filter: `header.customer.accountId = "${accountId.replace(/"/g, "")}"`,
  });
  return withLedgers(token, rows);
}

/** The invoices already raised from one quote — what stops it being billed twice. */
export async function listInvoicesForQuote(token: string, quoteId: string): Promise<InvoiceSummary[]> {
  const rows = await readMany(token, "invoices", {
    limit: 0,
    sort: "-created",
    fields: INVOICE_SUMMARY_FIELDS,
    filter: `quote = "${quoteId.replace(/"/g, "")}"`,
  });
  return withLedgers(token, rows);
}

export async function getInvoice(token: string, id: string): Promise<Invoice | null> {
  const row = await readOne(token, "invoices", id);
  if (!row) return null;
  const ledger = await readLedger(token, String(row.id));
  return toInvoice(row, ledger.payments, ledger.credits);
}

export async function createInvoice(token: string, input: InvoiceRecordInput): Promise<Invoice> {
  const row = await write(token, "invoices", null, { id: newId("inv"), ...invoiceBody(input) }, "Could not save the invoice");
  // Brand new, so its ledger is empty by construction rather than by query.
  return toInvoice(row!, [], []);
}

export async function updateInvoice(token: string, id: string, input: InvoiceRecordInput): Promise<Invoice | null> {
  const row = await write(token, "invoices", id, invoiceBody(input), "Could not update the invoice");
  if (!row) return null;
  const ledger = await readLedger(token, id);
  return toInvoice(row, ledger.payments, ledger.credits);
}

export const deleteInvoice = (token: string, id: string) => remove(token, "invoices", id);

/**
 * The next invoice number: `INV-2026-0007`.
 *
 * Counted rather than sequenced, exactly like `nextQuoteNumber`, and with the
 * same escape hatch: the unique index on (owner, number) catches a collision
 * and `src/server/invoices.ts` retries with the next one along.
 *
 * Invoice numbers matter more than quote numbers — in most jurisdictions they
 * are supposed to be sequential and gapless — and a count satisfies that
 * while nothing is ever deleted. Deleting a draft leaves a gap, which is why
 * `src/server/invoices.ts` refuses to delete anything that was ever issued.
 */
export async function nextInvoiceNumber(token: string, attempt = 0): Promise<string> {
  const year = new Date().getFullYear();
  let count = 0;
  try {
    count = await countRecords(token, "invoices");
  } catch (error) {
    throw toApiError(error, "Could not work out the next invoice number");
  }
  return `INV-${year}-${String(count + 1 + attempt).padStart(4, "0")}`;
}
