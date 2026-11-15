/**
 * The data table's record form: one record, the layout to draw it with, and
 * the write that saves it. What a click on a row in `/table` opens.
 *
 *   GET   /api/table/:collection/:id   the record and its form
 *   PATCH /api/table/:collection/:id   change the fields the form offers
 *   POST  /api/record-forms/:collection   store the default layout to edit
 *
 * Like the listing, everything goes out on the caller's own credential. The
 * layout narrows what this route will write — a field the form shows as
 * read-only, or does not show, is refused here — but it is not access
 * control: PocketBase's update rule for the collection still decides whether
 * the caller may change the record at all, and answers 403 if not.
 *
 * Quotes, invoices and ledger rows are never written here (`SERVER_OWNED`):
 * the server prices and totals them on every save, and a raw write would
 * skip that.
 */
import { ClientResponseError } from "pocketbase";
import { inferFields, isCollectionName, stripMeta, type TableRecord } from "../lib/dataTable";
import {
  checkFormConfigPatch,
  checkPatch,
  editableFields,
  fallbackLayout,
  humanize,
  readFormLayout,
  RECORD_FORMS_COLLECTION,
  writability,
  type RecordForm,
  type RecordFormConfig,
  type RecordWithForm,
} from "../lib/recordForm";
import { ApiError, asRecord } from "./http";
import { clientFor, toApiError } from "./pocketbase";

const RECORD_ID = /^[A-Za-z0-9_]{1,100}$/;

function checkNames(collection: string, id?: string) {
  if (!isCollectionName(collection)) throw new ApiError(`"${collection}" is not a collection name.`);
  if (id !== undefined && !RECORD_ID.test(id)) throw new ApiError(`"${id}" is not a record id.`);
}

/** PocketBase's answers, in sentences about this record. */
function explain(error: unknown, collection: string, id: string, doing: "read" | "change"): ApiError {
  if (error instanceof ClientResponseError) {
    // PocketBase applies an update rule as a filter, so a refused write reads
    // as "not found" — of a record that was found a moment ago.
    if (error.status === 404 && doing === "read") {
      return new ApiError(`There is no record "${id}" in "${collection}" that you can see.`, 404);
    }
    if (error.status === 403 || error.status === 404) {
      return new ApiError(`You may not ${doing} this record — the rules of "${collection}" do not let your account.`, 403);
    }
  }
  return toApiError(error, doing === "read" ? `Could not read "${collection}/${id}"` : `PocketBase refused the change`);
}

/** The organization's stored layout for a collection, or null when there is none. */
async function storedConfig(token: string, collection: string): Promise<{ id: string; raw: TableRecord } | null> {
  const client = clientFor(token);
  try {
    const list = await client
      .collection(RECORD_FORMS_COLLECTION)
      .getList<TableRecord>(1, 1, { filter: client.filter("collection = {:collection}", { collection }) });
    const row = list.items[0];
    return row ? { id: String(row.id), raw: row } : null;
  } catch (error) {
    // No layouts readable — the default is the honest answer, not a failure.
    if (error instanceof ClientResponseError && (error.status === 403 || error.status === 404)) return null;
    throw toApiError(error, "Could not read the form layout");
  }
}

/** The form for one record: the stored layout if it reads, otherwise the record's own shape. */
export async function formFor(token: string, collection: string, record: TableRecord): Promise<RecordForm> {
  const stored = await storedConfig(token, collection);
  const base = {
    collection,
    configId: stored?.id ?? null,
    ...writability(collection),
  };

  if (stored) {
    const layout = readFormLayout(stored.raw.layout);
    if (layout.ok) {
      return {
        ...base,
        title: String(stored.raw.title || humanize(collection)),
        description: String(stored.raw.description ?? ""),
        layout: layout.value,
        source: "stored",
        problem: null,
      };
    }
    return {
      ...base,
      title: humanize(collection),
      description: "",
      layout: fallbackLayout(collection, inferFields([record])),
      source: "default",
      problem: `The stored layout could not be used, so this is the default: ${layout.error}`,
    };
  }

  return {
    ...base,
    title: humanize(collection),
    description: "",
    layout: fallbackLayout(collection, inferFields([record])),
    source: "default",
    problem: null,
  };
}

