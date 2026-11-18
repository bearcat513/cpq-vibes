import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Calculator, Heading, Hash, LayoutList, Link2, Loader2, Plus, Sigma, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { api, type LayoutConfig } from "@/lib/api";
import { BROWSABLE_COLLECTIONS, type FieldInfo } from "@/lib/dataTable";
import {
  FORM_WIDGETS,
  readFormLayout,
  REST_MODES,
  type FormFieldConfig,
  type FormLayout,
  type FormSection,
  type FormWidget,
} from "@/lib/recordForm";
import {
  readWorkspaceLayout,
  ROLLUP_OPS,
  SUMMARY_FORMATS,
  uniqueKey,
  type RelatedList,
  type RollupOp,
  type SummaryFormat,
  type SummaryItem,
  type WorkspaceLayout,
} from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { nativeSelect } from "./QueryBuilder";

/**
 * Customize: the visual editor for a collection's workspace — the details
 * form, the related-list tabs and the record summary — all saved together to
 * its `record_forms` row.
 *
 * The draft is checked by the same readers the server runs on save
 * (`readFormLayout`, `readWorkspaceLayout`), so a mistake is named here, as
 * it is typed, rather than by a refused save. While it is open, the page
 * behind draws the draft workspace — the tabs and the summary — so the
 * effect of a change is visible before it is stored.
 */

type Pane = "details" | "related" | "summary";

const COLLECTIONS = [...new Set([...BROWSABLE_COLLECTIONS, "sys_attachment"])];
const COLLECTION_OPTIONS: ComboboxOption[] = COLLECTIONS.map(name => ({ value: name, label: name }));

const fieldOptions = (fields: FieldInfo[], exclude: Iterable<string> = []): ComboboxOption[] => {
  const skip = new Set(exclude);
  return fields.filter(field => !skip.has(field.name)).map(field => ({ value: field.name, label: field.name, badge: field.type }));
};

