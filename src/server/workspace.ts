/**
 * The record workspace: a record, its form, its related lists and its
 * summary — what `/table` opens a row into. See src/lib/workspace.ts for the
 * model.
 *
 *   GET  /api/workspace/:collection/:id          the page, from the stored workspace
 *   POST /api/workspace/:collection/:id/preview  the same, from a draft workspace
 *   GET  /api/record-forms/:collection           the stored (or default) layouts, and the fields to pick from
 *   PUT  /api/record-forms/:collection           store both layouts — admins
 *   POST /api/table/:collection                  create a record through its form
 *
 * Everything goes out on the caller's own credential. A related list is a
 * filter PocketBase runs under that collection's rules, and a roll-up adds up
 * only the rows that filter let through: a sales member's "Invoiced" can
 * never include an invoice they could not open.
 */
import { ClientResponseError } from "pocketbase";
import { inferFields, type FieldInfo, type TableRecord } from "../lib/dataTable";
import {
  checkPatch,
  editableFields,
  fallbackLayout,
  humanize,
  LOCKED_FIELDS,
  readFormLayout,
  RECORD_FORMS_COLLECTION,
  widgetForType,
  writability,
  type FormLayout,
  type RecordForm,
} from "../lib/recordForm";
import {
  computeSummary,
  defaultWorkspace,
  MAX_ROLLUP_ROWS,
  readWorkspaceLayout,
  relatedFilter,
  rollup,
  rollupsOf,
  type RollupResult,
  type WorkspaceLayout,
  type WorkspaceView,
} from "../lib/workspace";
import { requireContext } from "./context";
import { ApiError, asRecord } from "./http";
import { clientFor, toApiError } from "./pocketbase";
import { checkNames, formFor, readOne, storedConfig } from "./recordForms";

/* ------------------------------ the workspace ------------------------------ */

/** The workspace stored for a collection, or its default — and why the stored one was not used, if it was not. */
function resolveWorkspace(collection: string, raw: unknown): Pick<WorkspaceView, "workspace" | "workspaceSource" | "workspaceProblem"> {
  const empty = raw === undefined || raw === null || raw === "" || (typeof raw === "object" && Object.keys(raw as object).length === 0);
  if (empty) return { workspace: defaultWorkspace(collection), workspaceSource: "default", workspaceProblem: null };
  const read = readWorkspaceLayout(raw);
  return read.ok
    ? { workspace: read.value, workspaceSource: "stored", workspaceProblem: null }
    : {
        workspace: defaultWorkspace(collection),
        workspaceSource: "default",
        workspaceProblem: `The stored workspace could not be used, so this is the default: ${read.error}`,
      };
}

/** A PocketBase refusal of a related list, as a sentence for the line that needed it. */
function listProblem(error: unknown, collection: string): string {
  if (error instanceof ClientResponseError) {
    if (error.status === 403) return `You may not read "${collection}".`;
    if (error.status === 404) return `There is no collection "${collection}".`;
    if (error.status === 400) return `PocketBase refused the filter — check the field names.`;
  }
  return error instanceof Error ? error.message : "Could not be read.";
}

