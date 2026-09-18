/**
 * The "P" in CPQ: turning a set of chosen products into a set of numbers.
 *
 * The whole engine is one pure function, `priceQuote`. Give it the lines a rep
 * entered and the catalogue, price book and rules they are entitled to, and it
 * hands back every line with its price worked out and the quote's totals. It
 * reads nothing, writes nothing and asks nothing — which is what lets the
 * browser run it on every keystroke for live totals while the server runs the
 * same code on save and is the only copy that decides what is stored.
 *
 * ## The pipeline
 *
 * A line's price is built in a fixed order, and every step is kept on the
 * line, because the question a CPQ is always asked is "why is it that price":
 *
 *   1. list price      the price book's entry, or the product's list price
 *   2. options         the configured options' factor, then their delta
 *   3. volume tier     the band the quantity falls into
 *   4. override        a negotiated unit price replaces steps 1-3 outright
 *   5. pricing rules   policy, by formula, in priority order
 *   6. discount        the rep's percentage, and any rule that changed it
 *   7. floor           the price book's minimum, which nothing may go below
 *   8. term            periods = term ÷ billing period, for recurring lines
 *
 * Steps 5 and 6 interleave: a rule targeting `discountPercent` sets the
 * discount that step 6 then applies, so a policy can be written either as "the
 * price becomes X" or as "the discount becomes Y" and both behave sanely.
 *
 * ## Why the arithmetic is boring on purpose
 *
 * Every step rounds to the quote's currency (see src/lib/money.ts), and every
 * total is the sum of numbers that were already rounded. A quote is checked
 * with a calculator by people who are about to spend money, and a total that
 * is a cent away from its own visible lines costs more to explain than it
 * could ever save.
 */
import { validateConfiguration } from "./configurator";
import { conditionHolds, runFormula } from "./formula";
import { atLeastZero, clampPercent, percentBetween, percentOf, round, sum, type CurrencyCode } from "./money";
import {
  BILLING_PERIOD_MONTHS,
  type AppliedRule,
  type PriceBook,
  type PricedLine,
  type PricingRule,
  type Product,
  type QuoteLineInput,
  type QuoteTotals,
  type VolumeTier,
} from "./types";

/** The catalogue snapshot a stored line carries, recovered when repricing. */
type LineSnapshot = Pick<PricedLine, "sku" | "name" | "family" | "chargeType" | "billingPeriod" | "unitOfMeasure">;

/** What `priceQuote` is given per line: the rep's input, plus any old snapshot. */
export type PriceableLine = QuoteLineInput & Partial<LineSnapshot>;

export type QuoteHeader = {
  currency: CurrencyCode;
  /** Default term for recurring lines that name none. */
  termMonths: number;
  /** Whole-quote discount, applied after every line discount. */
  discountPercent: number;
  taxPercent: number;
  shipping: number;
};

export type PricingContext = {
  /** Every product the caller may price with, by id. */
  products: Map<string, Product>;
  /** The book in force, or null to price straight off the catalogue. */
  priceBook: PriceBook | null;
  /** The caller's own rules. Inactive ones may be passed; they are skipped. */
  rules: PricingRule[];
};

export type PricedQuote = {
  lines: PricedLine[];
  totals: QuoteTotals;
  /** Problems with the quote as a whole — a stale price book, a bad rule. */
  issues: string[];
  warnings: string[];
  /** Quote-scoped rules that fired, for the totals panel to explain itself. */
  appliedRules: AppliedRule[];
};

/* ---------------------------- rule variables ----------------------------- */

/**
 * What a rule may reference, by scope. Surfaced to the rule editor so the
 * variables are discoverable rather than folklore, and used to validate an
 * expression the moment it is typed.
 */
