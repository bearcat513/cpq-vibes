/**
 * Turning untrusted input into domain objects.
 *
 * Everything that arrives from outside — a REST body, an imported catalogue
 * file, a form the browser posted — comes through here first, and comes out
 * either as a complete, in-range record or as one sentence saying what is
 * wrong with it. There is no third outcome, and no partially-trusted object
 * downstream of this file.
 *
 * It is shared code on purpose. The API and the file importer accept exactly
 * the same shapes because they run the same functions: a product that imports
 * is a product that posts, a rule rejected by one is rejected by the other,
 * and neither can drift into accepting something the other would not.
 *
 * Two habits run through it:
 *
 * **Strip, clamp, then reject.** Unknown keys are dropped rather than stored,
 * numbers are clamped into their legal range rather than refused, and only
 * things that cannot be repaired — a missing name, a formula that will not
 * parse, two products claiming one SKU — are errors. A quantity of −5 is a
 * slip; a pricing rule that references a variable that does not exist is a
 * policy that would silently never fire.
 *
 * **Validate formulas at the door.** A pricing rule, an approval condition and
 * a product validation rule are all parsed here, against the variables their
 * scope actually offers. A formula that cannot work is caught by the person
 * writing it rather than by the quote it mispriced a month later.
 */
import { parseFormula } from "./formula";
import { isEmbeddableImage } from "./image";
import { asCurrency, atLeastZero, clampPercent, isCurrency } from "./money";
import { lineVariableNames, quoteVariableNames } from "./pricing";
import { MAX_PDF_TEMPLATE_BODY_LENGTH, MAX_TEMPLATE_BODY_LENGTH, MAX_TEMPLATE_NAME_LENGTH } from "./document";
import { DEFAULT_MARGINS, PAGE_SIZES } from "./pdf";
import { FONT_FAMILIES, type FontFamily } from "./pdfFonts";
import {
  DEFAULT_PAGE,
  defaultStyle,
  defaultLineColumns,
  defaultTotalsRows,
  lineItemFields,
  starterPdfTemplate,
  totalsFields,
  type LineItemColumn,
  type PdfBlock,
  type PdfHeader,
  type PdfStyle,
  type PdfTemplate,
  type PdfWatermark,
  type TotalsRow,
} from "./pdfTemplate";
import {
  ACCOUNT_STATUSES,
  APPROVAL_METRICS,
  BILLING_PERIODS,
  CHARGE_TYPES,
  COMPARATORS,
  CONTACT_ROLES,
  CREDIT_REASONS,
  CURRENCIES,
  EMPTY_ADDRESS,
  PAYMENT_METHODS,
  PRICING_RULE_TARGETS,
  PRODUCT_RULE_KINDS,
  PROPOSAL_FORMATS,
  TEMPLATE_KINDS,
  TIER_KINDS,
  type Account,
  type AccountContact,
  type Address,
  type ApprovalRule,
  type BillingPeriod,
  type BundleComponent,
  type ChargeType,
  type InvoiceCredit,
  type InvoiceLine,
  type InvoicePayment,
  type OptionGroup,
  type PriceBook,
  type PriceBookEntry,
  type PricingRule,
  type Product,
  type ProductOption,
  type ProductRule,
  type ProposalFormat,
  type ProposalTemplate,
  type TemplateKind,
  type QuoteLineInput,
  type VolumeTier,
} from "./types";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export const invalid = (error: string): { ok: false; error: string } => ({ ok: false, error });
const valid = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

/* ------------------------------- scalars --------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const text = (value: unknown, max: number): string => String(value ?? "").trim().slice(0, max);

const number = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.min(Math.max(number(value, fallback), min), max);

const integer = (value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  Math.trunc(bounded(value, fallback, min, max));

const percent = (value: unknown, fallback = 0): number => clampPercent(number(value, fallback));

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const stringList = (value: unknown, max = 200): string[] =>
  Array.isArray(value) ? value.map(entry => text(entry, max)).filter(Boolean) : [];

/** An ISO date, or "" — anything unparseable becomes "" rather than a wrong day. */
const isoDate = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = new Date(raw.length <= 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
};

const email = (value: unknown): string => String(value ?? "").trim().toLowerCase().slice(0, 200);

/**
 * A key for an option or a group: lowercase, no spaces, stable across an
 * export. Rules reference these, which is why they cannot be free text.
 */
const slug = (value: unknown, fallback: string): string => {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
};

let counter = 0;
/** Ids for nested things, which PocketBase never sees — only the record does. */
export const localId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/* ------------------------------- formulas -------------------------------- */

/** Variables a product's `validate` rule may use, given the option keys it has. */
const productRuleVariables = (optionKeys: string[]) => [
  "quantity",
  "term",
  "termMonths",
  "selectedCount",
  ...optionKeys.map(key => `option.${key}`),
];

function checkFormula(expression: string, variables: string[], what: string): string | null {
  const result = parseFormula(expression, variables);
  return result.ok ? null : `${what}: ${result.error}`;
}

/* -------------------------------- products ------------------------------- */

function readOption(raw: unknown, index: number): ProductOption {
  const input = asRecord(raw);
  const name = text(input.name, 120) || `Option ${index + 1}`;
  const option: ProductOption = {
    id: text(input.id, 60) || localId("opt"),
    key: slug(input.key ?? name, `option_${index + 1}`),
    name,
    description: text(input.description, 500),
    priceDelta: number(input.priceDelta, 0),
    // A factor of 0 would make the option free rather than neutral, which is
    // never what someone meant to type.
    priceFactor: number(input.priceFactor, 1) > 0 ? number(input.priceFactor, 1) : 1,
    costDelta: number(input.costDelta, 0),
    default: flag(input.default, false),
  };

  // An empty condition is no condition, so it is left off rather than stored
  // blank — the same rule a letterhead and a watermark follow.
  const visibleWhen = text(input.visibleWhen, 2_000);
  if (visibleWhen) option.visibleWhen = visibleWhen;

  return option;
}

