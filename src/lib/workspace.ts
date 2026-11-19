/**
 * The record workspace: what `/table` opens a record into. Three panes —
 *
 * - **details**, the record form (`FormLayout`, from src/lib/recordForm.ts);
 * - **related lists**, tabs of records that point at this one;
 * - **record summary**, a column of numbers about it, the way a quote's
 *   totals panel sits beside its lines.
 *
 * The second and third are a `WorkspaceLayout`, kept on the same
 * `record_forms` row as the form (its `workspace` JSON field), so one record
 * per collection per organization describes the whole page. Admins write it;
 * everybody reads it.
 *
 * Nothing here grants anything. A related list is a filter run with the
 * caller's own credential, so the related collection's rules decide which
 * rows appear; a roll-up adds up only what that filter returned. A layout can
 * be wrong — name a field that does not exist — and the page says so rather
 * than inventing a number.
 *
 * Pure, so the visual editor previews the summary with the same code the
 * server computes it with.
 */
import { evaluateFormula, parseFormula } from "./formula";
import { asCurrency, formatMoney, formatPercent } from "./money";
import { isCollectionName, type TableRecord } from "./dataTable";
import { quote as quoteFilterValue } from "./filterQuery";
import { humanize, LOCKED_FIELDS, SERVER_OWNED, type FormLayout } from "./recordForm";

/* --------------------------------- the shape -------------------------------- */

/** A condition every row in a related list must also meet: `target = "quotes"`. */
export type RelatedMatch = { field: string; value: string };

export type RelatedList = {
  /** Unique in the layout; how a roll-up names the list. */
  key: string;
  title: string;
  /** The collection the related records are in. */
  collection: string;
  /**
   * The field on *those* records that holds this record's id — a relation, a
   * text id, or a JSON path (`header.customer.accountId`).
   */
  field: string;
  /** Further fixed conditions, for a polymorphic link like `sys_attachment`. */
  match: RelatedMatch[];
  /** The columns the tab shows. Empty shows what the rows have. */
  columns: string[];
  /** PocketBase sort, e.g. `-created`. */
  sort: string;
  /** Whether to offer "New" in the tab. Never for a collection only the server writes. */
  allowCreate: boolean;
};

export const SUMMARY_FORMATS = ["text", "number", "money", "percent", "date", "badge"] as const;
export type SummaryFormat = (typeof SUMMARY_FORMATS)[number];

export const ROLLUP_OPS = ["count", "sum", "avg", "min", "max"] as const;
export type RollupOp = (typeof ROLLUP_OPS)[number];

type SummaryBase = {
  /** Unique in the layout; how a formula names this line. */
  key: string;
  label: string;
  format: SummaryFormat;
  /** Drawn as the line the panel is about — bold, with a rule above. */
  emphasis: boolean;
};

export type SummaryItem =
  | ({ kind: "field"; field: string } & SummaryBase)
  | ({ kind: "rollup"; list: string; op: RollupOp; field: string; where: string } & SummaryBase)
  | ({ kind: "formula"; expression: string } & SummaryBase)
  | { kind: "heading"; key: string; label: string };

export type SummaryLayout = {
  /** The record field naming the currency money is shown in; the org's default when it has none. */
  currencyField: string;
  items: SummaryItem[];
};

export type WorkspaceLayout = {
  relatedLists: RelatedList[];
  summary: SummaryLayout;
};

/* --------------------------------- limits --------------------------------- */

export const MAX_RELATED_LISTS = 12;
export const MAX_SUMMARY_ITEMS = 40;
export const MAX_COLUMNS = 12;
export const MAX_MATCHES = 4;
/** A roll-up reads at most this many rows; past it the line says it is partial. */
export const MAX_ROLLUP_ROWS = 5000;
const MAX_TEXT = 200;
const MAX_WHERE = 1000;
const MAX_EXPRESSION = 500;

/** A field, or a dotted path into a JSON field. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const SORT = /^[-+]?[A-Za-z_][A-Za-z0-9_.]*(,[-+]?[A-Za-z_][A-Za-z0-9_.]*)*$/;

export const EMPTY_WORKSPACE: WorkspaceLayout = { relatedLists: [], summary: { currencyField: "currency", items: [] } };

/* -------------------------------- defaults -------------------------------- */

