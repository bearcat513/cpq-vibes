/**
 * The "C" in CPQ: deciding whether a set of chosen options is a product the
 * business is willing to sell, and what those choices do to the price.
 *
 * Two things live here, and keeping them together is deliberate — the price
 * impact of an option and the legality of choosing it are the same question
 * asked twice, and a configurator that answers them in different places ends
 * up quoting configurations it would refuse to build.
 *
 * Everything is pure. The browser runs it on every click so the rep sees the
 * consequence immediately; the server runs the identical code on save, which
 * is the copy that decides what gets stored. A client that skips the check, or
 * lies about the result, changes nothing.
 */
import { conditionHolds } from "./formula";
import { clampPercent, round, type CurrencyCode } from "./money";
import type { OptionGroup, Product, ProductOption, ProductRule } from "./types";

/** A problem that stops the quote, or a note that does not. */
export type ConfigurationIssue = {
  severity: "error" | "warning";
  /** The group or rule it came from, so the UI can point at it. */
  source: string;
  message: string;
};

export type ConfigurationResult = {
  /** No errors. Warnings do not make a configuration invalid. */
  valid: boolean;
  /** Selected keys, filtered to ones the product actually has, in group order. */
  selected: string[];
  /** Display names of `selected`, for the line and the proposal. */
  optionNames: string[];
  /** Added to the unit price by the selected options. */
  unitDelta: number;
  /** Multiplied into the unit price. 1 when no option carries a factor. */
  unitFactor: number;
  issues: ConfigurationIssue[];
  errors: string[];
  warnings: string[];
};

export type ConfigurationInput = {
  selectedOptions: string[];
  quantity: number;
  termMonths: number;
};

/* ------------------------------- lookups -------------------------------- */

/** Every option on the product, flattened, keyed by its `key`. */
export function optionIndex(product: Pick<Product, "optionGroups">): Map<string, { group: OptionGroup; option: ProductOption }> {
  const index = new Map<string, { group: OptionGroup; option: ProductOption }>();
  for (const group of product.optionGroups) {
    for (const option of group.options) {
      // First definition wins, so a duplicated key cannot make the same
      // selection mean two different prices depending on iteration order.
      if (!index.has(option.key)) index.set(option.key, { group, option });
    }
  }
  return index;
}

/**
 * What a freshly added line starts with: every option marked `default`, plus
 * the first option of any required single-select group that named none —
 * a required choice with nothing chosen is a line that is born invalid, which
 * is a worse first impression than a defensible default.
 */
export function defaultSelection(product: Pick<Product, "optionGroups">): string[] {
  const selected: string[] = [];
  for (const group of product.optionGroups) {
    const defaults = group.options.filter(option => option.default);
    if (defaults.length) {
      // A single-select group takes only the first default, whatever the data says.
      selected.push(...(group.select === "one" ? defaults.slice(0, 1) : defaults).map(option => option.key));
      continue;
    }
    if (group.required && group.select === "one" && group.options[0]) selected.push(group.options[0].key);
  }
  return selected;
}

/** Human-readable name for a rule's target, used in rule messages. */
const nameOf = (index: ReturnType<typeof optionIndex>, key: string) => index.get(key)?.option.name ?? key;

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/* ------------------------------ validation ------------------------------- */

/** Whether every key in `when` is selected — the trigger every rule shares. */
const triggered = (rule: ProductRule, selected: Set<string>) =>
  rule.when.length > 0 && rule.when.every(key => selected.has(key));

/**
 * Checks one configuration and works out its price impact.
 *
 * The order matters. Unknown keys are dropped first (a product may have lost
 * an option since the line was written), then group cardinality, then the
 * product's own rules — so a rule never fires on a selection the group already
 * rejected, and the rep is told about one problem rather than three versions
 * of it.
 */