function readOptionGroup(raw: unknown, index: number): OptionGroup {
  const input = asRecord(raw);
  const name = text(input.name, 120) || `Group ${index + 1}`;
  const options = (Array.isArray(input.options) ? input.options : []).map(readOption);

  // Duplicate keys within a group would make a selection ambiguous; the later
  // one is renamed rather than dropped, so nothing silently disappears.
  const seen = new Set<string>();
  for (const option of options) {
    let key = option.key;
    for (let suffix = 2; seen.has(key); suffix++) key = `${option.key}_${suffix}`;
    option.key = key;
    seen.add(key);
  }

  const select = oneOf(input.select, ["one", "many"] as const, "one");
  const group: OptionGroup = {
    id: text(input.id, 60) || localId("grp"),
    key: slug(input.key ?? name, `group_${index + 1}`),
    name,
    description: text(input.description, 500),
    select,
    required: flag(input.required, false),
    options,
  };

  const visibleWhen = text(input.visibleWhen, 2_000);
  if (visibleWhen) group.visibleWhen = visibleWhen;

  if (select === "many") {
    if (input.minSelect !== undefined && input.minSelect !== null) {
      group.minSelect = integer(input.minSelect, 0, 0, options.length);
    }
    if (input.maxSelect !== undefined && input.maxSelect !== null) {
      group.maxSelect = integer(input.maxSelect, options.length, 0, options.length);
    }
  }

  return group;
}

function readProductRule(raw: unknown, index: number, optionKeys: Set<string>): Validated<ProductRule> {
  const input = asRecord(raw);
  const kind = oneOf(input.kind, PRODUCT_RULE_KINDS, "requires");
  const when = stringList(input.when, 60).map(key => slug(key, key));
  const then = stringList(input.then, 60).map(key => slug(key, key));

  // A rule pointing at an option the product does not have would never fire,
  // and would read on screen as though it did.
  for (const key of [...when, ...then]) {
    if (!optionKeys.has(key)) return invalid(`Rule ${index + 1} references an option that does not exist: "${key}".`);
  }

  const rule: ProductRule = {
    id: text(input.id, 60) || localId("prl"),
    kind,
    when,
    then,
    message: text(input.message, 500),
  };

  if (kind === "validate") {
    const expression = text(input.expression, 2_000);
    if (!expression) return invalid(`Rule ${index + 1} is a validation rule but has no expression.`);
    const error = checkFormula(expression, productRuleVariables([...optionKeys]), `Rule ${index + 1}`);
    if (error) return invalid(error);
    rule.expression = expression;
  } else if (!then.length) {
    return invalid(`Rule ${index + 1} ("${kind}") needs at least one option to act on.`);
  }

  return valid(rule);
}

function readTier(raw: unknown): VolumeTier {
  const input = asRecord(raw);
  const max = input.maxQuantity === null || input.maxQuantity === undefined ? null : integer(input.maxQuantity, 0, 0);
  return {
    minQuantity: integer(input.minQuantity, 0, 0),
    maxQuantity: max,
    kind: oneOf(input.kind, TIER_KINDS, "percent"),
    value: number(input.value, 0),
  };
}

function readComponent(raw: unknown): BundleComponent {
  const input = asRecord(raw);
  return {
    id: text(input.id, 60) || localId("cmp"),
    sku: text(input.sku, 60).toUpperCase(),
    quantity: integer(input.quantity, 1, 1, 1_000_000),
    required: flag(input.required, true),
    discountPercent: percent(input.discountPercent),
  };
}

/** The shape a product is written in, before ownership and timestamps. */
export type ProductInput = Omit<Product, "id" | "ownerId" | "sharedWith" | "createdAt" | "updatedAt">;

export function readProduct(raw: unknown): Validated<ProductInput> {
  const input = asRecord(raw);

  const name = text(input.name, 200);
  if (!name) return invalid("A product needs a name.");

  const sku = text(input.sku, 60).toUpperCase().replace(/\s+/g, "-");
  if (!sku) return invalid(`"${name}" needs a SKU.`);
  if (!/^[A-Z0-9._-]+$/.test(sku)) {
    return invalid(`"${sku}" is not a usable SKU — letters, digits, dot, dash and underscore only.`);
  }

  const optionGroups = (Array.isArray(input.optionGroups) ? input.optionGroups : []).map(readOptionGroup);

  // Keys are unique across the product, not just within a group: a rule names
  // an option by key alone, so two groups sharing one would be ambiguous. A
  // group's key is deduplicated for the same reason — the configurator shows
  // and hides groups by key.
  const optionKeys = new Set<string>();
  const groupKeys = new Set<string>();
  for (const group of optionGroups) {
    let groupKey = group.key;
    for (let suffix = 2; groupKeys.has(groupKey); suffix++) groupKey = `${group.key}_${suffix}`;
    group.key = groupKey;
    groupKeys.add(groupKey);

    for (const option of group.options) {
      let key = option.key;
      for (let suffix = 2; optionKeys.has(key); suffix++) key = `${option.key}_${suffix}`;
      option.key = key;
      optionKeys.add(key);
    }
  }

  // Visibility conditions are checked once the keys are final, so one naming
  // an option that does not exist is refused here rather than silently
  // hiding a group for every line that is ever configured.
  const variables = productRuleVariables([...optionKeys]);
  for (const group of optionGroups) {
    const groupError = group.visibleWhen && checkFormula(group.visibleWhen, variables, `the condition on “${group.name}”`);
    if (groupError) return invalid(`${name}: ${groupError}`);
    for (const option of group.options) {
      const error = option.visibleWhen && checkFormula(option.visibleWhen, variables, `the condition on “${option.name}”`);
      if (error) return invalid(`${name}: ${error}`);
    }
  }

  const rules: ProductRule[] = [];
  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  for (const [index, entry] of rawRules.entries()) {
    const parsed = readProductRule(entry, index, optionKeys);
    if (!parsed.ok) return invalid(`${name}: ${parsed.error}`);
    rules.push(parsed.value);
  }

  const minQuantity = integer(input.minQuantity, 1, 0, 1_000_000_000);
  const maxQuantity = integer(input.maxQuantity, 0, 0, 1_000_000_000);
  if (maxQuantity > 0 && maxQuantity < minQuantity) {
    return invalid(`${name}: the maximum quantity (${maxQuantity}) is below the minimum (${minQuantity}).`);
  }

  const quantityIncrement = integer(input.quantityIncrement, 0, 0, 1_000_000);
  // A pack that does not fit under the ceiling is a product nobody can buy:
  // the smallest legal quantity is one whole pack.
  if (quantityIncrement > 1 && maxQuantity > 0 && maxQuantity < quantityIncrement) {
    return invalid(
      `${name}: sold in multiples of ${quantityIncrement}, but the maximum quantity is ${maxQuantity} — ` +
        "no quantity satisfies both.",
    );
  }

  const availableFrom = isoDate(input.availableFrom);
  const availableTo = isoDate(input.availableTo);
  if (availableFrom && availableTo && availableTo < availableFrom) {
    return invalid(`${name}: it is withdrawn (${availableTo}) before it is available (${availableFrom}).`);
  }

  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(input.attributes)).slice(0, 50)) {
    attributes[text(key, 60)] = text(value, 500);
  }

  return valid({
    sku,
    name,
    description: text(input.description, 5_000),
    family: text(input.family, 120),
    chargeType: oneOf(input.chargeType, CHARGE_TYPES, "one-time") as ChargeType,
    billingPeriod: oneOf(input.billingPeriod, BILLING_PERIODS, "monthly") as BillingPeriod,
    unitOfMeasure: text(input.unitOfMeasure, 40) || "unit",
    listPrice: atLeastZero(number(input.listPrice, 0)),
    cost: atLeastZero(number(input.cost, 0)),
    currency: asCurrency(input.currency),
    active: flag(input.active, true),
    minQuantity,
    maxQuantity,
    floorDiscountPercent: percent(input.floorDiscountPercent),
    optionGroups,
    rules,
    components: (Array.isArray(input.components) ? input.components : []).map(readComponent).filter(component => component.sku),
    volumeTiers: (Array.isArray(input.volumeTiers) ? input.volumeTiers : [])
      .map(readTier)
      .sort((a, b) => a.minQuantity - b.minQuantity),
    attributes,
    // Absent rather than zero or blank: every one of these means "no
    // constraint", and a product written before they existed has to keep
    // reading exactly as it did.
    ...(quantityIncrement > 1 ? { quantityIncrement } : {}),
    ...(availableFrom ? { availableFrom } : {}),
    ...(availableTo ? { availableTo } : {}),
  });
}

