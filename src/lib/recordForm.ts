/**
 * The record form on `/table`: what a click on a row opens, and how its
 * layout is described.
 *
 * A layout lives in the `record_forms` collection, one per collection per
 * organization, as JSON: sections of fields, each with a widget, a label and
 * whatever bounds it needs. A collection with no stored layout gets
 * `defaultLayout`, built from the record's own shape. So the form is
 * configured by editing a record — in the data table itself, if you like,
 * since `record_forms` is a collection like any other.
 *
 * Pure, and shared by the route and the page: the server resolves the same
 * layout the form was drawn from and refuses a write to anything it does not
 * offer as editable. That narrows what *this route* writes; it grants nothing.
 * PocketBase's rules still decide whether the caller may change the record at
 * all.
 *
 * Two kinds of value appear here. A *form value* is what an input holds — a
 * string for most widgets, a boolean for a checkbox, a list for tags. A
 * *record value* is what PocketBase stores. `toFormValue` and
 * `fromFormValue` cross between them, and `checkValue` judges a record value,
 * which is the half the server re-runs.
 */
import { isCollectionName, type FieldInfo, type TableRecord } from "./dataTable";

/* --------------------------------- the shape -------------------------------- */

export const RECORD_FORMS_COLLECTION = "record_forms";

export const FORM_WIDGETS = [
  "text",
  "textarea",
  "number",
  "checkbox",
  "date",
  "select",
  "email",
  "url",
  "tags",
  "json",
] as const;

export type FormWidget = (typeof FORM_WIDGETS)[number];

/** What happens to a record's fields the layout does not mention. */
export const REST_MODES = ["hidden", "readOnly"] as const;

export type RestMode = (typeof REST_MODES)[number];

/** One field as a layout describes it. Everything but `name` is optional. */
export type FormFieldConfig = {
  name: string;
  label?: string;
  widget?: FormWidget;
  /** Across both columns of a two-column section. */
  span?: 1 | 2;
  readOnly?: boolean;
  required?: boolean;
  help?: string;
  placeholder?: string;
  /** A `select`'s choices. */
  options?: string[];
  /** A number's bounds, or a text's length. */
  min?: number;
  max?: number;
  /** A `textarea` or `json` field's height. */
  rows?: number;
};

export type FormSection = {
  title: string;
  description: string;
  columns: 1 | 2;
  fields: FormFieldConfig[];
};

export type FormLayout = {
  sections: FormSection[];
  rest: RestMode;
};

/** A field with every choice made: what the form draws and the server checks. */
export type ResolvedField = {
  name: string;
  label: string;
  widget: FormWidget;
  span: 1 | 2;
  readOnly: boolean;
  required: boolean;
  help: string;
  placeholder: string;
  options: string[];
  min: number | null;
  max: number | null;
  rows: number;
};

export type ResolvedSection = { title: string; description: string; columns: 1 | 2; fields: ResolvedField[] };

/** A layout as stored in `record_forms`. */
export type RecordFormConfig = {
  id: string;
  collection: string;
  title: string;
  description: string;
  layout: FormLayout;
};

/** The form for one collection, as the route hands it out. */
export type RecordForm = {
  collection: string;
  title: string;
  description: string;
  layout: FormLayout;
  /** Whether the layout came from `record_forms` or was built from the record. */
  source: "stored" | "default";
  /** The `record_forms` record, when there is one. */
  configId: string | null;
  /** Why a stored layout was not used, when it could not be read. */
  problem: string | null;
  /** False where this route never writes — see `SERVER_OWNED`. */
  writable: boolean;
  readOnlyReason: string | null;
};

/** One record, and the form to draw it with. */
export type RecordWithForm = { record: TableRecord; form: RecordForm };

/* --------------------------- what is never written -------------------------- */

/**
 * Collections whose stored rows the server derives: it prices every quote and
 * totals every invoice it stores, and a ledger row is half of a balance. A raw
 * record write would skip all of that, so these open read-only, with the
 * reason, whatever a layout says.
 */
