import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useForm } from "@tanstack/react-form";
import { AlertCircle, ChevronRight, ExternalLink, LayoutTemplate, Loader2, Lock, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { tablePageUrl, type TableRecord } from "@/lib/dataTable";
import {
  buildPatch,
  editableFields,
  fieldError,
  initialValues,
  RECORD_FORMS_COLLECTION,
  resolveSections,
  type FormValue,
  type FormValues,
  type RecordWithForm,
  type ResolvedField,
} from "@/lib/recordForm";
import { cn } from "@/lib/utils";
import { nativeSelect } from "./QueryBuilder";

/**
 * The record form: one record's fields, laid out by its collection's
 * `record_forms` row or built from the record, held by TanStack Form. Each
 * field runs its check from `src/lib/recordForm.ts` — the same check the
 * server runs again on save — and only the fields that moved are sent.
 *
 * The details pane of the record workspace (`RecordWorkspace.tsx`), and the
 * form a related list's "New" opens.
 */

/* --------------------------------- the form -------------------------------- */

export function RecordFormBody({
  formId,
  collection,
  id,
  loaded,
  canEditLayout,
  onDirtyChange,
  onReload,
  onSaved,
  submit,
  hideLayoutNotice,
  collapsible,
}: {
  formId: string;
  collection: string;
  id: string;
  loaded: RecordWithForm;
  canEditLayout: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onReload: () => void;
  onSaved: (next: RecordWithForm) => void;
  /**
   * Sends the change. An edit by default; a new record passes its own, which
   * receives every field that moved from blank.
   */
  submit?: (patch: TableRecord, updated: string | null) => Promise<RecordWithForm>;
  /** The workspace says where its layout comes from itself. */
  hideLayoutNotice?: boolean;
  /**
   * Sections fold, and the bookkeeping ones start folded — so a record's
   * related lists are not a long scroll below its ids and stamps.
   */
  collapsible?: boolean;
}) {
  const { record, form: layout } = loaded;
  const sections = useMemo(() => resolveSections(layout, record), [layout, record]);
  const editable = useMemo(() => editableFields(layout, record), [layout, record]);
  const defaultValues = useMemo(() => initialValues(sections, record), [sections, record]);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [folded, setFolded] = useState<Set<number>>(
    () => new Set(collapsible ? sections.flatMap((section, index) => (FOLDED_BY_DEFAULT.has(section.title) ? [index] : [])) : []),
  );
  const toggle = (index: number) =>
    setFolded(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const form = useForm({
    defaultValues: defaultValues as FormValues,
    onSubmit: async ({ value }) => {
      setSaveError(null);
      const built = buildPatch(editable, value, record);
      if (!built.ok) {
        setSaveError({ message: Object.values(built.errors)[0]!, conflict: false });
        return;
      }
      // Nothing moved is nothing to save — except for a new record, which exists once sent.
      if (Object.keys(built.patch).length === 0 && !submit) return;
      try {
        const updated = typeof record.updated === "string" ? record.updated : null;
        onSaved(await (submit ?? ((patch, stamp) => api.updateTableRecord(collection, id, patch, stamp)))(built.patch, updated));
        onDirtyChange(false);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "The change could not be saved.";
        setSaveError({ message, conflict: (reason as { status?: number }).status === 409 && layout.writable });
      }
    },
  });

  // Ctrl/⌘ Enter saves from anywhere in the form.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void form.handleSubmit();
    }
  };

  return (
    <form
      id={formId}
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={event => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      onReset={event => {
        event.preventDefault();
        form.reset();
        setSaveError(null);
      }}
      className="space-y-4 pb-2"
    >
      <form.Subscribe selector={state => state.isDirty && !state.isDefaultValue}>
        {dirty => <DirtyReporter dirty={dirty} onChange={onDirtyChange} />}
      </form.Subscribe>

      {!hideLayoutNotice && <LayoutNotice loaded={loaded} collection={collection} canEditLayout={canEditLayout} />}

      {sections.map((section, index) => (
        <fieldset
          key={`${section.title}-${index}`}
          className="panel motion-safe:animate-rise rounded-lg border shadow-[0_1px_2px_var(--cast)]"
        >
          {(section.title || section.description) && (
            <legend className="sr-only">{section.title || `Section ${index + 1}`}</legend>
          )}
          {(section.title || section.description) &&
            (collapsible ? (
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-expanded={!folded.has(index)}
                className={cn("flex w-full items-center gap-2 px-3 py-2 text-left", !folded.has(index) && "seam border-b")}
              >
                <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !folded.has(index) && "rotate-90")} />
                <span className="min-w-0 flex-1">
                  {section.title && <span className="block font-display text-sm font-semibold">{section.title}</span>}
                  {section.description && <span className="block text-xs text-muted-foreground">{section.description}</span>}
                </span>
                {folded.has(index) && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {section.fields.length} {section.fields.length === 1 ? "field" : "fields"}
                  </span>
                )}
              </button>
            ) : (
              <div className="seam border-b px-3 py-2">
                {section.title && <h3 className="font-display text-sm font-semibold">{section.title}</h3>}
                {section.description && <p className="text-xs text-muted-foreground">{section.description}</p>}
              </div>
            ))}
          {/* Folded, not unmounted: a field's value and its check stay with the form. */}
          <div className={cn("grid gap-3 p-3", section.columns === 2 && "@md:grid-cols-2", folded.has(index) && "hidden")}>
            {section.fields.map(field => (
              <form.Field
                key={field.name}
                name={field.name}
                validators={
                  field.readOnly
                    ? undefined
                    : {
                        // An untouched value is not sent, so it is not judged: a stored family
                        // the layout's options leave out must not block saving the name.
                        onChange: ({ value }) =>
                          unchanged(value, defaultValues[field.name]) ? undefined : (fieldError(field, value) ?? undefined),
                      }
                }
              >
                {state => {
                  const errors = state.state.meta.errors.filter(Boolean).map(String);
                  const shownError = state.state.meta.isTouched || state.form.state.submissionAttempts > 0 ? errors[0] : undefined;
                  return (
                    <FieldShell
                      field={field}
                      inputId={`${formId}-${field.name}`}
                      error={shownError}
                      className={cn(field.span === 2 && "@md:col-span-2")}>
                      <Widget
                        field={field}
                        inputId={`${formId}-${field.name}`}
                        value={state.state.value as FormValue}
                        invalid={Boolean(shownError)}
                        onChange={next => state.handleChange(next)}
                        onBlur={state.handleBlur}
                      />
                    </FieldShell>
                  );
                }}
              </form.Field>
            ))}
          </div>
        </fieldset>
      ))}

      {saveError && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{saveError.message}</span>
          {saveError.conflict && (
            <Button type="button" variant="outline" size="sm" onClick={onReload}>
              <RefreshCw />
              Reload
            </Button>
          )}
        </div>
      )}
    </form>
  );
}