const attachments = (target: string): RelatedList => ({
  key: "files",
  title: "Files",
  collection: "sys_attachment",
  field: "recordId",
  match: [{ field: "target", value: target }],
  columns: ["name", "size", "note", "created"],
  sort: "-created",
  allowCreate: true,
});

/**
 * What the collections this app knows about open with when nothing is
 * stored — the relations that exist, wired up, so the page is useful before
 * anybody configures it. Any other collection gets an empty workspace.
 */
const BUILT_IN: Record<string, WorkspaceLayout> = {
  accounts: {
    relatedLists: [
      {
        key: "contacts",
        title: "Contacts",
        collection: "contacts",
        field: "account",
        match: [],
        columns: ["name", "title", "contactEmail", "phone", "role", "primary"],
        sort: "-primary,name",
        allowCreate: true,
      },
      {
        key: "quotes",
        title: "Quotes",
        collection: "quotes",
        field: "header.customer.accountId",
        match: [],
        columns: ["number", "name", "status", "currency", "created"],
        sort: "-created",
        allowCreate: false,
      },
      {
        key: "invoices",
        title: "Invoices",
        collection: "invoices",
        field: "header.customer.accountId",
        match: [],
        columns: ["number", "state", "total", "dueDate", "created"],
        sort: "-created",
        allowCreate: false,
      },
      attachments("accounts"),
    ],
    summary: {
      currencyField: "currency",
      items: [
        { kind: "heading", key: "pipeline", label: "Pipeline" },
        { kind: "rollup", key: "quoteCount", label: "Quotes", list: "quotes", op: "count", field: "", where: "", format: "number", emphasis: false },
        { kind: "rollup", key: "won", label: "Accepted", list: "quotes", op: "count", field: "", where: 'status = "accepted"', format: "number", emphasis: false },
        { kind: "formula", key: "winRate", label: "Win rate", expression: "if(quoteCount > 0, won / quoteCount * 100, 0)", format: "percent", emphasis: false },
        { kind: "heading", key: "billing", label: "Billing" },
        { kind: "rollup", key: "invoiced", label: "Invoiced", list: "invoices", op: "sum", field: "total", where: 'state = "issued"', format: "money", emphasis: false },
        { kind: "field", key: "creditLimit", label: "Credit limit", field: "creditLimit", format: "money", emphasis: false },
        { kind: "field", key: "terms", label: "Payment terms (days)", field: "paymentTermDays", format: "number", emphasis: false },
      ],
    },
  },
  quotes: {
    relatedLists: [
      {
        key: "lines",
        title: "Lines",
        collection: "quote_lines",
        field: "quote",
        match: [],
        columns: ["sku", "name", "quantity", "unitPrice", "netTotal"],
        sort: "position",
        allowCreate: false,
      },
      {
        key: "invoices",
        title: "Invoices",
        collection: "invoices",
        field: "quote",
        match: [],
        columns: ["number", "state", "total", "dueDate"],
        sort: "-created",
        allowCreate: false,
      },
      {
        key: "revisions",
        title: "Revisions",
        collection: "quotes",
        field: "supersedes",
        match: [],
        columns: ["number", "name", "status", "created"],
        sort: "-created",
        allowCreate: false,
      },
      attachments("quotes"),
    ],
    summary: {
      currencyField: "currency",
      items: [
        { kind: "field", key: "status", label: "Status", field: "status", format: "badge", emphasis: false },
        { kind: "field", key: "lines", label: "Lines", field: "lineCount", format: "number", emphasis: false },
        { kind: "field", key: "validUntil", label: "Valid until", field: "validUntil", format: "date", emphasis: false },
        { kind: "heading", key: "totals", label: "Totals" },
        { kind: "field", key: "subtotal", label: "Subtotal", field: "totals.subtotal", format: "money", emphasis: false },
        { kind: "field", key: "discount", label: "Discount", field: "totals.effectiveDiscountPercent", format: "percent", emphasis: false },
        { kind: "field", key: "tax", label: "Tax", field: "totals.taxAmount", format: "money", emphasis: false },
        { kind: "field", key: "grandTotal", label: "Grand total", field: "totals.grandTotal", format: "money", emphasis: true },
        { kind: "rollup", key: "invoiced", label: "Invoiced", list: "invoices", op: "sum", field: "total", where: 'state != "void"', format: "money", emphasis: false },
        { kind: "formula", key: "toBill", label: "Left to invoice", expression: "grandTotal - invoiced", format: "money", emphasis: false },
      ],
    },
  },
  invoices: {
    relatedLists: [
      {
        key: "lines",
        title: "Lines",
        collection: "invoice_lines",
        field: "invoice",
        match: [],
        columns: ["sku", "description", "quantity", "unitPrice", "amount"],
        sort: "position",
        allowCreate: false,
      },
      {
        key: "payments",
        title: "Payments",
        collection: "payments",
        field: "invoice",
        match: [],
        columns: ["receivedOn", "amount", "method", "reference"],
        sort: "-receivedOn",
        allowCreate: false,
      },
      {
        key: "credits",
        title: "Credits",
        collection: "credits",
        field: "invoice",
        match: [],
        columns: ["issuedOn", "amount", "reason", "note"],
        sort: "-issuedOn",
        allowCreate: false,
      },
      attachments("invoices"),
    ],
    summary: {
      currencyField: "currency",
      items: [
        { kind: "field", key: "state", label: "State", field: "state", format: "badge", emphasis: false },
        { kind: "field", key: "dueDate", label: "Due", field: "dueDate", format: "date", emphasis: false },
        { kind: "heading", key: "balance", label: "Balance" },
        { kind: "field", key: "total", label: "Total", field: "total", format: "money", emphasis: false },
        { kind: "rollup", key: "paid", label: "Paid", list: "payments", op: "sum", field: "amount", where: "", format: "money", emphasis: false },
        { kind: "rollup", key: "credited", label: "Credited", list: "credits", op: "sum", field: "amount", where: "", format: "money", emphasis: false },
        { kind: "formula", key: "balanceDue", label: "Balance", expression: "total - paid - credited", format: "money", emphasis: true },
      ],
    },
  },
};

