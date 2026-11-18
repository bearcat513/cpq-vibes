import { useEffect, useMemo, useState } from "react";
import type { PaginationState, SortingState, Updater } from "@tanstack/react-table";
import { AlertCircle, ArrowLeft, Check, Code2, Database, Link2, ListFilter, LogIn, RotateCcw, X } from "lucide-react";
import { BrandLockup } from "@/components/app/Brand";
import { useAccountTheme } from "@/components/app/useAccountTheme";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Textarea } from "@/components/ui/textarea";
import { api, isUnauthorized, type SessionUser } from "@/lib/api";
import { can } from "@/lib/organization";
import { copyText } from "@/lib/clipboard";
import {
  BROWSABLE_COLLECTIONS,
  DEFAULT_TABLE_PAGE_SIZE,
  isCollectionName,
  sortParam,
  tablePageUrl,
  type FieldInfo,
  type TablePage as TablePageData,
  type TableRecord,
} from "@/lib/dataTable";
import {
  countConditions,
  emptyGroup,
  filterProblems,
  MAX_FILTER_LENGTH,
  parseFilter,
  serializeFilter,
  type FilterGroup,
} from "@/lib/filterQuery";
import { cn } from "@/lib/utils";
import { DataTable } from "./DataTable";
import { QueryBuilder } from "./QueryBuilder";
import { RecordWorkspace } from "./RecordWorkspace";

/**
 * `/table?table_name=<collection>&query=<filter>` — one collection, filtered.
 *
 * The URL is the page's whole state: the two parameters open it, and applying
 * a filter writes them back, so the address bar is always a link to what is
 * on screen. Nothing is stored anywhere else.
 *
 * The filter is edited as a tree (`QueryBuilder`) or as text, and only the
 * *applied* filter is sent — typing in the builder does not refetch on every
 * keystroke, and a half-written condition never reaches PocketBase. A filter
 * from the URL that the builder cannot show (a function call, say) opens in
 * text mode rather than being refused: PocketBase is the judge of whether it
 * is valid, not the builder.
 */

const EMPTY_ROWS: TableRecord[] = [];
const EMPTY_FIELDS: FieldInfo[] = [];

const COLLECTION_OPTIONS = BROWSABLE_COLLECTIONS.map(name => ({ value: name, label: name }));

type Mode = "builder" | "text";

/** What the URL asked for, once, on load. */
function readUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    collection: (params.get("table_name") ?? "").trim(),
    filter: params.get("query") ?? "",
    record: (params.get("record") ?? "").trim(),
  };
}

/** The builder's starting point for a filter, or text mode with the reason. */
function startFrom(filter: string): { mode: Mode; group: FilterGroup; text: string; notice: string } {
  const parsed = parseFilter(filter);
  return parsed.ok
    ? { mode: "builder", group: parsed.group, text: filter, notice: "" }
    : { mode: "text", group: emptyGroup(), text: filter, notice: parsed.error };
}

