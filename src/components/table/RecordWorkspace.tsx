import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ArrowLeft, Loader2, Lock, RefreshCw, RotateCcw, Save, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { TableRecord } from "@/lib/dataTable";
import { RECORD_FORMS_COLLECTION, type RecordWithForm } from "@/lib/recordForm";
import type { WorkspaceLayout, WorkspaceView } from "@/lib/workspace";
import { RecordFormBody } from "./RecordForm";
import { RelatedLists } from "./RelatedLists";
import { SummaryPane } from "./SummaryPane";
import { WorkspaceEditor } from "./WorkspaceEditor";

type Loaded = RecordWithForm & WorkspaceView;

/** What a record is called on its own page: its number, its name, its address — its id when it has none. */
function recordTitle(record: TableRecord): string {
  for (const key of ["number", "name", "title", "email", "collection"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return String(record.id ?? "");
}

/**
 * The record workspace: one record, full page, in three panes — its details
 * form, tabs of the records that point at it, and a summary column — laid
 * out per collection by `record_forms`. What a row in `/table` opens.
 *
 * Everything on it is read as the person looking. The summary is worked out
 * by the server (src/server/workspace.ts) because a roll-up needs rows the
 * page has not loaded; the editor's preview asks the same route with a draft.
 */
export function RecordWorkspace({
  collection,
  id,
  canEditLayout,
  onBack,
  onSaved,
}: {
  collection: string;
  id: string;
  canEditLayout: boolean;
  onBack: () => void;
  onSaved: (record: TableRecord) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [customizing, setCustomizing] = useState(false);

  /** The editor's draft, previewed in the tabs and the summary while it is open. */
  const [draft, setDraft] = useState<WorkspaceLayout | null>(null);
  const [preview, setPreview] = useState<WorkspaceView | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api
      .recordWorkspace(collection, id, controller.signal)
      .then(setLoaded)
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The record could not be read.");
      });
    return () => controller.abort();
  }, [collection, id, attempt]);

  useEffect(() => {
    if (loaded) document.title = `${recordTitle(loaded.record)} — ${collection} — CPQ`;
  }, [loaded, collection]);

  // A draft is previewed a moment after the typing stops, not on every key.
  useEffect(() => {
    if (!draft) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewing(true);
      api
        .previewWorkspace(collection, id, draft, controller.signal)
        .then(setPreview)
        .catch(() => {})
        .finally(() => !controller.signal.aborted && setPreviewing(false));
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft, collection, id]);

  const reload = useCallback(() => setAttempt(n => n + 1), []);
  const onDraftChange = useCallback((next: WorkspaceLayout | null) => setDraft(next), []);

  const back = () => {
    if (dirty && !window.confirm("Discard your changes to this record?")) return;
    onBack();
  };

  if (error) {
    return (
      <main className="mx-auto max-w-3xl space-y-3 px-4 py-8">
        <p role="alert" className="flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft /> Back to {collection}
          </Button>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw /> Try again
          </Button>
        </div>
      </main>
    );
  }

  if (!loaded) {
    return (
      <main className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Reading the record…
      </main>
    );
  }

  const { record, form } = loaded;
  const shown = draft && preview ? preview : loaded;
  const lists = draft ? draft.relatedLists : loaded.workspace.relatedLists;
  const formId = `workspace-form-${id}`;

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">
      {/* ------------------------------ heading ------------------------------ */}
      <div className="flex flex-wrap items-start gap-3">
        <Button variant="ghost" size="sm" onClick={back} className="-ml-2">
          <ArrowLeft /> {collection}
        </Button>
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="truncate font-display text-xl font-semibold">{recordTitle(record)}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {form.description || form.title} · <code className="font-mono">{String(record.id)}</code>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={reload} aria-label="Read the record again" title="Reload">
            <RefreshCw />
          </Button>
          {canEditLayout && (
            <Button variant="outline" size="sm" onClick={() => setCustomizing(true)}>
              <Settings2 /> Customize
            </Button>
          )}
        </div>
      </div>

      {(form.problem || loaded.workspaceProblem) && (
        <p className="flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-xs text-alert">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          {[form.problem, loaded.workspaceProblem].filter(Boolean).join(" ")}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* ------------------------------ details ----------------------------- */}
          <section aria-label="Details" className="@container space-y-3">
            {!form.writable && form.readOnlyReason && (
              <p className="flex items-start gap-2 rounded-md border border-hazard/40 bg-hazard/10 px-2.5 py-1.5 text-xs text-hazard">
                <Lock className="mt-px size-3.5 shrink-0" />
                {form.readOnlyReason}
              </p>
            )}
            <RecordFormBody
              key={`${String(record.id)}:${String(record.updated ?? "")}:${form.configId ?? ""}`}
              formId={formId}
              collection={collection}
              id={id}
              loaded={{ record, form }}
              canEditLayout={false}
              hideLayoutNotice
              collapsible
              onDirtyChange={setDirty}
              onReload={reload}
              onSaved={next => {
                onSaved(next.record);
                setDirty(false);
                // A field the summary reads may have moved; work it out again.
                reload();
              }}
            />
            {form.writable && (
              <div className="flex items-center justify-end gap-2">
                <span className="mr-auto text-[11px] text-muted-foreground">
                  {dirty ? "Unsaved changes. Ctrl/⌘ Enter saves." : "Only changed fields are saved."}
                </span>
                <Button type="reset" form={formId} variant="outline" size="sm" disabled={!dirty}>
                  <RotateCcw /> Reset
                </Button>
                <Button type="submit" form={formId} size="sm" disabled={!dirty}>
                  <Save /> Save
                </Button>
              </div>
            )}
          </section>

          {/* --------------------------- related lists -------------------------- */}
          <RelatedLists lists={lists} counts={shown.counts} recordId={String(record.id)} version={attempt} onChanged={reload} />
        </div>

        {/* ------------------------------ summary ------------------------------- */}
        {/* First on a phone: it is the answer someone opened the record for. */}
        <aside className="order-first lg:order-none lg:sticky lg:top-20 lg:self-start">
          <SummaryPane summary={shown.summary} loading={previewing} preview={Boolean(draft)} />
          {canEditLayout && (
            <p className="mt-2 px-1 text-[11px] text-muted-foreground">
              {loaded.workspaceSource === "stored" ? (
                <>Laid out by <code className="font-mono">{RECORD_FORMS_COLLECTION}</code>.</>
              ) : (
                <>The default layout. Customize stores this collection's own.</>
              )}
            </p>
          )}
        </aside>
      </div>

      {customizing && (
        <WorkspaceEditor
          collection={collection}
          onClose={() => setCustomizing(false)}
          onDraftChange={onDraftChange}
          onSaved={() => {
            setCustomizing(false);
            reload();
          }}
        />
      )}
    </main>
  );
}