export function defaultWorkspace(collection: string): WorkspaceLayout {
  return structuredClone(BUILT_IN[collection] ?? EMPTY_WORKSPACE);
}

/* ---------------------------- reading a stored one -------------------------- */

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function text(raw: Record<string, unknown>, key: string, where: string, max = MAX_TEXT): Read<string> {
  const value = raw[key];
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: `${where}.${key} must be text.` };
  if (value.length > max) return { ok: false, error: `${where}.${key} may be at most ${max} characters.` };
  return { ok: true, value: value.trim() };
}

function key(raw: Record<string, unknown>, where: string, seen: Set<string>): Read<string> {
  const value = typeof raw.key === "string" ? raw.key.trim() : "";
  if (!KEY.test(value)) {
    return { ok: false, error: `${where}.key ${value ? `"${value}" is not` : "must be"} a name — letters, digits and underscores, starting with a letter.` };
  }
  if (seen.has(value)) return { ok: false, error: `"${value}" is used as a key twice.` };
  seen.add(value);
  return { ok: true, value };
}

function fieldPath(raw: Record<string, unknown>, name: string, where: string, required: boolean): Read<string> {
  const value = typeof raw[name] === "string" ? (raw[name] as string).trim() : "";
  if (!value) return required ? { ok: false, error: `${where}.${name} must name a field.` } : { ok: true, value: "" };
  if (!FIELD_PATH.test(value)) return { ok: false, error: `${where}.${name} "${value}" is not a field name.` };
  return { ok: true, value };
}

