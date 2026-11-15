/**
 * PocketBase's filter language, read into a tree and written back out.
 *
 * What the query builder on `/table` edits. The builder never holds a filter
 * as text: it holds a `FilterGroup`, and `serializeFilter` is the only thing
 * that turns one into the string PocketBase receives — so a value with a quote
 * in it is escaped once, here, rather than by every input that could take one.
 *
 * `parseFilter` goes the other way, for a filter that arrived in the URL. It
 * accepts the subset of the language the builder can show — comparisons with
 * a field on the left, joined by `&&` and `||`, grouped by parentheses — and
 * refuses the rest with a sentence (a function call, a literal on the left).
 * Refused is not invalid: PocketBase may well accept it, so the page keeps
 * the text and lets it be edited as text.
 *
 * Precedence is SQL's, because that is what PocketBase compiles to: `&&` binds
 * tighter than `||`, so `a && b || c` is `(a && b) || c`. The serializer
 * parenthesises every nested group, so what it writes never depends on that.
 *
 * Pure, and knows nothing about any collection: field names come from the
 * caller.
 */

export const FILTER_OPERATORS = [
  { op: "=", label: "equals" },
  { op: "!=", label: "does not equal" },
  { op: ">", label: "greater than" },
  { op: ">=", label: "at least" },
  { op: "<", label: "less than" },
  { op: "<=", label: "at most" },
  { op: "~", label: "contains" },
  { op: "!~", label: "does not contain" },
  { op: "?=", label: "any equals" },
  { op: "?!=", label: "any does not equal" },
  { op: "?>", label: "any greater than" },
  { op: "?>=", label: "any at least" },
  { op: "?<", label: "any less than" },
  { op: "?<=", label: "any at most" },
  { op: "?~", label: "any contains" },
  { op: "?!~", label: "any does not contain" },
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number]["op"];

/** Longest first, so `?!=` is never read as `?` and then `!=`. */
const OPERATORS_BY_LENGTH = [...FILTER_OPERATORS].map(entry => entry.op).sort((a, b) => b.length - a.length);

export const isFilterOperator = (value: string): value is FilterOperator =>
  FILTER_OPERATORS.some(entry => entry.op === value);

/**
 * How the right-hand side is written. `identifier` is another field or a
 * macro — `@now`, `@todayStart`, `@request.auth.id` — written bare.
 */
export const VALUE_KINDS = [
  { kind: "string", label: "text" },
  { kind: "number", label: "number" },
  { kind: "boolean", label: "true / false" },
  { kind: "null", label: "empty (null)" },
  { kind: "identifier", label: "field or @macro" },
] as const;

export type ValueKind = (typeof VALUE_KINDS)[number]["kind"];

/** The macros worth offering by name; PocketBase knows a few more. */
export const FILTER_MACROS = [
  "@now",
  "@today",
  "@todayStart",
  "@todayEnd",
  "@monthStart",
  "@monthEnd",
  "@yearStart",
  "@yearEnd",
  "@request.auth.id",
  "@request.auth.org",
] as const;

export type FilterValue = { kind: ValueKind; text: string };

export type FilterCondition = {
  type: "condition";
  id: string;
  field: string;
  op: FilterOperator;
  value: FilterValue;
};

export type FilterJoin = "&&" | "||";

export type FilterGroup = {
  type: "group";
  id: string;
  join: FilterJoin;
  children: FilterNode[];
};

export type FilterNode = FilterCondition | FilterGroup;

/** Longest filter this app sends — PocketBase has no limit of its own worth relying on. */
export const MAX_FILTER_LENGTH = 4000;

/* --------------------------------- ids --------------------------------- */

let counter = 0;
/** Keys for React, never sent anywhere. */
export const nodeId = () => `n${(++counter).toString(36)}`;

export const emptyGroup = (join: FilterJoin = "&&"): FilterGroup => ({ type: "group", id: nodeId(), join, children: [] });

export const newCondition = (field = "", kind: ValueKind = "string"): FilterCondition => ({
  type: "condition",
  id: nodeId(),
  field,
  op: "=",
  value: { kind, text: kind === "boolean" ? "true" : "" },
});

/* ------------------------------ tokenizer ------------------------------ */

type Token =
  | { type: "string"; value: string; at: number }
  | { type: "number"; value: string; at: number }
  | { type: "identifier"; value: string; at: number }
  | { type: "op"; value: FilterOperator; at: number }
  | { type: "join"; value: FilterJoin; at: number }
  | { type: "open" | "close" | "comma"; at: number };