export const SERVER_OWNED: Record<string, string> = {
  quotes: "A quote is priced by the server on every save — edit it in the quote editor.",
  quote_lines: "A quote line is priced with its quote — edit it in the quote editor.",
  invoices: "An invoice's totals and numbering are kept by the server — edit it in Receivables.",
  invoice_lines: "An invoice line is totalled with its invoice — edit it in Receivables.",
  payments: "A payment is part of an invoice's balance — record or remove it in Receivables.",
  credits: "A credit is part of an invoice's balance — record or remove it in Receivables.",
  sys_attachment: "An attachment is a file on a record — add or remove it from that record's Attachments panel.",
};

/**
 * Fields a request never sets. PocketBase stamps the first three, and the
 * ownership hooks restore the rest on every update — writing them here would
 * look like it worked and change nothing.
 */
export const LOCKED_FIELDS = new Set([
  "id",
  "created",
  "updated",
  "owner",
  "org",
  "user",
  "sharedWith",
  "approvers",
  "supersededBy",
  "collectionId",
  "collectionName",
]);

/**
 * Fields locked in one collection only: a contact's auth fields (nobody signs
 * in as a contact — see 1750000014_account_normalize.js) and a location's
 * `name`, which pb_hooks/rules/locations.js derives from its parts on every
 * save. Elsewhere the same names are ordinary fields — an invitation's
 * `email` is the whole point of it.
 */
export const COLLECTION_LOCKED_FIELDS: Record<string, readonly string[]> = {
  contacts: ["email", "emailVisibility", "verified"],
  sys_physical_location: ["name"],
};

export const isLockedField = (collection: string, name: string): boolean =>
  LOCKED_FIELDS.has(name) || (COLLECTION_LOCKED_FIELDS[collection]?.includes(name) ?? false);

/** Shown last, in the "Record" section of a default layout. */
const RECORD_FIELDS = ["id", "owner", "org", "created", "updated"];

/** Whether this route writes to `collection` at all, and if not, why. */
export function writability(collection: string): { writable: boolean; readOnlyReason: string | null } {
  const reason = SERVER_OWNED[collection];
  return reason ? { writable: false, readOnlyReason: reason } : { writable: true, readOnlyReason: null };
}

/* ---------------------------------- labels ---------------------------------- */

/** `priceBook` → "Price book", `key_hash` → "Key hash", `api_keys` → "Api keys". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/* ------------------------------ default layouts ----------------------------- */

const LONG_TEXT = new Set(["body", "description", "notes", "summary", "message"]);

/** The widget a field of this inferred type gets when the layout does not say. */
export function widgetForType(type: FieldInfo["type"] | undefined, name = ""): FormWidget {
  switch (type) {
    case "number":
      return "number";
    case "boolean":
      return "checkbox";
    case "date":
      return "date";
    case "list":
      return "tags";
    case "json":
    case "unknown":
      return "json";
    default:
      if (/(^|_)email$|Email$/.test(name) || name === "email") return "email";
      if (/(^|_)(url|website)$|Url$/.test(name)) return "url";
      return LONG_TEXT.has(name) ? "textarea" : "text";
  }
}

/** A widget from one value, for a field a layout names but does not type. */
export function widgetForValue(value: unknown, name = ""): FormWidget {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return value.every(entry => typeof entry === "string") ? "tags" : "json";
  if (value !== null && typeof value === "object") return "json";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(value)) return "date";
  return widgetForType("text", name);
}

/**
 * What a collection with no stored layout gets: every field the record has,
 * the editable ones first and the bookkeeping read-only at the bottom.
 */
export function defaultLayout(fields: FieldInfo[]): FormLayout {
  const editable: FormFieldConfig[] = [];
  const record: FormFieldConfig[] = [];

  for (const field of fields) {
    const widget = widgetForType(field.type, field.name);
    const wide = widget === "json" || widget === "textarea" || widget === "tags";
    const config: FormFieldConfig = { name: field.name, widget, ...(wide ? { span: 2 as const } : {}) };
    if (RECORD_FIELDS.includes(field.name)) record.push({ ...config, readOnly: true });
    else editable.push(LOCKED_FIELDS.has(field.name) ? { ...config, readOnly: true } : config);
  }
  record.sort((a, b) => RECORD_FIELDS.indexOf(a.name) - RECORD_FIELDS.indexOf(b.name));

  const sections: FormSection[] = [];
  if (editable.length) sections.push({ title: "Fields", description: "", columns: 2, fields: editable });
  if (record.length) sections.push({ title: "Record", description: "", columns: 2, fields: record });
  return { sections, rest: "readOnly" };
}