async function readOne(token: string, collection: string, id: string): Promise<TableRecord> {
  try {
    return stripMeta(await clientFor(token).collection(collection).getOne<TableRecord>(id));
  } catch (error) {
    throw explain(error, collection, id, "read");
  }
}

export async function readRecord(token: string, collection: string, id: string): Promise<RecordWithForm> {
  checkNames(collection, id);
  const record = await readOne(token, collection, id);
  return { record, form: await formFor(token, collection, record) };
}

export type RecordUpdate = { values: TableRecord; updated: string | null };

export function readRecordUpdate(raw: unknown): RecordUpdate {
  const body = asRecord(raw);
  const values = body.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new ApiError(`The body needs "values": an object of field → value.`);
  }
  if (body.updated !== undefined && body.updated !== null && typeof body.updated !== "string") {
    throw new ApiError(`"updated" must be the record's \`updated\` stamp, as it was read.`);
  }
  return { values: values as TableRecord, updated: (body.updated as string | undefined) ?? null };
}

/**
 * Change the fields the form offers. `updated`, when given, is the stamp the
 * form was opened with: a record changed since then is refused with a 409
 * rather than overwritten, so two people editing one row do not silently
 * undo each other. (A collection with no `updated` field cannot be checked.)
 */
export async function updateRecord(token: string, collection: string, id: string, update: RecordUpdate): Promise<RecordWithForm> {
  checkNames(collection, id);
  const current = await readOne(token, collection, id);
  const form = await formFor(token, collection, current);
  if (!form.writable) throw new ApiError(form.readOnlyReason ?? "This record is not written here.", 409);

  if (update.updated && typeof current.updated === "string" && current.updated !== update.updated) {
    throw new ApiError("This record has changed since you opened it. Reload it, then make your change again.", 409);
  }

  const checked = checkPatch(editableFields(form, current), update.values);
  if (!checked.ok) throw new ApiError(checked.error);
  let patch = checked.value;

  // A layout is only worth storing if it can be drawn.
  if (collection === RECORD_FORMS_COLLECTION) {
    const config = checkFormConfigPatch(patch);
    if (!config.ok) throw new ApiError(config.error);
    patch = config.value;
  }

  if (Object.keys(patch).length === 0) return { record: current, form };

  let saved: TableRecord;
  try {
    saved = stripMeta(await clientFor(token).collection(collection).update<TableRecord>(id, patch));
  } catch (error) {
    throw explain(error, collection, id, "change");
  }
  return { record: saved, form: await formFor(token, collection, saved) };
}

/**
 * Store the default layout for a collection, so there is something in
 * `record_forms` to edit. Built from one record the caller can see; a
 * collection they can see nothing of has no shape to start from.
 */
export async function createRecordForm(token: string, collection: string): Promise<RecordFormConfig> {
  checkNames(collection);
  if (await storedConfig(token, collection)) {
    throw new ApiError(`"${collection}" already has a layout — edit it in ${RECORD_FORMS_COLLECTION}.`, 409);
  }

  let sample: TableRecord[];
  try {
    sample = (await clientFor(token).collection(collection).getList<TableRecord>(1, 1)).items;
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      throw new ApiError(`There is no collection called "${collection}".`, 404);
    }
    if (error instanceof ClientResponseError && error.status === 403) {
      throw new ApiError(`You may not list "${collection}" — its rules do not let your account read it.`, 403);
    }
    throw toApiError(error, `Could not read "${collection}"`);
  }
  if (sample.length === 0) {
    throw new ApiError(`"${collection}" has no record you can see to build a layout from.`, 409);
  }

  const layout = fallbackLayout(collection, inferFields(sample));
  let created: TableRecord;
  try {
    created = await clientFor(token)
      .collection(RECORD_FORMS_COLLECTION)
      .create<TableRecord>({ collection, title: humanize(collection), description: "", layout });
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 403) {
      throw new ApiError("Only an admin may change how records are laid out.", 403);
    }
    throw toApiError(error, "Could not store the layout");
  }
  return {
    id: String(created.id),
    collection,
    title: String(created.title ?? ""),
    description: String(created.description ?? ""),
    layout,
  };
}