export function TablePage() {
  const initial = useMemo(() => {
    const url = readUrl();
    return { ...url, ...startFrom(url.filter) };
  }, []);

  const [user, setUser] = useState<SessionUser | null>(null);
  const [collection, setCollection] = useState(initial.collection);
  const [applied, setApplied] = useState(initial.filter.trim());
  /** The record open in the form panel — in the URL too, so a link can open it. */
  const [openId, setOpenId] = useState(initial.record);

  const [mode, setMode] = useState<Mode>(initial.mode);
  const [group, setGroup] = useState<FilterGroup>(initial.group);
  const [text, setText] = useState(initial.text);
  /** Why the text cannot be shown in the builder, when it cannot. */
  const [notice, setNotice] = useState(initial.notice);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: DEFAULT_TABLE_PAGE_SIZE });

  const [data, setData] = useState<TablePageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; signedOut: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  useAccountTheme(user);

  useEffect(() => {
    api
      .me()
      .then(({ user: account }) => setUser(account))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    document.title = collection ? `${collection} — Data table — CPQ` : "Data table — CPQ";
  }, [collection]);

  /* -------------------------------- fetching -------------------------------- */

  const sort = sortParam(sorting);
  useEffect(() => {
    if (!collection || !isCollectionName(collection)) return;
    const controller = new AbortController();
    setLoading(true);
    api
      .tablePage(
        collection,
        { filter: applied, sort, page: pagination.pageIndex + 1, perPage: pagination.pageSize },
        controller.signal,
      )
      .then(page => {
        setData(page);
        setError(null);
      })
      .catch(reason => {
        if (controller.signal.aborted) return;
        setError({
          message: reason instanceof Error ? reason.message : "The page could not be read.",
          signedOut: isUnauthorized(reason),
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [collection, applied, sort, pagination.pageIndex, pagination.pageSize]);

  /** The columns of the last page that had any — a failed filter keeps them editable. */
  const [fields, setFields] = useState<FieldInfo[]>(EMPTY_FIELDS);
  useEffect(() => {
    if (data?.collection === collection && data.fields.length) setFields(data.fields);
  }, [data, collection]);

  /* --------------------------------- filter -------------------------------- */

  const draft = mode === "builder" ? serializeFilter(group) : text.trim();
  const problems = useMemo(() => (mode === "builder" ? filterProblems(group) : {}), [mode, group]);
  const problemCount = Object.keys(problems).length;
  const tooLong = draft.length > MAX_FILTER_LENGTH;
  const dirty = draft !== applied;

  function writeUrl(nextCollection: string, filter: string, record = openId) {
    history.replaceState(null, "", tablePageUrl(nextCollection, filter, record));
  }

  function apply(filter = draft) {
    setApplied(filter);
    setPagination(current => ({ ...current, pageIndex: 0 }));
    writeUrl(collection, filter);
  }

  function openRecord(id: string) {
    setOpenId(id);
    writeUrl(collection, applied, id);
  }

  function closeRecord() {
    setOpenId("");
    writeUrl(collection, applied, "");
  }

  /** A saved record replaces its row in place; the next fetch decides whether it still matches. */
  function recordSaved(record: TableRecord) {
    setData(current =>
      current && current.collection === collection
        ? { ...current, items: current.items.map(item => (item.id === record.id ? record : item)) }
        : current,
    );
  }

  function revert() {
    const start = startFrom(applied);
    setMode(start.mode);
    setGroup(start.group);
    setText(start.text);
    setNotice(start.notice);
  }

  function clear() {
    setGroup(emptyGroup());
    setText("");
    setNotice("");
    setMode("builder");
    apply("");
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    if (next === "text") {
      setText(serializeFilter(group));
      setNotice("");
      setMode("text");
      return;
    }
    const parsed = parseFilter(text);
    if (!parsed.ok) {
      setNotice(parsed.error);
      return;
    }
    setGroup(parsed.group);
    setNotice("");
    setMode("builder");
  }

  function chooseCollection(next: string) {
    const name = next.trim();
    if (!name || name === collection) return;
    setCollection(name);
    setData(null);
    setFields(EMPTY_FIELDS);
    setError(null);
    setSorting([]);
    setPagination(current => ({ ...current, pageIndex: 0 }));
    // Another collection's fields would not mean anything here.
    setGroup(emptyGroup());
    setText("");
    setNotice("");
    setMode("builder");
    setApplied("");
    setOpenId("");
    writeUrl(name, "", "");
  }

  const onSortingChange = (updater: Updater<SortingState>) => {
    setSorting(current => (typeof updater === "function" ? updater(current) : updater));
    setPagination(current => ({ ...current, pageIndex: 0 }));
  };
  const onPaginationChange = (updater: Updater<PaginationState>) =>
    setPagination(current => {
      const next = typeof updater === "function" ? updater(current) : updater;
      // A new page size starts again from the top, rather than at a page that may not exist.
      return next.pageSize !== current.pageSize ? { ...next, pageIndex: 0 } : next;
    });

  async function copyLink() {
    await copyText(new URL(tablePageUrl(collection, applied), window.location.origin).href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /* --------------------------------- render -------------------------------- */

  const header = (
    <header className="seam sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
        <a href="/" className="rounded">
          <BrandLockup tagline="data table" markClassName="size-7" />
        </a>
        <div className="flex min-w-48 flex-1 items-center gap-2 sm:max-w-xs">
          <Database className="size-4 shrink-0 text-muted-foreground" />
          <Combobox
            value={collection}
            onChange={chooseCollection}
            options={COLLECTION_OPTIONS}
            allowCustom
            placeholder="Choose a collection…"
            aria-label="Collection"
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {collection && (
            <Button variant="outline" size="sm" onClick={copyLink}>
              {copied ? <Check /> : <Link2 />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          )}
          <Button asChild variant="ghost" size="sm">
            <a href="/">
              <ArrowLeft />
              App
            </a>
          </Button>
        </div>
      </div>
    </header>
  );

  if (!collection) {
    return (
      <div className="slab min-h-dvh">
        {header}
        <main className="mx-auto max-w-3xl px-4 py-10">
          <h1 className="font-display text-xl font-semibold">Choose a collection</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Open one below, or link straight to it:{" "}
            <code className="font-mono text-xs">/table?table_name=quotes&amp;query=status = "sent"</code>. Rows are the
            stored records, and the collection's own rules decide which of them you see.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {BROWSABLE_COLLECTIONS.map(name => (
              <a
                key={name}
                href={tablePageUrl(name)}
                className="panel motion-safe:animate-rise rounded-md border px-3 py-2.5 font-mono text-sm transition-colors hover:border-primary/40 hover:bg-accent/50"
              >
                {name}
              </a>
            ))}
          </div>
        </main>
      </div>
    );
  }

  // A record opens full page — its workspace — rather than in a panel over the table.
  if (openId && isCollectionName(collection)) {
    return (
      <div className="slab min-h-dvh">
        {header}
        <RecordWorkspace
          key={`${collection}/${openId}`}
          collection={collection}
          id={openId}
          canEditLayout={can(user?.role, "forms.write")}
          onBack={closeRecord}
          onSaved={recordSaved}
        />
      </div>
    );
  }

  const conditions = mode === "builder" ? countConditions(group) : 0;
  const shownError = isCollectionName(collection)
    ? error
    : { message: `"${collection}" is not a collection name — letters, digits and underscores only.`, signedOut: false };

  return (
    <div className="slab min-h-dvh">
      {header}

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-xl font-semibold">{collection}</h1>
          {data && data.collection === collection && (
            <span className="font-display text-sm text-muted-foreground tabular-nums">
              {data.totalItems.toLocaleString()} {data.totalItems === 1 ? "row" : "rows"}
              {applied ? " matching" : ""}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground/80">
            Stored records — derived values (a quote's expiry, an invoice's balance) are not shown here.
          </span>
        </div>

        {/* ------------------------------ filter ------------------------------ */}
        <section aria-label="Filter" className="panel @container rounded-lg border shadow-[0_1px_2px_var(--cast)]">
          <div className="seam flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <ListFilter className="size-4 text-muted-foreground" />
            <h2 className="font-display text-sm font-semibold">Filter</h2>
            {mode === "builder" && conditions > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {conditions} {conditions === 1 ? "condition" : "conditions"}
              </span>
            )}
            <div className="ml-auto inline-flex gap-0.5 rounded-md border bg-muted/60 p-0.5">
              {(["builder", "text"] as const).map(entry => (
                <button
                  key={entry}
                  type="button"
                  aria-pressed={mode === entry}
                  onClick={() => switchMode(entry)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                    mode === entry ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry === "builder" ? <ListFilter className="size-3" /> : <Code2 className="size-3" />}
                  {entry === "builder" ? "Builder" : "Text"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3 p-3">
            {notice && (
              <p className="flex items-start gap-2 rounded-md border border-hazard/40 bg-hazard/10 px-2.5 py-1.5 text-xs text-hazard">
                <AlertCircle className="mt-px size-3.5 shrink-0" />
                <span>
                  Shown as text: {notice} It can still be applied — PocketBase decides whether it is valid.
                </span>
              </p>
            )}

            {mode === "builder" ? (
              <QueryBuilder value={group} onChange={setGroup} fields={fields} problems={problems} />
            ) : (
              <Textarea
                aria-label="Filter expression"
                value={text}
                onChange={event => setText(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !tooLong) {
                    event.preventDefault();
                    apply();
                  }
                }}
                spellCheck={false}
                rows={3}
                placeholder={'status = "sent" && total > 1000'}
                className="font-mono text-xs"
              />
            )}

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <code
                className={cn(
                  "min-w-0 flex-1 truncate rounded-sm bg-muted/50 px-2 py-1 font-mono text-[11px]",
                  !draft && "text-muted-foreground",
                )}
                title={draft}
              >
                {draft || "no filter"}
              </code>
              {tooLong && (
                <span className="text-[11px] text-alert">At most {MAX_FILTER_LENGTH.toLocaleString()} characters.</span>
              )}
              {problemCount > 0 && (
                <span className="text-[11px] text-alert">
                  {problemCount} {problemCount === 1 ? "condition needs" : "conditions need"} fixing
                </span>
              )}
              {dirty && (
                <Button variant="ghost" size="sm" onClick={revert}>
                  <RotateCcw />
                  Revert
                </Button>
              )}
              {(applied || draft) && (
                <Button variant="ghost" size="sm" onClick={clear}>
                  <X />
                  Clear
                </Button>
              )}
              <Button size="sm" onClick={() => apply()} disabled={!dirty || problemCount > 0 || tooLong}>
                Apply
              </Button>
            </div>
          </div>
        </section>

        {/* ------------------------------- table ------------------------------ */}
        {shownError &&
          (shownError.signedOut ? (
            <div className="panel flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm">
              <LogIn className="size-4 text-muted-foreground" />
              <span className="flex-1">Sign in to read this collection — every row is read as you.</span>
              <Button asChild size="sm">
                <a href="/">Sign in</a>
              </Button>
            </div>
          ) : (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {shownError.message}
            </p>
          ))}

        {!shownError?.signedOut && (
          <DataTable
            fields={fields}
            rows={data && data.collection === collection && !shownError ? data.items : EMPTY_ROWS}
            totalItems={data && data.collection === collection && !shownError ? data.totalItems : 0}
            sorting={sorting}
            onSortingChange={onSortingChange}
            pagination={pagination}
            onPaginationChange={onPaginationChange}
            loading={loading}
            onOpenRow={row => openRecord(String(row.id))}
            selectedId={openId}
          />
        )}
      </main>

    </div>
  );
}