/**
 * Layouts that ship with the app, used where a collection has none stored.
 * `record_forms` lays out its own records: the layout JSON is the one field
 * that matters, so it gets the room and a reminder of the shape.
 */
const BUILT_IN_LAYOUTS: Record<string, FormLayout> = {
  [RECORD_FORMS_COLLECTION]: {
    rest: "readOnly",
    sections: [
      {
        title: "Form",
        description: "Which collection this lays out, and the heading its form opens with.",
        columns: 2,
        fields: [
          { name: "collection", required: true, help: "A collection name, exactly." },
          { name: "title" },
          { name: "description", widget: "textarea", rows: 2, span: 2 },
        ],
      },
      {
        title: "Layout",
        description: "",
        columns: 1,
        fields: [
          {
            name: "layout",
            widget: "json",
            rows: 20,
            help:
              `{"sections": [{"title", "columns": 1|2, "fields": ["name", {"name", "label", "widget", "readOnly", ` +
              `"required", "span", "help", "options", "min", "max"}]}], "rest": "hidden"|"readOnly"}. ` +
              `Widgets: ${FORM_WIDGETS.join(", ")}. Checked before it is saved.`,
          },
          {
            name: "workspace",
            widget: "json",
            rows: 14,
            help:
              `The record workspace: {"relatedLists": [...], "summary": {"currencyField", "items": [...]}} — see ` +
              `src/lib/workspace.ts. Easier from the workspace's own Customize panel. Checked before it is saved.`,
          },
        ],
      },
    ],
  },
};

/** The layout a collection gets with nothing stored: its built-in one, or one from the record. */
export function fallbackLayout(collection: string, fields: FieldInfo[]): FormLayout {
  return BUILT_IN_LAYOUTS[collection] ?? defaultLayout(fields);
}

/* --------------------------- reading a stored layout ------------------------- */

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_SECTIONS = 20;
const MAX_FIELDS = 200;
const MAX_TEXT = 500;
const MAX_OPTIONS = 100;

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function optionalText(raw: Record<string, unknown>, key: string, where: string): Read<string | undefined> {
  const value = raw[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `${where}.${key} must be text.` };
  if (value.length > MAX_TEXT) return { ok: false, error: `${where}.${key} may be at most ${MAX_TEXT} characters.` };
  return { ok: true, value: value.trim() };
}

function optionalNumber(raw: Record<string, unknown>, key: string, where: string): Read<number | undefined> {
  const value = raw[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `${where}.${key} must be a number.` };
  return { ok: true, value };
}

function optionalBoolean(raw: Record<string, unknown>, key: string, where: string): Read<boolean | undefined> {
  const value = raw[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "boolean") return { ok: false, error: `${where}.${key} must be true or false.` };
  return { ok: true, value };
}