export function WorkspaceEditor({
  collection,
  onClose,
  onDraftChange,
  onSaved,
}: {
  collection: string;
  onClose: () => void;
  /** The draft workspace, for the page behind to draw while editing — or null when invalid or closed. */
  onDraftChange: (workspace: WorkspaceLayout | null) => void;
  onSaved: () => void;
}) {
  const [config, setConfig] = useState<LayoutConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pane, setPane] = useState<Pane>("details");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [layout, setLayout] = useState<FormLayout>({ sections: [], rest: "hidden" });
  const [workspace, setWorkspace] = useState<WorkspaceLayout | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  /** Fields of the collections the related lists point into, read as they are needed. */
  const [related, setRelated] = useState<Record<string, FieldInfo[]>>({});

  useEffect(() => {
    const controller = new AbortController();
    api
      .layoutConfig(collection, controller.signal)
      .then(next => {
        setConfig(next);
        setTitle(next.title);
        setDescription(next.description);
        setLayout(next.layout);
        setWorkspace(next.workspace);
      })
      .catch(reason => {
        if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "The layout could not be read.");
      });
    return () => controller.abort();
  }, [collection]);

  useEffect(() => {
    for (const name of new Set(workspace?.relatedLists.map(list => list.collection) ?? [])) {
      if (!name || name in related) continue;
      setRelated(current => ({ ...current, [name]: [] }));
      api
        .layoutConfig(name)
        .then(next => setRelated(current => ({ ...current, [name]: next.fields })))
        .catch(() => {});
    }
  }, [workspace, related]);

  const layoutCheck = useMemo(() => readFormLayout(layout), [layout]);
  const workspaceCheck = useMemo(() => (workspace ? readWorkspaceLayout(workspace) : null), [workspace]);
  const problem = !layoutCheck.ok ? `Details: ${layoutCheck.error}` : workspaceCheck && !workspaceCheck.ok ? workspaceCheck.error : "";

  // The page behind previews whatever is valid.
  useEffect(() => {
    onDraftChange(workspaceCheck?.ok ? workspaceCheck.value : null);
  }, [workspaceCheck, onDraftChange]);
  useEffect(() => () => onDraftChange(null), [onDraftChange]);

  const touch = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setDirty(true);
  };
  const changeLayout = touch(setLayout);
  const changeWorkspace = touch((next: WorkspaceLayout) => setWorkspace(next));

  const close = () => {
    if (dirty && !window.confirm("Discard your changes to this layout?")) return;
    onClose();
  };

  const save = async () => {
    if (!workspace || problem) return;
    setSaving(true);
    setSaveError("");
    try {
      await api.saveLayoutConfig(collection, { title, description, layout, workspace });
      setDirty(false);
      onSaved();
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "The layout could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title={`Customize ${collection}`}
      description="The details form, the related lists and the summary — for everyone in the organization."
      onClose={close}
      className="sm:w-[52%]"
      footer={
        <>
          <p className={cn("mr-auto min-w-0 truncate text-[11px]", problem ? "text-alert" : "text-muted-foreground")} title={problem}>
            {problem || (config?.configId ? "Saved to record_forms." : "Saving creates this collection's record_forms row.")}
          </p>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!config || !dirty || Boolean(problem) || saving}>
            {saving && <Loader2 className="animate-spin" />}
            Save layout
          </Button>
        </>
      }
    >
      {loadError ? (
        <Problem>{loadError}</Problem>
      ) : !config || !workspace ? (
        <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading the layout…
        </p>
      ) : (
        <div className="space-y-4">
          {saveError && <Problem>{saveError}</Problem>}
          <Tabs
            value={pane}
            onValueChange={setPane}
            idPrefix="customize"
            aria-label="What to customize"
            items={[
              { id: "details", label: "Details", icon: <LayoutList /> },
              { id: "related", label: `Related lists (${workspace.relatedLists.length})`, icon: <Link2 /> },
              { id: "summary", label: `Summary (${workspace.summary.items.length})`, icon: <Sigma /> },
            ]}
          />
          <TabPanel idPrefix="customize" id={pane}>
            {pane === "details" ? (
              <DetailsEditor
                title={title}
                description={description}
                layout={layout}
                fields={config.fields}
                onTitle={touch(setTitle)}
                onDescription={touch(setDescription)}
                onChange={changeLayout}
              />
            ) : pane === "related" ? (
              <RelatedEditor workspace={workspace} related={related} onChange={changeWorkspace} />
            ) : (
              <SummaryEditor workspace={workspace} fields={config.fields} related={related} onChange={changeWorkspace} />
            )}
          </TabPanel>
        </div>
      )}
    </Sheet>
  );
}

/* --------------------------------- pieces --------------------------------- */

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      {children}
    </p>
  );
}

function Labelled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block min-w-0 space-y-1", className)}>
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function NativeSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly T[] | { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value as T)} className={cn(nativeSelect, "h-8 w-full text-xs")}>
      {options.map(option => {
        const entry = typeof option === "string" ? { value: option, label: option } : option;
        return (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        );
      })}
    </select>
  );
}

/** Up, down and remove, for any item in an ordered list. */
function Mover({ index, count, onMove, onRemove, what }: { index: number; count: number; onMove: (to: number) => void; onRemove: () => void; what: string }) {
  return (
    <div className="flex shrink-0 items-center">
      <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={`Move ${what} up`}>
        <ArrowUp />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={`Move ${what} down`}>
        <ArrowDown />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} aria-label={`Remove ${what}`}>
        <Trash2 className="text-muted-foreground hover:text-destructive" />
      </Button>
    </div>
  );
}

const move = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};
const replace = <T,>(list: T[], index: number, item: T): T[] => list.map((entry, at) => (at === index ? item : entry));

/* ------------------------------ details pane ------------------------------- */