/* ------------------------------ price books ------------------------------ */

function readEntry(raw: unknown): PriceBookEntry {
  const input = asRecord(raw);
  const floor = input.minPrice === null || input.minPrice === undefined ? null : atLeastZero(number(input.minPrice, 0));
  return {
    sku: text(input.sku, 60).toUpperCase(),
    unitPrice: atLeastZero(number(input.unitPrice, 0)),
    minPrice: floor,
    active: flag(input.active, true),
  };
}

export type PriceBookInput = Omit<PriceBook, "id" | "ownerId" | "sharedWith" | "createdAt" | "updatedAt">;

export function readPriceBook(raw: unknown): Validated<PriceBookInput> {
  const input = asRecord(raw);

  const name = text(input.name, 200);
  if (!name) return invalid("A price book needs a name.");

  if (input.currency !== undefined && !isCurrency(input.currency)) {
    return invalid(`"${String(input.currency)}" is not a currency this app can price in (${CURRENCIES.join(", ")}).`);
  }

  const entries = (Array.isArray(input.entries) ? input.entries : []).map(readEntry).filter(entry => entry.sku);

  // One price per SKU per book, or "the price" stops being a single fact.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.sku)) return invalid(`Price book "${name}" lists ${entry.sku} more than once.`);
    seen.add(entry.sku);
    if (entry.minPrice !== null && entry.minPrice !== undefined && entry.minPrice > entry.unitPrice) {
      return invalid(`${entry.sku}: the floor (${entry.minPrice}) is above the price (${entry.unitPrice}).`);
    }
  }

  const validFrom = isoDate(input.validFrom);
  const validTo = isoDate(input.validTo);
  if (validFrom && validTo && validTo < validFrom) {
    return invalid(`Price book "${name}" ends (${validTo}) before it starts (${validFrom}).`);
  }

  return valid({
    name,
    description: text(input.description, 2_000),
    currency: asCurrency(input.currency),
    isDefault: flag(input.isDefault, false),
    active: flag(input.active, true),
    validFrom,
    validTo,
    entries,
  });
}

/* ----------------------------- pricing rules ----------------------------- */

export type PricingRuleInput = Omit<PricingRule, "id" | "ownerId" | "createdAt" | "updatedAt">;

export function readPricingRule(raw: unknown): Validated<PricingRuleInput> {
  const input = asRecord(raw);

  const name = text(input.name, 200);
  if (!name) return invalid("A pricing rule needs a name.");

  const scope = oneOf(input.scope, ["line", "quote"] as const, "line");
  const variables = scope === "line" ? lineVariableNames() : quoteVariableNames();

  const condition = text(input.condition, 2_000);
  if (condition) {
    const error = checkFormula(condition, variables, `"${name}" condition`);
    if (error) return invalid(error);
  }

  const expression = text(input.expression, 2_000);
  if (!expression) return invalid(`"${name}" needs an expression — what the rule sets.`);
  const error = checkFormula(expression, variables, `"${name}"`);
  if (error) return invalid(error);

  const target = oneOf(input.target, PRICING_RULE_TARGETS, "discountPercent");
  if (scope === "quote" && target === "unitPrice") {
    return invalid(`"${name}" targets a unit price, which a quote-scoped rule has no way to set.`);
  }

  return valid({
    name,
    description: text(input.description, 2_000),
    scope,
    condition,
    target,
    expression,
    appliesToFamily: text(input.appliesToFamily, 120),
    appliesToSku: text(input.appliesToSku, 60).toUpperCase(),
    priority: integer(input.priority, 100, 0, 100_000),
    active: flag(input.active, true),
    message: text(input.message, 500),
  });
}

/* ---------------------------- approval rules ----------------------------- */

export type ApprovalRuleInput = Omit<ApprovalRule, "id" | "ownerId" | "createdAt" | "updatedAt">;

/**
 * The most people one rule may ask.
 *
 * Matches `MAX_APPROVERS` in docker/pb_hooks/lib/approvers.js and the
 * `approvers` relation's `maxSelect`: an approver who cannot be stamped onto
 * the quote cannot see it, so the three numbers have to agree.
 */
export const MAX_APPROVERS = 50;