/** How many rows each related list holds for this record, as the caller sees them. */
async function countLists(token: string, workspace: WorkspaceLayout, recordId: string): Promise<Record<string, number | null>> {
  const client = clientFor(token);
  const entries = await Promise.all(
    workspace.relatedLists.map(async list => {
      try {
        const page = await client
          .collection(list.collection)
          .getList(1, 1, { filter: relatedFilter(list, recordId), fields: "id" });
        return [list.key, page.totalItems] as const;
      } catch {
        return [list.key, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** Every roll-up's value, read row by row through the caller's credential. */
async function computeRollups(token: string, workspace: WorkspaceLayout, recordId: string): Promise<Record<string, RollupResult>> {
  const client = clientFor(token);
  const results = await Promise.all(
    rollupsOf(workspace).map(async ({ item, list }) => {
      const filter = relatedFilter(list, recordId, item.where);
      try {
        if (item.op === "count") {
          const page = await client.collection(list.collection).getList(1, 1, { filter, fields: "id" });
          return [item.key, { value: page.totalItems, rows: page.totalItems, partial: false }] as const;
        }
        // PocketBase has no aggregates over REST: read the one field, a page at a time, up to the cap.
        const values: unknown[] = [];
        const top = item.field.split(".")[0]!;
        let page = 1;
        let total = 0;
        while (values.length < MAX_ROLLUP_ROWS) {
          const batch = await client
            .collection(list.collection)
            .getList<TableRecord>(page, 500, { filter, fields: `id,${top}`, skipTotal: page > 1 });
          if (page === 1) total = batch.totalItems;
          for (const row of batch.items) {
            let value: unknown = row;
            for (const part of item.field.split(".")) value = (value as Record<string, unknown> | null)?.[part];
            values.push(value);
          }
          if (batch.items.length < 500) break;
          page++;
        }
        return [
          item.key,
          { value: rollup(item.op, values.slice(0, MAX_ROLLUP_ROWS)), rows: Math.min(values.length, MAX_ROLLUP_ROWS), partial: total > MAX_ROLLUP_ROWS },
        ] as const;
      } catch (error) {
        return [item.key, { value: null, rows: 0, partial: false, error: listProblem(error, list.collection) }] as const;
      }
    }),
  );
  return Object.fromEntries(results);
}

async function viewFor(
  token: string,
  record: TableRecord,
  resolved: Pick<WorkspaceView, "workspace" | "workspaceSource" | "workspaceProblem">,
): Promise<WorkspaceView> {
  const id = String(record.id ?? "");
  const [counts, rollups] = await Promise.all([
    countLists(token, resolved.workspace, id),
    computeRollups(token, resolved.workspace, id),
  ]);
  const context = requireContext();
  return {
    ...resolved,
    counts,
    summary: computeSummary(resolved.workspace.summary, record, rollups, {
      defaultCurrency: context.user.preferences?.defaultCurrency,
      locale: context.user.preferences?.locale || undefined,
    }),
  };
}

export type RecordWorkspace = { record: TableRecord; form: RecordForm } & WorkspaceView;

export async function readWorkspace(token: string, collection: string, id: string): Promise<RecordWorkspace> {
  checkNames(collection, id);
  const record = await readOne(token, collection, id);
  const [form, stored] = await Promise.all([formFor(token, collection, record), storedConfig(token, collection)]);
  const view = await viewFor(token, record, resolveWorkspace(collection, stored?.raw.workspace));
  return { record, form, ...view };
}

/** The page as a draft workspace would draw it — what the editor's preview shows before anything is saved. */
export async function previewWorkspace(token: string, collection: string, id: string, raw: unknown): Promise<WorkspaceView> {
  checkNames(collection, id);
  const read = readWorkspaceLayout(asRecord(raw).workspace);
  if (!read.ok) throw new ApiError(read.error);
  const record = await readOne(token, collection, id);
  return viewFor(token, record, { workspace: read.value, workspaceSource: "stored", workspaceProblem: null });
}

/* ------------------------------ the layouts -------------------------------- */

export type LayoutConfig = {
  collection: string;
  /** The `record_forms` row, when one is stored. */
  configId: string | null;
  title: string;
  description: string;
  layout: FormLayout;
  workspace: WorkspaceLayout;
  /** The collection's fields, from the records the caller can see — what the editor offers. */
  fields: FieldInfo[];
  writable: boolean;
  readOnlyReason: string | null;
};

/** Up to a page of records, for their shape. None readable is an empty shape, not a failure. */
async function sampleFields(token: string, collection: string): Promise<FieldInfo[]> {
  try {
    return inferFields((await clientFor(token).collection(collection).getList<TableRecord>(1, 20)).items);
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      throw new ApiError(`There is no collection called "${collection}".`, 404);
    }
    return [];
  }
}

/** A layout with each field's widget filled in from its sampled type, so a blank record draws the right inputs. */
function withWidgets(layout: FormLayout, fields: FieldInfo[]): FormLayout {
  const types = new Map(fields.map(field => [field.name, field.type]));
  return {
    ...layout,
    sections: layout.sections.map(section => ({
      ...section,
      fields: section.fields.map(field =>
        field.widget || !types.has(field.name) ? field : { ...field, widget: widgetForType(types.get(field.name), field.name) },
      ),
    })),
  };
}

export async function readLayoutConfig(token: string, collection: string): Promise<LayoutConfig> {
  checkNames(collection);
  const [stored, fields] = await Promise.all([storedConfig(token, collection), sampleFields(token, collection)]);
  const layout = stored ? readFormLayout(stored.raw.layout) : null;
  return {
    collection,
    configId: stored?.id ?? null,
    title: String(stored?.raw.title || humanize(collection)),
    description: String(stored?.raw.description ?? ""),
    layout: withWidgets(layout?.ok ? layout.value : fallbackLayout(collection, fields), fields),
    workspace: resolveWorkspace(collection, stored?.raw.workspace).workspace,
    fields,
    ...writability(collection),
  };
}

/** `PUT /api/record-forms/:collection` — both layouts at once, checked, created if missing. */
export async function saveLayoutConfig(token: string, collection: string, raw: unknown): Promise<LayoutConfig> {
  checkNames(collection);
  const body = asRecord(raw);
  const layout = readFormLayout(body.layout);
  if (!layout.ok) throw new ApiError(`The form layout cannot be used: ${layout.error}`);
  const workspace = readWorkspaceLayout(body.workspace ?? {});
  if (!workspace.ok) throw new ApiError(`The workspace cannot be used: ${workspace.error}`);
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : humanize(collection);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 1000) : "";

  const values = { collection, title, description, layout: layout.value, workspace: workspace.value };
  const stored = await storedConfig(token, collection);
  try {
    const forms = clientFor(token).collection(RECORD_FORMS_COLLECTION);
    if (stored) await forms.update(stored.id, values);
    else await forms.create(values);
  } catch (error) {
    // An update rule is applied as a filter, so a refusal can read as a 404.
    if (error instanceof ClientResponseError && (error.status === 403 || error.status === 404 || error.status === 400)) {
      if (error.status !== 400 || Object.keys(error.response?.data ?? {}).length === 0) {
        throw new ApiError("Only an admin may change how records are laid out.", 403);
      }
    }
    throw toApiError(error, "Could not store the layout");
  }
  return readLayoutConfig(token, collection);
}

/* ------------------------------- creating ---------------------------------- */

export type RecordCreate = { values: TableRecord; link: TableRecord };

export function readRecordCreate(raw: unknown): RecordCreate {
  const body = asRecord(raw);
  const values = body.values ?? {};
  const link = body.link ?? {};
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new ApiError(`"values" must be an object of field → value.`);
  }
  if (link === null || typeof link !== "object" || Array.isArray(link)) {
    throw new ApiError(`"link" must be an object of field → value.`);
  }
  for (const [name, value] of Object.entries(link)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)) throw new ApiError(`"link.${name}" is not a field name.`);
    if (LOCKED_FIELDS.has(name)) throw new ApiError(`"${name}" is set by PocketBase, not by a request.`);
    if (typeof value !== "string") throw new ApiError(`"link.${name}" must be text — a record id or a fixed value.`);
  }
  return { values: values as TableRecord, link: link as TableRecord };
}

/**
 * A new record, through its collection's form: the fields the form offers as
 * editable, each checked, plus the `link` values that point it back at the
 * record whose related list it was started from. The collection's create
 * rule still decides, and the ownership hooks still stamp owner and org.
 */
export async function createRecord(token: string, collection: string, create: RecordCreate): Promise<TableRecord> {
  checkNames(collection);
  const { writable, readOnlyReason } = writability(collection);
  if (!writable) throw new ApiError(readOnlyReason ?? "Records here are not created through a form.", 409);

  const config = await readLayoutConfig(token, collection);
  const form: RecordForm = {
    collection,
    title: config.title,
    description: config.description,
    layout: config.layout,
    source: config.configId ? "stored" : "default",
    configId: config.configId,
    problem: null,
    writable: true,
    readOnlyReason: null,
  };
  const checked = checkPatch(editableFields(form, {}), create.values);
  if (!checked.ok) throw new ApiError(checked.error);

  try {
    const created = await clientFor(token)
      .collection(collection)
      .create<TableRecord>({ ...checked.value, ...create.link });
    return Object.fromEntries(Object.entries(created).filter(([key]) => !["collectionId", "collectionName", "expand"].includes(key)));
  } catch (error) {
    if (error instanceof ClientResponseError && (error.status === 403 || (error.status === 400 && !Object.keys(error.response?.data ?? {}).length))) {
      throw new ApiError(`You may not create records in "${collection}" — its rules do not let your account.`, 403);
    }
    throw toApiError(error, `Could not create the record`);
  }
}