export function validateConfiguration(
  product: Pick<Product, "optionGroups" | "rules" | "minQuantity" | "maxQuantity" | "name">,
  input: ConfigurationInput,
  currency: CurrencyCode = "USD",
): ConfigurationResult {
  const index = optionIndex(product);
  const issues: ConfigurationIssue[] = [];

  // Selections the product no longer has are dropped silently: the line was
  // valid when it was written, and an option that has since been retired is
  // the catalogue's change to explain, not this line's error.
  const chosen = new Set(input.selectedOptions.filter(key => index.has(key)));

  /* --- group cardinality --- */

  for (const group of product.optionGroups) {
    const picked = group.options.filter(option => chosen.has(option.key));

    if (group.select === "one") {
      if (picked.length > 1) {
        // Keep the first and say so, rather than refusing to price at all.
        for (const extra of picked.slice(1)) chosen.delete(extra.key);
        issues.push({
          severity: "error",
          source: group.name,
          message: `“${group.name}” takes one choice — kept ${picked[0]!.name}.`,
        });
      } else if (group.required && picked.length === 0) {
        issues.push({ severity: "error", source: group.name, message: `Choose an option for “${group.name}”.` });
      }
      continue;
    }

    const min = group.required ? Math.max(1, group.minSelect ?? 1) : (group.minSelect ?? 0);
    const max = group.maxSelect ?? group.options.length;

    if (picked.length < min) {
      issues.push({
        severity: "error",
        source: group.name,
        message: `“${group.name}” needs at least ${min} option${min === 1 ? "" : "s"} — ${picked.length} chosen.`,
      });
    } else if (picked.length > max) {
      issues.push({
        severity: "error",
        source: group.name,
        message: `“${group.name}” allows at most ${max} option${max === 1 ? "" : "s"} — ${picked.length} chosen.`,
      });
    }
  }

  /* --- quantity --- */

  const quantity = input.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    issues.push({ severity: "error", source: "Quantity", message: "Quantity must be greater than zero." });
  } else {
    if (product.minQuantity > 0 && quantity < product.minQuantity) {
      issues.push({
        severity: "error",
        source: "Quantity",
        message: `${product.name} has a minimum of ${product.minQuantity}.`,
      });
    }
    if (product.maxQuantity > 0 && quantity > product.maxQuantity) {
      issues.push({
        severity: "error",
        source: "Quantity",
        message: `${product.name} has a maximum of ${product.maxQuantity}.`,
      });
    }
  }

  /* --- product rules --- */

  // Variables a `validate` rule sees. Every option is present as 1 or 0, so a
  // formula can weigh a choice without knowing whether it was offered.
  const variables: Record<string, number> = {
    quantity: Number.isFinite(quantity) ? quantity : 0,
    term: input.termMonths,
    termMonths: input.termMonths,
    selectedCount: chosen.size,
  };
  for (const key of index.keys()) variables[`option.${key}`] = chosen.has(key) ? 1 : 0;

  for (const rule of product.rules) {
    switch (rule.kind) {
      case "requires": {
        if (!triggered(rule, chosen)) break;
        const missing = rule.then.filter(key => !chosen.has(key));
        if (missing.length) {
          issues.push({
            severity: "error",
            source: "Rule",
            message:
              rule.message ||
              `${list(rule.when.map(key => nameOf(index, key)))} requires ${list(missing.map(key => nameOf(index, key)))}.`,
          });
        }
        break;
      }

      case "excludes": {
        if (!triggered(rule, chosen)) break;
        const conflicting = rule.then.filter(key => chosen.has(key));
        if (conflicting.length) {
          issues.push({
            severity: "error",
            source: "Rule",
            message:
              rule.message ||
              `${list(rule.when.map(key => nameOf(index, key)))} cannot be combined with ${list(conflicting.map(key => nameOf(index, key)))}.`,
          });
        }
        break;
      }

      case "recommend": {
        if (!triggered(rule, chosen)) break;
        const absent = rule.then.filter(key => !chosen.has(key));
        if (absent.length) {
          issues.push({
            severity: "warning",
            source: "Rule",
            message: rule.message || `Consider adding ${list(absent.map(key => nameOf(index, key)))}.`,
          });
        }
        break;
      }

      case "validate": {
        const expression = rule.expression?.trim();
        if (!expression) break;
        // A rule with a trigger only checks its formula once the trigger is met.
        if (rule.when.length > 0 && !triggered(rule, chosen)) break;
        if (!conditionHolds(expression, variables)) {
          issues.push({
            severity: "error",
            source: "Rule",
            message: rule.message || `This configuration does not satisfy “${expression}”.`,
          });
        }
        break;
      }
    }
  }

  /* --- price impact --- */

  // Group order, not selection order, so two lines with the same options
  // always read the same way on the quote.
  const selected: string[] = [];
  const optionNames: string[] = [];
  let unitDelta = 0;
  let unitFactor = 1;

  for (const group of product.optionGroups) {
    for (const option of group.options) {
      if (!chosen.has(option.key)) continue;
      selected.push(option.key);
      optionNames.push(option.name);
      unitDelta += Number.isFinite(option.priceDelta) ? option.priceDelta : 0;
      const factor = option.priceFactor;
      if (typeof factor === "number" && Number.isFinite(factor) && factor > 0) unitFactor *= factor;
    }
  }

  const errors = issues.filter(issue => issue.severity === "error").map(issue => issue.message);
  const warnings = issues.filter(issue => issue.severity === "warning").map(issue => issue.message);

  return {
    valid: errors.length === 0,
    selected,
    optionNames,
    unitDelta: round(unitDelta, currency),
    unitFactor,
    issues,
    errors,
    warnings,
  };
}

/**
 * Applies a click in a single-select group, since "replace whatever was there"
 * is not something a checkbox list does for you.
 *
 * Returned rather than mutated: the editor holds the selection in React state.
 */
export function toggleOption(
  product: Pick<Product, "optionGroups">,
  selected: string[],
  key: string,
  on: boolean,
): string[] {
  const index = optionIndex(product);
  const entry = index.get(key);
  if (!entry) return selected;

  const next = new Set(selected);
  if (!on) {
    next.delete(key);
    return [...next];
  }

  // Choosing one option in a radio group unchooses its siblings.
  if (entry.group.select === "one") {
    for (const sibling of entry.group.options) next.delete(sibling.key);
  }
  next.add(key);
  return [...next];
}

/** A percentage a bundle grants on a component, kept in range. */
export const componentDiscount = (component: { discountPercent?: number }): number =>
  clampPercent(component.discountPercent ?? 0);