/** The sections of ids, stamps and leftovers — open on request, not by default. */
const FOLDED_BY_DEFAULT = new Set(["Record", "Other fields"]);

const unchanged = (a: FormValue, b: FormValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Lifts TanStack Form's dirty flag out to the panel, which asks before closing. */
function DirtyReporter({ dirty, onChange }: { dirty: boolean; onChange: (dirty: boolean) => void }) {
  useEffect(() => onChange(dirty), [dirty, onChange]);
  return null;
}

/** Save and reset, outside the scroll area — tied to the form by its id. */
export function FormFooter({ formId, writable, onClose }: { formId: string; writable: boolean; onClose: () => void }) {
  return (
    <>
      <p className="mr-auto hidden text-[11px] text-muted-foreground sm:block">
        {writable ? "Only changed fields are saved." : "Read-only here."}
      </p>
      <Button variant="ghost" onClick={onClose}>
        {writable ? "Cancel" : "Close"}
      </Button>
      {writable && (
        <>
          <Button type="reset" form={formId} variant="outline">
            <RotateCcw />
            Reset
          </Button>
          <Button type="submit" form={formId}>
            Save
          </Button>
        </>
      )}
    </>
  );
}

/** Where the layout came from, and the way to change it. */
function LayoutNotice({
  loaded,
  collection,
  canEditLayout,
}: {
  loaded: RecordWithForm;
  collection: string;
  canEditLayout: boolean;
}) {
  const { form } = loaded;
  const [configId, setConfigId] = useState(form.configId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function storeLayout() {
    setBusy(true);
    setError("");
    try {
      const created = await api.createRecordForm(collection);
      setConfigId(created.id);
      window.open(tablePageUrl(RECORD_FORMS_COLLECTION, "", created.id), "_blank", "noopener");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The layout could not be stored.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {!form.writable && form.readOnlyReason && (
        <p className="flex items-start gap-2 rounded-md border border-hazard/40 bg-hazard/10 px-2.5 py-1.5 text-xs text-hazard">
          <Lock className="mt-px size-3.5 shrink-0" />
          {form.readOnlyReason}
        </p>
      )}
      {form.problem && (
        <p className="flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-2.5 py-1.5 text-xs text-alert">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          {form.problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <LayoutTemplate className="size-3.5" />
        <span className="flex-1">
          {form.source === "stored" ? (
            <>
              Laid out by <code className="font-mono">{RECORD_FORMS_COLLECTION}</code>.
            </>
          ) : configId ? (
            <>Layout stored — edit it, then reopen this record.</>
          ) : (
            <>
              Default layout — nothing in <code className="font-mono">{RECORD_FORMS_COLLECTION}</code> for this collection.
            </>
          )}
        </span>
        {canEditLayout &&
          (configId ? (
            <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-[11px]">
              <a href={tablePageUrl(RECORD_FORMS_COLLECTION, "", configId)} target="_blank" rel="noopener">
                Edit layout
                <ExternalLink />
              </a>
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={storeLayout} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <LayoutTemplate />}
              Customize layout
            </Button>
          ))}
      </div>
      {error && <p className="text-xs text-alert">{error}</p>}
    </div>
  );
}

/* --------------------------------- fields --------------------------------- */

function FieldShell({
  field,
  inputId,
  error,
  className,
  children,
}: {
  field: ResolvedField;
  inputId: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
        <label htmlFor={inputId}>{field.label}</label>
        {field.required && !field.readOnly && <span className="text-alert" aria-hidden="true">*</span>}
        {field.readOnly && <Lock className="size-3 self-center opacity-60" aria-label="read-only" />}
        <code className="ml-auto font-mono text-[10px] opacity-60">{field.name}</code>
      </div>
      {children}
      {error ? (
        <p className="text-xs text-alert">{error}</p>
      ) : (
        field.help && <p className="text-xs text-muted-foreground">{field.help}</p>
      )}
    </div>
  );
}

type WidgetProps = {
  field: ResolvedField;
  inputId: string;
  value: FormValue;
  invalid: boolean;
  onChange: (value: FormValue) => void;
  onBlur: () => void;
};

function Widget({ field, inputId, value, invalid, onChange, onBlur }: WidgetProps) {
  const common = {
    id: inputId,
    "aria-label": field.label,
    "aria-invalid": invalid || undefined,
    "aria-required": field.required || undefined,
    readOnly: field.readOnly,
    onBlur,
    placeholder: field.placeholder || undefined,
  };
  const text = typeof value === "string" ? value : "";

  switch (field.widget) {
    case "checkbox":
      return (
        <div className="flex h-9 items-center">
          <Switch
            id={inputId}
            aria-label={field.label}
            checked={value === true}
            disabled={field.readOnly}
            onChange={event => onChange(event.target.checked)}
            onBlur={onBlur}
          />
        </div>
      );
    case "textarea":
    case "json":
      return (
        <Textarea
          {...common}
          value={text}
          rows={field.rows}
          spellCheck={field.widget !== "json"}
          onChange={event => onChange(event.target.value)}
          className={cn(field.widget === "json" && "max-h-64 font-mono text-xs", field.readOnly && "bg-muted/40 text-muted-foreground")}
        />
      );
    case "select": {
      const options = text && !field.options.includes(text) ? [text, ...field.options] : field.options;
      return (
        <select
          id={inputId}
          aria-label={field.label}
          aria-invalid={invalid || undefined}
          value={text}
          disabled={field.readOnly}
          onChange={event => onChange(event.target.value)}
          onBlur={onBlur}
          className={cn(nativeSelect, "h-9 w-full text-sm")}
        >
          {(!field.required || !text) && <option value="">—</option>}
          {options.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    case "tags":
      return (
        <TagsInput
          inputId={inputId}
          label={field.label}
          value={Array.isArray(value) ? value : []}
          readOnly={field.readOnly}
          invalid={invalid}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
    default:
      return (
        <Input
          {...common}
          type={field.widget === "date" ? "datetime-local" : field.widget === "email" ? "email" : field.widget === "url" ? "url" : "text"}
          inputMode={field.widget === "number" ? "decimal" : undefined}
          value={text}
          onChange={event => onChange(event.target.value)}
          className={cn(
            (field.widget === "number" || field.name === "id") && "font-mono tabular-nums",
            field.readOnly && "bg-muted/40 text-muted-foreground",
          )}
        />
      );
  }
}

/** A list of short strings: Enter or a comma adds one, Backspace in an empty input takes the last back. */
function TagsInput({
  inputId,
  label,
  value,
  readOnly,
  invalid,
  onChange,
  onBlur,
}: {
  inputId: string;
  label: string;
  value: string[];
  readOnly: boolean;
  invalid: boolean;
  onChange: (value: string[]) => void;
  onBlur: () => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const entry = draft.trim();
    if (entry && !value.includes(entry)) onChange([...value, entry]);
    setDraft("");
  };

  return (
    <div
      aria-invalid={invalid || undefined}
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1 shadow-xs aria-invalid:border-destructive dark:bg-input/30",
        readOnly && "bg-muted/40",
      )}
    >
      {value.map(entry => (
        <span key={entry} className="inline-flex items-center gap-1 rounded-sm border bg-muted/50 px-1.5 font-mono text-[11px]">
          {entry}
          {!readOnly && (
            <button
              type="button"
              onClick={() => onChange(value.filter(other => other !== entry))}
              aria-label={`Remove ${entry}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          id={inputId}
          aria-label={label}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" || event.key === ",") {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              add();
            } else if (event.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            add();
            onBlur();
          }}
          placeholder={value.length ? "" : "Type, then Enter"}
          className="min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        />
      )}
      {readOnly && value.length === 0 && <span className="text-sm text-muted-foreground">—</span>}
    </div>
  );
}