/** What PocketBase allows in a field path: `org.name`, `lines:length`, `@request.auth.id`. */
const IDENTIFIER_START = /[A-Za-z_@#]/;
const IDENTIFIER_PART = /[A-Za-z0-9_.@#:]/;
export const IDENTIFIER = /^[A-Za-z_@#][A-Za-z0-9_.@#:]*$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;

class FilterSyntaxError extends Error {}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // PocketBase allows line comments in a filter.
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    // A comma only ever separates a function's arguments, which the parser
    // refuses by name — it is tokenized so that refusal can say so.
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ type: ch === "(" ? "open" : ch === ")" ? "close" : "comma", at: i });
      i++;
      continue;
    }

    if (text.startsWith("&&", i) || text.startsWith("||", i)) {
      tokens.push({ type: "join", value: text.slice(i, i + 2) as FilterJoin, at: i });
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      // Only the quote character itself is escaped, which is how PocketBase reads it.
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\" && text[j + 1] === ch) {
          value += ch;
          j += 2;
        } else {
          value += text[j];
          j++;
        }
      }
      if (j >= text.length) throw new FilterSyntaxError(`The text starting at character ${i + 1} is never closed.`);
      tokens.push({ type: "string", value, at: i });
      i = j + 1;
      continue;
    }

    const number = /^-?(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
    // A minus is a number's sign only where an operand is expected.
    if (number && (ch !== "-" || tokens.at(-1)?.type === "op")) {
      tokens.push({ type: "number", value: number[0], at: i });
      i += number[0].length;
      continue;
    }

    const op = OPERATORS_BY_LENGTH.find(candidate => text.startsWith(candidate, i));
    if (op) {
      tokens.push({ type: "op", value: op, at: i });
      i += op.length;
      continue;
    }

    if (IDENTIFIER_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENTIFIER_PART.test(text[j]!)) j++;
      tokens.push({ type: "identifier", value: text.slice(i, j), at: i });
      i = j;
      continue;
    }

    throw new FilterSyntaxError(`Unexpected "${ch}" at character ${i + 1}.`);
  }

  return tokens;
}

/* -------------------------------- parser -------------------------------- */

const PUNCTUATION = { open: "(", close: ")", comma: "," } as const;

const describe = (token: Token | undefined) =>
  !token
    ? "the end of the filter"
    : `"${"value" in token ? token.value : PUNCTUATION[token.type]}" at character ${token.at + 1}`;

function valueOf(token: Token): FilterValue {
  if (token.type === "string") return { kind: "string", text: token.value };
  if (token.type === "number") return { kind: "number", text: token.value };
  if (token.type === "identifier") {
    if (token.value === "true" || token.value === "false") return { kind: "boolean", text: token.value };
    if (token.value === "null") return { kind: "null", text: "" };
    return { kind: "identifier", text: token.value };
  }
  throw new FilterSyntaxError(`Expected a value, found ${describe(token)}.`);
}

/** A group of the same join as its parent adds nothing; its children move up. */
function joinAll(join: FilterJoin, nodes: FilterNode[]): FilterNode {
  if (nodes.length === 1) return nodes[0]!;
  const children = nodes.flatMap(node => (node.type === "group" && node.join === join ? node.children : [node]));
  return { type: "group", id: nodeId(), join, children };
}

function parseTokens(tokens: Token[]): FilterGroup {
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];

  function or(): FilterNode {
    const nodes = [and()];
    while (peek()?.type === "join" && (peek() as { value: string }).value === "||") {
      next();
      nodes.push(and());
    }
    return joinAll("||", nodes);
  }

  function and(): FilterNode {
    const nodes = [primary()];
    while (peek()?.type === "join" && (peek() as { value: string }).value === "&&") {
      next();
      nodes.push(primary());
    }
    return joinAll("&&", nodes);
  }

  function primary(): FilterNode {
    const token = next();
    if (!token) throw new FilterSyntaxError("The filter ends where a condition was expected.");

    if (token.type === "open") {
      const inner = or();
      const close = next();
      if (close?.type !== "close") throw new FilterSyntaxError(`Expected ")", found ${describe(close)}.`);
      return inner;
    }

    if (token.type !== "identifier") {
      throw new FilterSyntaxError(
        `The builder needs a field on the left of each condition; found ${describe(token)}.`,
      );
    }
    if (peek()?.type === "open") {
      throw new FilterSyntaxError(`"${token.value}(…)" is a function call, which the builder cannot show.`);
    }

    const op = next();
    if (op?.type !== "op") throw new FilterSyntaxError(`Expected an operator after "${token.value}", found ${describe(op)}.`);

    const operand = next();
    if (!operand) throw new FilterSyntaxError(`"${token.value} ${op.value}" has no value.`);

    return { type: "condition", id: nodeId(), field: token.value, op: op.value, value: valueOf(operand) };
  }

  if (tokens.length === 0) return emptyGroup();

  const root = or();
  if (at < tokens.length) throw new FilterSyntaxError(`Unexpected ${describe(tokens[at])}.`);
  return root.type === "group" ? root : { type: "group", id: nodeId(), join: "&&", children: [root] };
}