function readRelatedList(raw: unknown, where: string, keys: Set<string>): Read<RelatedList> {
  if (!isObject(raw)) return { ok: false, error: `${where} must be an object.` };
  const listKey = key(raw, where, keys);
  if (!listKey.ok) return listKey;
  const title = text(raw, "title", where);
  if (!title.ok) return title;

  const collection = typeof raw.collection === "string" ? raw.collection.trim() : "";
  if (!isCollectionName(collection)) return { ok: false, error: `${where}.collection must be a collection name.` };
  const field = fieldPath(raw, "field", where, true);
  if (!field.ok) return field;

  const match: RelatedMatch[] = [];
  if (raw.match !== undefined && raw.match !== null) {
    if (!Array.isArray(raw.match)) return { ok: false, error: `${where}.match must be a list.` };
    if (raw.match.length > MAX_MATCHES) return { ok: false, error: `${where}.match may hold at most ${MAX_MATCHES}.` };
    for (const [index, entry] of raw.match.entries()) {
      const at = `${where}.match[${index}]`;
      if (!isObject(entry)) return { ok: false, error: `${at} must be { field, value }.` };
      const matchField = fieldPath(entry, "field", at, true);
      if (!matchField.ok) return matchField;
      const value = text(entry, "value", at);
      if (!value.ok) return value;
      match.push({ field: matchField.value, value: value.value });
    }
  }

  const columns: string[] = [];
  if (raw.columns !== undefined && raw.columns !== null) {
    if (!Array.isArray(raw.columns) || !raw.columns.every(column => typeof column === "string")) {
      return { ok: false, error: `${where}.columns must be a list of field names.` };
    }
    if (raw.columns.length > MAX_COLUMNS) return { ok: false, error: `${where}.columns may hold at most ${MAX_COLUMNS}.` };
    for (const column of raw.columns as string[]) {
      if (!FIELD_PATH.test(column.trim())) return { ok: false, error: `${where}.columns: "${column}" is not a field name.` };
      if (!columns.includes(column.trim())) columns.push(column.trim());
    }
  }

  const sort = typeof raw.sort === "string" ? raw.sort.replace(/\s+/g, "") : "";
  if (sort && !SORT.test(sort)) return { ok: false, error: `${where}.sort "${sort}" is not a sort — e.g. "-created,name".` };

  return {
    ok: true,
    value: {
      key: listKey.value,
      title: title.value || humanize(collection),
      collection,
      field: field.value,
      match,
      columns,
      sort,
      allowCreate: raw.allowCreate === true,
    },
  };
}

function readSummaryItem(raw: unknown, where: string, keys: Set<string>, lists: Set<string>): Read<SummaryItem> {
  if (!isObject(raw)) return { ok: false, error: `${where} must be an object.` };
  const kind = raw.kind;
  const itemKey = key(raw, where, keys);
  if (!itemKey.ok) return itemKey;
  const label = text(raw, "label", where);
  if (!label.ok) return label;

  if (kind === "heading") return { ok: true, value: { kind, key: itemKey.value, label: label.value } };

  const format = raw.format ?? "number";
  if (!(SUMMARY_FORMATS as readonly unknown[]).includes(format)) {
    return { ok: false, error: `${where}.format must be one of ${SUMMARY_FORMATS.join(", ")}.` };
  }
  const base = {
    key: itemKey.value,
    label: label.value || humanize(itemKey.value),
    format: format as SummaryFormat,
    emphasis: raw.emphasis === true,
  };

  if (kind === "field") {
    const field = fieldPath(raw, "field", where, true);
    if (!field.ok) return field;
    return { ok: true, value: { kind, field: field.value, ...base } };
  }

  if (kind === "rollup") {
    const list = typeof raw.list === "string" ? raw.list.trim() : "";
    if (!lists.has(list)) {
      return { ok: false, error: `${where}.list must be the key of one of the related lists${list ? ` — there is no "${list}"` : ""}.` };
    }
    const op = raw.op ?? "count";
    if (!(ROLLUP_OPS as readonly unknown[]).includes(op)) {
      return { ok: false, error: `${where}.op must be one of ${ROLLUP_OPS.join(", ")}.` };
    }
    const field = fieldPath(raw, "field", where, op !== "count");
    if (!field.ok) return field;
    const filter = text(raw, "where", where, MAX_WHERE);
    if (!filter.ok) return filter;
    return { ok: true, value: { kind, list, op: op as RollupOp, field: op === "count" ? "" : field.value, where: filter.value, ...base } };
  }

  if (kind === "formula") {
    const expression = text(raw, "expression", where, MAX_EXPRESSION);
    if (!expression.ok) return expression;
    // Only the lines above it exist when it is worked out.
    const parsed = parseFormula(expression.value, [...keys].filter(name => name !== itemKey.value));
    if (!parsed.ok) return { ok: false, error: `${where} (${base.label}): ${parsed.error}` };
    return { ok: true, value: { kind, expression: expression.value, ...base } };
  }

  return { ok: false, error: `${where}.kind must be "field", "rollup", "formula" or "heading".` };
}

/**
 * A workspace from `record_forms.workspace`, checked, with a sentence naming
 * the exact place it went wrong. Accepts the parsed JSON or its text.
 */