export function readApprovalRule(raw: unknown): Validated<ApprovalRuleInput> {
  const input = asRecord(raw);

  const name = text(input.name, 200);
  if (!name) return invalid("An approval rule needs a name.");

  // `approverEmail` is the shape this had before a rule could name several
  // people; a stored rule or an exported file from then still reads.
  const rawApprovers = Array.isArray(input.approvers)
    ? input.approvers
    : input.approverEmail !== undefined
      ? [input.approverEmail]
      : [];

  const approvers = [...new Set(rawApprovers.map(email).filter(Boolean))].slice(0, MAX_APPROVERS);
  if (!approvers.length) {
    return invalid(`"${name}" needs at least one approver — a rule nobody can answer blocks a quote forever.`);
  }

  const bad = approvers.find(address => !address.includes("@"));
  if (bad) return invalid(`"${bad}" is not an email address.`);

  // A quorum larger than the room could never be met. Clamped rather than
  // refused: removing an approver from a rule that wanted all of them is a
  // reasonable edit, and it should not become an error message.
  const approvalsRequired = integer(input.approvalsRequired, 1, 1, approvers.length);
  const rejectionsRequired = integer(input.rejectionsRequired, 1, 1, approvers.length);

  const scope = oneOf(input.scope, ["line", "quote"] as const, "quote");
  const metric = oneOf(input.metric, APPROVAL_METRICS, "discountPercent");

  const condition = text(input.condition, 2_000);
  if (metric === "custom") {
    if (!condition) return invalid(`"${name}" is a custom rule, so it needs a condition.`);
    // The approval engine's variables are a superset of the pricing ones, so
    // validating against the wider set is what matches what it will see.
    const available =
      scope === "line"
        ? [...lineVariableNames(), "marginPercent", "margin", "costTotal", "floorDiscountPercent", "effectiveDiscountPercent"]
        : [...quoteVariableNames(), "margin", "netTotal", "grandTotal", "monthlyRecurringTotal", "annualRecurringTotal"];
    const error = checkFormula(condition, available, `"${name}" condition`);
    if (error) return invalid(error);
  }

  return valid({
    name,
    scope,
    metric,
    comparator: oneOf(input.comparator, COMPARATORS, ">"),
    threshold: number(input.threshold, 0),
    condition,
    level: integer(input.level, 1, 1, 20),
    approvers,
    approvalsRequired,
    rejectionsRequired,
    message: text(input.message, 500),
    active: flag(input.active, true),
  });
}

/* -------------------------------- accounts ------------------------------- */

function readAddress(raw: unknown): Address {
  const input = asRecord(raw);
  return {
    line1: text(input.line1, 200),
    line2: text(input.line2, 200),
    city: text(input.city, 120),
    state: text(input.state, 120),
    postalCode: text(input.postalCode, 40),
    country: text(input.country, 120),
  };
}

/** More people than this at one customer is a directory, not a contact list. */
export const MAX_CONTACTS = 25;

/** More tags than this stop being segmentation and start being prose. */
export const MAX_TAGS = 12;

function readContact(raw: unknown, index: number): AccountContact {
  const input = asRecord(raw);
  return {
    id: text(input.id, 60) || localId("con"),
    name: text(input.name, 200) || `Contact ${index + 1}`,
    title: text(input.title, 120),
    email: email(input.email),
    phone: text(input.phone, 60),
    role: oneOf(input.role, CONTACT_ROLES, "commercial"),
    primary: flag(input.primary, false),
  };
}

/**
 * The contact list, with exactly one primary.
 *
 * Two things are repaired here rather than refused. An account written before
 * contacts existed — an old export, an API caller working from last year's
 * docs — arrives with `contactName`/`contactEmail`/`contactPhone` and no
 * list, and becomes a one-contact account. And a list with no primary, or
 * several, is settled in favour of the first: the alternative is an account
 * that cannot be saved because of a radio button nobody noticed.
 */
function readContacts(input: Record<string, unknown>): Validated<AccountContact[]> {
  const raw = Array.isArray(input.contacts) ? input.contacts : null;

  const contacts = raw
    ? raw.slice(0, MAX_CONTACTS).map(readContact)
    : // The legacy shape. A blank one is dropped, so an account that never
      // named anybody comes out with no contacts rather than one empty row.
      [{ name: input.contactName, email: input.contactEmail, phone: input.contactPhone, primary: true }]
        .filter(entry => text(entry.name, 200) || email(entry.email) || text(entry.phone, 60))
        .map(readContact);

  for (const contact of contacts) {
    if (contact.email && !contact.email.includes("@")) {
      return invalid(`"${contact.email}" is not an email address.`);
    }
  }

  const primary = contacts.find(contact => contact.primary) ?? contacts[0];
  for (const contact of contacts) contact.primary = contact === primary;

  return valid(contacts);
}

/**
 * Payment terms as a number of days.
 *
 * Taken from `paymentTermDays` when it is given, and otherwise read out of
 * the terms text: an account written before receivables existed says "Net 30"
 * and nothing else, and defaulting all of those to 30 would quietly re-term
 * every Net 45 customer in the workspace. A text naming no number falls back
 * to the default, which is the only thing left to do with "On receipt".
 */
export const DEFAULT_PAYMENT_TERM_DAYS = 30;

/** Two years of credit is not terms, it is a data entry slip. */
const MAX_PAYMENT_TERM_DAYS = 730;

export function readPaymentTermDays(raw: unknown, terms: string): number {
  if (raw !== undefined && raw !== null && raw !== "") {
    return integer(raw, DEFAULT_PAYMENT_TERM_DAYS, 0, MAX_PAYMENT_TERM_DAYS);
  }
  const named = /(\d{1,3})/.exec(terms);
  return named ? integer(named[1], DEFAULT_PAYMENT_TERM_DAYS, 0, MAX_PAYMENT_TERM_DAYS) : DEFAULT_PAYMENT_TERM_DAYS;
}

/** Lowercased, de-duplicated, and short enough to read as a chip. */
function readTags(raw: unknown): string[] {
  const seen = new Set<string>();
  for (const entry of stringList(raw, 40)) {
    const tag = entry.toLowerCase();
    if (tag) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen].sort();
}

export type AccountInput = Omit<Account, "id" | "ownerId" | "createdAt" | "updatedAt">;

