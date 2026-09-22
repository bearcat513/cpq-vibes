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
import { conditionHolds, runFormula } from "./formula";
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
  /** Added to the unit cost by the selected options. Internal, like every cost. */
  unitCostDelta: number;
  /**
   * The groups and options this line is actually offered, by key — what the
   * configurator draws. Everything else is hidden by a `visibleWhen` that
   * came out false, and is not required, not priced and not selectable.
   */
  visibleGroups: string[];
  visibleOptions: string[];
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

/* ------------------------------ visibility ------------------------------- */

/**
 * The variable bag a product's own formulas see — a `validate` rule's, and a
 * `visibleWhen`. Every option the product has is present as 1 or 0, so a
 * formula can weigh a choice without knowing whether it was offered.
 */
function formulaVariables(
  index: ReturnType<typeof optionIndex>,
  chosen: ReadonlySet<string>,
  input: ConfigurationInput,
): Record<string, number> {
  const quantity = Number.isFinite(input.quantity) ? input.quantity : 0;
  const variables: Record<string, number> = {
    quantity,
    term: input.termMonths,
    termMonths: input.termMonths,
    selectedCount: chosen.size,
  };
  for (const key of index.keys()) variables[`option.${key}`] = chosen.has(key) ? 1 : 0;
  return variables;
}

/**
 * Whether a `visibleWhen` lets something through.
 *
 * No formula is no condition. A formula that will not run shows it anyway:
 * `readProduct` refuses an expression that does not parse, so one that gets
 * here came from outside, and a catalogue that quietly stops offering half
 * its options is a worse failure than one that offers too many.
 */
const shown = (expression: string | undefined, variables: Record<string, number>): boolean => {
  const trimmed = expression?.trim();
  if (!trimmed) return true;
  const result = runFormula(trimmed, variables);
  return result.ok ? result.value !== null && result.value !== 0 : true;
};

/** What a line is actually offered, and what survives of its selection. */
export type Visibility = {
  /** Group keys. A group with no visible option is not one of them. */
  groups: Set<string>;
  /** Option keys, across every visible group. */
  options: Set<string>;
  /** The selection, minus anything that is no longer on offer. */
  selected: Set<string>;
};

/**
 * Resolves `visibleWhen` across the whole product.
 *
 * Visibility is a fixed point, not a pass: a group can be shown by a choice
 * that another formula has just hidden, and answering that in one sweep would
 * make the result depend on the order the groups happen to be in. So the
 * selection is pruned and the formulas are run again until nothing more
 * drops — which always terminates, because a pass can only ever remove.
 *
 * A hidden selection is dropped silently, like a selection whose option the
 * product no longer has: the line was configured under conditions that have
 * since changed, and that is the catalogue's business to explain, not this
 * line's error.
 */
export function resolveVisibility(
  product: Pick<Product, "optionGroups">,
  input: ConfigurationInput,
  selected: Iterable<string>,
): Visibility {
  const index = optionIndex(product);
  let chosen = new Set([...selected].filter(key => index.has(key)));
  let groups = new Set<string>();
  let options = new Set<string>();

  for (;;) {
    const variables = formulaVariables(index, chosen, input);
    groups = new Set();
    options = new Set();

    for (const group of product.optionGroups) {
      if (!shown(group.visibleWhen, variables)) continue;
      const visible = group.options.filter(option => shown(option.visibleWhen, variables));
      // A group with nothing left to choose from is not a question worth
      // asking, and a *required* one would be a question with no answer.
      if (!visible.length) continue;
      groups.add(group.key);
      for (const option of visible) options.add(option.key);
    }

    const next = new Set([...chosen].filter(key => options.has(key)));
    if (next.size === chosen.size) break;
    chosen = next;
  }

  return { groups, options, selected: chosen };
}

/**
 * What a freshly added line starts with: every option marked `default`, plus
 * the first option of any required single-select group that named none —
 * a required choice with nothing chosen is a line that is born invalid, which
 * is a worse first impression than a defensible default.
 */
