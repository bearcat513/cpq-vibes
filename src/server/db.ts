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
import type {
  Account,
  ApprovalDecision,
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
import type {
  AccountInput,
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

function toAccount(row: Record_): Account {
  const details = jsonObject<Partial<Account>>(row.details, {});
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    industry: details.industry ?? "",
    website: details.website ?? "",
    contactName: details.contactName ?? "",
    contactEmail: String(row.contactEmail ?? ""),
    contactPhone: details.contactPhone ?? "",
    billingAddress: details.billingAddress ?? {
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "",
    },
    currency: asCurrency(row.currency),
    priceBookId: relationId(row.priceBook),
    paymentTerms: details.paymentTerms ?? "",
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
    customer: header.customer ?? {
      accountId: null,
      name: "",
      contactName: "",
      contactEmail: "",
      contactPhone: "",
      billingAddress: { line1: "", line2: "", city: "", state: "", postalCode: "", country: "" },
      paymentTerms: "",
    },
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
  contactEmail: input.contactEmail,
  currency: input.currency,
  // PocketBase wants "" for an unset relation, not null.
  priceBook: input.priceBookId || "",
  details: {
    industry: input.industry,
    website: input.website,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    billingAddress: input.billingAddress,
    paymentTerms: input.paymentTerms,
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
    return { ...status, accounts: null, products: null, priceBooks: null, quotes: null, proposalTemplates: null };
  }

  try {
    const [accounts, products, priceBooks, quotes, proposalTemplates] = await Promise.all([
      countRecords(token, "accounts"),
      countRecords(token, "products"),
      countRecords(token, "price_books"),
      countRecords(token, "quotes"),
      countRecords(token, "proposal_templates"),
    ]);
    return { ...status, accounts, products, priceBooks, quotes, proposalTemplates };
  } catch (error) {
    throw toApiError(error, "Could not read the record counts");
  }
}

/** Re-exported so callers reading a session get a normalized preference set. */
export { normalizePreferences };