export function readAccount(raw: unknown): Validated<AccountInput> {
  const input = asRecord(raw);

  const name = text(input.name, 200);
  if (!name) return invalid("An account needs a name.");

  const paymentTerms = text(input.paymentTerms, 120);
  const contacts = readContacts(input);
  if (!contacts.ok) return contacts;

  const billingAddress = input.billingAddress ? readAddress(input.billingAddress) : { ...EMPTY_ADDRESS };
  // Defaults to true, so an account that names one address is not quietly
  // recorded as shipping to nowhere.
  const shippingSameAsBilling = flag(input.shippingSameAsBilling, true);

  return valid({
    name,
    industry: text(input.industry, 120),
    website: text(input.website, 300),
    status: oneOf(input.status, ACCOUNT_STATUSES, "prospect"),
    tags: readTags(input.tags),
    contacts: contacts.value,
    billingAddress,
    // Resolved here rather than at every read: downstream never has to check
    // the flag before using the address.
    shippingAddress: shippingSameAsBilling
      ? { ...billingAddress }
      : input.shippingAddress
        ? readAddress(input.shippingAddress)
        : { ...EMPTY_ADDRESS },
    shippingSameAsBilling,
    currency: asCurrency(input.currency),
    priceBookId: text(input.priceBookId, 40),
    paymentTerms,
    paymentTermDays: readPaymentTermDays(input.paymentTermDays, paymentTerms),
    creditLimit: atLeastZero(number(input.creditLimit, 0)),
    defaultDiscountPercent: percent(input.defaultDiscountPercent),
    taxExempt: flag(input.taxExempt, false),
    taxPercent: percent(input.taxPercent),
    notes: text(input.notes, 5_000),
  });
}

/* --------------------------- proposal templates -------------------------- */

export type ProposalTemplateInput = Omit<ProposalTemplate, "id" | "ownerId" | "sharedWith" | "createdAt" | "updatedAt">;

export function readProposalTemplate(raw: unknown): Validated<ProposalTemplateInput> {
  const input = asRecord(raw);

  const name = text(input.name, MAX_TEMPLATE_NAME_LENGTH);
  if (!name) return invalid("A proposal template needs a name.");

  const format = oneOf(input.format, PROPOSAL_FORMATS, "html") as ProposalFormat;
  // A template stored before invoices existed has no kind, and is a quote's —
  // which is also why "quote" is the fallback rather than an error.
  const kind = oneOf(input.kind, TEMPLATE_KINDS, "quote") as TemplateKind;

  const body = String(input.body ?? "");
  const limit = format === "pdf" ? MAX_PDF_TEMPLATE_BODY_LENGTH : MAX_TEMPLATE_BODY_LENGTH;
  if (body.length > limit) {
    return invalid(`A template body must be ${limit.toLocaleString()} characters or fewer.`);
  }

  // A PDF template's body is a document description rather than prose, so it
  // is parsed and normalised here. Storing it back as the canonical JSON means
  // the renderer never has to guess at a half-formed block, and a template
  // written by hand against the API gets the same defaults the editor uses.
  if (format === "pdf") {
    // Read against *this* template's kind: a column or a totals row naming a
    // field the other kind has is dropped here, so a template switched from
    // quote to invoice comes back with a table it can actually fill.
    const parsed = readPdfTemplate(body, kind);
    if (!parsed.ok) return parsed;
    return valid({ name, kind, format, body: JSON.stringify(parsed.value) });
  }

  return valid({ name, kind, format, body });
}

/* --------------------------- PDF template bodies ------------------------- */

const color = (value: unknown, fallback: string): string => {
  const raw = text(value, 32);
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw) ? (raw.startsWith("#") ? raw : `#${raw}`) : fallback;
};

/** An optional colour: absent stays absent, so "no fill" is expressible. */
const optionalColor = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = text(value, 32);
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw) ? (raw.startsWith("#") ? raw : `#${raw}`) : undefined;
};

const align = (value: unknown): "left" | "center" | "right" | undefined =>
  value === "center" || value === "right" || value === "left" ? value : undefined;

/**
 * A picture on a template, as a `data:` URL.
 *
 * Anything a PDF reader could not be handed is dropped to an empty string
 * rather than refused — a template is a document being worked on, and losing
 * the whole of it because one logo is a progressive JPEG would be the wrong
 * trade. `renderPdf` reports what it could not draw, and the editor refuses
 * the file at the point it is chosen, which is where the message is useful.
 */
const imageSource = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) return "";
  return isEmbeddableImage(value.trim()) ? value.trim() : "";
};

function readLineColumns(raw: unknown, kind: TemplateKind): LineItemColumn[] {
  const fields = new Set<string>(lineItemFields(kind).map(entry => entry.field));
  const columns = (Array.isArray(raw) ? raw : [])
    .map((entry): LineItemColumn | null => {
      const column = asRecord(entry);
      const field = String(column.field ?? "");
      if (!fields.has(field)) return null;
      return {
        field: field as LineItemColumn["field"],
        header: text(column.header, 60),
        width: bounded(column.width, 1, 0.1, 100),
        ...(align(column.align) ? { align: align(column.align) } : {}),
      };
    })
    .filter((column): column is LineItemColumn => column !== null);

  // A line-item block with no usable column would render an empty table, which
  // is a worse outcome than this kind's default columns.
  return columns.length ? columns : defaultLineColumns(kind);
}

function readTotalsRows(raw: unknown, kind: TemplateKind): TotalsRow[] {
  const fields = new Set<string>(totalsFields(kind).map(entry => entry.field));
  const rows = (Array.isArray(raw) ? raw : [])
    .map((entry): TotalsRow | null => {
      const row = asRecord(entry);
      const field = String(row.field ?? "");
      // Silently dropping an unknown field is what keeps `cost` and `margin`
      // out of a customer-facing document even if a hand-written body asks
      // for them — see the note atop src/lib/pdfTemplate.ts.
      if (!fields.has(field)) return null;
      return {
        label: text(row.label, 60),
        field: field as TotalsRow["field"],
        ...(row.emphasis === true ? { emphasis: true } : {}),
        ...(row.omitIfZero === true ? { omitIfZero: true } : {}),
      };
    })
    .filter((row): row is TotalsRow => row !== null);

  return rows.length ? rows : defaultTotalsRows(kind);
}