function readField(raw: unknown, where: string): Read<FormFieldConfig> {
  // A bare string is a field with every default.
  if (typeof raw === "string") raw = { name: raw };
  if (!isObject(raw)) return { ok: false, error: `${where} must be a field name or an object with a "name".` };

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!FIELD_NAME.test(name)) return { ok: false, error: `${where}.name ${name ? `"${name}" is not` : "must be"} a field name.` };
  const field: FormFieldConfig = { name };

  if (raw.widget !== undefined && raw.widget !== null) {
    if (!(FORM_WIDGETS as readonly unknown[]).includes(raw.widget)) {
      return { ok: false, error: `${where}.widget "${String(raw.widget)}" is not a widget — use one of ${FORM_WIDGETS.join(", ")}.` };
    }
    field.widget = raw.widget as FormWidget;
  }
  if (raw.span !== undefined && raw.span !== null) {
    if (raw.span !== 1 && raw.span !== 2) return { ok: false, error: `${where}.span must be 1 or 2.` };
    field.span = raw.span;
  }

  for (const key of ["label", "help", "placeholder"] as const) {
    const text = optionalText(raw, key, where);
    if (!text.ok) return text;
    if (text.value) field[key] = text.value;
  }
  for (const key of ["readOnly", "required"] as const) {
    const flag = optionalBoolean(raw, key, where);
    if (!flag.ok) return flag;
    if (flag.value !== undefined) field[key] = flag.value;
  }
  for (const key of ["min", "max", "rows"] as const) {
    const number = optionalNumber(raw, key, where);
    if (!number.ok) return number;
    if (number.value !== undefined) field[key] = number.value;
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    return { ok: false, error: `${where}: min (${field.min}) is more than max (${field.max}).` };
  }
  if (field.rows !== undefined && (!Number.isInteger(field.rows) || field.rows < 1 || field.rows > 40)) {
    return { ok: false, error: `${where}.rows must be a whole number from 1 to 40.` };
  }

  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options) || !raw.options.every(option => typeof option === "string")) {
      return { ok: false, error: `${where}.options must be a list of text.` };
    }
    if (raw.options.length > MAX_OPTIONS) return { ok: false, error: `${where}.options may hold at most ${MAX_OPTIONS}.` };
    field.options = [...new Set(raw.options.map(option => option.trim()).filter(Boolean))];
  }
  if (field.widget === "select" && !field.options?.length) {
    return { ok: false, error: `${where} is a select with no options.` };
  }
  return { ok: true, value: field };
}

/**
 * A layout from `record_forms`, checked, with a sentence naming the exact
 * place it went wrong. Accepts the parsed JSON or its text.
 */
export function readFormLayout(raw: unknown): Read<FormLayout> {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: "The layout is not valid JSON." };
    }
  }
  if (!isObject(raw)) return { ok: false, error: `The layout must be an object with "sections".` };
  if (!Array.isArray(raw.sections)) return { ok: false, error: `The layout needs a "sections" list.` };
  if (raw.sections.length > MAX_SECTIONS) return { ok: false, error: `A layout may have at most ${MAX_SECTIONS} sections.` };

  let rest: RestMode = "hidden";
  if (raw.rest !== undefined && raw.rest !== null) {
    if (!(REST_MODES as readonly unknown[]).includes(raw.rest)) {
      return { ok: false, error: `"rest" must be ${REST_MODES.map(mode => `"${mode}"`).join(" or ")}.` };
    }
    rest = raw.rest as RestMode;
  }

  const seen = new Set<string>();
  const sections: FormSection[] = [];
  let count = 0;

  for (const [index, entry] of raw.sections.entries()) {
    const where = `sections[${index}]`;
    if (!isObject(entry)) return { ok: false, error: `${where} must be an object with "fields".` };
    if (!Array.isArray(entry.fields)) return { ok: false, error: `${where} needs a "fields" list.` };

    const title = optionalText(entry, "title", where);
    if (!title.ok) return title;
    const description = optionalText(entry, "description", where);
    if (!description.ok) return description;
    const columns = entry.columns ?? 2;
    if (columns !== 1 && columns !== 2) return { ok: false, error: `${where}.columns must be 1 or 2.` };

    const fields: FormFieldConfig[] = [];
    for (const [position, rawField] of entry.fields.entries()) {
      const field = readField(rawField, `${where}.fields[${position}]`);
      if (!field.ok) return field;
      if (seen.has(field.value.name)) return { ok: false, error: `"${field.value.name}" appears twice in the layout.` };
      seen.add(field.value.name);
      fields.push(field.value);
    }
    count += fields.length;
    if (count > MAX_FIELDS) return { ok: false, error: `A layout may have at most ${MAX_FIELDS} fields.` };

    sections.push({ title: title.value ?? "", description: description.value ?? "", columns, fields });
  }

  return { ok: true, value: { sections, rest } };
}

/* ------------------------------- resolving ------------------------------- */

function resolveField(config: FormFieldConfig, value: unknown, columns: 1 | 2, form: RecordForm): ResolvedField {
  const widget = config.widget ?? widgetForValue(value, config.name);
  return {
    name: config.name,
    label: config.label || humanize(config.name),
    widget,
    span: columns === 1 ? 1 : (config.span ?? (widget === "json" || widget === "textarea" ? 2 : 1)),
    readOnly: !form.writable || isLockedField(form.collection, config.name) || config.readOnly === true,
    required: config.required === true,
    help: config.help ?? "",
    placeholder: config.placeholder ?? "",
    options: config.options ?? [],
    min: config.min ?? null,
    max: config.max ?? null,
    rows: config.rows ?? (widget === "json" ? 8 : 4),
  };
}

