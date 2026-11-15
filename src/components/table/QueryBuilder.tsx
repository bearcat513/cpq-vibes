import { useMemo } from "react";
import { FolderPlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { isListField, valueKindFor, type FieldInfo } from "@/lib/dataTable";
import {
  emptyGroup,
  FILTER_MACROS,
  FILTER_OPERATORS,
  newCondition,
  updateNode,
  VALUE_KINDS,
  type FilterCondition,
  type FilterGroup,
  type FilterJoin,
  type FilterNode,
  type FilterOperator,
  type ValueKind,
} from "@/lib/filterQuery";
import { cn } from "@/lib/utils";

/**
 * The filter as a tree of conditions and groups.
 *
 * It edits a `FilterGroup` and nothing else — `serializeFilter` in
 * `lib/filterQuery.ts` is what writes the PocketBase string, so no input here
 * ever has to think about quoting. Groups nest without limit; each one is all
 * (`&&`) or any (`||`) of what it holds, and is parenthesised on the way out.
 */

export const nativeSelect =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

type Props = {
  value: FilterGroup;
  onChange: (value: FilterGroup) => void;
  fields: FieldInfo[];
  /** Condition id → what is wrong with it. */
  problems: Record<string, string>;
};

export function QueryBuilder({ value, onChange, fields, problems }: Props) {
  const fieldOptions = useMemo<ComboboxOption[]>(
    () => fields.map(field => ({ value: field.name, label: field.name, badge: field.type })),
    [fields],
  );
  const typeOf = useMemo(() => new Map(fields.map(field => [field.name, field.type])), [fields]);

  const edit = (id: string, update: (node: FilterNode) => FilterNode | null) => onChange(updateNode(value, id, update));

  return (
    <>
      <datalist id="table-filter-identifiers">
        {FILTER_MACROS.map(macro => (
          <option key={macro} value={macro} />
        ))}
        {fields.map(field => (
          <option key={field.name} value={field.name} />
        ))}
      </datalist>
      <Group
        group={value}
        root
        onChange={onChange}
        edit={edit}
        fieldOptions={fieldOptions}
        typeOf={typeOf}
        problems={problems}
        firstField={fields.find(field => field.name !== "id")?.name ?? ""}
      />
    </>
  );
}

type GroupProps = {
  group: FilterGroup;
  root?: boolean;
  onChange: (group: FilterGroup) => void;
  edit: (id: string, update: (node: FilterNode) => FilterNode | null) => void;
  fieldOptions: ComboboxOption[];
  typeOf: Map<string, FieldInfo["type"]>;
  problems: Record<string, string>;
  firstField: string;
};

function Group({ group, root, onChange, edit, fieldOptions, typeOf, problems, firstField }: GroupProps) {
  const replace = (next: FilterGroup) => (root ? onChange(next) : edit(group.id, () => next));
  const add = (node: FilterNode) => replace({ ...group, children: [...group.children, node] });
  const addCondition = () => add(newCondition(firstField, valueKindFor(typeOf.get(firstField))));
  const addGroup = () => {
    const nested = emptyGroup(group.join === "&&" ? "||" : "&&");
    nested.children.push(newCondition(firstField, valueKindFor(typeOf.get(firstField))));
    add(nested);
  };

  return (
    <div
      role="group"
      aria-label={root ? "Filter" : "Condition group"}
      className={cn("space-y-2", !root && "rounded-md border border-dashed bg-muted/30 p-2.5")}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Match</span>
        <JoinToggle join={group.join} onChange={join => replace({ ...group, join })} />
        <span>of {root ? "these conditions" : "this group"}</span>
        {!root && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto size-7"
            onClick={() => edit(group.id, () => null)}
            aria-label="Remove this group"
            title="Remove this group"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {group.children.length === 0 && (
        <p className="text-xs text-muted-foreground/80">
          {root ? "No conditions — every row the collection's rules let you see." : "An empty group matches nothing extra."}
        </p>
      )}

      <div className="space-y-2">
        {group.children.map(child =>
          child.type === "group" ? (
            <Group
              key={child.id}
              group={child}
              onChange={onChange}
              edit={edit}
              fieldOptions={fieldOptions}
              typeOf={typeOf}
              problems={problems}
              firstField={firstField}
            />
          ) : (
            <ConditionRow
              key={child.id}
              condition={child}
              onChange={next => edit(child.id, () => next)}
              onRemove={() => edit(child.id, () => null)}
              fieldOptions={fieldOptions}
              typeOf={typeOf}
              problem={problems[child.id]}
            />
          ),
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addCondition}>
          <Plus className="size-3.5" />
          Condition
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={addGroup}>
          <FolderPlus className="size-3.5" />
          Group
        </Button>
      </div>
    </div>
  );
}

function JoinToggle({ join, onChange }: { join: FilterJoin; onChange: (join: FilterJoin) => void }) {
  const choices: { join: FilterJoin; label: string }[] = [
    { join: "&&", label: "all" },
    { join: "||", label: "any" },
  ];
  return (
    <div className="inline-flex gap-0.5 rounded-md border bg-muted/60 p-0.5">
      {choices.map(choice => (
        <button
          key={choice.join}
          type="button"
          aria-pressed={choice.join === join}
          onClick={() => onChange(choice.join)}
          className={cn(
            "rounded px-2 py-0.5 text-xs font-medium transition-colors",
            choice.join === join ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

type ConditionProps = {
  condition: FilterCondition;
  onChange: (condition: FilterCondition) => void;
  onRemove: () => void;
  fieldOptions: ComboboxOption[];
  typeOf: Map<string, FieldInfo["type"]>;
  problem?: string;
};

function ConditionRow({ condition, onChange, onRemove, fieldOptions, typeOf, problem }: ConditionProps) {
  const { field, op, value } = condition;
  const type = typeOf.get(field);

  /** A new field brings the value kind and the operator family that suit it. */
  function chooseField(next: string) {
    const nextType = typeOf.get(next);
    const kind = valueKindFor(nextType);
    const listy = isListField(nextType);
    const nextOp: FilterOperator = listy && !op.startsWith("?") ? "?=" : !listy && op.startsWith("?") ? "=" : op;
    onChange({
      ...condition,
      field: next,
      op: nextOp,
      value: value.text && value.kind === kind ? value : { kind, text: kind === "boolean" ? "true" : "" },
    });
  }

  function chooseKind(kind: ValueKind) {
    onChange({ ...condition, value: { kind, text: kind === "boolean" ? "true" : kind === "null" ? "" : value.text } });
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1.5 @2xl:grid-cols-[minmax(9rem,1.1fr)_minmax(8rem,0.9fr)_minmax(7rem,0.7fr)_minmax(8rem,1.3fr)_auto]">
        <Combobox
          value={field}
          onChange={chooseField}
          options={fieldOptions}
          allowCustom
          placeholder="Field…"
          aria-label="Field"
          className="col-span-1 h-8 text-xs"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="Remove this condition"
          title="Remove this condition"
          className="@2xl:order-last"
        >
          <Trash2 className="size-3.5" />
        </Button>

        <div className="col-span-2 grid grid-cols-2 gap-1.5 @2xl:col-span-1 @2xl:contents">
          <select
            aria-label="Operator"
            value={op}
            onChange={event => onChange({ ...condition, op: event.target.value as FilterOperator })}
            className={nativeSelect}
          >
            {FILTER_OPERATORS.map(entry => (
              <option key={entry.op} value={entry.op}>
                {entry.op} {entry.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Value type"
            value={value.kind}
            onChange={event => chooseKind(event.target.value as ValueKind)}
            className={nativeSelect}
          >
            {VALUE_KINDS.map(entry => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2 @2xl:col-span-1">
          <ValueInput condition={condition} type={type} onChange={onChange} invalid={Boolean(problem)} />
        </div>
      </div>
      {problem && <p className="text-[11px] text-alert">{problem}</p>}
    </div>
  );
}

function ValueInput({
  condition,
  type,
  onChange,
  invalid,
}: {
  condition: FilterCondition;
  type: FieldInfo["type"] | undefined;
  onChange: (condition: FilterCondition) => void;
  invalid: boolean;
}) {
  const { value } = condition;
  const set = (text: string) => onChange({ ...condition, value: { ...value, text } });

  if (value.kind === "null") {
    return <div className="flex h-8 items-center px-1 font-mono text-xs text-muted-foreground">null</div>;
  }

  if (value.kind === "boolean") {
    return (
      <select aria-label="Value" value={value.text} onChange={event => set(event.target.value)} className={cn(nativeSelect, "w-full")}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  return (
    <Input
      aria-label="Value"
      aria-invalid={invalid || undefined}
      value={value.text}
      onChange={event => set(event.target.value)}
      inputMode={value.kind === "number" ? "decimal" : undefined}
      list={value.kind === "identifier" ? "table-filter-identifiers" : undefined}
      spellCheck={false}
      placeholder={
        value.kind === "identifier"
          ? "@now, another field…"
          : value.kind === "number"
            ? "0"
            : type === "date"
              ? "2026-01-31 00:00:00"
              : "value"
      }
      className="h-8 font-mono text-xs"
    />
  );
}