export const PRICING_VARIABLES: Record<"line" | "quote", { name: string; description: string }[]> = {
  line: [
    { name: "quantity", description: "Units on this line" },
    { name: "listPrice", description: "Catalogue or price-book unit price, before options" },
    { name: "optionsDelta", description: "What the selected options add to one unit" },
    { name: "unitPrice", description: "Unit price so far — after options, tiers and earlier rules" },
    { name: "discountPercent", description: "The discount currently on the line, 0-100" },
    { name: "termMonths", description: "This line's subscription term in months" },
    { name: "periods", description: "Billing periods charged: term ÷ billing period" },
    { name: "unitCost", description: "What one unit costs to deliver" },
    { name: "listTotal", description: "Undiscounted value of the line" },
    { name: "netTotal", description: "Line value as it currently stands" },
    { name: "marginPercent", description: "Margin on the line as it currently stands" },
    { name: "optionCount", description: "How many options are selected" },
    { name: "isRecurring", description: "1 for a subscription line, 0 otherwise" },
  ],
  quote: [
    { name: "subtotal", description: "Every line's net, added up" },
    { name: "listTotal", description: "Every line undiscounted, added up" },
    { name: "lineCount", description: "Number of lines" },
    { name: "totalQuantity", description: "Units across every line" },
    { name: "discountPercent", description: "The whole-quote discount, 0-100" },
    { name: "termMonths", description: "The quote's default term" },
    { name: "costTotal", description: "Cost of everything quoted" },
    { name: "marginPercent", description: "Margin across the quote" },
    { name: "oneTimeTotal", description: "Non-recurring revenue on the quote" },
    { name: "recurringTotal", description: "Subscription revenue over the term" },
  ],
};

export const lineVariableNames = () => PRICING_VARIABLES.line.map(variable => variable.name);
export const quoteVariableNames = () => PRICING_VARIABLES.quote.map(variable => variable.name);

/* ------------------------------- helpers --------------------------------- */

/**
 * The tier a quantity falls into.
 *
 * Tiers are not cumulative — the matching band sets the whole line's price,
 * which is how a published price break reads. The last match wins, so an
 * overlapping table degrades to "the most specific band wins" rather than to
 * whichever one happened to be first in the array.
 */
export function tierFor(tiers: VolumeTier[], quantity: number): VolumeTier | null {
  let match: VolumeTier | null = null;
  for (const tier of tiers) {
    const min = Number.isFinite(tier.minQuantity) ? tier.minQuantity : 0;
    const max = tier.maxQuantity === null || tier.maxQuantity === undefined ? Infinity : tier.maxQuantity;
    if (quantity >= min && quantity <= max) match = tier;
  }
  return match;
}

/** A tier applied to a unit price. `override` replaces, the others reduce. */
function applyTier(unitPrice: number, tier: VolumeTier | null, currency: CurrencyCode): number {
  if (!tier) return unitPrice;
  switch (tier.kind) {
    case "percent":
      return round(unitPrice * (1 - clampPercent(tier.value) / 100), currency);
    case "amount":
      return round(unitPrice - tier.value, currency);
    case "override":
      return round(tier.value, currency);
  }
}

/** How many billing periods a line is charged for. One-time products bill once. */
export function periodsFor(
  chargeType: PricedLine["chargeType"],
  billingPeriod: PricedLine["billingPeriod"],
  termMonths: number,
): number {
  if (chargeType !== "recurring") return 1;
  const months = BILLING_PERIOD_MONTHS[billingPeriod] ?? 1;
  const term = atLeastZero(termMonths);
  if (!term) return 0;
  // Deliberately fractional: an 18-month deal on annual billing is 1.5
  // periods, and pretending it is 1 or 2 misstates the contract's value.
  return term / months;
}

/** A rule's reach: inactive, or scoped to a family or SKU it does not match. */
function ruleApplies(rule: PricingRule, scope: "line" | "quote", line?: { family: string; sku: string }): boolean {
  if (!rule.active || rule.scope !== scope) return false;
  if (scope === "quote") return true;
  if (rule.appliesToFamily && rule.appliesToFamily.toLowerCase() !== (line?.family ?? "").toLowerCase()) return false;
  if (rule.appliesToSku && rule.appliesToSku.toLowerCase() !== (line?.sku ?? "").toLowerCase()) return false;
  return true;
}

