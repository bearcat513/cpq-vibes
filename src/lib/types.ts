/**
 * The CPQ domain, shared by the server and the React UI.
 *
 * Five things are modelled here, and the order below is the order a quote
 * actually flows through them:
 *
 *   product   — what is sold: a price, a cost, options, rules, tiers
 *   price book— what it costs this customer: per-product overrides in one currency
 *   line      — one product on one quote: quantity, options, discount, term
 *   rule      — pricing and approval policy, expressed as formulas
 *   quote     — the document: lines, totals, approvals, status, a customer
 *
 * Two conventions run through the whole file.
 *
 * **Money is a plain number in the quote's currency.** Not minor units, not a
 * decimal library: every amount is rounded to the currency's precision at each
 * step by `src/lib/money.ts`, which is what keeps a total equal to the sum of
 * the lines a reader can see. See that file for why.
 *
 * **A quote snapshots what it was priced from.** A line carries the product's
 * name, SKU and list price as they were when it was priced, and the quote
 * carries the customer's details the same way. A quote sent last quarter still
 * renders correctly after the catalogue moves on, and a quote shared with a
 * colleague who cannot read your accounts still renders at all.
 */

/* ------------------------------- currency -------------------------------- */

/**
 * The currencies a price book may be denominated in. A closed list rather than
 * free text: the minor-unit count in `src/lib/money.ts` has to exist for every
 * one of them, and a quote whose currency nothing can round is worse than a
 * quote that could not be created.
 */
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "SEK", "INR", "BRL"] as const;

export type CurrencyCode = (typeof CURRENCIES)[number];

export const CURRENCY_SET: ReadonlySet<string> = new Set(CURRENCIES);

/* -------------------------------- product -------------------------------- */

/**
 * How a product is billed, which is what decides where its money lands in the
 * totals: one-time revenue, recurring revenue, or usage (quoted at an
 * estimated volume and billed in arrears).
 */
export type ChargeType = "one-time" | "recurring" | "usage";

export const CHARGE_TYPES: ChargeType[] = ["one-time", "recurring", "usage"];

/** How often a recurring charge is billed. Ignored for one-time products. */
export type BillingPeriod = "monthly" | "quarterly" | "annual";

export const BILLING_PERIODS: BillingPeriod[] = ["monthly", "quarterly", "annual"];

/** Months in one billing period — the divisor behind every MRR figure. */
export const BILLING_PERIOD_MONTHS: Record<BillingPeriod, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/**
 * One choice inside an option group.
 *
 * An option changes the line's unit price in one of two ways, and a group may
 * mix them: `priceDelta` adds a fixed amount (an add-on module at $12/user),
 * `priceFactor` multiplies (a "Premium" tier at 1.4× the base). Both apply
 * when both are set — the factor first, then the delta, so a percentage uplift
 * never silently scales a flat add-on.
 */
export type ProductOption = {
  id: string;
  /** Referenced by configuration rules and validation formulas as `option.<key>`. */
  key: string;
  name: string;
  description?: string;
  /** Added to the unit price when selected. May be negative. */
  priceDelta: number;
  /** Multiplies the unit price when selected. 1 (or absent) means no change. */
  priceFactor?: number;
  /**
   * Added to the unit cost when selected. Absent is zero, which is what every
   * option cost before this field existed.
   *
   * An option that adds price usually adds cost — a premium tier is more
   * machine, an on-site engineer is a person — and a margin that ignores that
   * is wrong by exactly the amount the configuration changed. Never shown to
   * a buyer, like every other cost here.
   */
  costDelta?: number;
  /**
   * A formula that decides whether this option is offered at all. Absent, or
   * empty, means always — so nothing written before this field existed can be
   * hidden by it.
   *
   * See `visibleWhen` on the group for what it may reference and what
   * happens to a selection the formula turns off.
   */
  visibleWhen?: string;
  /** Preselected when the line is first configured. */
  default?: boolean;
};

/**
 * A set of options the buyer picks from.
 *
 * `select: "one"` is a radio group, `"many"` a checkbox list. `minSelect` and
 * `maxSelect` bound a `"many"` group; a required `"one"` group means exactly
 * one, which is the common case and needs no bounds.
 */
export type OptionGroup = {
  id: string;
  key: string;
  name: string;
  description?: string;
  select: "one" | "many";
  required: boolean;
  /** "many" groups only. Absent means unbounded. */
  minSelect?: number;
  maxSelect?: number;
  /**
   * A formula that decides whether the group is shown, over `quantity`,
   * `term` / `termMonths`, `selectedCount` and `option.<key>` as 1 or 0 —
   * the same variables a `validate` rule sees. Absent means always shown.
   *
   * This is the difference between a catalogue that can only say *no* and one
   * that can say *not yet*: a rule tells a rep that what they picked is not
   * allowed, while a hidden group means the question was never put to them.
   * A group whose formula is false is not required, its selections are
   * dropped rather than priced, and nothing inside it can trigger a rule —
   * it is, for that line, as though the product did not have it.
   */
  visibleWhen?: string;
  options: ProductOption[];
};

