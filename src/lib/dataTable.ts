/**
 * The record browser on `/table`: which collection, which page, in what order,
 * and what its columns are.
 *
 * Pure, and shared by the route (`GET /api/table/:collection`) and the page, so
 * a bound the page offers is the bound the server keeps.
 *
 * A user token cannot read a collection's schema — that is a superuser call,
 * and this server holds no superuser credential. So the columns are *inferred*
 * from the records the caller can see: a field nobody can read is a field the
 * table does not show, which is the right answer anyway.
 */

/** What a collection name may look like. Anything else never reaches PocketBase. */
export const COLLECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

export const isCollectionName = (value: string) => COLLECTION_NAME.test(value);

/**
 * The collections worth offering by name. Not a whitelist: any name may be
 * asked for, and PocketBase's rules answer — `counters`, which no user rule
 * reaches, answers 403 whoever asks.
 */
export const BROWSABLE_COLLECTIONS = [
  "accounts",
  "contacts",
  "sys_physical_location",
  "products",
  "price_books",
  "pricing_rules",
  "approval_rules",
  "proposal_templates",
  "quotes",
  "quote_lines",
  "invoices",
  "invoice_lines",
  "payments",
  "credits",
  "organizations",
  "memberships",
  "invitations",
  "api_keys",
  "users",
  "record_forms",
] as const;

export const TABLE_PAGE_SIZES = [10, 25, 50, 100, 200] as const;
export const DEFAULT_TABLE_PAGE_SIZE = 25;
export const MAX_TABLE_PAGE_SIZE = TABLE_PAGE_SIZES.at(-1)!;

/** The bookkeeping PocketBase adds to every record; not columns. */
const META_KEYS = new Set(["collectionId", "collectionName", "expand"]);

/** First, in this order, wherever they exist; the rest follow alphabetically. */
const LEADING_FIELDS = ["id", "number", "name", "email", "status", "state"];
const TRAILING_FIELDS = ["created", "updated"];

export const FIELD_TYPES = ["text", "number", "boolean", "date", "list", "json", "unknown"] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldInfo = { name: string; type: FieldType };

export type TableRecord = Record<string, unknown>;

export type TablePage = {
  collection: string;
  filter: string;
  sort: string;
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: TableRecord[];
  fields: FieldInfo[];
};

/** `2026-01-31 12:00:00.000Z`, the way PocketBase stores a date — or ISO-8601. */
const DATE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;

/** One value's type, or null when it says nothing (empty, null). */
function typeOfValue(value: unknown): FieldType | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return value.length === 0 ? null : value.every(entry => typeof entry === "string") ? "list" : "json";
  if (typeof value === "object") return "json";
  if (typeof value === "string") return DATE.test(value) ? "date" : "text";
  return "unknown";
}

/**
 * The columns of a page of records: every key any of them has, typed by the
 * values seen. A field that disagrees with itself across rows is `unknown`
 * rather than whichever row happened to come first.
 *
 * An empty array or an empty string counts as no evidence: PocketBase writes
 * `""` for an unset date and `[]` for an unset multi-select, and neither
 * should make a column look like text.
 */
export function inferFields(records: TableRecord[]): FieldInfo[] {
  const types = new Map<string, FieldType | null>();

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (META_KEYS.has(key)) continue;
      const seen = typeOfValue(value);
      const known = types.get(key);
      if (known === undefined || known === null) types.set(key, seen);
      else if (seen !== null && seen !== known) types.set(key, "unknown");
    }
  }

  const names = [...types.keys()];
  const rank = (name: string) => {
    const leading = LEADING_FIELDS.indexOf(name);
    if (leading !== -1) return leading;
    const trailing = TRAILING_FIELDS.indexOf(name);
    if (trailing !== -1) return 1000 + trailing;
    return 100;
  };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  return names.map(name => ({ name, type: types.get(name) ?? (name === "created" || name === "updated" ? "date" : "text") }));
}

/** The records without PocketBase's bookkeeping keys. */
export const stripMeta = (record: TableRecord): TableRecord =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !META_KEYS.has(key)));

/* --------------------------------- sort -------------------------------- */

export type SortEntry = { id: string; desc: boolean };

const SORT_FIELD = /^[A-Za-z_@#][A-Za-z0-9_.@#:]*$/;

/** `[{ id: "created", desc: true }, { id: "name" }]` → `-created,name`. */
export const sortParam = (sorting: SortEntry[]) =>
  sorting.map(entry => `${entry.desc ? "-" : ""}${entry.id}`).join(",");

/**
 * A `sort` parameter checked field by field. PocketBase would refuse a bad one
 * too, but with a message that does not say which part was bad.
 */
export function readSort(raw: string | null): { ok: true; value: string } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, value: "" };
  for (const part of text.split(",")) {
    const field = part.trim().replace(/^[-+]/, "");
    if (!SORT_FIELD.test(field)) return { ok: false, error: `"${part.trim()}" is not a field to sort by.` };
  }
  return { ok: true, value: text.split(",").map(part => part.trim()).join(",") };
}

/** Which value kind a builder condition starts with for a field of this type. */
export const valueKindFor = (type: FieldType | undefined) =>
  type === "number" ? "number" : type === "boolean" ? "boolean" : "string";

/** Whether the "any…" operators (`?=`) are the natural ones — a field holding a list. */
export const isListField = (type: FieldType | undefined) => type === "list" || type === "json";

/* ------------------------------ the page URL ------------------------------ */

export const TABLE_PAGE_PATH = "/table";

/** `/table?table_name=quotes&query=…&record=…` — the link that opens one view, and one record in it. */
export function tablePageUrl(collection: string, filter = "", record = ""): string {
  const params = new URLSearchParams({ table_name: collection });
  if (filter.trim()) params.set("query", filter);
  if (record) params.set("record", record);
  return `${TABLE_PAGE_PATH}?${params}`;
}