const byPriority = (a: PricingRule, b: PricingRule) => a.priority - b.priority || a.name.localeCompare(b.name);

/* ------------------------------ line pricing ----------------------------- */

/** A line whose product is gone: priced at what it says, and flagged. */
function orphanLine(line: PriceableLine, header: QuoteHeader): PricedLine {
  const currency = header.currency;
  const quantity = atLeastZero(line.quantity);
  const unitPrice = round(line.unitPriceOverride ?? 0, currency);
  const netTotal = round(unitPrice * quantity, currency);

  return {
    ...line,
    sku: line.sku ?? "",
    name: line.name ?? "Unknown product",
    family: line.family ?? "",
    chargeType: line.chargeType ?? "one-time",
    billingPeriod: line.billingPeriod ?? "monthly",
    unitOfMeasure: line.unitOfMeasure ?? "",
    optionNames: [],
    listUnitPrice: unitPrice,
    optionsUnitDelta: 0,
    baseUnitPrice: unitPrice,
    tier: null,
    unitPrice,
    listTotal: netTotal,
    discountAmount: 0,
    netTotal,
    effectiveDiscountPercent: 0,
    periods: 1,
    unitCost: 0,
    costTotal: 0,
    margin: netTotal,
    marginPercent: netTotal ? 100 : 0,
    oneTime: netTotal,
    monthlyRecurring: 0,
    annualRecurring: 0,
    appliedRules: [],
    issues: [
      line.sku
        ? `${line.sku} is no longer in the catalogue — re-add the line or price it by hand.`
        : "This line's product is no longer in the catalogue.",
    ],
    warnings: [],
  };
}