function DetailsEditor({
  title,
  description,
  layout,
  fields,
  onTitle,
  onDescription,
  onChange,
}: {
  title: string;
  description: string;
  layout: FormLayout;
  fields: FieldInfo[];
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
  onChange: (layout: FormLayout) => void;
}) {
  const used = new Set(layout.sections.flatMap(section => section.fields.map(field => field.name)));
  const setSection = (index: number, section: FormSection) => onChange({ ...layout, sections: replace(layout.sections, index, section) });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 @md:grid-cols-2">
        <Labelled label="Form title">
          <Input value={title} onChange={event => onTitle(event.target.value)} maxLength={200} className="h-8" />
        </Labelled>
        <Labelled label="Fields not placed below">
          <NativeSelect
            label="Fields not placed below"
            value={layout.rest}
            options={REST_MODES.map(mode => ({ value: mode, label: mode === "hidden" ? "Hidden" : "Shown read-only, under Other fields" }))}
            onChange={rest => onChange({ ...layout, rest })}
          />
        </Labelled>
        <Labelled label="Description" className="@md:col-span-2">
          <Input value={description} onChange={event => onDescription(event.target.value)} maxLength={1000} className="h-8" />
        </Labelled>
      </div>

      {layout.sections.map((section, index) => (
        <fieldset key={index} className="panel space-y-3 rounded-lg border p-3">
          <legend className="sr-only">Section {index + 1}</legend>
          <div className="flex items-end gap-2">
            <Labelled label="Section" className="flex-1">
              <Input value={section.title} onChange={event => setSection(index, { ...section, title: event.target.value })} className="h-8" />
            </Labelled>
            <Labelled label="Columns" className="w-20">
              <NativeSelect
                label="Columns"
                value={String(section.columns) as "1" | "2"}
                options={["1", "2"] as const}
                onChange={columns => setSection(index, { ...section, columns: Number(columns) as 1 | 2 })}
              />
            </Labelled>
            <Mover
              index={index}
              count={layout.sections.length}
              what="section"
              onMove={to => onChange({ ...layout, sections: move(layout.sections, index, to) })}
              onRemove={() => onChange({ ...layout, sections: layout.sections.filter((_, at) => at !== index) })}
            />
          </div>

          <ul className="divide-y rounded-md border">
            {section.fields.map((field, position) => (
              <FieldRow
                key={field.name}
                field={field}
                index={position}
                count={section.fields.length}
                onChange={next => setSection(index, { ...section, fields: replace(section.fields, position, next) })}
                onMove={to => setSection(index, { ...section, fields: move(section.fields, position, to) })}
                onRemove={() => setSection(index, { ...section, fields: section.fields.filter((_, at) => at !== position) })}
              />
            ))}
            {section.fields.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No fields yet.</li>}
          </ul>

          <Combobox
            value=""
            onChange={name => {
              if (!name || used.has(name)) return;
              setSection(index, { ...section, fields: [...section.fields, { name }] });
            }}
            options={fieldOptions(fields, used)}
            allowCustom
            placeholder="Add a field…"
            aria-label={`Add a field to section ${index + 1}`}
            className="h-8 text-xs"
          />
        </fieldset>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange({ ...layout, sections: [...layout.sections, { title: "New section", description: "", columns: 2, fields: [] }] })}
      >
        <Plus /> Add a section
      </Button>
    </div>
  );
}

function FieldRow({
  field,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  field: FormFieldConfig;
  index: number;
  count: number;
  onChange: (field: FormFieldConfig) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const widget = field.widget ?? "";
  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{field.name}</code>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Switch checked={field.readOnly === true} onChange={event => onChange({ ...field, readOnly: event.target.checked || undefined })} aria-label={`${field.name} is read-only`} />
          read-only
        </label>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Switch checked={field.required === true} onChange={event => onChange({ ...field, required: event.target.checked || undefined })} aria-label={`${field.name} is required`} />
          required
        </label>
        <Mover index={index} count={count} onMove={onMove} onRemove={onRemove} what={field.name} />
      </div>
      <div className="grid gap-2 @md:grid-cols-[1fr_8rem_5rem]">
        <Input
          value={field.label ?? ""}
          placeholder="Label (the field name in words)"
          onChange={event => onChange({ ...field, label: event.target.value || undefined })}
          aria-label={`${field.name} label`}
          className="h-8 text-xs"
        />
        <NativeSelect
          label={`${field.name} widget`}
          value={widget as FormWidget | ""}
          options={[{ value: "", label: "Guess" }, ...FORM_WIDGETS.map(name => ({ value: name, label: name }))] as { value: FormWidget | ""; label: string }[]}
          onChange={next => onChange({ ...field, widget: (next || undefined) as FormWidget | undefined })}
        />
        <NativeSelect
          label={`${field.name} width`}
          value={String(field.span ?? "") as "" | "1" | "2"}
          options={[
            { value: "", label: "Auto" },
            { value: "1", label: "Half" },
            { value: "2", label: "Full" },
          ]}
          onChange={next => onChange({ ...field, span: next ? (Number(next) as 1 | 2) : undefined })}
        />
      </div>
      {widget === "select" && (
        <Input
          value={(field.options ?? []).join(", ")}
          placeholder="Choices, separated by commas"
          onChange={event => onChange({ ...field, options: event.target.value.split(",").map(option => option.trim()).filter(Boolean) })}
          aria-label={`${field.name} choices`}
          className="h-8 text-xs"
        />
      )}
      <Input
        value={field.help ?? ""}
        placeholder="Help text (optional)"
        onChange={event => onChange({ ...field, help: event.target.value || undefined })}
        aria-label={`${field.name} help`}
        className="h-8 text-xs"
      />
    </li>
  );
}

/* --------------------------- related lists pane ---------------------------- */

function RelatedEditor({
  workspace,
  related,
  onChange,
}: {
  workspace: WorkspaceLayout;
  related: Record<string, FieldInfo[]>;
  onChange: (workspace: WorkspaceLayout) => void;
}) {
  const lists = workspace.relatedLists;
  const set = (next: RelatedList[]) => onChange({ ...workspace, relatedLists: next });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        A tab of the records in another collection whose <em>link field</em> holds this record's id. Rows are read as
        the person looking, so the collection's own rules decide what each tab shows.
      </p>

      {lists.map((list, index) => {
        const fields = related[list.collection] ?? [];
        const patch = (changes: Partial<RelatedList>) => set(replace(lists, index, { ...list, ...changes }));
        return (
          <fieldset key={index} className="panel space-y-3 rounded-lg border p-3">
            <legend className="sr-only">{list.title}</legend>
            <div className="flex items-end gap-2">
              <Labelled label="Tab title" className="flex-1">
                <Input value={list.title} onChange={event => patch({ title: event.target.value })} className="h-8" />
              </Labelled>
              <Labelled label="Key" className="w-32">
                <Input value={list.key} onChange={event => patch({ key: event.target.value })} className="h-8 font-mono text-xs" />
              </Labelled>
              <Mover index={index} count={lists.length} what={list.title || "list"} onMove={to => set(move(lists, index, to))} onRemove={() => set(lists.filter((_, at) => at !== index))} />
            </div>
            <div className="grid gap-3 @md:grid-cols-2">
              <Labelled label="Collection">
                <Combobox
                  value={list.collection}
                  onChange={collection => patch({ collection, columns: [], match: [] })}
                  options={COLLECTION_OPTIONS}
                  allowCustom
                  aria-label="Related collection"
                  className="h-8 font-mono text-xs"
                />
              </Labelled>
              <Labelled label="Link field (holds this record's id)">
                <Combobox
                  value={list.field}
                  onChange={field => patch({ field })}
                  options={fieldOptions(fields)}
                  allowCustom
                  placeholder="e.g. invoice, or header.customer.accountId"
                  aria-label="Link field"
                  className="h-8 font-mono text-xs"
                />
              </Labelled>
              <Labelled label="Sort">
                <Input value={list.sort} onChange={event => patch({ sort: event.target.value })} placeholder="-created" className="h-8 font-mono text-xs" />
              </Labelled>
              <label className="flex items-center gap-2 self-end pb-1.5 text-xs">
                <Switch checked={list.allowCreate} onChange={event => patch({ allowCreate: event.target.checked })} aria-label="Offer New in this tab" />
                Offer <strong>New</strong> in this tab
              </label>
            </div>

            <ChipList
              label="Columns"
              values={list.columns}
              options={fieldOptions(fields, list.columns)}
              onChange={columns => patch({ columns })}
              empty="Every column the rows have."
            />

            <div className="space-y-1.5">
              <span className="block text-[11px] text-muted-foreground">Also only where</span>
              {list.match.map((match, at) => (
                <div key={at} className="flex items-center gap-2">
                  <Combobox
                    value={match.field}
                    onChange={field => patch({ match: replace(list.match, at, { ...match, field }) })}
                    options={fieldOptions(fields)}
                    allowCustom
                    aria-label="Condition field"
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <span className="text-xs text-muted-foreground">=</span>
                  <Input
                    value={match.value}
                    onChange={event => patch({ match: replace(list.match, at, { ...match, value: event.target.value }) })}
                    aria-label="Condition value"
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => patch({ match: list.match.filter((_, other) => other !== at) })} aria-label="Remove condition">
                    <X />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => patch({ match: [...list.match, { field: "", value: "" }] })}>
                <Plus /> Condition
              </Button>
            </div>
          </fieldset>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          set([
            ...lists,
            {
              key: uniqueKey("list", lists.map(list => list.key)),
              title: "New list",
              collection: "",
              field: "",
              match: [],
              columns: [],
              sort: "-created",
              allowCreate: false,
            },
          ])
        }
      >
        <Plus /> Add a related list
      </Button>
    </div>
  );
}

function ChipList({
  label,
  values,
  options,
  onChange,
  empty,
}: {
  label: string;
  values: string[];
  options: ComboboxOption[];
  onChange: (values: string[]) => void;
  empty: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        {values.length === 0 && <span className="text-xs text-muted-foreground">{empty}</span>}
        {values.map((value, index) => (
          <span key={value} className="inline-flex items-center gap-0.5 rounded-sm border bg-muted/50 px-1.5 font-mono text-[11px]">
            {index > 0 && (
              <button type="button" onClick={() => onChange(move(values, index, index - 1))} aria-label={`Move ${value} left`} className="text-muted-foreground hover:text-foreground">
                ‹
              </button>
            )}
            {value}
            <button type="button" onClick={() => onChange(values.filter(other => other !== value))} aria-label={`Remove ${value}`} className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <Combobox
        value=""
        onChange={value => value && !values.includes(value) && onChange([...values, value])}
        options={options}
        allowCustom
        placeholder={`Add to ${label.toLowerCase()}…`}
        aria-label={`Add to ${label.toLowerCase()}`}
        className="h-8 text-xs"
      />
    </div>
  );
}

/* ------------------------------ summary pane ------------------------------- */

const KIND_ICON = { field: Hash, rollup: Sigma, formula: Calculator, heading: Heading } as const;

function SummaryEditor({
  workspace,
  fields,
  related,
  onChange,
}: {
  workspace: WorkspaceLayout;
  fields: FieldInfo[];
  related: Record<string, FieldInfo[]>;
  onChange: (workspace: WorkspaceLayout) => void;
}) {
  const items = workspace.summary.items;
  const set = (next: SummaryItem[]) => onChange({ ...workspace, summary: { ...workspace.summary, items: next } });
  const keys = items.map(item => item.key);
  const listOptions = workspace.relatedLists.map(list => ({ value: list.key, label: list.title }));

  const add = (kind: SummaryItem["kind"]) => {
    const base = { key: uniqueKey(kind === "rollup" ? "total" : kind, keys), label: "", format: "number" as SummaryFormat, emphasis: false };
    const item: SummaryItem =
      kind === "heading"
        ? { kind, key: uniqueKey("heading", keys), label: "Heading" }
        : kind === "field"
          ? { kind, field: "", ...base }
          : kind === "rollup"
            ? { kind, list: workspace.relatedLists[0]?.key ?? "", op: "count", field: "", where: "", ...base }
            : { kind, expression: "", ...base };
    set([...items, item]);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Lines are worked out top to bottom. A <strong>formula</strong> uses the keys of the lines above it, in the
        formula language: <code className="font-mono">if(count &gt; 0, won / count * 100, 0)</code>. A{" "}
        <strong>roll-up</strong> counts or adds up a field across a related list, and only counts rows the reader can see.
      </p>

      <Labelled label="Currency for money lines (a field on this record)">
        <Combobox
          value={workspace.summary.currencyField}
          onChange={currencyField => onChange({ ...workspace, summary: { ...workspace.summary, currencyField } })}
          options={fieldOptions(fields)}
          allowCustom
          aria-label="Currency field"
          className="h-8 font-mono text-xs"
        />
      </Labelled>

      <ul className="space-y-2">
        {items.map((item, index) => {
          const Icon = KIND_ICON[item.kind];
          const patch = (changes: Partial<SummaryItem>) => set(replace(items, index, { ...item, ...changes } as SummaryItem));
          const above = keys.slice(0, index);
          return (
            <li key={index} className="panel space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={item.kind} />
                <Input value={item.label} onChange={event => patch({ label: event.target.value })} placeholder="Label" aria-label="Line label" className="h-8 flex-1" />
                <Input value={item.key} onChange={event => patch({ key: event.target.value })} aria-label="Line key" className="h-8 w-28 font-mono text-xs" />
                <Mover index={index} count={items.length} what={item.label || item.key} onMove={to => set(move(items, index, to))} onRemove={() => set(items.filter((_, at) => at !== index))} />
              </div>

              {item.kind === "field" && (
                <Combobox
                  value={item.field}
                  onChange={field => patch({ field })}
                  options={fieldOptions(fields)}
                  allowCustom
                  placeholder="A field, or a path into JSON: totals.grandTotal"
                  aria-label="Summary field"
                  className="h-8 font-mono text-xs"
                />
              )}

              {item.kind === "rollup" && (
                <div className="grid gap-2 @md:grid-cols-[1fr_6rem_1fr]">
                  <NativeSelect
                    label="Related list"
                    value={item.list}
                    options={listOptions.length ? listOptions : [{ value: "", label: "Add a related list first" }]}
                    onChange={list => patch({ list })}
                  />
                  <NativeSelect label="Operation" value={item.op} options={ROLLUP_OPS} onChange={op => patch({ op: op as RollupOp, field: op === "count" ? "" : item.field })} />
                  {item.op === "count" ? (
                    <span className="self-center text-[11px] text-muted-foreground">of the rows</span>
                  ) : (
                    <Combobox
                      value={item.field}
                      onChange={field => patch({ field })}
                      options={fieldOptions(related[workspace.relatedLists.find(list => list.key === item.list)?.collection ?? ""] ?? [])}
                      allowCustom
                      placeholder="Field to add up"
                      aria-label="Roll-up field"
                      className="h-8 font-mono text-xs"
                    />
                  )}
                  <Input
                    value={item.where}
                    onChange={event => patch({ where: event.target.value })}
                    placeholder='Only where… e.g. state = "issued"'
                    aria-label="Roll-up filter"
                    className="h-8 font-mono text-xs @md:col-span-3"
                  />
                </div>
              )}

              {item.kind === "formula" && (
                <div className="space-y-1">
                  <Input
                    value={item.expression}
                    onChange={event => patch({ expression: event.target.value })}
                    placeholder="grandTotal - invoiced"
                    aria-label="Formula"
                    className="h-8 font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Can use: {above.length ? above.map(name => <code key={name} className="mr-1 font-mono">{name}</code>) : "nothing yet — add lines above it."}
                  </p>
                </div>
              )}

              {item.kind !== "heading" && (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="w-32">
                    <NativeSelect label="Format" value={item.format} options={SUMMARY_FORMATS} onChange={format => patch({ format })} />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs">
                    <Switch checked={item.emphasis} onChange={event => patch({ emphasis: event.target.checked })} aria-label="Emphasize this line" />
                    The line this panel is about
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap gap-2">
        {(["field", "rollup", "formula", "heading"] as const).map(kind => {
          const Icon = KIND_ICON[kind];
          return (
            <Button key={kind} type="button" variant="outline" size="sm" onClick={() => add(kind)}>
              <Icon /> {kind === "rollup" ? "Roll-up" : kind[0]!.toUpperCase() + kind.slice(1)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