export function readWorkspaceLayout(raw: unknown): Read<WorkspaceLayout> {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: "The workspace is not valid JSON." };
    }
  }
  if (!isObject(raw)) return { ok: false, error: `The workspace must be an object with "relatedLists" and "summary".` };

  const rawLists = raw.relatedLists ?? [];
  if (!Array.isArray(rawLists)) return { ok: false, error: `"relatedLists" must be a list.` };
  if (rawLists.length > MAX_RELATED_LISTS) return { ok: false, error: `A workspace may have at most ${MAX_RELATED_LISTS} related lists.` };

  const listKeys = new Set<string>();
  const relatedLists: RelatedList[] = [];
  for (const [index, entry] of rawLists.entries()) {
    const list = readRelatedList(entry, `relatedLists[${index}]`, listKeys);
    if (!list.ok) return list;
    relatedLists.push(list.value);
  }

  const rawSummary = raw.summary ?? {};
  if (!isObject(rawSummary)) return { ok: false, error: `"summary" must be an object with "items".` };
  const rawItems = rawSummary.items ?? [];
  if (!Array.isArray(rawItems)) return { ok: false, error: `"summary.items" must be a list.` };
  if (rawItems.length > MAX_SUMMARY_ITEMS) return { ok: false, error: `A summary may have at most ${MAX_SUMMARY_ITEMS} lines.` };

  const currencyField = fieldPath(rawSummary, "currencyField", "summary", false);
  if (!currencyField.ok) return currencyField;

  const itemKeys = new Set<string>();
  const items: SummaryItem[] = [];
  for (const [index, entry] of rawItems.entries()) {
    const item = readSummaryItem(entry, `summary.items[${index}]`, itemKeys, listKeys);
    if (!item.ok) return item;
    items.push(item.value);
  }

  return { ok: true, value: { relatedLists, summary: { currencyField: currencyField.value || "currency", items } } };
}

/* ------------------------------ related lists ------------------------------ */

/** Whether a related list may offer "New": a plain field link into a collection people write. */
export function canCreateIn(list: RelatedList): boolean {
  return list.allowCreate && !list.field.includes(".") && (!SERVER_OWNED[list.collection] || list.collection === "sys_attachment");
}

/** The PocketBase filter for one record's rows in a related list. Quoting is filterQuery's. */
export function relatedFilter(list: RelatedList, recordId: string, extra = ""): string {
  const parts = [
    `${list.field} = ${quoteFilterValue(recordId)}`,
    ...list.match.map(match => `${match.field} = ${quoteFilterValue(match.value)}`),
  ];
  if (extra.trim()) parts.push(`(${extra.trim()})`);
  return parts.join(" && ");
}

/** The values a new related record starts with, so it points back at this one. */
export function relatedDefaults(list: RelatedList, recordId: string): TableRecord {
  return Object.fromEntries([[list.field, recordId], ...list.match.map(match => [match.field, match.value])]);
}

/** Never typed into a new record: PocketBase or the hooks set these. */
const STAMPED = new Set(["id", "created", "updated"]);

/**
 * The form a new related record is written in: its collection's layout less
 * everything a request cannot set (stamped and locked fields, read-only ones)
 * and less the link, which is filled in rather than typed. Nothing else is
 * left out — "rest" fields are never shown for a blank record.
 */
export function layoutForCreate(layout: FormLayout, linkFields: Iterable<string>): FormLayout {
  const link = new Set(linkFields);
  return {
    rest: "hidden",
    sections: layout.sections
      .map(section => ({
        ...section,
        fields: section.fields.filter(
          field => !field.readOnly && !LOCKED_FIELDS.has(field.name) && !STAMPED.has(field.name) && !link.has(field.name),
        ),
      }))
      .filter(section => section.fields.length > 0),
  };
}

/** A key not yet in `taken`: `total`, then `total2`, `total3`… */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = base.replace(/[^A-Za-z0-9_]/g, "").replace(/^[^A-Za-z_]+/, "") || "item";
  const root = clean.slice(0, 36);
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) if (!used.has(`${root}${n}`)) return `${root}${n}`;
}

/* -------------------------------- the summary ------------------------------- */

