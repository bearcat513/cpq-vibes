/**
 * The expression language behind pricing rules, approval policy and product
 * validation.
 *
 * Commercial policy changes far more often than software does — "20% off
 * above 500 seats", "three-year terms carry an 8% uplift", "services may not
 * exceed 15% of the software total" — so the policy is data, written as
 * expressions, rather than code someone has to deploy.
 *
 * That makes the evaluator security-relevant, and it is built accordingly:
 * expressions are tokenized, parsed into an AST and walked by hand. There is
 * no `eval`, no `Function`, no access to anything but the variables passed in.
 * Everything is a number — comparisons yield 1 or 0, so a condition and a
 * price formula are the same kind of expression and the same parser handles
 * both:
 *
 *   quantity * unitPrice                          a price
 *   quantity >= 500 && family == 0                a condition
 *   if(termMonths >= 36, unitPrice * 0.8, unitPrice)   either
 *
 * It runs identically in the browser (live validation and preview totals as
 * the rep types) and on the server (which is the authority on what is stored),
 * so it is dependency-free.
 */

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||";

export type FormulaNode =
  | { kind: "number"; value: number }
  | { kind: "ref"; field: string }
  | { kind: "unary"; op: "-" | "+" | "!"; operand: FormulaNode }
  | { kind: "binary"; op: BinaryOp; left: FormulaNode; right: FormulaNode }
  | { kind: "call"; name: FunctionName; args: FormulaNode[] };

export type ParseResult = { ok: true; node: FormulaNode; refs: string[] } | { ok: false; error: string };

/**
 * `if` is absent from this table on purpose: it is the one function whose
 * arguments must not all be evaluated, so the evaluator handles it directly.
 * Everything here is total over its arguments.
 */
const FUNCTIONS = {
  round: (args: number[]) => {
    const [value = 0, digits = 0] = args;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  },
  floor: (args: number[]) => Math.floor(args[0] ?? 0),
  ceil: (args: number[]) => Math.ceil(args[0] ?? 0),
  abs: (args: number[]) => Math.abs(args[0] ?? 0),
  sqrt: (args: number[]) => Math.sqrt(args[0] ?? 0),
  pow: (args: number[]) => (args[0] ?? 0) ** (args[1] ?? 0),
  min: (args: number[]) => Math.min(...args),
  max: (args: number[]) => Math.max(...args),
  /** `clamp(value, low, high)` — the guard a discount formula usually wants. */
  clamp: (args: number[]) => {
    const [value = 0, low = 0, high = 0] = args;
    return Math.min(Math.max(value, low), high);
  },
  /** Chooses the first of three; see the note above. Listed so it autocompletes. */
  if: (args: number[]) => (args[0] ? (args[1] ?? 0) : (args[2] ?? 0)),
} satisfies Record<string, (args: number[]) => number>;

export type FunctionName = keyof typeof FUNCTIONS;

export const FUNCTION_NAMES = Object.keys(FUNCTIONS) as FunctionName[];