function priceLine(line: PriceableLine, header: QuoteHeader, context: PricingContext): PricedLine {
  const currency = header.currency;
  const product = context.products.get(line.productId);
  if (!product) return orphanLine(line, header);

  const issues: string[] = [];
  const warnings: string[] = [];
  const appliedRules: AppliedRule[] = [];

  const quantity = atLeastZero(line.quantity);
  const termMonths = atLeastZero(line.termMonths) || atLeastZero(header.termMonths);

  /* 0 — configuration */

  const configuration = validateConfiguration(product, { selectedOptions: line.selectedOptions, quantity, termMonths }, currency);
  issues.push(...configuration.errors);
  warnings.push(...configuration.warnings);

  /* 1 — list price */

  const entry = context.priceBook?.entries.find(
    candidate => candidate.sku === product.sku && candidate.active !== false,
  );

  // No entry and a product priced in another currency is the one case where
  // guessing would be worse than refusing: there is no exchange rate here, and
  // inventing one would put a wrong number in front of a customer.
  if (!entry && product.currency !== currency) {
    issues.push(
      `${product.sku} is priced in ${product.currency} and this quote is in ${currency} — add it to the price book.`,
    );
  }

  const listUnitPrice = round(entry ? entry.unitPrice : product.listPrice, currency);

  /* 2 — options */

  // The factor scales the list price; the delta is added afterwards, so a
  // percentage uplift never silently scales a flat add-on.
  const optionsUnitDelta = round(listUnitPrice * (configuration.unitFactor - 1) + configuration.unitDelta, currency);
  const optionedUnitPrice = round(listUnitPrice + optionsUnitDelta, currency);

  /* 3 — volume tier */

  const tier = tierFor(product.volumeTiers, quantity);
  const tieredUnitPrice = applyTier(optionedUnitPrice, tier, currency);

  /* 4 — override */

  const overridden = line.unitPriceOverride !== null && Number.isFinite(line.unitPriceOverride);
  let baseUnitPrice = overridden ? round(line.unitPriceOverride as number, currency) : tieredUnitPrice;

  /* 5 & 6 — rules and the discount */

  let discountPercent = clampPercent(line.discountPercent);
  const periods = periodsFor(product.chargeType, product.billingPeriod, termMonths);

  /** The variable bag, rebuilt before each rule so rules chain properly. */
  const variables = () => {
    const netUnit = round(baseUnitPrice * (1 - discountPercent / 100), currency);
    const netTotal = round(netUnit * quantity * periods, currency);
    const costTotal = round(product.cost * quantity * periods, currency);
    return {
      quantity,
      listPrice: listUnitPrice,
      optionsDelta: optionsUnitDelta,
      unitPrice: baseUnitPrice,
      discountPercent,
      termMonths,
      periods,
      unitCost: product.cost,
      listTotal: round(listUnitPrice * quantity * periods, currency),
      netTotal,
      marginPercent: percentBetween(netTotal - costTotal, netTotal),
      optionCount: configuration.selected.length,
      isRecurring: product.chargeType === "recurring" ? 1 : 0,
    };
  };

  /** Rules that produce an amount, applied to the line net after everything. */
  let adjustment = 0;

  for (const rule of context.rules.filter(candidate => ruleApplies(candidate, "line", product)).sort(byPriority)) {
    const bag = variables();
    if (!conditionHolds(rule.condition, bag)) continue;

    const result = runFormula(rule.expression, bag);
    if (!result.ok) {
      // A rule that does not parse is a policy that is not being applied —
      // say so on the quote rather than leaving it silently inert.
      warnings.push(`Pricing rule “${rule.name}” was skipped: ${result.error}`);
      continue;
    }
    if (result.value === null) continue;

    switch (rule.target) {
      case "unitPrice": {
        const next = round(result.value, currency);
        if (next === baseUnitPrice) break;
        appliedRules.push({ ruleId: rule.id, name: rule.name, target: "unitPrice", from: baseUnitPrice, to: next, message: rule.message });
        baseUnitPrice = next;
        break;
      }
      case "discountPercent": {
        const next = clampPercent(result.value);
        if (next === discountPercent) break;
        appliedRules.push({ ruleId: rule.id, name: rule.name, target: "discountPercent", from: discountPercent, to: next, message: rule.message });
        discountPercent = next;
        break;
      }
      case "adjustment": {
        const next = round(result.value, currency);
        if (!next) break;
        appliedRules.push({ ruleId: rule.id, name: rule.name, target: "adjustment", from: adjustment, to: round(adjustment + next, currency), message: rule.message });
        adjustment = round(adjustment + next, currency);
        break;
      }
    }
  }

  /* 7 — the floor */

  let unitPrice = round(baseUnitPrice * (1 - discountPercent / 100), currency);

  const floor = entry?.minPrice;
  if (typeof floor === "number" && Number.isFinite(floor) && unitPrice < floor) {
    // A warning, not an error. The floor has already done its job — the line
    // is priced at it — so the quote is correct and sendable, and the rep
    // needs to know their discount did not land, not to be stopped by a
    // problem the engine has already fixed.
    warnings.push(
      `${product.sku} may not be sold below ${floor} in this price book, so the unit price was raised from ` +
        `${unitPrice} to ${floor}.`,
    );
    unitPrice = round(floor, currency);
  }

  // The product's own discount ceiling is a policy signal, not a hard stop:
  // it is what the approval rules key off (see src/lib/approvals.ts), so the
  // line says it out loud rather than failing.
  const effectiveOnUnit = percentBetween(optionedUnitPrice - unitPrice, optionedUnitPrice);
  if (product.floorDiscountPercent > 0 && effectiveOnUnit > product.floorDiscountPercent) {
    warnings.push(
      `${effectiveOnUnit}% off list is beyond the ${product.floorDiscountPercent}% this product allows without approval.`,
    );
  }

  /* 8 — the term, and the totals */

  // The baseline is the *configured* product at list — options included,
  // tiers and discounts not. Anything else makes "% off list" meaningless the
  // moment an option adds value: a line whose options cost more than the base
  // product would read as a markup rather than as a discount, and the quote's
  // own list total would come out below its subtotal.
  const listTotal = round(optionedUnitPrice * quantity * periods, currency);
  const netTotal = round(round(unitPrice * quantity * periods, currency) + adjustment, currency);
  const discountAmount = round(listTotal - netTotal, currency);

  const unitCost = round(product.cost, currency);
  const costTotal = round(unitCost * quantity * periods, currency);
  const margin = round(netTotal - costTotal, currency);

  // Revenue shape. A recurring line's MRR is its net spread over the term —
  // not its per-period price, which says nothing comparable once two lines
  // bill on different cycles.
  const recurring = product.chargeType === "recurring" && termMonths > 0;
  const monthlyRecurring = recurring ? round(netTotal / termMonths, currency) : 0;

  return {
    ...line,
    termMonths,
    sku: product.sku,
    name: product.name,
    family: product.family,
    chargeType: product.chargeType,
    billingPeriod: product.billingPeriod,
    unitOfMeasure: product.unitOfMeasure,
    selectedOptions: configuration.selected,
    optionNames: configuration.optionNames,
    listUnitPrice,
    optionsUnitDelta,
    baseUnitPrice,
    tier,
    unitPrice,
    listTotal,
    discountAmount,
    netTotal,
    effectiveDiscountPercent: percentBetween(discountAmount, listTotal),
    periods,
    unitCost,
    costTotal,
    margin,
    marginPercent: percentBetween(margin, netTotal),
    oneTime: recurring ? 0 : netTotal,
    monthlyRecurring,
    annualRecurring: round(monthlyRecurring * 12, currency),
    appliedRules,
    issues,
    warnings,
  };
}