/**
 * A configuration rule, evaluated against the options selected on a line.
 *
 * - `requires`  — if everything in `when` is selected, everything in `then` must be too
 * - `excludes`  — if everything in `when` is selected, nothing in `then` may be
 * - `recommend` — same trigger, but advisory: it warns rather than blocks
 * - `validate`  — an arbitrary formula over the line that must hold
 *
 * `when` and `then` hold option *keys*, which is what makes a rule survive a
 * product being exported and re-imported with fresh ids.
 */
export type ProductRuleKind = "requires" | "excludes" | "recommend" | "validate";

export const PRODUCT_RULE_KINDS: ProductRuleKind[] = ["requires", "excludes", "recommend", "validate"];

export type ProductRule = {
  id: string;
  kind: ProductRuleKind;
  /** Option keys that trigger the rule. Empty means "always", for `validate`. */
  when: string[];
  /** Option keys the rule acts on. Unused by `validate`. */
  then: string[];
  /**
   * `validate` only: a formula that must evaluate to a non-zero (true) number.
   * Variables are `quantity`, `term`, and `option.<key>` as 1 or 0.
   */
  expression?: string;
  /** Shown to the person configuring the line when the rule fires. */
  message: string;
};

/**
 * A product pulled in by a bundle.
 *
 * A bundle prices as its own line plus one child line per component, so the
 * quote shows what the customer is actually getting rather than one opaque
 * number. A `required` component cannot be removed from the bundle.
 */
export type BundleComponent = {
  id: string;
  /** The component product's SKU — stable across export and import, unlike an id. */
  sku: string;
  quantity: number;
  required: boolean;
  /** A discount the bundle grants on this component, 0-100. */
  discountPercent?: number;
};

/**
 * One band of a volume-pricing table.
 *
 * Tiers are matched on the line's quantity and are *not* cumulative: the band
 * a quantity falls into sets the whole line's unit price. That is how
 * published price breaks read ("100-499 seats: $18") and it is what a customer
 * comparing two quotes expects.
 */
export type VolumeTier = {
  /** Inclusive lower bound. */
  minQuantity: number;
  /** Inclusive upper bound; null or absent is "and above". */
  maxQuantity?: number | null;
  /** `percent` and `amount` come off the unit price; `override` replaces it. */
  kind: "percent" | "amount" | "override";
  value: number;
};

export const TIER_KINDS: VolumeTier["kind"][] = ["percent", "amount", "override"];

export type Product = {
  id: string;
  /** The catalogue key. Unique per account, and what bundles and files reference. */
  sku: string;
  name: string;
  description: string;
  /** Free-text grouping — "Platform", "Services". Pricing rules can target it. */
  family: string;
  chargeType: ChargeType;
  /** Recurring products only. */
  billingPeriod: BillingPeriod;
  /** "user", "seat", "GB" — shown on the line, never calculated with. */
  unitOfMeasure: string;
  /** The catalogue price, in `currency`. A price book overrides it per customer. */
  listPrice: number;
  /** What it costs to deliver one unit. Drives margin, and is never shown to a buyer. */
  cost: number;
  currency: CurrencyCode;
  active: boolean;
  minQuantity: number;
  /** 0 means unbounded. */
  maxQuantity: number;
  /**
   * The pack size: a quantity has to be a multiple of it. Absent, 0 and 1 all
   * mean "any number", which is what every product meant before this existed.
   *
   * A minimum and a maximum bound a quantity; this shapes it. Rack units come
   * four to a shelf and licences are sold in blocks of five, and a catalogue
   * that cannot say so leaves the rep to remember it.
   */
  quantityIncrement?: number;
  /**
   * The window the product may be quoted in, as ISO dates. Absent at either
   * end is "open ended", and both absent — the default — is a product that is
   * always available.
   *
   * `active` is a switch somebody flips; this is a date somebody knew in
   * advance. A price rise on the first of the month, a model withdrawn at the
   * end of the quarter: both are knowable now and neither should wait on
   * remembering to flip a switch. Quoting outside the window warns rather
   * than refuses, because the deadline is a commercial one and a quote priced
   * last week must still price today.
   */
  availableFrom?: string;
  availableTo?: string;
  /** The most a rep may discount this line before approval is needed, 0-100. */
  floorDiscountPercent: number;
  optionGroups: OptionGroup[];
  rules: ProductRule[];
  components: BundleComponent[];
  volumeTiers: VolumeTier[];
  /** Arbitrary catalogue metadata, rendered on proposals as a spec table. */
  attributes: Record<string, string>;
  ownerId: string;
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
};