/**
 * The house style, clamped into what a document can actually be set in.
 *
 * Read against the template's own body size, because the default heading scale
 * is derived from it — see `defaultStyle`. Every bound here is a legibility
 * bound rather than a taste one: leading below 1 overlaps its own descenders,
 * a heading smaller than the body is not a heading, and a cell with no padding
 * puts a number against a grid line.
 */
function readStyle(raw: unknown, fontSize: number): PdfStyle {
  const input = asRecord(raw);
  const table = asRecord(input.table);
  const fallback = defaultStyle(fontSize);
  // Absent rather than defaulted: no heading face means "follow the body",
  // which is not the same as naming the body's face and would stop following
  // it the moment somebody changed the body.
  const headingFamily = FONT_FAMILIES.includes(input.headingFamily as FontFamily)
    ? (input.headingFamily as FontFamily)
    : undefined;

  return {
    lineHeight: bounded(input.lineHeight, fallback.lineHeight, 1, 3),
    paragraphSpacing: bounded(input.paragraphSpacing, fallback.paragraphSpacing, 0, 48),
    headingScale: bounded(input.headingScale, fallback.headingScale, 1, 4),
    ...(headingFamily ? { headingFamily } : {}),
    ...(input.headingUppercase === true ? { headingUppercase: true } : {}),
    ruleColor: color(input.ruleColor, fallback.ruleColor),
    table: {
      ...(optionalColor(table.headerFill) ? { headerFill: optionalColor(table.headerFill) } : {}),
      ...(optionalColor(table.headerColor) ? { headerColor: optionalColor(table.headerColor) } : {}),
      ...(table.headerUppercase === true ? { headerUppercase: true } : {}),
      ...(optionalColor(table.zebra) ? { zebra: optionalColor(table.zebra) } : {}),
      gridColor: color(table.gridColor, fallback.table.gridColor),
      rowLines: table.rowLines !== false,
      cellPadding: bounded(table.cellPadding, fallback.table.cellPadding, 1, 24),
    },
  };
}

/**
 * The stamp across the page.
 *
 * No text is no watermark, and the key is left out entirely rather than stored
 * as an empty one — the same rule the letterhead follows, and for the same
 * reason: a template that has never had one should not carry one around.
 */
function readWatermark(raw: unknown): PdfWatermark | undefined {
  const input = asRecord(raw);
  const body = text(input.text, 60);
  if (!body) return undefined;

  return {
    text: body,
    ...(input.uppercase === true ? { uppercase: true } : {}),
    ...(optionalColor(input.color) ? { color: optionalColor(input.color) } : {}),
    ...(input.size !== undefined ? { size: bounded(input.size, 84, 8, 400) } : {}),
    ...(input.opacity !== undefined ? { opacity: bounded(input.opacity, 0.08, 0.01, 1) } : {}),
    ...(input.angle !== undefined ? { angle: bounded(input.angle, 45, -90, 90) } : {}),
  };
}

function readBlock(raw: unknown, kind: TemplateKind): PdfBlock | null {
  const input = asRecord(raw);

  switch (input.type) {
    case "heading":
      return {
        type: "heading",
        text: text(input.text, 2_000),
        ...(input.size !== undefined ? { size: bounded(input.size, 18, 6, 72) } : {}),
        ...(align(input.align) ? { align: align(input.align) } : {}),
        ...(optionalColor(input.color) ? { color: optionalColor(input.color) } : {}),
        ...(input.spaceAfter !== undefined ? { spaceAfter: bounded(input.spaceAfter, 4, 0, 200) } : {}),
      };

    case "text":
      return {
        type: "text",
        text: text(input.text, 20_000),
        ...(input.size !== undefined ? { size: bounded(input.size, 10, 5, 48) } : {}),
        ...(align(input.align) ? { align: align(input.align) } : {}),
        ...(optionalColor(input.color) ? { color: optionalColor(input.color) } : {}),
        ...(input.bold === true ? { bold: true } : {}),
        ...(input.italic === true ? { italic: true } : {}),
        ...(input.spaceAfter !== undefined ? { spaceAfter: bounded(input.spaceAfter, 4, 0, 200) } : {}),
      };

    case "image": {
      // An unreadable picture is dropped, not refused: the block keeps its
      // place in the document and the editor says what was wrong with it,
      // which beats a save that fails on a file someone just chose.
      const source = imageSource(input.source);
      return {
        type: "image",
        source,
        width: bounded(input.width, 140, 8, 900),
        ...(align(input.align) ? { align: align(input.align) } : {}),
        ...(text(input.caption, 300) ? { caption: text(input.caption, 300) } : {}),
        ...(input.spaceAfter !== undefined ? { spaceAfter: bounded(input.spaceAfter, 6, 0, 200) } : {}),
      };
    }

    case "spacer":
      return { type: "spacer", height: bounded(input.height, 12, 0, 400) };

    case "divider":
      return {
        type: "divider",
        ...(optionalColor(input.color) ? { color: optionalColor(input.color) } : {}),
        ...(input.thickness !== undefined ? { thickness: bounded(input.thickness, 0.75, 0.1, 8) } : {}),
      };

    case "columns": {
      const columns = (Array.isArray(input.columns) ? input.columns : []).slice(0, 4).map(entry => {
        const column = asRecord(entry);
        return {
          ...(text(column.heading, 120) ? { heading: text(column.heading, 120) } : {}),
          text: text(column.text, 4_000),
          ...(align(column.align) ? { align: align(column.align) } : {}),
        };
      });
      return {
        type: "columns",
        ...(input.gap !== undefined ? { gap: bounded(input.gap, 16, 0, 120) } : {}),
        columns: columns.length ? columns : [{ text: "" }],
      };
    }

    case "fields":
      return {
        type: "fields",
        rows: (Array.isArray(input.rows) ? input.rows : []).slice(0, 40).map(entry => {
          const row = asRecord(entry);
          return { label: text(row.label, 120), value: text(row.value, 500) };
        }),
      };

    case "lineItems":
      return {
        type: "lineItems",
        columns: readLineColumns(input.columns, kind),
        ...(input.showOptions === false ? { showOptions: false } : { showOptions: true }),
        ...(input.showDescription === false ? { showDescription: false } : { showDescription: true }),
        ...(optionalColor(input.headerFill) ? { headerFill: optionalColor(input.headerFill) } : {}),
        ...(optionalColor(input.zebra) ? { zebra: optionalColor(input.zebra) } : {}),
        ...(input.fontSize !== undefined ? { fontSize: bounded(input.fontSize, 9, 5, 24) } : {}),
      };

    case "totals":
      return {
        type: "totals",
        rows: readTotalsRows(input.rows, kind),
        ...(input.width !== undefined ? { width: bounded(input.width, 260, 120, 600) } : {}),
      };

    case "signatures":
      return {
        type: "signatures",
        parties: (Array.isArray(input.parties) ? input.parties : []).slice(0, 4).map(entry => {
          const party = asRecord(entry);
          return {
            label: text(party.label, 120),
            ...(text(party.caption, 120) ? { caption: text(party.caption, 120) } : {}),
          };
        }),
      };

    case "pageBreak":
      return { type: "pageBreak" };

    default:
      // An unrecognised block is dropped rather than refused: a template from
      // a future version should lose the block it cannot draw, not the page.
      return null;
  }
}