/**
 * The sections to draw for one record: the layout's, with every default
 * filled in, and — when `rest` says so — an "Other fields" section holding
 * whatever the record has that the layout does not mention, read-only.
 */
export function resolveSections(form: RecordForm, record: TableRecord): ResolvedSection[] {
  const sections: ResolvedSection[] = form.layout.sections.map(section => ({
    title: section.title,
    description: section.description,
    columns: section.columns,
    fields: section.fields.map(field => resolveField(field, record[field.name], section.columns, form)),
  }));

  if (form.layout.rest === "readOnly") {
    const named = new Set(form.layout.sections.flatMap(section => section.fields.map(field => field.name)));
    const others = Object.keys(record).filter(name => !named.has(name));
    if (others.length) {
      sections.push({
        title: "Other fields",
        description: "",
        columns: 2,
        fields: others.map(name => ({ ...resolveField({ name }, record[name], 2, form), readOnly: true })),
      });
    }
  }
  return sections.filter(section => section.fields.length > 0);
}

/** The fields this form lets you change, by name. */
export function editableFields(form: RecordForm, record: TableRecord): Map<string, ResolvedField> {
  return new Map(
    resolveSections(form, record)
      .flatMap(section => section.fields)
      .filter(field => !field.readOnly)
      .map(field => [field.name, field]),
  );
}

/* ------------------------------ form values ------------------------------ */

export type FormValue = string | boolean | string[];

export type FormValues = Record<string, FormValue>;

const pad = (n: number) => String(n).padStart(2, "0");