/* ------------------------------ quote pricing ---------------------------- */

export function priceQuote(lines: PriceableLine[], header: QuoteHeader, context: PricingContext): PricedQuote {
  const currency = header.currency;
  const issues: string[] = [];
  const warnings: string[] = [];
  const appliedRules: AppliedRule[] = [];

  // Component lines follow their parent; everything else keeps its own order.
  const priced = [...lines]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(line => priceLine(line, header, context));

  const listTotal = sum(priced.map(line => line.listTotal), currency);
  const subtotal = sum(priced.map(line => line.netTotal), currency);
  const costTotal = sum(priced.map(line => line.costTotal), currency);
  const oneTimeTotal = sum(priced.map(line => line.oneTime), currency);
  const recurringTotal = sum(priced.filter(line => line.chargeType === "recurring").map(line => line.netTotal), currency);

  /* quote-scoped rules */

  let discountPercent = clampPercent(header.discountPercent);
  let adjustment = 0;

  const variables = () => {
    const discount = percentOf(subtotal, discountPercent, currency);
    const net = round(subtotal - discount + adjustment, currency);
    return {
      subtotal,
      listTotal,
      lineCount: priced.length,
      totalQuantity: priced.reduce((total, line) => total + line.quantity, 0),
      discountPercent,
      termMonths: header.termMonths,
      costTotal,
      marginPercent: percentBetween(net - costTotal, net),
      oneTimeTotal,
      recurringTotal,
    };
  };

  for (const rule of context.rules.filter(candidate => ruleApplies(candidate, "quote")).sort(byPriority)) {
    const bag = variables();
    if (!conditionHolds(rule.condition, bag)) continue;

    const result = runFormula(rule.expression, bag);
    if (!result.ok) {
      warnings.push(`Pricing rule “${rule.name}” was skipped: ${result.error}`);
      continue;
    }
    if (result.value === null) continue;

    if (rule.target === "discountPercent") {
      const next = clampPercent(result.value);
      if (next === discountPercent) continue;
      appliedRules.push({ ruleId: rule.id, name: rule.name, target: "discountPercent", from: discountPercent, to: next, message: rule.message });
      discountPercent = next;
    } else if (rule.target === "adjustment") {
      const next = round(result.value, currency);
      if (!next) continue;
      appliedRules.push({ ruleId: rule.id, name: rule.name, target: "adjustment", from: adjustment, to: round(adjustment + next, currency), message: rule.message });
      adjustment = round(adjustment + next, currency);
    } else {
      // `unitPrice` has no meaning for a whole quote; say so rather than
      // applying something arbitrary.
      warnings.push(`Pricing rule “${rule.name}” targets a unit price but is scoped to the quote, so it was skipped.`);
    }
  }

  const quoteDiscountAmount = percentOf(subtotal, discountPercent, currency);
  const netTotal = round(subtotal - quoteDiscountAmount + adjustment, currency);
  const shipping = round(atLeastZero(header.shipping), currency);
  const taxAmount = percentOf(netTotal + shipping, header.taxPercent, currency);
  const grandTotal = round(netTotal + shipping + taxAmount, currency);

  const margin = round(netTotal - costTotal, currency);
  const monthlyRecurringTotal = sum(priced.map(line => line.monthlyRecurring), currency);

  /* price book sanity, reported once for the quote rather than per line */

  const book = context.priceBook;
  if (book) {
    if (book.currency !== currency) {
      issues.push(`Price book “${book.name}” is in ${book.currency}, but this quote is in ${currency}.`);
    }
    if (!book.active) warnings.push(`Price book “${book.name}” is no longer active.`);
    const today = new Date().toISOString().slice(0, 10);
    if (book.validFrom && today < book.validFrom) warnings.push(`Price book “${book.name}” does not start until ${book.validFrom}.`);
    if (book.validTo && today > book.validTo) warnings.push(`Price book “${book.name}” expired on ${book.validTo}.`);
  }

  const totals: QuoteTotals = {
    currency,
    lineCount: priced.length,
    listTotal,
    lineDiscountAmount: round(listTotal - subtotal, currency),
    subtotal,
    quoteDiscountAmount,
    quoteAdjustment: adjustment,
    netTotal,
    taxAmount,
    shipping,
    grandTotal,
    effectiveDiscountPercent: percentBetween(round(listTotal - netTotal, currency), listTotal),
    costTotal,
    margin,
    marginPercent: percentBetween(margin, netTotal),
    oneTimeTotal,
    monthlyRecurringTotal,
    annualRecurringTotal: round(monthlyRecurringTotal * 12, currency),
    // Everything the customer commits to over the term. It equals `netTotal`
    // by construction — recurring lines are already priced across their whole
    // term — and is carried separately because "TCV" is the number the
    // business asks for by name.
    totalContractValue: netTotal,
  };

  return {
    lines: priced,
    totals,
    issues: [...issues, ...priced.flatMap(line => line.issues)],
    warnings: [...warnings, ...priced.flatMap(line => line.warnings)],
    appliedRules,
  };
}