/** True when the product pulls other products onto the quote with it. */
export const isBundle = (product: Pick<Product, "components">) => product.components.length > 0;

/* ------------------------------ price books ------------------------------ */

/**
 * One product's price in one price book.
 *
 * `minPrice` is a hard floor: no discount, tier or pricing rule may take the
 * line's unit price below it. That is the difference between a price book and
 * a discount — a floor is a commitment the business made to itself.
 */
export type PriceBookEntry = {
  /** The product's SKU, not its id: a price book survives a catalogue re-import. */
  sku: string;
  unitPrice: number;
  minPrice?: number | null;
  active?: boolean;
};

export type PriceBook = {
  id: string;
  name: string;
  description: string;
  currency: CurrencyCode;
  /** The book a new quote starts on when the account names none. */
  isDefault: boolean;
  active: boolean;
  /** ISO dates. Empty means no bound. A quote outside the window is warned about. */
  validFrom: string;
  validTo: string;
  entries: PriceBookEntry[];
  ownerId: string;
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
};

/* ----------------------------- pricing rules ----------------------------- */

/**
 * A pricing rule adjusts a line, or the quote as a whole, by formula.
 *
 * This is the escape hatch that stops a CPQ needing a code change for every
 * commercial policy: "20% off Platform above 500 seats", "add 8% uplift on
 * three-year terms", "cap Services at 15% of the software total". The formula
 * language is the one in `src/lib/formula.ts` — arithmetic, comparisons and
 * logic, parsed to an AST and evaluated by hand, so nothing here is `eval`.
 */
export type PricingRuleScope = "line" | "quote";

/**
 * What the rule's expression produces.
 *
 * - `unitPrice`       — replaces the unit price outright
 * - `discountPercent` — replaces the line or quote discount, 0-100
 * - `adjustment`      — an amount added to (or, negative, taken off) the net
 */
export type PricingRuleTarget = "unitPrice" | "discountPercent" | "adjustment";

export const PRICING_RULE_TARGETS: PricingRuleTarget[] = ["unitPrice", "discountPercent", "adjustment"];

