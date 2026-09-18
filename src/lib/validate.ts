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
import { asCurrency, atLeastZero, clampPercent, isCurrency } from "./money";
import { lineVariableNames, quoteVariableNames } from "./pricing";
import { MAX_TEMPLATE_BODY_LENGTH, MAX_TEMPLATE_NAME_LENGTH } from "./proposal";
import { DEFAULT_MARGINS, PAGE_SIZES } from "./pdf";
import { FONT_FAMILIES } from "./pdfFonts";
import {
  DEFAULT_LINE_COLUMNS,
  DEFAULT_PAGE,
  DEFAULT_TOTALS_ROWS,
  LINE_ITEM_FIELDS,
  TOTALS_FIELDS,
  starterPdfTemplate,
  type LineItemColumn,
  type PdfBlock,
  type PdfTemplate,
  type TotalsRow,
} from "./pdfTemplate";
import {
  APPROVAL_METRICS,
  BILLING_PERIODS,
  CHARGE_TYPES,
  COMPARATORS,
  CURRENCIES,
  EMPTY_ADDRESS,
  PRICING_RULE_TARGETS,
  PRODUCT_RULE_KINDS,
  PROPOSAL_FORMATS,
  TIER_KINDS,
  type Account,
  type Address,
  type ApprovalRule,
  type BillingPeriod,
  type BundleComponent,
  type ChargeType,
  type OptionGroup,
  type PriceBook,
  type PriceBookEntry,
  type PricingRule,
  type Product,
  type ProductOption,
  type ProductRule,
  type ProposalFormat,
  type ProposalTemplate,
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
  return {
    id: text(input.id, 60) || localId("opt"),
    key: slug(input.key ?? name, `option_${index + 1}`),
    name,
    description: text(input.description, 500),
    priceDelta: number(input.priceDelta, 0),
    // A factor of 0 would make the option free rather than neutral, which is
    // never what someone meant to type.
    priceFactor: number(input.priceFactor, 1) > 0 ? number(input.priceFactor, 1) : 1,
    default: flag(input.default, false),
  };
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
  // an option by key alone, so two groups sharing one would be ambiguous.
  const optionKeys = new Set<string>();
  for (const group of optionGroups) {
    for (const option of group.options) {
      let key = option.key;
      for (let suffix = 2; optionKeys.has(key); suffix++) key = `${option.key}_${suffix}`;
      option.key = key;
      optionKeys.add(key);
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

export type AccountInput = Omit<Account, "id" | "ownerId" | "createdAt" | "updatedAt">;

export function readAccount(raw: unknown): Validated<AccountInput> {
  const input = asRecord(raw);

  const name = text(input.name, 200);
  if (!name) return invalid("An account needs a name.");

  const contactEmail = email(input.contactEmail);
  if (contactEmail && !contactEmail.includes("@")) return invalid(`"${contactEmail}" is not an email address.`);

  return valid({
    name,
    industry: text(input.industry, 120),
    website: text(input.website, 300),
    contactName: text(input.contactName, 200),
    contactEmail,
    contactPhone: text(input.contactPhone, 60),
    billingAddress: input.billingAddress ? readAddress(input.billingAddress) : { ...EMPTY_ADDRESS },
    currency: asCurrency(input.currency),
    priceBookId: text(input.priceBookId, 40),
    paymentTerms: text(input.paymentTerms, 120),
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

  const body = String(input.body ?? "");
  if (body.length > MAX_TEMPLATE_BODY_LENGTH) {
    return invalid(`A template body must be ${MAX_TEMPLATE_BODY_LENGTH.toLocaleString()} characters or fewer.`);
  }

  // A PDF template's body is a document description rather than prose, so it
  // is parsed and normalised here. Storing it back as the canonical JSON means
  // the renderer never has to guess at a half-formed block, and a template
  // written by hand against the API gets the same defaults the editor uses.
  if (format === "pdf") {
    const parsed = readPdfTemplate(body);
    if (!parsed.ok) return parsed;
    return valid({ name, format, body: JSON.stringify(parsed.value) });
  }

  return valid({ name, format, body });
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

function readLineColumns(raw: unknown): LineItemColumn[] {
  const fields = new Set(LINE_ITEM_FIELDS.map(entry => entry.field));
  const columns = (Array.isArray(raw) ? raw : [])
    .map((entry): LineItemColumn | null => {
      const column = asRecord(entry);
      const field = String(column.field ?? "");
      if (!fields.has(field as LineItemColumn["field"])) return null;
      return {
        field: field as LineItemColumn["field"],
        header: text(column.header, 60),
        width: bounded(column.width, 1, 0.1, 100),
        ...(align(column.align) ? { align: align(column.align) } : {}),
      };
    })
    .filter((column): column is LineItemColumn => column !== null);

  // A line-item block with no usable column would render an empty table, which
  // is a worse outcome than the default five.
  return columns.length ? columns : structuredClone(DEFAULT_LINE_COLUMNS);
}

function readTotalsRows(raw: unknown): TotalsRow[] {
  const fields = new Set(TOTALS_FIELDS.map(entry => entry.field));
  const rows = (Array.isArray(raw) ? raw : [])
    .map((entry): TotalsRow | null => {
      const row = asRecord(entry);
      const field = String(row.field ?? "");
      // Silently dropping an unknown field is what keeps `cost` and `margin`
      // out of a customer-facing document even if a hand-written body asks
      // for them — see the note atop src/lib/pdfTemplate.ts.
      if (!fields.has(field as TotalsRow["field"])) return null;
      return {
        label: text(row.label, 60),
        field: field as TotalsRow["field"],
        ...(row.emphasis === true ? { emphasis: true } : {}),
        ...(row.omitIfZero === true ? { omitIfZero: true } : {}),
      };
    })
    .filter((row): row is TotalsRow => row !== null);

  return rows.length ? rows : structuredClone(DEFAULT_TOTALS_ROWS);
}

function readBlock(raw: unknown): PdfBlock | null {
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
        columns: readLineColumns(input.columns),
        ...(input.showOptions === false ? { showOptions: false } : { showOptions: true }),
        ...(input.showDescription === false ? { showDescription: false } : { showDescription: true }),
        ...(optionalColor(input.headerFill) ? { headerFill: optionalColor(input.headerFill) } : {}),
        ...(optionalColor(input.zebra) ? { zebra: optionalColor(input.zebra) } : {}),
        ...(input.fontSize !== undefined ? { fontSize: bounded(input.fontSize, 9, 5, 24) } : {}),
      };

    case "totals":
      return {
        type: "totals",
        rows: readTotalsRows(input.rows),
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
export function readPdfTemplate(raw: unknown): Validated<PdfTemplate> {
  let source: unknown = raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // An empty body is a brand-new template, not an error.
    if (!trimmed) return valid(starterPdfTemplate());
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
    .map(readBlock)
    .filter((block): block is PdfBlock => block !== null);

  if (!blocks.length) return invalid("A PDF template needs at least one block.");

  const footer = asRecord(source.footer);

  return valid({
    page: {
      size: oneOf(page.size, PAGE_SIZES, DEFAULT_PAGE.size),
      margins: {
        top: bounded(margins.top, DEFAULT_MARGINS.top, 12, 200),
        right: bounded(margins.right, DEFAULT_MARGINS.right, 12, 200),
        bottom: bounded(margins.bottom, DEFAULT_MARGINS.bottom, 12, 200),
        left: bounded(margins.left, DEFAULT_MARGINS.left, 12, 200),
      },
      family: oneOf(page.family, FONT_FAMILIES, DEFAULT_PAGE.family),
      fontSize: bounded(page.fontSize, DEFAULT_PAGE.fontSize, 6, 18),
      textColor: color(page.textColor, DEFAULT_PAGE.textColor),
      mutedColor: color(page.mutedColor, DEFAULT_PAGE.mutedColor),
      accentColor: color(page.accentColor, DEFAULT_PAGE.accentColor),
    },
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