/** Whether a priced quote is fit to leave the building. */
export const quoteBlockers = (priced: Pick<PricedQuote, "issues">): string[] => priced.issues;

/* ------------------------------- bundles --------------------------------- */

/**
 * The component lines a bundle brings with it.
 *
 * Expansion happens when the line is added rather than at pricing time, so the
 * quote stores exactly what it prices: a bundle whose contents change next
 * month does not silently rewrite a quote that was already sent. Components
 * are ordinary lines with a `parentId` — they show on the quote, and the
 * customer sees what they are actually buying.
 */
export function expandBundle(
  parent: QuoteLineInput,
  product: Product,
  bySku: Map<string, Product>,
  nextId: () => string,
): QuoteLineInput[] {
  return product.components
    .map((component, index): QuoteLineInput | null => {
      const child = bySku.get(component.sku);
      if (!child) return null;
      return {
        id: nextId(),
        productId: child.id,
        // A bundle of three each containing two widgets is six widgets.
        quantity: Math.max(1, atLeastZero(component.quantity)) * Math.max(1, atLeastZero(parent.quantity)),
        discountPercent: clampPercent(component.discountPercent ?? 0),
        unitPriceOverride: null,
        selectedOptions: [],
        termMonths: parent.termMonths,
        description: "",
        parentId: parent.id,
        sortOrder: parent.sortOrder + (index + 1) / 100,
      };
    })
    .filter((line): line is QuoteLineInput => line !== null);
}