/** How many arguments each function needs, for an error worth reading. */
const ARITY: Record<FunctionName, { min: number; max: number }> = {
  round: { min: 1, max: 2 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  sqrt: { min: 1, max: 1 },
  pow: { min: 2, max: 2 },
  min: { min: 1, max: Infinity },
  max: { min: 1, max: Infinity },
  clamp: { min: 3, max: 3 },
  if: { min: 3, max: 3 },
};

/* ------------------------------- tokenizer ------------------------------ */

type Token =
  | { type: "number"; value: number }
  | { type: "ident"; value: string }
  | { type: "op"; value: string };

/** Longest first, so `<=` is never read as `<` followed by `=`. */
const OPERATORS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "(", ")", ","];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i]!;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      const match = /^\d*\.?\d+/.exec(input.slice(i));
      if (!match) throw new Error(`Unexpected "${char}"`);
      tokens.push({ type: "number", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }

    // [bracketed name] lets a variable contain spaces or dashes.
    if (char === "[") {
      const end = input.indexOf("]", i);
      if (end === -1) throw new Error("Unclosed [ in a variable reference");
      tokens.push({ type: "ident", value: input.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(input.slice(i))!;
      tokens.push({ type: "ident", value: match[0] });
      i += match[0].length;
      continue;
    }

    const operator = OPERATORS.find(candidate => input.startsWith(candidate, i));
    if (operator) {
      tokens.push({ type: "op", value: operator });
      i += operator.length;
      continue;
    }

    // A lone `=` is the classic slip — say what was meant rather than
    // "unexpected character".
    if (char === "=") throw new Error('Use "==" to compare, not "="');
    if (char === "&") throw new Error('Use "&&" for "and"');
    if (char === "|") throw new Error('Use "||" for "or"');

    throw new Error(`Unexpected character "${char}"`);
  }

  return tokens;
}

/* -------------------------------- parser -------------------------------- */

/**
 * Precedence, loosest binding first. Each level parses the one below it and
 * then folds left, which is what makes `a - b - c` mean `(a - b) - c` and
 * `1 < 2 == 1` mean `(1 < 2) == 1`.
 */
const PRECEDENCE: BinaryOp[][] = [
  ["||"],
  ["&&"],
  ["==", "!="],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token?.type === "op" && token.value === value;
  }

  private eat(value: string): boolean {
    if (!this.isOp(value)) return false;
    this.position++;
    return true;
  }

  private expect(value: string): void {
    if (!this.eat(value)) throw new Error(`Expected "${value}"`);
  }

  parse(): FormulaNode {
    const node = this.binary(0);
    if (this.position < this.tokens.length) {
      const token = this.peek()!;
      throw new Error(`Unexpected ${token.type === "op" ? `"${token.value}"` : String(token.value)}`);
    }
    return node;
  }

  /** One precedence level; below the last one is exponentiation. */
  private binary(level: number): FormulaNode {
    const operators = PRECEDENCE[level];
    if (!operators) return this.power();

    let left = this.binary(level + 1);
    for (;;) {
      const op = operators.find(candidate => this.isOp(candidate));
      if (!op) return left;
      this.position++;
      left = { kind: "binary", op, left, right: this.binary(level + 1) };
    }
  }

  /** Exponentiation, right associative: `2 ^ 3 ^ 2` is 512, not 64. */
  private power(): FormulaNode {
    const base = this.unary();
    if (this.eat("^")) return { kind: "binary", op: "^", left: base, right: this.power() };
    return base;
  }

  private unary(): FormulaNode {
    for (const op of ["-", "+", "!"] as const) {
      if (this.isOp(op)) {
        this.position++;
        return { kind: "unary", op, operand: this.unary() };
      }
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const token = this.peek();
    if (!token) throw new Error("Unexpected end of expression");

    if (token.type === "number") {
      this.position++;
      return { kind: "number", value: token.value };
    }

    if (token.type === "ident") {
      this.position++;
      // An identifier followed by "(" is a call, otherwise a variable.
      if (this.isOp("(")) {
        const name = token.value as FunctionName;
        if (!FUNCTION_NAMES.includes(name)) {
          throw new Error(`Unknown function "${token.value}" (available: ${FUNCTION_NAMES.join(", ")})`);
        }
        this.expect("(");
        const args: FormulaNode[] = [];
        if (!this.isOp(")")) {
          do {
            args.push(this.binary(0));
          } while (this.eat(","));
        }
        this.expect(")");

        const arity = ARITY[name];
        if (args.length < arity.min || args.length > arity.max) {
          const wanted =
            arity.max === Infinity
              ? `at least ${arity.min}`
              : arity.min === arity.max
                ? `exactly ${arity.min}`
                : `${arity.min} to ${arity.max}`;
          throw new Error(`"${name}()" takes ${wanted} argument${arity.min === 1 && arity.max === 1 ? "" : "s"}`);
        }
        return { kind: "call", name, args };
      }
      return { kind: "ref", field: token.value };
    }

    if (this.eat("(")) {
      const node = this.binary(0);
      this.expect(")");
      return node;
    }

    throw new Error(`Unexpected "${token.value}"`);
  }
}

function collectRefs(node: FormulaNode, into: Set<string>): void {
  switch (node.kind) {
    case "ref":
      into.add(node.field);
      break;
    case "unary":
      collectRefs(node.operand, into);
      break;
    case "binary":
      collectRefs(node.left, into);
      collectRefs(node.right, into);
      break;
    case "call":
      node.args.forEach(arg => collectRefs(arg, into));
      break;
    case "number":
      break;
  }
}

/**
 * Parses an expression, and — when `available` is supplied — checks every
 * variable against it, so a typo in a pricing rule is caught while it is being
 * written rather than on the quote it silently mispriced.
 */
export function parseFormula(expression: string, available?: Iterable<string>): ParseResult {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: false, error: "Enter an expression, e.g. quantity * unitPrice" };

  let node: FormulaNode;
  try {
    node = new Parser(tokenize(trimmed)).parse();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid expression" };
  }

  const refs = new Set<string>();
  collectRefs(node, refs);

  if (available) {
    const known = new Set(available);
    const unknown = [...refs].filter(ref => !known.has(ref));
    if (unknown.length) {
      return { ok: false, error: `Unknown variable: ${unknown.map(name => `"${name}"`).join(", ")}` };
    }
  }

  return { ok: true, node, refs: [...refs] };
}

/* ------------------------------- evaluation ------------------------------ */

/** Sentinel for "this cannot be computed" — a divide by zero, a bad input. */
const UNCOMPUTABLE = Symbol("uncomputable");

