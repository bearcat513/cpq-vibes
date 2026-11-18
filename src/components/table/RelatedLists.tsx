import { useEffect, useMemo, useRef, useState } from "react";
import type { PaginationState, SortingState, Updater } from "@tanstack/react-table";
import { AlertCircle, Link2, Loader2, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { api, type LayoutConfig } from "@/lib/api";
import { attachmentProblem, isAttachmentTarget } from "@/lib/attachments";
import { sortParam, tablePageUrl, type FieldInfo, type TablePage, type TableRecord } from "@/lib/dataTable";
import type { RecordWithForm } from "@/lib/recordForm";
import { canCreateIn, layoutForCreate, relatedDefaults, relatedFilter, type RelatedList } from "@/lib/workspace";
import { DataTable } from "./DataTable";
import { FormFooter, RecordFormBody } from "./RecordForm";

const PAGE_SIZE = 10;

/**
 * The related-list pane: one tab per list in the workspace, each a page of
 * the records that point at this one, read through the caller's credential
 * with the same table the collection view uses. A row opens that record's
 * own workspace — an attachment downloads instead — and "New" starts one
 * already pointing back here.
 */
export function RelatedLists({
  lists,
  counts,
  recordId,
  version,
  onChanged,
}: {
  lists: RelatedList[];
  counts: Record<string, number | null>;
  recordId: string;
  /** Bumped when the record changes, so every tab reads again. */
  version: number;
  /** A record was added in a tab: counts and the summary are out of date. */
  onChanged: () => void;
}) {
  const [active, setActive] = useState(lists[0]?.key ?? "");
  useEffect(() => {
    if (!lists.some(list => list.key === active)) setActive(lists[0]?.key ?? "");
  }, [lists, active]);

  if (lists.length === 0) {
    return (
      <section className="panel rounded-lg border px-4 py-6 text-center text-xs text-muted-foreground">
        <Link2 className="mx-auto mb-1 size-4" />
        No related lists — add one under Customize to see the records that point at this one.
      </section>
    );
  }

  const current = lists.find(list => list.key === active) ?? lists[0]!;

  return (
    <section aria-label="Related records" className="space-y-2">
      <Tabs
        value={current.key}
        onValueChange={setActive}
        idPrefix="related"
        aria-label="Related records"
        items={lists.map(list => {
          const count = counts[list.key];
          return { id: list.key, label: count === null || count === undefined ? list.title : `${list.title} (${count})` };
        })}
      />
      <TabPanel idPrefix="related" id={current.key}>
        <RelatedTab key={`${current.key}:${recordId}`} list={current} recordId={recordId} version={version} onChanged={onChanged} />
      </TabPanel>
    </section>
  );
}

function RelatedTab({
  list,
  recordId,
  version,
  onChanged,
}: {
  list: RelatedList;
  recordId: string;
  version: number;
  onChanged: () => void;
}) {
  const [page, setPage] = useState<TablePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reads, setReads] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const sort = sortParam(sorting) || list.sort;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api
      .tablePage(
        list.collection,
        { filter: relatedFilter(list, recordId), sort, page: pagination.pageIndex + 1, perPage: pagination.pageSize },
        controller.signal,
      )
      .then(next => {
        setPage(next);
        setError("");
      })
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The list could not be read.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [list, recordId, sort, pagination.pageIndex, pagination.pageSize, version, reads]);

  /** The configured columns, typed from the rows; every column the rows have when none are configured. */
  const fields: FieldInfo[] = useMemo(() => {
    const seen = page?.fields ?? [];
    if (!list.columns.length) return seen.filter(field => field.type !== "json");
    const types = new Map(seen.map(field => [field.name, field.type]));
    return list.columns.map(name => ({ name, type: types.get(name) ?? "text" }));
  }, [page, list.columns]);

  const attachments = list.collection === "sys_attachment";
  const target = list.match.find(match => match.field === "target")?.value;
  const creatable = canCreateIn(list) && (!attachments || (isAttachmentTarget(target) && list.field === "recordId"));

  const open = (row: TableRecord) => {
    const id = String(row.id);
    // A file has nothing to edit; what you want from it is the file.
    if (attachments) window.open(api.attachmentUrl(id, true), "_blank", "noopener");
    else window.location.href = tablePageUrl(list.collection, "", id);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !isAttachmentTarget(target)) return;
    setUploading(true);
    setError("");
    try {
      for (const file of files) {
        const problem = attachmentProblem(file);
        if (problem) throw new Error(problem);
        await api.uploadAttachment(target, recordId, file);
      }
      setReads(n => n + 1);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The file could not be attached.");
    } finally {
      setUploading(false);
    }
  };

  const onSortingChange = (updater: Updater<SortingState>) => {
    setSorting(current => (typeof updater === "function" ? updater(current) : updater));
    setPagination(current => ({ ...current, pageIndex: 0 }));
  };
  const onPaginationChange = (updater: Updater<PaginationState>) =>
    setPagination(current => {
      const next = typeof updater === "function" ? updater(current) : updater;
      return next.pageSize !== current.pageSize ? { ...next, pageIndex: 0 } : next;
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <code className="min-w-0 flex-1 truncate font-mono" title={relatedFilter(list, recordId)}>
          {list.collection} · {list.field} = this record
          {list.match.map(match => ` · ${match.field} = ${match.value}`).join("")}
        </code>
        <a href={tablePageUrl(list.collection, relatedFilter(list, recordId))} className="hover:text-foreground hover:underline">
          Open as a table
        </a>
        {creatable &&
          (attachments ? (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={event => {
                  void upload(event.target.files);
                  event.target.value = "";
                }}
              />
              <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
                Attach
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <Plus />
              New
            </Button>
          ))}
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-xs text-alert">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}

      <DataTable
        fields={fields}
        rows={page?.items ?? []}
        totalItems={page?.totalItems ?? 0}
        sorting={sorting}
        onSortingChange={onSortingChange}
        pagination={pagination}
        onPaginationChange={onPaginationChange}
        loading={loading}
        onOpenRow={open}
      />

      {creating && (
        <NewRecordSheet
          list={list}
          recordId={recordId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setReads(n => n + 1);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * A new record in a related list, in its collection's own form — less what a
 * request cannot set, and less the link, which is filled in: it is what makes
 * the record belong here.
 */
function NewRecordSheet({
  list,
  recordId,
  onClose,
  onCreated,
}: {
  list: RelatedList;
  recordId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [config, setConfig] = useState<LayoutConfig | null>(null);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const link = useMemo(() => relatedDefaults(list, recordId), [list, recordId]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .layoutConfig(list.collection, controller.signal)
      .then(setConfig)
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The form could not be read.");
      });
    return () => controller.abort();
  }, [list.collection]);

  const loaded: RecordWithForm | null = useMemo(
    () =>
      config && {
        record: {},
        form: {
          collection: list.collection,
          title: config.title,
          description: config.description,
          layout: layoutForCreate(config.layout, Object.keys(link)),
          source: config.configId ? "stored" : "default",
          configId: config.configId,
          problem: null,
          writable: config.writable,
          readOnlyReason: config.readOnlyReason,
        },
      },
    [config, link, list.collection],
  );

  const close = () => {
    if (dirty && !window.confirm("Discard this new record?")) return;
    onClose();
  };
  const formId = `new-${list.key}`;

  return (
    <Sheet
      title={`New ${config?.title.toLowerCase() ?? list.title.toLowerCase()}`}
      description={`In ${list.collection}, linked to this record by ${Object.keys(link).join(", ")}.`}
      onClose={close}
      className="sm:w-[42%]"
      footer={loaded && <FormFooter formId={formId} writable={loaded.form.writable} onClose={close} />}
    >
      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : !loaded ? (
        <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading the form…
        </p>
      ) : (
        <div className="space-y-3">
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <Link2 className="size-3.5" />
            {Object.entries(link).map(([field, value]) => (
              <code key={field} className="rounded-sm border bg-muted/50 px-1 font-mono">
                {field} = {String(value)}
              </code>
            ))}
          </p>
          <RecordFormBody
            formId={formId}
            collection={list.collection}
            id=""
            loaded={loaded}
            canEditLayout={false}
            hideLayoutNotice
            onDirtyChange={setDirty}
            onReload={() => {}}
            onSaved={() => onCreated()}
            submit={async patch => ({ record: await api.createTableRecord(list.collection, patch, link), form: loaded.form })}
          />
        </div>
      )}
    </Sheet>
  );
}
