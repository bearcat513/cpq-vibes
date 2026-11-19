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
import { ACCOUNT_STATUSES, CONTACT_ROLES, EMPTY_ADDRESS, emptyCustomer } from "../lib/types";
import { ADDRESS_PARTS, isBlankAddress } from "../lib/locations";
import type {
  Account,
  AccountContact,
  AccountStatus,
  Address,
  ContactRole,
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
import { MAX_INVOICE_LINES, MAX_QUOTE_LINES, readPaymentTermDays } from "../lib/validate";
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
import { ClientResponseError } from "pocketbase";
import { ApiError } from "./http";
import {
  POCKETBASE_URL,
  callHook,
  clientFor,
  countRecords,
  isNotFound,
  pocketbaseStatus,
  toApiError,
  toIso,
} from "./pocketbase";

/** PocketBase rejects a `perPage` above this, so larger reads are paged. */
const MAX_PER_PAGE = 500;

type Record_ = globalThis.Record<string, unknown>;

/* ------------------------------- helpers -------------------------------- */

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

async function readOne(token: string, collection: string, id: string, options?: { fields?: string; expand?: string }): Promise<Record_ | null> {
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
  { limit, sort, fields, filter, expand }: { limit: number; sort: string; fields?: string; filter?: string; expand?: string },
): Promise<Record_[]> {
  try {
    const records = clientFor(token).collection(collection);
    if (limit > 0 && limit <= MAX_PER_PAGE) return (await records.getList(1, limit, { sort, fields, filter, expand })).items;

    const all = await records.getFullList({ batch: MAX_PER_PAGE, sort, fields, filter, expand });
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

/**
 * A failed batch answers 400 "Batch transaction failed." and tucks the real
 * answer — the sub-request that failed, with its own status — inside
 * `data.requests`. This puts that answer back on top, so a rule miss inside a
 * batch reads as the 404 it is, exactly as it would outside one.
 */
function unwrapBatchError(error: unknown): unknown {
  if (!(error instanceof ClientResponseError)) return error;
  const requests = (error.response?.data as Record_ | undefined)?.requests;
  if (!requests || typeof requests !== "object") return error;
  const failed = Object.values(requests as Record_)[0] as { response?: { status?: number; body?: Record_ } } | undefined;
  const inner = failed?.response;
  if (!inner?.status) return error;
  return new ClientResponseError({ url: error.url, status: inner.status, response: inner.body ?? {} });
}

async function sendBatch(batch: ReturnType<ReturnType<typeof clientFor>["createBatch"]>): Promise<void> {
  try {
    await batch.send();
  } catch (error) {
    throw unwrapBatchError(error);
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

const ownership = (row: Record_) => ({
  ownerId: relationId(row.owner),
  orgId: relationId(row.org),
  sharedWith: relationIds(row.sharedWith),
});

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
    quantityIncrement: Number(definition.quantityIncrement ?? 0),
    availableFrom: definition.availableFrom ?? "",
    availableTo: definition.availableTo ?? "",
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
    orgId: relationId(row.org),
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
    orgId: relationId(row.org),
    ...stamps(row),
  };
}

/* An account is three collections — see 1750000014_account_normalize.js. */

const LOCATIONS = "sys_physical_location";
const CONTACTS = "contacts";

/** What an account is read with: both addresses, and everybody pointing at it. */
const ACCOUNT_EXPAND = "billingAddress,shippingAddress,contacts_via_account";

function toAddress(row: unknown): Address {
  if (!row || typeof row !== "object") return { ...EMPTY_ADDRESS };
  const record = row as Record_;
  return {
    line1: String(record.line1 ?? ""),
    line2: String(record.line2 ?? ""),
    city: String(record.city ?? ""),
    state: String(record.state ?? ""),
    postalCode: String(record.postalCode ?? ""),
    country: String(record.country ?? ""),
  };
}

function toContact(row: Record_): AccountContact {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    title: String(row.title ?? ""),
    email: String(row.contactEmail ?? ""),
    phone: String(row.phone ?? ""),
    role: (CONTACT_ROLES as string[]).includes(String(row.role)) ? (row.role as ContactRole) : "commercial",
    primary: row.primary === true,
  };
}

/** In the order the account lists them — `position`, which the server writes on every save. */
const contactOrder = (a: Record_, b: Record_) =>
  Number(a.position ?? 0) - Number(b.position ?? 0) || String(a.id).localeCompare(String(b.id));

function toAccount(row: Record_): Account {
  const expand = (row.expand ?? {}) as Record_;
  const billingAddressId = relationId(row.billingAddress);
  const shippingAddressId = relationId(row.shippingAddress);
  // Shipping to the billing address is both relations naming one record —
  // or no shipping record at all, which is what an account with no address
  // has, and what "same as billing" has always defaulted to.
  const shippingSameAsBilling = !shippingAddressId || shippingAddressId === billingAddressId;
  const billingAddress = toAddress(expand.billingAddress);
  const contacts = Array.isArray(expand.contacts_via_account) ? [...(expand.contacts_via_account as Record_[])] : [];

  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    industry: String(row.industry ?? ""),
    website: String(row.website ?? ""),
    status: (ACCOUNT_STATUSES as string[]).includes(String(row.status)) ? (row.status as AccountStatus) : "prospect",
    tags: jsonArray<string>(row.tags),
    contacts: contacts.sort(contactOrder).map(toContact),
    billingAddress,
    shippingAddress: shippingSameAsBilling ? { ...billingAddress } : toAddress(expand.shippingAddress),
    shippingSameAsBilling,
    billingAddressId,
    shippingAddressId: shippingSameAsBilling ? billingAddressId : shippingAddressId,
    currency: asCurrency(row.currency),
    priceBookId: relationId(row.priceBook),
    paymentTerms: String(row.paymentTerms ?? ""),
    paymentTermDays: readPaymentTermDays(row.paymentTermDays, String(row.paymentTerms ?? "")),
    creditLimit: Number(row.creditLimit ?? 0),
    defaultDiscountPercent: Number(row.defaultDiscountPercent ?? 0),
    taxExempt: row.taxExempt === true,
    taxPercent: Number(row.taxPercent ?? 0),
    notes: String(row.notes ?? ""),
    ownerId: relationId(row.owner),
    orgId: relationId(row.org),
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

function toQuote(row: Record_, lines: PricedLine[]): Quote {
  const header = jsonObject<Partial<Quote>>(row.header, {});
  return {
    id: String(row.id),
    number: String(row.number ?? ""),
    name: String(row.name ?? ""),
    status: (String(row.status ?? "draft") || "draft") as QuoteStatus,
    version: Number(row.version ?? 1),
    supersedesId: relationId(row.supersedes) || null,
    supersededById: relationId(row.supersededBy) || null,
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
    lines,
    totals: jsonObject<QuoteTotals>(row.totals, {} as QuoteTotals),
    approvals: jsonArray<unknown>(row.approvals).map(toApprovalRequest),
    approverIds: relationIds(row.approvers),
    ownerId: relationId(row.owner),
    orgId: relationId(row.org),
    sharedWith: relationIds(row.sharedWith),
    sentAt: toIso(row.sentAt),
    decidedAt: toIso(row.decidedAt),
    ...stamps(row),
  };
}

/** The list view: everything but the lines, which are not read for it. */
function toQuoteSummary(row: Record_): QuoteSummary {
  const { lines: _lines, approvals, ...rest } = toQuote(row, []);
  return {
    ...rest,
    lineCount: Number(row.lineCount ?? 0),
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
    quantityIncrement: input.quantityIncrement,
    availableFrom: input.availableFrom,
    availableTo: input.availableTo,
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
  currency: input.currency,
  // PocketBase wants "" for an unset relation, not null.
  priceBook: input.priceBookId || "",
  industry: input.industry,
  website: input.website,
  status: input.status,
  tags: input.tags,
  paymentTerms: input.paymentTerms,
  paymentTermDays: input.paymentTermDays,
  creditLimit: input.creditLimit,
  defaultDiscountPercent: input.defaultDiscountPercent,
  taxExempt: input.taxExempt,
  taxPercent: input.taxPercent,
  notes: input.notes,
});

const contactBody = (contact: AccountContact, position: number): Record_ => ({
  position,
  name: contact.name,
  title: contact.title,
  contactEmail: contact.email,
  phone: contact.phone,
  role: contact.role,
  primary: contact.primary,
});

const sameAddress = (a: Address, b: Address) => ADDRESS_PARTS.every(part => a[part] === b[part]);
const sameContact = (row: Record_, contact: AccountContact, position: number) => {
  const stored = contactBody(toContact(row), Number(row.position ?? 0));
  const next = contactBody(contact, position);
  return Object.keys(next).every(key => stored[key] === next[key]);
};

/**
 * Saves an account and what it is made of — its two locations and its
 * contacts — in one PocketBase batch, so a failure anywhere leaves all three
 * collections as they were. Every write is still the caller's own, under the
 * collection rules.
 *
 * A location is edited in place while the account keeps pointing at it, and
 * created when it starts to. One the account stops naming is removed by
 * pb_hooks/rules/locations.js once nothing names it. "Same as billing" points
 * the shipping relation at the billing record rather than copying it.
 *
 * A contact keeps its id when it is one this account already has; any other
 * id is a client's placeholder, and the server mints a real one — ids are
 * global, and two accounts installed from the same sample would collide.
 */
async function saveAccountGraph(token: string, id: string | null, input: AccountInput): Promise<Account | null> {
  const existing = id ? await readOne(token, "accounts", id, { expand: ACCOUNT_EXPAND }) : null;
  if (id && !existing) return null;
  const accountId = id ?? newId("acc");
  const expand = (existing?.expand ?? {}) as Record_;

  const batch = clientFor(token).createBatch();
  const locations = batch.collection(LOCATIONS);

  /** The location an address should live in: `current` edited if it changed, a new one if there is none. */
  const place = (address: Address, currentId: string, current: unknown): string => {
    if (isBlankAddress(address)) return "";
    if (currentId) {
      if (!sameAddress(toAddress(current), address)) locations.update(currentId, { ...address });
      return currentId;
    }
    const created = newId("loc");
    locations.create({ id: created, ...address });
    return created;
  };

  const oldBilling = relationId(existing?.billingAddress);
  const oldShipping = relationId(existing?.shippingAddress);
  const billingAddress = place(input.billingAddress, oldBilling, expand.billingAddress);
  const shippingAddress = input.shippingSameAsBilling
    ? billingAddress
    : // A shipping record that was the billing one is the billing one; ship elsewhere needs its own.
      place(input.shippingAddress, oldShipping !== oldBilling ? oldShipping : "", oldShipping !== oldBilling ? expand.shippingAddress : null);

  const body = { ...accountBody(input), billingAddress, shippingAddress };
  if (id) batch.collection("accounts").update(id, body);
  else batch.collection("accounts").create({ id: accountId, ...body });

  const stored = new Map(
    (Array.isArray(expand.contacts_via_account) ? (expand.contacts_via_account as Record_[]) : []).map(row => [String(row.id), row]),
  );
  const contacts = batch.collection(CONTACTS);
  input.contacts.forEach((contact, position) => {
    const row = stored.get(contact.id);
    if (row) {
      if (!sameContact(row, contact, position)) contacts.update(contact.id, contactBody(contact, position));
      stored.delete(contact.id);
    } else {
      contacts.create({ id: newId("con"), account: accountId, ...contactBody(contact, position) });
    }
  });
  for (const gone of stored.keys()) contacts.delete(gone);

  try {
    await sendBatch(batch);
  } catch (error) {
    if (id && isNotFound(error)) return null;
    throw toApiError(error, id ? "Could not update the account" : "Could not save the account");
  }
  return getAccount(token, accountId);
}

export const listAccounts = async (token: string): Promise<Account[]> =>
  (await readMany(token, "accounts", { limit: 0, sort: "name", expand: ACCOUNT_EXPAND })).map(toAccount);

export async function getAccount(token: string, id: string): Promise<Account | null> {
  const row = await readOne(token, "accounts", id, { expand: ACCOUNT_EXPAND });
  return row ? toAccount(row) : null;
}

export async function createAccount(token: string, input: AccountInput): Promise<Account> {
  return (await saveAccountGraph(token, null, input))!;
}

export const updateAccount = (token: string, id: string, input: AccountInput): Promise<Account | null> =>
  saveAccountGraph(token, id, input);

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

/* ------------------------------- line items ------------------------------- */

/**
 * A quote's lines are `quote_lines` records and an invoice's are
 * `invoice_lines` — see 1750000016_line_items.js. Each is saved with its
 * parent in one PocketBase batch, so a quote is never stored with half its
 * lines.
 *
 * A row keeps the line's own id as `lineId` (what a bundle component's
 * `parentId` and an invoice line's `sourceLineId` name) and is matched on it
 * when the parent is saved again: a line still there is updated only if
 * something on it changed, a new one is created, and one the save leaves out
 * is deleted. The record id is the server's, minted on create.
 */
type LineSpec<T> = {
  collection: string;
  /** The relation to the parent. */
  parent: string;
  prefix: string;
  body: (line: T, position: number) => Record_;
  read: (row: Record_) => T;
};

const QUOTE_LINE_TEXT = ["productId", "description", "sku", "name", "family", "chargeType", "billingPeriod", "unitOfMeasure"] as const;
const QUOTE_LINE_NUMBERS = [
  "sortOrder",
  "quantity",
  "discountPercent",
  "termMonths",
  "listUnitPrice",
  "optionsUnitDelta",
  "baseUnitPrice",
  "unitPrice",
  "listTotal",
  "discountAmount",
  "netTotal",
  "effectiveDiscountPercent",
  "periods",
  "unitCost",
  "costTotal",
  "margin",
  "marginPercent",
  "oneTime",
  "monthlyRecurring",
  "annualRecurring",
] as const;
const QUOTE_LINE_COLUMNS = new Set<string>(["id", "parentId", ...QUOTE_LINE_TEXT, ...QUOTE_LINE_NUMBERS]);

const finite = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * A priced line as a `quote_lines` body: every scalar in its column, and
 * whatever is left — options, tier, applied rules, issues, warnings,
 * `unitPriceOverride` — in `detail`. Anything a line gains later lands in
 * `detail` without a migration.
 */
function quoteLineBody(line: PricedLine, position: number): Record_ {
  const body: Record_ = { lineId: line.id, position, parentLineId: line.parentId ?? "" };
  for (const key of QUOTE_LINE_TEXT) body[key] = String(line[key] ?? "");
  for (const key of QUOTE_LINE_NUMBERS) body[key] = finite(line[key]);
  body.detail = Object.fromEntries(Object.entries(line).filter(([key]) => !QUOTE_LINE_COLUMNS.has(key)));
  return body;
}

function toQuoteLine(row: Record_): PricedLine {
  const line: Record_ = {
    unitPriceOverride: null,
    selectedOptions: [],
    optionNames: [],
    tier: null,
    appliedRules: [],
    issues: [],
    warnings: [],
    ...jsonObject<Record_>(row.detail, {}),
    id: String(row.lineId ?? ""),
    parentId: relationId(row.parentLineId) || null,
  };
  for (const key of QUOTE_LINE_TEXT) line[key] = String(row[key] ?? "");
  for (const key of QUOTE_LINE_NUMBERS) line[key] = finite(row[key]);
  return line as PricedLine;
}

const invoiceLineBody = (line: InvoiceLine, position: number): Record_ => ({
  lineId: line.id,
  position,
  sourceLineId: line.sourceLineId ?? "",
  sku: line.sku,
  description: line.description,
  quantity: finite(line.quantity),
  unitPrice: finite(line.unitPrice),
  amount: finite(line.amount),
  taxPercent: finite(line.taxPercent),
  taxAmount: finite(line.taxAmount),
});

const toInvoiceLine = (row: Record_): InvoiceLine => ({
  id: String(row.lineId ?? ""),
  sourceLineId: relationId(row.sourceLineId) || null,
  sku: String(row.sku ?? ""),
  description: String(row.description ?? ""),
  quantity: finite(row.quantity),
  unitPrice: finite(row.unitPrice),
  amount: finite(row.amount),
  taxPercent: finite(row.taxPercent),
  taxAmount: finite(row.taxAmount),
});

const QUOTE_LINES: LineSpec<PricedLine> = {
  collection: "quote_lines",
  parent: "quote",
  prefix: "qln",
  body: quoteLineBody,
  read: toQuoteLine,
};

const INVOICE_LINES: LineSpec<InvoiceLine> = {
  collection: "invoice_lines",
  parent: "invoice",
  prefix: "iln",
  body: invoiceLineBody,
  read: toInvoiceLine,
};

const LINE_SORT = "position,id";

/** One parent's line rows, in order. */
const readLineRows = (token: string, spec: Pick<LineSpec<unknown>, "collection" | "parent">, parentId: string): Promise<Record_[]> =>
  readMany(token, spec.collection, { limit: 0, sort: LINE_SORT, filter: `${spec.parent} = "${parentId.replace(/"/g, "")}"` });

/** Key order does not make two bodies different. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort().map(key => [key, (inner as Record_)[key]]))
      : inner,
  );

/**
 * Queues the writes that turn `rows` — what is stored — into `lines`. A
 * second row claiming a `lineId` already seen is a leftover and is removed.
 */
function queueLines<T>(
  batch: ReturnType<ReturnType<typeof clientFor>["createBatch"]>,
  spec: LineSpec<T>,
  parentId: string,
  rows: Record_[],
  lines: T[],
): void {
  const records = batch.collection(spec.collection);
  const stored = new Map<string, Record_>();
  for (const row of rows) {
    const key = String(row.lineId ?? "");
    if (stored.has(key)) records.delete(String(row.id));
    else stored.set(key, row);
  }

  lines.forEach((line, position) => {
    const body = spec.body(line, position);
    const row = stored.get(String(body.lineId));
    if (!row) {
      records.create({ id: newId(spec.prefix), [spec.parent]: parentId, ...body });
      return;
    }
    stored.delete(String(body.lineId));
    if (canonical(spec.body(spec.read(row), Number(row.position ?? 0))) !== canonical(body)) {
      records.update(String(row.id), body);
    }
  });

  for (const row of stored.values()) records.delete(String(row.id));
}

/**
 * Creates or updates a parent record and, unless `lines` is null, makes its
 * stored lines exactly `lines` — all in one batch. Returns false when an
 * update finds nothing it may change.
 */
async function saveWithLines<T>(
  token: string,
  parent: { collection: string; id: string; create: boolean; body: Record_; what: string },
  spec: LineSpec<T>,
  lines: T[] | null,
): Promise<boolean> {
  const rows = lines && !parent.create ? await readLineRows(token, spec, parent.id) : [];
  const batch = clientFor(token).createBatch();
  if (parent.create) batch.collection(parent.collection).create({ id: parent.id, ...parent.body });
  else batch.collection(parent.collection).update(parent.id, parent.body);
  if (lines) queueLines(batch, spec, parent.id, rows, lines);

  try {
    await sendBatch(batch);
    return true;
  } catch (error) {
    if (!parent.create && isNotFound(error)) return false;
    throw toApiError(error, parent.what);
  }
}

/* --------------------------------- quotes -------------------------------- */

/** Everything a list shows. The lines are `quote_lines` rows, and are not read for a list. */
const QUOTE_SUMMARY_FIELDS =
  "id,number,name,status,version,supersedes,supersededBy,priceBook,currency,validUntil,header,totals,approvals,approvers,owner,org,sharedWith,sentAt,decidedAt,created,updated,lineCount";

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
  if (input.lines.length > MAX_QUOTE_LINES) {
    throw new ApiError(
      `This quote comes to ${input.lines.length} lines once its bundles are expanded, over the ` +
        `${MAX_QUOTE_LINES} a quote may hold. Split it into several quotes.`,
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

export type QuoteQuery = {
  /** Matched against the number, the name and the customer's name. */
  q?: string;
  /** An effective status — `expired` and `superseded` included. */
  status?: QuoteStatus | "";
  /** 1-based. */
  page?: number;
  perPage?: number;
};

export type QuotePage = {
  items: QuoteSummary[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
};

/**
 * The PocketBase filter for one *effective* status.
 *
 * `expired` and `superseded` are never stored (src/lib/quoteLifecycle.ts), so
 * filtering on the column alone would put an expired quote under "sent" and
 * find nothing under "expired". Each status here is the same test
 * `effectiveStatus` applies, written as a filter. `asOf` is the
 * organization's today.
 */
export function quoteStatusFilter(status: QuoteStatus, asOf: string): { filter: string; params: Record_ } {
  const live = 'supersededBy = ""';
  switch (status) {
    case "superseded":
      return { filter: 'supersededBy != "" && status != "accepted"', params: {} };
    case "accepted":
      return { filter: 'status = "accepted"', params: {} };
    case "expired":
      return { filter: `${live} && status = "sent" && validUntil != "" && validUntil < {:asOf}`, params: { asOf } };
    case "sent":
      return { filter: `${live} && status = "sent" && (validUntil = "" || validUntil >= {:asOf})`, params: { asOf } };
    default:
      return { filter: `${live} && status = {:status}`, params: { status } };
  }
}

/**
 * One page of quotes, newest first, searched and filtered in PocketBase.
 *
 * The list used to be the caller's most recent fifty, searched in the
 * browser — so a quote from last year could not be found at all once fifty
 * newer ones existed. Now the search runs where the quotes are.
 */
export async function searchQuotes(token: string, query: QuoteQuery, asOf: string): Promise<QuotePage> {
  const client = clientFor(token);
  const parts: string[] = [];
  const q = String(query.q ?? "").trim();
  if (q) parts.push(client.filter("(number ~ {:q} || name ~ {:q} || header.customer.name ~ {:q})", { q }));
  if (query.status) {
    const { filter, params } = quoteStatusFilter(query.status, asOf);
    parts.push(client.filter(filter, params));
  }

  // 0 meant "everything" when this took `limit`; it now means the largest page.
  const asked = Math.trunc(query.perPage ?? 50);
  const perPage = asked <= 0 ? MAX_PER_PAGE : Math.min(asked, MAX_PER_PAGE);
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  try {
    const result = await client.collection("quotes").getList(page, perPage, {
      sort: "-updated",
      fields: QUOTE_SUMMARY_FIELDS,
      filter: parts.map(part => `(${part})`).join(" && ") || undefined,
    });
    return {
      items: result.items.map(row => toQuoteSummary(row as Record_)),
      page: result.page,
      perPage: result.perPage,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
    };
  } catch (error) {
    throw toApiError(error, "Could not list quotes");
  }
}

/**
 * How many quotes the caller can see in each effective status, for the
 * filter chips — one count per status, each a `getList(1, 1)` that transfers
 * no records.
 */
export async function countQuotesByStatus(
  token: string,
  statuses: readonly QuoteStatus[],
  asOf: string,
  q = "",
): Promise<Record<string, number>> {
  const client = clientFor(token);
  const search = q.trim()
    ? client.filter("(number ~ {:q} || name ~ {:q} || header.customer.name ~ {:q})", { q: q.trim() })
    : "";
  const count = async (filter: string) =>
    (await client.collection("quotes").getList(1, 1, { fields: "id", filter: filter || undefined })).totalItems;

  try {
    const entries = await Promise.all(
      statuses.map(async status => {
        const { filter, params } = quoteStatusFilter(status, asOf);
        const parts = [client.filter(filter, params), search].filter(Boolean).map(part => `(${part})`);
        return [status, await count(parts.join(" && "))] as const;
      }),
    );
    return { all: await count(search), ...Object.fromEntries(entries) };
  } catch (error) {
    throw toApiError(error, "Could not count quotes");
  }
}

export const listQuotes = async (token: string, limit = 50): Promise<QuoteSummary[]> =>
  (await readMany(token, "quotes", { limit, sort: "-updated", fields: QUOTE_SUMMARY_FIELDS })).map(toQuoteSummary);

/** Every revision of one quote, the original among them — for "was this already invoiced". */
export async function listRevisionChain(token: string, quote: Pick<Quote, "id" | "supersedesId">): Promise<QuoteSummary[]> {
  const seen = new Map<string, QuoteSummary>();
  // Walk back to the original, then collect everything that revises anything
  // in the chain. Chains are short; this is a handful of reads.
  let rootId = quote.id;
  let parent = quote.supersedesId;
  for (let hops = 0; parent && hops < 50; hops++) {
    const row = await readOne(token, "quotes", parent, { fields: QUOTE_SUMMARY_FIELDS });
    if (!row) break;
    const summary = toQuoteSummary(row);
    seen.set(summary.id, summary);
    rootId = summary.id;
    parent = summary.supersedesId;
  }

  let frontier = [rootId];
  for (let hops = 0; frontier.length && hops < 50; hops++) {
    const filter = frontier.map(id => `supersedes = "${id.replace(/"/g, "")}"`).join(" || ");
    const rows = await readMany(token, "quotes", { limit: 0, sort: "created", fields: QUOTE_SUMMARY_FIELDS, filter });
    frontier = [];
    for (const row of rows) {
      const summary = toQuoteSummary(row);
      if (seen.has(summary.id) || summary.id === quote.id) continue;
      seen.set(summary.id, summary);
      frontier.push(summary.id);
    }
  }
  return [...seen.values()];
}

/**
 * Marks a quote as superseded by one of its revisions.
 *
 * Written on its own, never by an ordinary save — `quoteBody` has no
 * `supersededBy` in it, so a save cannot unset it by accident. PocketBase
 * checks that the revision really does revise this quote (pb_hooks/rules/
 * approvals.js).
 */
export async function markSuperseded(token: string, id: string, revisionId: string): Promise<void> {
  try {
    await clientFor(token).collection("quotes").update(id, { supersededBy: revisionId });
  } catch (error) {
    throw toApiError(error, "Could not mark the quote as superseded");
  }
}

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

/** A quote and its lines, read side by side. */
export async function getQuote(token: string, id: string): Promise<Quote | null> {
  const [row, lines] = await Promise.all([readOne(token, "quotes", id), readLineRows(token, QUOTE_LINES, id)]);
  return row ? toQuote(row, lines.map(toQuoteLine)) : null;
}

export async function createQuote(token: string, input: QuoteRecordInput): Promise<Quote> {
  const id = newId("qte");
  await saveWithLines(token, { collection: "quotes", id, create: true, body: quoteBody(input), what: "Could not save the quote" }, QUOTE_LINES, input.lines);
  const quote = await getQuote(token, id);
  if (!quote) throw new ApiError("The quote was saved but could not be read back.", 502);
  return quote;
}

/**
 * Saves a quote and its lines together. `lines: false` writes the quote
 * alone — what an approver's decision does, since an approver may not write
 * a line (1750000016) and deciding never changes one.
 */
export async function updateQuote(
  token: string,
  id: string,
  input: QuoteRecordInput,
  options: { lines?: boolean } = {},
): Promise<Quote | null> {
  const lines = options.lines === false ? null : input.lines;
  const saved = await saveWithLines(token, { collection: "quotes", id, create: false, body: quoteBody(input), what: "Could not update the quote" }, QUOTE_LINES, lines);
  return saved ? getQuote(token, id) : null;
}

export const deleteQuote = (token: string, id: string) => remove(token, "quotes", id);

/**
 * The next quote number in the caller's organization: `Q-2026-0007`.
 *
 * Taken from a counter in PocketBase (pb_hooks/lib/orgs.js), per
 * organization and year, inside a transaction. It used to be a count of the
 * quotes the caller could see — which counted quotes shared with them and
 * quotes they were approving, and fell back onto numbers already used when a
 * share was revoked. `year` is the year in the organization's own calendar.
 */
export async function nextQuoteNumber(token: string, year: number): Promise<string> {
  const { number } = await callHook<{ number: string }>(token, "/api/cpq/numbers/quote", {
    method: "POST",
    body: JSON.stringify({ year }),
  });
  return number;
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
    orgId: relationId(row.org),
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
    orgId: relationId(row.org),
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
function toInvoice(row: Record_, lines: InvoiceLine[], payments: InvoicePayment[], credits: InvoiceCredit[]): Invoice {
  const header = jsonObject<Record<string, unknown>>(row.header, {});
  const stored = jsonObject<Partial<InvoiceTotals>>(row.totals, {});
  const currency = asCurrency(row.currency);

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
      lineCount: Number(stored.lineCount ?? row.lineCount ?? lines.length),
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
  const { lines: _lines, payments: paid, credits: credited, ...rest } = toInvoice(row, [], payments, credits);
  return {
    ...rest,
    lineCount: Number(row.lineCount ?? 0),
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
  if (input.lines.length > MAX_INVOICE_LINES) {
    throw new ApiError(
      `This invoice has ${input.lines.length} lines, over the ${MAX_INVOICE_LINES} an invoice may hold. ` +
        "Split it into several invoices.",
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

/** An invoice, its lines and its ledger — three reads, side by side. */
export async function getInvoice(token: string, id: string): Promise<Invoice | null> {
  const [row, lines, ledger] = await Promise.all([
    readOne(token, "invoices", id),
    readLineRows(token, INVOICE_LINES, id),
    readLedger(token, id),
  ]);
  return row ? toInvoice(row, lines.map(toInvoiceLine), ledger.payments, ledger.credits) : null;
}

export async function createInvoice(token: string, input: InvoiceRecordInput): Promise<Invoice> {
  const id = newId("inv");
  await saveWithLines(token, { collection: "invoices", id, create: true, body: invoiceBody(input), what: "Could not save the invoice" }, INVOICE_LINES, input.lines);
  // Brand new, so its ledger is empty by construction rather than by query.
  const [row, lines] = await Promise.all([readOne(token, "invoices", id), readLineRows(token, INVOICE_LINES, id)]);
  if (!row) throw new ApiError("The invoice was saved but could not be read back.", 502);
  return toInvoice(row, lines.map(toInvoiceLine), [], []);
}

/**
 * Saves an invoice and its lines together. Only a draft's lines can be
 * written (1750000016); the lines of an issued invoice come back from a save
 * unchanged, so nothing is queued for them.
 */
export async function updateInvoice(token: string, id: string, input: InvoiceRecordInput): Promise<Invoice | null> {
  const saved = await saveWithLines(token, { collection: "invoices", id, create: false, body: invoiceBody(input), what: "Could not update the invoice" }, INVOICE_LINES, input.lines);
  return saved ? getInvoice(token, id) : null;
}

export const deleteInvoice = (token: string, id: string) => remove(token, "invoices", id);

/**
 * Issues a draft: PocketBase takes the next invoice number and sets the state
 * and the dates, in one transaction (pb_hooks/lib/orgs.js).
 *
 * An invoice is numbered when it is issued rather than when its draft is
 * created, so a discarded draft never leaves a hole in the issued run — and
 * numbering and issuing are one write, so a failed issue cannot either.
 */
export async function issueDraftInvoice(token: string, id: string, issueDate: string, dueDate: string): Promise<string> {
  const { number } = await callHook<{ number: string }>(token, `/api/cpq/invoices/${encodeURIComponent(id)}/issue`, {
    method: "POST",
    body: JSON.stringify({ issueDate, dueDate }),
  });
  return number;
}