export type ParsedFilter = { ok: true; group: FilterGroup } | { ok: false; error: string };

/** A filter string as a builder tree, or the sentence saying why it cannot be one. */
export function parseFilter(text: string): ParsedFilter {
  try {
    return { ok: true, group: parseTokens(tokenize(text)) };
  } catch (error) {
    if (error instanceof FilterSyntaxError) return { ok: false, error: error.message };
    throw error;
  }
}

/* ------------------------------ serializer ------------------------------ */

/** Double quotes unless the text holds one and no single quote. */
export function quote(text: string): string {
  const mark = text.includes('"') && !text.includes("'") ? "'" : '"';
  return `${mark}${text.split(mark).join(`\\${mark}`)}${mark}`;
}

function serializeValue(value: FilterValue): string {
  switch (value.kind) {
    case "string":
      return quote(value.text);
    case "number":
      return value.text.trim();
    case "boolean":
      return value.text === "false" ? "false" : "true";
    case "null":
      return "null";
    case "identifier":
      return value.text.trim();
  }
}

function serializeNode(node: FilterNode, nested: boolean): string {
  if (node.type === "condition") return `${node.field.trim()} ${node.op} ${serializeValue(node.value)}`;

  const parts = node.children.map(child => serializeNode(child, true)).filter(Boolean);
  if (parts.length === 0) return "";
  const joined = parts.join(` ${node.join} `);
  return nested && parts.length > 1 ? `(${joined})` : joined;
}

/** The tree as the string PocketBase receives. An empty tree is an empty filter. */
export function serializeFilter(group: FilterGroup): string {
  return serializeNode(group, false);
}

/* ------------------------------ validation ------------------------------ */

/** What is wrong with one condition, in a sentence — or null when nothing is. */
export function conditionProblem(condition: FilterCondition): string | null {
  const field = condition.field.trim();
  if (!field) return "Choose a field.";
  if (!IDENTIFIER.test(field)) return `"${field}" is not a field name.`;

  const text = condition.value.text.trim();
  switch (condition.value.kind) {
    case "number":
      return NUMBER.test(text) ? null : "Enter a number.";
    case "identifier":
      if (!text) return "Name a field or a macro such as @now.";
      return IDENTIFIER.test(text) ? null : `"${text}" is not a field or a macro.`;
    default:
      return null;
  }
}

/** Every condition with something wrong, by id. Empty means the tree may be applied. */
export function filterProblems(node: FilterNode, found: Record<string, string> = {}): Record<string, string> {
  if (node.type === "condition") {
    const problem = conditionProblem(node);
    if (problem) found[node.id] = problem;
  } else {
    node.children.forEach(child => filterProblems(child, found));
  }
  return found;
}

/* ------------------------------- editing -------------------------------- */

/** The tree with the node `id` replaced by `update(node)`; `null` removes it. */
export function updateNode(
  group: FilterGroup,
  id: string,
  update: (node: FilterNode) => FilterNode | null,
): FilterGroup {
  const children: FilterNode[] = [];
  for (const child of group.children) {
    if (child.id === id) {
      const replaced = update(child);
      if (replaced) children.push(replaced);
    } else if (child.type === "group") {
      children.push(updateNode(child, id, update));
    } else {
      children.push(child);
    }
  }
  return { ...group, children };
}

/** How many conditions the tree holds, at any depth. */
export const countConditions = (node: FilterNode): number =>
  node.type === "condition" ? 1 : node.children.reduce((sum, child) => sum + countConditions(child), 0);