/**
 * Reads a PDF template body.
 *
 * Accepts the JSON string the record stores, or an already-parsed object, so
 * the same function serves the API, the file importer and the editor.
 */
export function readPdfTemplate(raw: unknown, kind: TemplateKind = "quote"): Validated<PdfTemplate> {
  let source: unknown = raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // An empty body is a brand-new template, not an error.
    if (!trimmed) return valid(starterPdfTemplate(kind));
    try {
      source = JSON.parse(trimmed);
    } catch {
      return invalid("A PDF template's body must be valid JSON describing the document.");
    }
  }

  if (!isRecord(source)) return invalid("A PDF template must be an object with `page` and `blocks`.");

  const page = asRecord(source.page);
  const margins = asRecord(page.margins);

  const blocks = (Array.isArray(source.blocks) ? source.blocks : [])
    .slice(0, 200)
    .map(block => readBlock(block, kind))
    .filter((block): block is PdfBlock => block !== null);

  if (!blocks.length) return invalid("A PDF template needs at least one block.");

  const footer = asRecord(source.footer);
  const header = asRecord(source.header);
  const fontSize = bounded(page.fontSize, DEFAULT_PAGE.fontSize, 6, 18);
  const watermark = readWatermark(source.watermark);
  // Held in a local rather than tested and used inline the way the cheap
  // readers above are: checking a logo means decoding it, and a letterhead can
  // be a few hundred kilobytes.
  const logo = imageSource(header.logo);
  const letterhead: PdfHeader = {
    ...(logo ? { logo } : {}),
    ...(header.logoWidth !== undefined ? { logoWidth: bounded(header.logoWidth, 110, 8, 400) } : {}),
    ...(header.logoAlign === "right" ? { logoAlign: "right" as const } : {}),
    ...(text(header.text, 500) ? { text: text(header.text, 500) } : {}),
    ...(optionalColor(header.color) ? { color: optionalColor(header.color) } : {}),
    ...(header.rule === true ? { rule: true } : {}),
    ...(header.firstPageOnly === true ? { firstPageOnly: true } : {}),
  };

  return valid({
    // A letterhead with nothing in it is no letterhead: the key is left out
    // so a template that has never had one does not carry an empty object
    // around for the rest of its life.
    ...(Object.keys(letterhead).length ? { header: letterhead } : {}),
    page: {
      size: oneOf(page.size, PAGE_SIZES, DEFAULT_PAGE.size),
      margins: {
        top: bounded(margins.top, DEFAULT_MARGINS.top, 12, 200),
        right: bounded(margins.right, DEFAULT_MARGINS.right, 12, 200),
        bottom: bounded(margins.bottom, DEFAULT_MARGINS.bottom, 12, 200),
        left: bounded(margins.left, DEFAULT_MARGINS.left, 12, 200),
      },
      family: oneOf(page.family, FONT_FAMILIES, DEFAULT_PAGE.family),
      fontSize,
      textColor: color(page.textColor, DEFAULT_PAGE.textColor),
      mutedColor: color(page.mutedColor, DEFAULT_PAGE.mutedColor),
      accentColor: color(page.accentColor, DEFAULT_PAGE.accentColor),
    },
    // Always stored, unlike the letterhead: a style is not an optional feature
    // of a document, it is how the document is set, and writing it down is
    // what stops the defaults shifting under a template that already exists.
    style: readStyle(source.style, fontSize),
    ...(watermark ? { watermark } : {}),
    blocks,
    footer: {
      text: text(footer.text, 300),
      showPageNumbers: footer.showPageNumbers !== false,
    },
  });
}

/* ------------------------------ quote lines ------------------------------ */

export function readQuoteLine(raw: unknown, index: number): Validated<QuoteLineInput> {
  const input = asRecord(raw);

  const productId = text(input.productId, 40);
  if (!productId) return invalid(`Line ${index + 1} has no product.`);

  const override = input.unitPriceOverride;
  return valid({
    id: text(input.id, 60) || localId("ln"),
    productId,
    quantity: bounded(input.quantity, 1, 0, 1_000_000_000),
    discountPercent: percent(input.discountPercent),
    unitPriceOverride:
      override === null || override === undefined || override === "" ? null : atLeastZero(number(override, 0)),
    selectedOptions: stringList(input.selectedOptions, 60),
    termMonths: integer(input.termMonths, 0, 0, 600),
    description: text(input.description, 2_000),
    parentId: text(input.parentId, 60) || null,
    sortOrder: number(input.sortOrder, index),
  });
}

export function readQuoteLines(raw: unknown): Validated<QuoteLineInput[]> {
  if (raw === undefined || raw === null) return valid([]);
  if (!Array.isArray(raw)) return invalid('"lines" must be an array.');

  const lines: QuoteLineInput[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const parsed = readQuoteLine(entry, index);
    if (!parsed.ok) return parsed;
    // Two lines sharing an id would make "edit line X" ambiguous, and a
    // component's parentId meaningless.
    if (ids.has(parsed.value.id)) parsed.value.id = localId("ln");
    ids.add(parsed.value.id);
    lines.push(parsed.value);
  }

  // A component whose parent is gone becomes an ordinary line rather than an
  // orphan nothing can reach.
  for (const line of lines) {
    if (line.parentId && !ids.has(line.parentId)) line.parentId = null;
  }

  return valid(lines);
}