/** PocketBase's `2026-01-31 12:00:00.000Z` → `2026-01-31T13:00` on a clock an hour east. */
export function toLocalInput(stored: string): string {
  if (!stored) return "";
  const date = new Date(stored.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The reverse: a `datetime-local` value, read on this clock, as PocketBase stores it. */
export function fromLocalInput(local: string): string | null {
  if (!local) return "";
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().replace("T", " ");
}

/** What an input starts with for a stored value. */
export function toFormValue(field: ResolvedField, value: unknown): FormValue {
  switch (field.widget) {
    case "checkbox":
      return value === true;
    case "tags":
      return Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? [value] : [];
    case "json":
      return value === undefined || value === null || value === "" ? "" : JSON.stringify(value, null, 2);
    case "number":
      return typeof value === "number" ? String(value) : value === undefined || value === null ? "" : String(value);
    case "date":
      return typeof value === "string" ? toLocalInput(value) : "";
    default:
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORED_DATE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;

/** A form value as PocketBase will store it, or why it cannot be one. */
export function fromFormValue(field: ResolvedField, value: FormValue): Read<unknown> {
  switch (field.widget) {
    case "checkbox":
      return { ok: true, value: value === true };
    case "tags":
      return {
        ok: true,
        value: (Array.isArray(value) ? value : String(value).split(/\n/)).map(entry => entry.trim()).filter(Boolean),
      };
    case "number": {
      const text = String(value).trim();
      if (!text) return { ok: true, value: null };
      const number = Number(text);
      return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, error: `${field.label} must be a number.` };
    }
    case "json": {
      const text = String(value).trim();
      if (!text) return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, error: `${field.label} is not valid JSON.` };
      }
    }
    case "date": {
      const stored = fromLocalInput(String(value));
      return stored === null ? { ok: false, error: `${field.label} is not a date.` } : { ok: true, value: stored };
    }
    default:
      return { ok: true, value: typeof value === "string" ? value : String(value) };
  }
}

/**
 * Whether a record value fits its field: the half the server runs again on
 * every write. Null when it does.
 */
export function checkValue(field: ResolvedField, value: unknown): string | null {
  const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) return field.required && field.widget !== "checkbox" ? `${field.label} is required.` : null;

  switch (field.widget) {
    case "checkbox":
      return typeof value === "boolean" ? null : `${field.label} must be true or false.`;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${field.label} must be a number.`;
      if (field.min !== null && value < field.min) return `${field.label} must be at least ${field.min}.`;
      if (field.max !== null && value > field.max) return `${field.label} must be at most ${field.max}.`;
      return null;
    }
    case "tags":
      return Array.isArray(value) && value.every(entry => typeof entry === "string")
        ? null
        : `${field.label} must be a list of text.`;
    case "json":
      return null;
    case "date":
      return typeof value === "string" && STORED_DATE.test(value) ? null : `${field.label} is not a date.`;
    default: {
      if (typeof value !== "string") return `${field.label} must be text.`;
      if (field.min !== null && value.length < field.min) return `${field.label} needs at least ${field.min} characters.`;
      if (field.max !== null && value.length > field.max) return `${field.label} may be at most ${field.max} characters.`;
      if (field.widget === "email" && !EMAIL.test(value)) return `${field.label} is not an email address.`;
      if (field.widget === "url") {
        try {
          const url = new URL(value);
          if (url.protocol !== "http:" && url.protocol !== "https:") return `${field.label} must be an http(s) address.`;
        } catch {
          return `${field.label} is not a web address.`;
        }
      }
      if (field.widget === "select" && field.options.length && !field.options.includes(value)) {
        return `${field.label} must be one of ${field.options.join(", ")}.`;
      }
      return null;
    }
  }
}

/** A form value's problem, if any — what the form's field validator calls. */
export function fieldError(field: ResolvedField, value: FormValue): string | null {
  const converted = fromFormValue(field, value);
  return converted.ok ? checkValue(field, converted.value) : converted.error;
}

/** Every field's starting value, editable or not. */
export function initialValues(sections: ResolvedSection[], record: TableRecord): FormValues {
  return Object.fromEntries(
    sections.flatMap(section => section.fields).map(field => [field.name, toFormValue(field, record[field.name])]),
  );
}

const same = (a: FormValue, b: FormValue) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The change to send: only the editable fields whose input moved, as record
 * values. Compared in *form* space, so a date whose seconds the input cannot
 * show is not rewritten just because the form was opened.
 */
export function buildPatch(
  editable: Map<string, ResolvedField>,
  values: FormValues,
  record: TableRecord,
): { ok: true; patch: TableRecord } | { ok: false; errors: Record<string, string> } {
  const patch: TableRecord = {};
  const errors: Record<string, string> = {};
  for (const [name, field] of editable) {
    const value = values[name];
    if (value === undefined || same(value, toFormValue(field, record[name]))) continue;
    const converted = fromFormValue(field, value);
    const problem = converted.ok ? checkValue(field, converted.value) : converted.error;
    if (problem) errors[name] = problem;
    else if (converted.ok) patch[name] = converted.value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, patch };
}

/**
 * The server's check of a requested change: every key one the form offers
 * as editable, every value one its field accepts.
 */
export function checkPatch(editable: Map<string, ResolvedField>, patch: unknown): Read<TableRecord> {
  if (!isObject(patch)) return { ok: false, error: `"values" must be an object of field → value.` };
  for (const [name, value] of Object.entries(patch)) {
    const field = editable.get(name);
    if (!field) {
      return {
        ok: false,
        error: LOCKED_FIELDS.has(name)
          ? `"${name}" is set by PocketBase, not by a request.`
          : `"${name}" is not an editable field on this form.`,
      };
    }
    const problem = checkValue(field, value);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: patch };
}

/** A `record_forms` record's own fields, checked before one is saved. */
export function checkFormConfigPatch(patch: TableRecord): Read<TableRecord> {
  const next = { ...patch };
  if ("collection" in next) {
    const name = typeof next.collection === "string" ? next.collection.trim() : "";
    if (!isCollectionName(name)) return { ok: false, error: `"${name}" is not a collection name.` };
    next.collection = name;
  }
  if ("layout" in next) {
    const layout = readFormLayout(next.layout);
    if (!layout.ok) return { ok: false, error: `The layout cannot be used: ${layout.error}` };
    next.layout = layout.value;
  }
  return { ok: true, value: next };
}