export type PricingRule = {
  id: string;
  name: string;
  description: string;
  scope: PricingRuleScope;
  /**
   * A formula that must be non-zero for the rule to fire. Empty means always.
   * Line scope sees the line variables, quote scope the quote variables — both
   * listed by `PRICING_VARIABLES` in src/lib/pricing.ts.
   */
  condition: string;
  target: PricingRuleTarget;
  /** The formula producing the new value, over the same variables. */
  expression: string;
  /** Line scope only: limit the rule to one family, or one SKU. Empty is "any". */
  appliesToFamily: string;
  appliesToSku: string;
  /** Lowest first. Each rule sees the values the previous ones produced. */
  priority: number;
  active: boolean;
  /** Shown on the line it changed, so a surprising price explains itself. */
  message: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

/** What a rule did to one line or quote, kept so the UI can show its work. */
export type AppliedRule = {
  ruleId: string;
  name: string;
  target: PricingRuleTarget;
  from: number;
  to: number;
  message: string;
};

/* ---------------------------- approval rules ----------------------------- */

/**
 * The metric an approval rule watches.
 *
 * `custom` hands the decision to a formula instead, for policies no single
 * number expresses ("services above 20% of software needs the VP").
 */
export type ApprovalMetric =
  | "discountPercent"
  | "marginPercent"
  | "netTotal"
  | "termMonths"
  | "floorBreach"
  | "custom";

export const APPROVAL_METRICS: ApprovalMetric[] = [
  "discountPercent",
  "marginPercent",
  "netTotal",
  "termMonths",
  "floorBreach",
  "custom",
];

/** What each metric watches, for the rule editor and the API index. */
export const APPROVAL_METRIC_LABELS: Record<ApprovalMetric, string> = {
  discountPercent: "Effective discount off list, as a percentage",
  marginPercent: "Margin, as a percentage of what is charged",
  netTotal: "Value after every discount, before tax",
  termMonths: "Subscription length in months",
  floorBreach: "A line discounted past the ceiling its own product allows",
  custom: "A formula you write, over the same variables the pricing rules use",
};

export type Comparator = ">" | ">=" | "<" | "<=" | "==";

export const COMPARATORS: Comparator[] = [">", ">=", "<", "<=", "=="];

export type ApprovalRule = {
  id: string;
  name: string;
  /** `quote` weighs the whole document; `line` fires on any single line. */
  scope: PricingRuleScope;
  metric: ApprovalMetric;
  comparator: Comparator;
  threshold: number;
  /** `custom` only: a formula that triggers the rule when non-zero. */
  condition: string;
  /** Ascending. A quote needs every level at or below the highest it triggers. */
  level: number;
  /**
   * Everyone asked. They see the quote this rule fired on, and nothing else
   * of yours.
   */
  approvers: string[];
  /**
   * How many of them must approve before this rule is satisfied.
   *
   * 1 is "any one of them" — a rota, where whoever is at their desk answers.
   * `approvers.length` is "all of them" — a board, where everyone signs. The
   * numbers in between are the interesting ones: two of your three regional
   * directors, say.
   */
  approvalsRequired: number;
  /**
   * How many must reject before the quote comes back.
   *
   * Separate from `approvalsRequired` on purpose, and usually smaller: a deal
   * that needs two yeses very often needs only one no. Setting both to 1 on a
   * pair of approvers is "first answer wins", which is a real policy.
   */
  rejectionsRequired: number;
  message: string;
  active: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

/** One person's answer on one request. */
export type ApprovalDecision = {
  approverEmail: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  comment: string;
};

/**
 * One approval a quote is waiting on, or has already had.
 *
 * A request is addressed to everyone on its rule at once and keeps every
 * answer it has been given, rather than being a single yes/no. Its own
 * `status` is derived from those answers against the two quorums — see
 * `requestStatus` in src/lib/approvals.ts, which is the only place that
 * decision is made.
 */
export type ApprovalRequest = {
  id: string;
  ruleId: string;
  ruleName: string;
  level: number;
  /** Everyone this request is addressed to. */
  approverEmails: string[];
  approvalsRequired: number;
  rejectionsRequired: number;
  /** Why it triggered, in numbers: "Discount 32.0% > 25%". */
  reason: string;
  status: "pending" | "approved" | "rejected";
  /** The line it fired on, for a line-scoped rule. */
  lineId?: string | null;
  /** Everyone who has answered so far, in the order they answered. */
  decisions: ApprovalDecision[];
  requestedAt: string;
};

/* -------------------------------- accounts ------------------------------- */

export type Address = {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

export const EMPTY_ADDRESS: Address = { line1: "", line2: "", city: "", state: "", postalCode: "", country: "" };

/**
 * What one person at a customer is there for.
 *
 * A deal is rarely one relationship: the person who negotiates is not the one
 * who pays the invoice, and neither is the one who signs. The role is what
 * lets a proposal be addressed to the right one of them without anybody
 * having to remember which line of the notes field said so.
 */
export type ContactRole = "commercial" | "billing" | "technical" | "signatory" | "other";

export const CONTACT_ROLES: ContactRole[] = ["commercial", "billing", "technical", "signatory", "other"];

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  commercial: "Commercial",
  billing: "Billing",
  technical: "Technical",
  signatory: "Signatory",
  other: "Other",
};

/** One person at a customer. */
export type AccountContact = {
  id: string;
  name: string;
  /** Their job title — "VP Operations". Shown, never matched on. */
  title: string;
  email: string;
  phone: string;
  role: ContactRole;
  /**
   * The one a quote is addressed to. Exactly one contact carries it, which
   * `readAccount` enforces rather than trusting: a proposal addressed to two
   * people or to none is a document nobody can send.
   */
  primary: boolean;
};

export const EMPTY_CONTACT: Omit<AccountContact, "id"> = {
  name: "",
  title: "",
  email: "",
  phone: "",
  role: "commercial",
  primary: false,
};

/**
 * Where a customer stands with you.
 *
 * Three states rather than a pipeline: this is a quoting tool, not a CRM, and
 * the only distinction it can honestly make is between somebody you are
 * chasing, somebody who has bought, and somebody you have stopped quoting.
 * `inactive` is the useful one — it keeps a customer's history without
 * keeping them in the list you scroll every morning.
 */
export type AccountStatus = "prospect" | "customer" | "inactive";

export const ACCOUNT_STATUSES: AccountStatus[] = ["prospect", "customer", "inactive"];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  prospect: "Prospect",
  customer: "Customer",
  inactive: "Inactive",
};

export type Account = {
  id: string;
  name: string;
  industry: string;
  website: string;
  status: AccountStatus;
  /** Free segmentation — "enterprise", "emea", "renewal-q3". Lowercased. */
  tags: string[];
  /** Everyone you deal with there. One of them is `primary`. */
  contacts: AccountContact[];
  billingAddress: Address;
  /**
   * Where the goods go, which is not always where the invoice does. Kept
   * equal to the billing address while `shippingSameAsBilling`, so everything
   * downstream can read it without asking which flag is set.
   */
  shippingAddress: Address;
  shippingSameAsBilling: boolean;
  currency: CurrencyCode;
  /** The price book quotes for this customer start on. Empty uses the default book. */
  priceBookId: string;
  /** "Net 30". Copied onto the quote and rendered on the proposal. */
  paymentTerms: string;
  /**
   * The same terms as a number, which is the form anything can calculate
   * with: an invoice's due date is its issue date plus this. Kept beside the
   * text rather than parsed out of it at the point of use, because "Net 30
   * from end of month" is a sentence no due-date function should be reading.
   * `readAccount` seeds it from the text when the text names a number.
   */
  paymentTermDays: number;
  /**
   * The most this customer may owe at once, in their currency. 0 is "no
   * limit set" rather than "no credit": a limit nobody has thought about
   * should not stop a sale, it should just not claim to be a limit.
   */
  creditLimit: number;
  /** A standing discount every quote for this account starts with, 0-100. */
  defaultDiscountPercent: number;
  taxExempt: boolean;
  /** Sales tax / VAT applied to this customer's quotes, 0-100. */
  taxPercent: number;
  notes: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The contact a quote is addressed to.
 *
 * The flagged one, falling back to the first — an account read from a record
 * written before contacts existed, or one whose primary was just deleted in
 * the editor, still has somebody to address.
 */
export const primaryContact = (account: Pick<Account, "contacts">): AccountContact | null =>
  account.contacts.find(contact => contact.primary) ?? account.contacts[0] ?? null;

/**
 * The customer details a quote carries itself.
 *
 * Copied from the account when the quote is created or the account is
 * re-attached, and then frozen: a quote is a document about a moment, and the
 * address it was sent to does not change because the account record did.
 */
export type CustomerSnapshot = {
  accountId: string | null;
  name: string;
  /** The account's primary contact, flattened: a document addresses one person. */
  contactName: string;
  contactTitle: string;
  contactEmail: string;
  contactPhone: string;
  billingAddress: Address;
  shippingAddress: Address;
  paymentTerms: string;
};

export const EMPTY_CUSTOMER: CustomerSnapshot = {
  accountId: null,
  name: "",
  contactName: "",
  contactTitle: "",
  contactEmail: "",
  contactPhone: "",
  billingAddress: { ...EMPTY_ADDRESS },
  shippingAddress: { ...EMPTY_ADDRESS },
  paymentTerms: "",
};

/**
 * A blank snapshot, addresses and all.
 *
 * Spreading `EMPTY_CUSTOMER` copies the top level and shares the two address
 * objects with every other quote that did the same — harmless while nothing
 * writes to them, and a very confusing bug the first time something does.
 */
export const emptyCustomer = (): CustomerSnapshot => ({
  ...EMPTY_CUSTOMER,
  billingAddress: { ...EMPTY_ADDRESS },
  shippingAddress: { ...EMPTY_ADDRESS },
});

/* --------------------------------- quotes -------------------------------- */

/**
 * Where a quote is in its life.
 *
 * `draft` → `in_review` (approvals outstanding) → `approved` → `sent` →
 * `accepted` / `declined`. `rejected` comes back from an approver and returns
 * the quote to the rep, and `expired` is what `validUntil` makes of a quote
 * nobody answered. The legal transitions live in `QUOTE_TRANSITIONS` below, so
 * the server and the UI agree on which buttons exist.
 */
export type QuoteStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "rejected"
  | "sent"
  | "accepted"
  | "declined"
  | "expired";

export const QUOTE_STATUSES: QuoteStatus[] = [
  "draft",
  "in_review",
  "approved",
  "rejected",
  "sent",
  "accepted",
  "declined",
  "expired",
];

/**
 * Which statuses each status may move to, by an explicit request.
 *
 * Two of them are not in here because they are not anybody's to request:
 * `in_review` and `approved` are decided by the approval engine when a quote
 * is submitted, and `expired` by the clock.
 */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ["sent"],
  in_review: ["draft"],
  approved: ["sent", "draft"],
  rejected: ["draft"],
  sent: ["accepted", "declined", "draft"],
  accepted: [],
  declined: ["draft"],
  expired: ["draft"],
};

/** A quote may only be edited while it is still the rep's to edit. */
export const isEditableStatus = (status: QuoteStatus) => status === "draft" || status === "rejected";

/**
 * One line as the person quoting entered it — everything the price is derived
 * *from*, and nothing derived. This is what the client sends and what is
 * stored; the numbers below are recomputed from it on every save.
 */
export type QuoteLineInput = {
  id: string;
  /** The product's id. The SKU is snapshotted beside it when priced. */
  productId: string;
  quantity: number;
  /** A manual discount the rep applied, 0-100. */
  discountPercent: number;
  /** A negotiated unit price. `null` means "whatever the price book says". */
  unitPriceOverride: number | null;
  /** Selected option keys, across every group on the product. */
  selectedOptions: string[];
  /** Subscription length in months. Recurring lines only; 0 uses the quote's term. */
  termMonths: number;
  /** A rep-written note that replaces the catalogue description on the proposal. */
  description: string;
  /** The bundle line this came from, if any. Component lines are not editable. */
  parentId: string | null;
  sortOrder: number;
};

/**
 * A line with its price worked out.
 *
 * Every intermediate number is kept rather than just the total, because the
 * question a CPQ is always asked is "why is it that price" — the UI walks
 * these fields to answer it, and `appliedRules` names what moved it.
 */
export type PricedLine = QuoteLineInput & {
  /* --- catalogue snapshot, as it was when this line was priced --- */
  sku: string;
  name: string;
  family: string;
  chargeType: ChargeType;
  billingPeriod: BillingPeriod;
  unitOfMeasure: string;
  /** Names of the selected options, for display and for the proposal. */
  optionNames: string[];

  /* --- the price, step by step --- */
  /** The price book's price, or the product's list price when it has no entry. */
  listUnitPrice: number;
  /** What the selected options added to (or took off) one unit. */
  optionsUnitDelta: number;
  /** After options and the volume tier, before discounts and rules. */
  baseUnitPrice: number;
  /** The tier the quantity landed in, or null when the product has no tiers. */
  tier: VolumeTier | null;
  /** What is actually charged per unit, after everything. */
  unitPrice: number;
  /** `listUnitPrice` × quantity × periods — what it would cost undiscounted. */
  listTotal: number;
  /** Everything taken off `listTotal`, as one number. */
  discountAmount: number;
  /** What the customer pays for this line over the whole term. */
  netTotal: number;
  /** `discountAmount` as a percentage of `listTotal`. */
  effectiveDiscountPercent: number;
  /** Billing periods this line is charged for; 1 for one-time products. */
  periods: number;

  /* --- margin, never shown to a buyer --- */
  unitCost: number;
  costTotal: number;
  margin: number;
  marginPercent: number;

  /* --- revenue shape --- */
  oneTime: number;
  monthlyRecurring: number;
  annualRecurring: number;

  /* --- provenance --- */
  appliedRules: AppliedRule[];
  /** Configuration and floor problems. A quote with any of these cannot be sent. */
  issues: string[];
  /** Advisory notes: a recommended option not taken, a tier just out of reach. */
  warnings: string[];
};

export type QuoteTotals = {
  currency: CurrencyCode;
  lineCount: number;
  /** Undiscounted value of every line. */
  listTotal: number;
  /** Line-level discounts, tiers and rules. */
  lineDiscountAmount: number;
  /** After line discounts, before the quote-level discount. */
  subtotal: number;
  /** The whole-quote discount, in money. */
  quoteDiscountAmount: number;
  /**
   * What quote-scoped pricing rules added or took off, as one amount. Kept
   * apart from the discount because a surcharge is not a negative discount,
   * and a totals panel that says so confuses everyone who reads it.
   */
  quoteAdjustment: number;
  /** After every discount and adjustment, before tax. */
  netTotal: number;
  taxAmount: number;
  shipping: number;
  grandTotal: number;
  /** `listTotal` − `netTotal`, over `listTotal`. The number an approver reads. */
  effectiveDiscountPercent: number;
  costTotal: number;
  margin: number;
  marginPercent: number;
  /* Revenue shape, which is what a subscription business actually reports. */
  oneTimeTotal: number;
  monthlyRecurringTotal: number;
  annualRecurringTotal: number;
  /** One-time charges plus the full recurring value of the term. */
  totalContractValue: number;
};

export type Quote = {
  id: string;
  /** Human-facing and sequential per account: "Q-2026-0007". */
  number: string;
  name: string;
  status: QuoteStatus;
  /** 1 for the original; a revision of a sent quote increments it. */
  version: number;
  /** The quote this one revises, if any. */
  supersedesId: string | null;
  customer: CustomerSnapshot;
  priceBookId: string;
  currency: CurrencyCode;
  /** Default subscription length for recurring lines that name none. */
  termMonths: number;
  /** A discount on the whole quote, applied after line discounts, 0-100. */
  discountPercent: number;
  taxPercent: number;
  shipping: number;
  /** ISO date. Past it, the quote reads as expired. */
  validUntil: string;
  notes: string;
  /** Not shown to the customer — the rep's own working notes. */
  internalNotes: string;
  lines: PricedLine[];
  totals: QuoteTotals;
  approvals: ApprovalRequest[];
  /** Who the quote is waiting on, flattened for PocketBase's access rules. */
  approverIds: string[];
  ownerId: string;
  sharedWith: string[];
  sentAt: string;
  decidedAt: string;
  createdAt: string;
  updatedAt: string;
};

/** A quote without its lines — what the list endpoint and the sidebar use. */
export type QuoteSummary = Omit<Quote, "lines" | "approvals"> & {
  lineCount: number;
  pendingApprovals: number;
};

/* ------------------------------- templates ------------------------------- */

/**
 * The customer-facing document a record is rendered into.
 *
 * A template is text with `{{token}}` placeholders in one of three formats,
 * or a `pdf` document description. Nothing is executed: rendering substitutes
 * strings, so a template is a document, never a program.
 */
export type ProposalFormat = "html" | "markdown" | "text" | "pdf";

export const PROPOSAL_FORMATS: ProposalFormat[] = ["html", "markdown", "text", "pdf"];

/**
 * The three text formats hold their document as text with `{{token}}` holes.
 * A `pdf` template holds a JSON document description instead — see
 * src/lib/pdfTemplate.ts for why a PDF cannot be described as text.
 */
export const isPdfFormat = (format: ProposalFormat): boolean => format === "pdf";

/**
 * What a template is *for*, which is what decides its token vocabulary.
 *
 * A quote template reaches `{{quote.number}}` and the pricing totals; an
 * invoice template reaches `{{invoice.dueDate}}` and the ledger. They are one
 * collection and one editor because a template is a template — the letterhead,
 * the address panel and the PDF block language are identical, and only the
 * meaning of a token differs. They are not one *vocabulary* because a token
 * that resolved to a blank half the time would be worse than one that does
 * not exist.
 *
 * The kinds live here rather than in either vocabulary so that neither has to
 * import the other.
 */
export type TemplateKind = "quote" | "invoice";

export const TEMPLATE_KINDS: TemplateKind[] = ["quote", "invoice"];

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  quote: "Quote",
  invoice: "Invoice",
};