/* -------------------------------- quotes --------------------------------- */

export type QuoteHeaderInput = {
  name: string;
  accountId: string | null;
  priceBookId: string;
  currency: ReturnType<typeof asCurrency>;
  termMonths: number;
  discountPercent: number;
  taxPercent: number;
  shipping: number;
  validUntil: string;
  notes: string;
  internalNotes: string;
};

export function readQuoteHeader(raw: unknown): Validated<QuoteHeaderInput> {
  const input = asRecord(raw);

  const name = text(input.name, 200);
  if (!name) return invalid("A quote needs a name.");

  if (input.currency !== undefined && !isCurrency(input.currency)) {
    return invalid(`"${String(input.currency)}" is not a currency this app can price in (${CURRENCIES.join(", ")}).`);
  }

  return valid({
    name,
    accountId: text(input.accountId, 40) || null,
    priceBookId: text(input.priceBookId, 40),
    currency: asCurrency(input.currency),
    // 0 is legal and means "one-time charges only".
    termMonths: integer(input.termMonths, 12, 0, 600),
    discountPercent: percent(input.discountPercent),
    taxPercent: percent(input.taxPercent),
    shipping: atLeastZero(number(input.shipping, 0)),
    validUntil: isoDate(input.validUntil),
    notes: text(input.notes, 10_000),
    internalNotes: text(input.internalNotes, 10_000),
  });
}

/* ------------------------------ receivables ------------------------------ */

/** An invoice with more lines than this is a data feed, not a document. */
export const MAX_INVOICE_LINES = 500;

/** Enough ledger entries for a payment plan; past it, something is looping. */
export const MAX_LEDGER_ENTRIES = 200;

/**
 * The header of an invoice: everything the caller sets and nothing derived.
 *
 * The totals are conspicuously absent, exactly as they are for a quote. The
 * server works out what an invoice comes to from its lines and its ledger and
 * overwrites whatever arrived, so a client that posts its own balance is
 * posting into the void.
 */
export type InvoiceHeaderInput = {
  accountId: string | null;
  quoteId: string | null;
  currency: ReturnType<typeof asCurrency>;
  issueDate: string;
  paymentTermDays: number;
  poNumber: string;
  notes: string;
  internalNotes: string;
};

export function readInvoiceHeader(raw: unknown): Validated<InvoiceHeaderInput> {
  const input = asRecord(raw);

  if (input.currency !== undefined && !isCurrency(input.currency)) {
    return invalid(`"${String(input.currency)}" is not a currency this app can invoice in (${CURRENCIES.join(", ")}).`);
  }

  return valid({
    accountId: text(input.accountId, 40) || null,
    quoteId: text(input.quoteId, 40) || null,
    currency: asCurrency(input.currency),
    // Empty is legal and means "not issued yet"; the server dates it on issue.
    issueDate: isoDate(input.issueDate),
    paymentTermDays: readPaymentTermDays(input.paymentTermDays, text(input.paymentTerms, 120)),
    poNumber: text(input.poNumber, 80),
    notes: text(input.notes, 10_000),
    internalNotes: text(input.internalNotes, 10_000),
  });
}

function readInvoiceLine(raw: unknown, index: number): InvoiceLine {
  const input = asRecord(raw);
  return {
    id: text(input.id, 60) || localId("inl"),
    sourceLineId: text(input.sourceLineId, 60) || null,
    sku: text(input.sku, 60),
    description: text(input.description, 2_000) || `Line ${index + 1}`,
    // A negative quantity is how a credit gets smuggled onto an invoice; the
    // credit ledger is where that belongs, so it is clamped rather than kept.
    quantity: bounded(number(input.quantity, 1), 1, 0, 1_000_000),
    // A negative unit price, though, is legitimate: a discount line.
    unitPrice: number(input.unitPrice, 0),
    // Both recomputed by the server. Present so the type is whole.
    amount: 0,
    taxPercent: percent(input.taxPercent),
    taxAmount: 0,
  };
}

export function readInvoiceLines(raw: unknown): Validated<InvoiceLine[]> {
  if (raw === undefined || raw === null) return valid([]);
  if (!Array.isArray(raw)) return invalid("An invoice's lines must be a list.");
  if (raw.length > MAX_INVOICE_LINES) {
    return invalid(`An invoice may have at most ${MAX_INVOICE_LINES} lines.`);
  }

  const lines = raw.map(readInvoiceLine);

  // Ids have to be distinct: the editor keys rows on them, and a duplicate
  // makes two rows edit as one.
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.id)) line.id = localId("inl");
    seen.add(line.id);
  }

  return valid(lines);
}

/**
 * A payment as a caller may describe it. The invoice it belongs to comes from
 * the URL, not the body — a payment cannot be filed against a different
 * invoice than the one being posted to.
 */
export type PaymentInput = Omit<InvoicePayment, "id" | "invoiceId" | "ownerId" | "createdAt" | "updatedAt">;

export function readPayment(raw: unknown): Validated<PaymentInput> {
  const input = asRecord(raw);

  const amount = number(input.amount, 0);
  // Zero is the one amount that means nothing happened, and a negative
  // payment is a refund — a different event, with its own paperwork.
  if (!(amount > 0)) return invalid("A payment has to be an amount greater than zero.");

  return valid({
    receivedOn: isoDate(input.receivedOn) || new Date().toISOString().slice(0, 10),
    amount,
    method: oneOf(input.method, PAYMENT_METHODS, "bank_transfer"),
    reference: text(input.reference, 120),
    note: text(input.note, 1_000),
  });
}

export type CreditInput = Omit<InvoiceCredit, "id" | "invoiceId" | "ownerId" | "createdAt" | "updatedAt">;

export function readCredit(raw: unknown): Validated<CreditInput> {
  const input = asRecord(raw);

  const amount = number(input.amount, 0);
  if (!(amount > 0)) return invalid("A credit has to be an amount greater than zero.");

  return valid({
    issuedOn: isoDate(input.issuedOn) || new Date().toISOString().slice(0, 10),
    amount,
    reason: oneOf(input.reason, CREDIT_REASONS, "adjustment"),
    note: text(input.note, 1_000),
  });
}