/** `a.b.c` into a record, through JSON fields. */
export function readPath(record: TableRecord, path: string): unknown {
  let value: unknown = record;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** What a roll-up came to: the number, how many rows it read, and whether it stopped short. */
export type RollupResult = { value: number | null; rows: number; partial: boolean; error?: string };

/** Count, sum, average, least or most — of numbers only; a blank or text value is skipped, not zero. */
export function rollup(op: RollupOp, values: unknown[], total = values.length): number | null {
  if (op === "count") return total;
  const numbers = values.map(value => (typeof value === "number" ? value : Number.NaN)).filter(Number.isFinite);
  if (!numbers.length) return op === "sum" ? 0 : null;
  switch (op) {
    case "sum":
      return Math.round(numbers.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6;
    case "avg":
      return Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 1e6) / 1e6;
    case "min":
      return Math.min(...numbers);
    case "max":
      return Math.max(...numbers);
  }
}

export type SummaryLine =
  | { kind: "heading"; key: string; label: string }
  | {
      kind: "value";
      key: string;
      label: string;
      format: SummaryFormat;
      emphasis: boolean;
      /** The raw value — a number for anything a formula can use. */
      value: unknown;
      /** As it should be read. "—" when there is nothing to show. */
      display: string;
      /** Why the value is missing or partial, when it is. */
      note: string;
    };

export type ComputedSummary = { currency: string; lines: SummaryLine[] };

function display(value: unknown, format: SummaryFormat, currency: string, locale?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (format) {
    case "money":
      return typeof value === "number" ? formatMoney(value, asCurrency(currency), locale) : String(value);
    case "percent":
      return typeof value === "number" ? formatPercent(value) : String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString(locale) : String(value);
    case "date": {
      if (typeof value !== "string") return String(value);
      const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value.replace(" ", "T"));
      return Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
    }
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/**
 * Works the summary out, top to bottom. Fields read the record, roll-ups
 * come from `rollups` (the server reads those rows, as the caller), and a
 * formula sees every line above it by key — so a formula can refer to a
 * roll-up, and a later formula to an earlier one, but nothing refers forward.
 */
export function computeSummary(
  layout: SummaryLayout,
  record: TableRecord,
  rollups: Record<string, RollupResult>,
  options: { defaultCurrency?: string; locale?: string } = {},
): ComputedSummary {
  const currency = String(readPath(record, layout.currencyField || "currency") || options.defaultCurrency || "USD");
  const vars: Record<string, unknown> = {};
  const lines: SummaryLine[] = [];

  for (const item of layout.items) {
    if (item.kind === "heading") {
      lines.push(item);
      continue;
    }

    let value: unknown = null;
    let note = "";
    if (item.kind === "field") {
      value = readPath(record, item.field);
      if (value === undefined) note = `This record has no "${item.field}".`;
    } else if (item.kind === "rollup") {
      const result = rollups[item.key];
      if (!result) note = "Not worked out.";
      else if (result.error) note = result.error;
      else {
        value = result.value;
        if (result.partial) note = `From the first ${result.rows.toLocaleString()} rows only.`;
      }
    } else {
      const parsed = parseFormula(item.expression);
      if (!parsed.ok) note = parsed.error;
      else {
        // A blank line is not a zero: a balance worked out from a payment
        // total nobody could read would be a confident wrong number.
        const blank = parsed.refs.filter(ref => typeof vars[ref] !== "number");
        if (blank.length) note = `Needs ${blank.join(", ")}, which ${blank.length === 1 ? "has" : "have"} no number.`;
        else {
          value = evaluateFormula(parsed.node, vars);
          if (value === null) note = "Cannot be worked out from the lines it uses.";
        }
      }
    }

    vars[item.key] = value;
    lines.push({
      kind: "value",
      key: item.key,
      label: item.label,
      format: item.format,
      emphasis: item.emphasis,
      value: value ?? null,
      display: display(value, item.format, currency, options.locale),
      note,
    });
  }

  return { currency, lines };
}

/** Every roll-up in a layout, with the related list it reads. */
export function rollupsOf(layout: WorkspaceLayout): { item: Extract<SummaryItem, { kind: "rollup" }>; list: RelatedList }[] {
  const lists = new Map(layout.relatedLists.map(list => [list.key, list]));
  return layout.summary.items.flatMap(item => {
    if (item.kind !== "rollup") return [];
    const list = lists.get(item.list);
    return list ? [{ item, list }] : [];
  });
}

/* ----------------------------- the whole page ------------------------------ */

/** What `GET /api/workspace/:collection/:id` answers with, beside the record and its form. */
export type WorkspaceView = {
  workspace: WorkspaceLayout;
  /** Where it came from: stored on `record_forms`, or the built-in / empty default. */
  workspaceSource: "stored" | "default";
  /** A stored workspace that failed its check, and why — the default is shown instead. */
  workspaceProblem: string | null;
  summary: ComputedSummary;
  /** Each related list's row count, for the tab labels. Null where the collection refused. */
  counts: Record<string, number | null>;
};