export type ProposalTemplate = {
  id: string;
  name: string;
  /** Which record it renders. A template written before invoices is a quote's. */
  kind: TemplateKind;
  format: ProposalFormat;
  body: string;
  ownerId: string;
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
};

/* ------------------------------ receivables ------------------------------ */

/**
 * An invoice: what a customer owes, and what has come back against it.
 *
 * A quote is an offer and an invoice is a demand, which is why they are
 * separate records rather than two states of one. The quote can be revised,
 * superseded and re-priced; the invoice is a number sent to an accounts
 * payable department, and the only honest way to change it is to credit it.
 *
 * Two conventions, both borrowed from elsewhere in this app because they
 * earned their keep there.
 *
 * **The invoice carries its own copy of everything.** The customer, their
 * address, the payment terms it was raised under, the price of every line.
 * The account can move to Net 60 tomorrow; an invoice already issued is still
 * due when it was always due.
 *
 * **Its status is derived, never assigned.** Only `state` is recorded — is it
 * a draft, has it been issued, was it voided — and everything a person
 * actually reads (open, part paid, paid, overdue) is worked out from the
 * ledger it carries and the date, by `invoiceStatus` in src/lib/receivable.ts.
 * The alternative is a stored status that disagrees with the arithmetic, and
 * in accounts receivable that is the one bug nobody forgives.
 */