export function defaultSelection(
  product: Pick<Product, "optionGroups" | "minQuantity">,
  input?: Partial<ConfigurationInput>,
): string[] {
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

  // Defaults are chosen first and pruned after, so a group that is only shown
  // *because* of a default still gets its own. The quantity a visibility
  // formula sees is the smallest the product can be bought in, since that is
  // what the line is about to be created with.
  const { selected: visible } = resolveVisibility(
    product,
    {
      selectedOptions: selected,
      quantity: input?.quantity ?? product.minQuantity ?? 1,
      termMonths: input?.termMonths ?? 0,
    },
    selected,
  );
  return selected.filter(key => visible.has(key));
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
  product: Pick<Product, "optionGroups" | "rules" | "minQuantity" | "maxQuantity" | "quantityIncrement" | "name">,
  input: ConfigurationInput,
  currency: CurrencyCode = "USD",
): ConfigurationResult {
  const index = optionIndex(product);
  const issues: ConfigurationIssue[] = [];

  // Selections the product no longer has are dropped silently: the line was
  // valid when it was written, and an option that has since been retired is
  // the catalogue's change to explain, not this line's error. A selection the
  // product still has but no longer offers this line goes the same way.
  const visibility = resolveVisibility(product, input, input.selectedOptions);
  const chosen = visibility.selected;

  /* --- group cardinality --- */

  for (const group of product.optionGroups) {
    // A hidden group asks nothing: not required, not bounded, not priced.
    if (!visibility.groups.has(group.key)) continue;
    const offered = group.options.filter(option => visibility.options.has(option.key));
    const picked = offered.filter(option => chosen.has(option.key));

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
    const max = group.maxSelect ?? offered.length;

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

    const increment = product.quantityIncrement ?? 0;
    // A pack size shapes a quantity where the minimum and maximum only bound
    // it. The nearest whole pack is named, because "not a multiple of 4" is a
    // complaint and "try 12" is an answer.
    if (increment > 1 && quantity % increment !== 0) {
      const nearest = Math.max(increment, Math.round(quantity / increment) * increment);
      issues.push({
        severity: "error",
        source: "Quantity",
        message: `${product.name} is sold in multiples of ${increment} — ${quantity} is not one. The nearest is ${nearest}.`,
      });
    }
  }

  /* --- product rules --- */

  // What a `validate` rule sees — the same bag the visibility formulas were
  // run against, rebuilt now that cardinality has had its say.
  const variables = formulaVariables(index, chosen, input);

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
  let unitCostDelta = 0;

  for (const group of product.optionGroups) {
    for (const option of group.options) {
      if (!chosen.has(option.key)) continue;
      selected.push(option.key);
      optionNames.push(option.name);
      unitDelta += Number.isFinite(option.priceDelta) ? option.priceDelta : 0;
      unitCostDelta += Number.isFinite(option.costDelta) ? (option.costDelta as number) : 0;
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
    unitCostDelta: round(unitCostDelta, currency),
    visibleGroups: product.optionGroups.filter(group => visibility.groups.has(group.key)).map(group => group.key),
    visibleOptions: [...visibility.options],
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

/* ----------------------------- availability ------------------------------ */

/** Where a product sits in its availability window, today. */
export type Availability = {
  state: "available" | "early" | "withdrawn";
  /** Empty while it is available; a sentence for a rep otherwise. */
  message: string;
};

/**
 * Whether a product may be quoted today.
 *
 * Derived, never stored, for the reason every other date-dependent fact here
 * is derived: a product stored as "withdrawn" is wrong the morning after
 * somebody writes it, and a product stored as "available" is wrong the
 * morning after that.
 */
export function availabilityOf(
  product: Pick<Product, "name" | "availableFrom" | "availableTo">,
  today: string = new Date().toISOString().slice(0, 10),
): Availability {
  const from = product.availableFrom?.trim();
  const to = product.availableTo?.trim();

  if (from && today < from) {
    return { state: "early", message: `${product.name} is not available to quote until ${from}.` };
  }
  if (to && today > to) {
    return { state: "withdrawn", message: `${product.name} was withdrawn from the catalogue on ${to}.` };
  }
  return { state: "available", message: "" };
}

/** A percentage a bundle grants on a component, kept in range. */
export const componentDiscount = (component: { discountPercent?: number }): number =>
  clampPercent(component.discountPercent ?? 0);