type Value = number | typeof UNCOMPUTABLE;

/**
 * Variables reach the evaluator as whatever the caller had.
 *
 * Strings that look like numbers are accepted (a form field, an imported
 * file), booleans are 1 and 0 — which is what makes `option.premium * 200`
 * work — and a missing variable is 0 rather than an error, since a product
 * without an option simply does not have it selected.
 */
function toNumber(value: unknown): Value {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : UNCOMPUTABLE;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return UNCOMPUTABLE;
}

const bool = (value: number): number => (value ? 1 : 0);

function evaluate(node: FormulaNode, vars: Record<string, unknown>): Value {
  switch (node.kind) {
    case "number":
      return node.value;

    case "ref":
      return toNumber(vars[node.field]);

    case "unary": {
      const operand = evaluate(node.operand, vars);
      if (operand === UNCOMPUTABLE) return UNCOMPUTABLE;
      if (node.op === "-") return -operand;
      if (node.op === "!") return bool(!operand ? 1 : 0);
      return operand;
    }

    case "binary": {
      // Short-circuit, so `quantity > 0 && total / quantity > 10` does not
      // become uncomputable on the very rows the guard was written for.
      if (node.op === "&&" || node.op === "||") {
        const left = evaluate(node.left, vars);
        if (left === UNCOMPUTABLE) return UNCOMPUTABLE;
        if (node.op === "&&" && !left) return 0;
        if (node.op === "||" && left) return 1;
        const right = evaluate(node.right, vars);
        return right === UNCOMPUTABLE ? UNCOMPUTABLE : bool(right);
      }

      const left = evaluate(node.left, vars);
      const right = evaluate(node.right, vars);
      if (left === UNCOMPUTABLE || right === UNCOMPUTABLE) return UNCOMPUTABLE;

      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return right === 0 ? UNCOMPUTABLE : left / right;
        case "%":
          return right === 0 ? UNCOMPUTABLE : left % right;
        case "^":
          return left ** right;
        case "<":
          return bool(left < right ? 1 : 0);
        case "<=":
          return bool(left <= right ? 1 : 0);
        case ">":
          return bool(left > right ? 1 : 0);
        case ">=":
          return bool(left >= right ? 1 : 0);
        case "==":
          return bool(left === right ? 1 : 0);
        case "!=":
          return bool(left !== right ? 1 : 0);
      }
      // Unreachable: every BinaryOp is handled above.
      return UNCOMPUTABLE;
    }

    case "call": {
      // `if` picks a branch before evaluating it, so the branch not taken can
      // divide by zero without poisoning the result.
      if (node.name === "if") {
        const condition = evaluate(node.args[0]!, vars);
        if (condition === UNCOMPUTABLE) return UNCOMPUTABLE;
        return evaluate(node.args[condition ? 1 : 2]!, vars);
      }

      const args: number[] = [];
      for (const arg of node.args) {
        const value = evaluate(arg, vars);
        if (value === UNCOMPUTABLE) return UNCOMPUTABLE;
        args.push(value);
      }
      return FUNCTIONS[node.name](args);
    }
  }
}

/**
 * Evaluates a parsed expression. `null` means the result is not a finite
 * number — a divide by zero, or a variable that was not numeric.
 *
 * Callers decide what `null` means for them: a pricing rule that cannot be
 * computed does not fire (`src/lib/pricing.ts`), and an approval condition
 * that cannot be computed does not approve anything (`src/lib/approvals.ts`).
 * Neither silently substitutes a number.
 */
export function evaluateFormula(node: FormulaNode, vars: Record<string, unknown>, decimals?: number): number | null {
  const result = evaluate(node, vars);
  if (result === UNCOMPUTABLE || !Number.isFinite(result)) return null;
  // Always round: floating-point noise has no business reaching a price.
  const digits = typeof decimals === "number" && decimals >= 0 ? Math.min(decimals, 10) : 6;
  const factor = 10 ** digits;
  return Math.round(result * factor) / factor;
}

/** Parse and evaluate in one go, for a caller holding the expression as text. */
export function runFormula(
  expression: string,
  vars: Record<string, unknown>,
  decimals?: number,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const parsed = parseFormula(expression);
  if (!parsed.ok) return parsed;
  return { ok: true, value: evaluateFormula(parsed.node, vars, decimals) };
}

/**
 * Whether a condition holds.
 *
 * An empty condition is `true` — a rule with no condition applies always,
 * which is how every rule editor in the app presents a blank box. Anything
 * that cannot be computed is `false`: a rule whose condition is broken must
 * not fire, since firing is the side that changes a price.
 */
export function conditionHolds(expression: string, vars: Record<string, unknown>): boolean {
  if (!expression.trim()) return true;
  const result = runFormula(expression, vars);
  return result.ok && result.value !== null && result.value !== 0;
}