/** How the money arrived. Reporting only — none of it changes the maths. */
export type PaymentMethod = "bank_transfer" | "card" | "cheque" | "cash" | "other";

export const PAYMENT_METHODS: PaymentMethod[] = ["bank_transfer", "card", "cheque", "cash", "other"];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  card: "Card",
  cheque: "Cheque",
  cash: "Cash",
  other: "Other",
};

/**
 * Cash actually received against one invoice.
 *
 * Its own record, in its own collection, rather than an entry in the
 * invoice's JSON. Three things follow from that and all three are the reason
 * for it:
 *
 * **Recording one is an insert.** It used to be a read-modify-write of the
 * whole invoice, so two people banking payments at the same moment could lose
 * one of them. An insert cannot.
 *
 * **Cash is answerable on its own.** "What came in last month" is a question
 * about payments, not about invoices, and it was previously unaskable without
 * opening every invoice in the workspace.
 *
 * **It has an identity and an audit trail** — an owner, a created date, a
 * durable id — like every other record here rather than an object inside
 * another record's field.
 */
export type InvoicePayment = {
  id: string;
  /** The invoice it settles. A payment always belongs to exactly one. */
  invoiceId: string;
  /**
   * ISO date the money arrived — not the day somebody keyed it in. Aging is
   * measured against the calendar, so the difference is a real one, and
   * `createdAt` is the day it was keyed in.
   */
  receivedOn: string;
  amount: number;
  method: PaymentMethod;
  /** Bank reference, cheque number, processor id — whatever ties it to a statement. */
  reference: string;
  note: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Why an amount was taken off an invoice without anybody paying it.
 *
 * `write_off` is the one that matters to a finance team: it is the admission
 * that the money is not coming, and it is deliberately not the same thing as
 * an `adjustment` that corrects an invoice raised wrongly.
 */
export type CreditReason = "adjustment" | "return" | "goodwill" | "write_off";

export const CREDIT_REASONS: CreditReason[] = ["adjustment", "return", "goodwill", "write_off"];

export const CREDIT_REASON_LABELS: Record<CreditReason, string> = {
  adjustment: "Adjustment",
  return: "Return",
  goodwill: "Goodwill",
  write_off: "Write-off",
};

/**
 * An amount forgiven, corrected or written off. Reduces the balance; no cash
 * moved. Its own record, for the same reasons as a payment.
 */
export type InvoiceCredit = {
  id: string;
  invoiceId: string;
  issuedOn: string;
  amount: number;
  reason: CreditReason;
  note: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * One billable line.
 *
 * Tax is per line rather than per invoice, because a single invoice very
 * often mixes rates — zero-rated services beside standard-rated goods — and
 * an invoice that can only hold one rate forces the seller to split the
 * document to stay correct.
 */
export type InvoiceLine = {
  id: string;
  /** The quote line this was raised from, when it came from a quote. */
  sourceLineId: string | null;
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
  /** `quantity × unitPrice`, rounded. Recomputed on every save, never trusted. */
  amount: number;
  taxPercent: number;
  taxAmount: number;
};

/**
 * What is recorded about an invoice — the whole of what anyone sets.
 *
 * `draft` is still the seller's to change. `issued` has gone to the customer
 * and is now a receivable. `void` is an invoice that should never have
 * existed; an invoice that existed and will not be paid is written off with a
 * credit instead, because the difference is one a finance team reports on.
 */
export type InvoiceState = "draft" | "issued" | "void";

export const INVOICE_STATES: InvoiceState[] = ["draft", "issued", "void"];

/**
 * What an invoice *is*, once the ledger and the calendar have had their say.
 *
 * Derived by `invoiceStatus`, never stored. `overdue` in particular cannot be
 * a stored value: nothing happens on the due date except the date arriving.
 */
export type InvoiceStatus = "draft" | "open" | "part_paid" | "paid" | "overdue" | "void";

export const INVOICE_STATUSES: InvoiceStatus[] = ["draft", "open", "part_paid", "paid", "overdue", "void"];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  open: "Open",
  part_paid: "Part paid",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
};

/**
 * What an invoice comes to.
 *
 * Split down the middle by where the numbers come from. `subtotal`,
 * `taxAmount` and `total` are a pure function of the invoice's own lines, and
 * are stored with it. `paidAmount`, `creditedAmount` and `balance` are a
 * function of its ledger, which lives in two other collections — so they are
 * **computed on every read** rather than cached on the invoice.
 *
 * That is deliberate. A cached balance is a number that can disagree with the
 * payments behind it, and a finance system is the last place to keep one.
 * Reading a page of invoices costs two extra queries for the whole page — not
 * one per invoice — which is a price worth paying to make drift impossible.
 */
export type InvoiceTotals = {
  currency: CurrencyCode;
  lineCount: number;
  /** Every line, before tax. */
  subtotal: number;
  taxAmount: number;
  /** What was demanded: subtotal plus tax. */
  total: number;
  /** Cash received. Summed from the `payments` collection at read time. */
  paidAmount: number;
  /** Amounts credited or written off. Summed from `credits` at read time. */
  creditedAmount: number;
  /**
   * `total − paid − credited`, and **allowed to be negative**: a customer who
   * pays an invoice twice is owed the difference, and clamping it at zero
   * would be the app quietly losing their money.
   */
  balance: number;
};

export type Invoice = {
  id: string;
  /** Human-facing and sequential per account: "INV-2026-0007". */
  number: string;
  /** The quote this was raised from, if any. */
  quoteId: string | null;
  /** Its number, snapshotted, so the link still reads after the quote is gone. */
  quoteNumber: string;
  customer: CustomerSnapshot;
  currency: CurrencyCode;
  state: InvoiceState;
  /** ISO date. Empty until it is issued — a draft has no date on it. */
  issueDate: string;
  /** ISO date: `issueDate` plus the terms below. What aging is measured from. */
  dueDate: string;
  /**
   * The terms this invoice was raised under, in days, snapshotted from the
   * customer. Moving an account to Net 60 must not move a due date that an
   * accounts payable department has already diarised.
   */
  paymentTermDays: number;
  /** The customer's own purchase order reference. Many will not pay without it. */
  poNumber: string;
  /** Printed on the invoice. */
  notes: string;
  /** Never shown to the customer — the collections note. */
  internalNotes: string;
  lines: InvoiceLine[];
  /**
   * Its ledger, read from the `payments` and `credits` collections and
   * attached here for whoever is holding the invoice. Not stored on it — see
   * `InvoiceTotals`.
   */
  payments: InvoicePayment[];
  credits: InvoiceCredit[];
  totals: InvoiceTotals;
  ownerId: string;
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
};

/**
 * An invoice without its lines or its ledger rows — what the list endpoint
 * returns. Its `totals` are still whole, balance included: the list reads
 * every payment and credit in two queries and adds them up, because a list of
 * invoices with no balances on it is not worth returning.
 */
export type InvoiceSummary = Omit<Invoice, "lines" | "payments" | "credits"> & {
  lineCount: number;
  paymentCount: number;
  creditCount: number;
};
