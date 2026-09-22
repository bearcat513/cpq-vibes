import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "@/components/docs/Markdown";
import { constraints, refName, resolve, typeLabel, type OpenApiDoc, type Schema } from "@/lib/openapiDoc";
import { cn } from "@/lib/utils";

/**
 * A schema, drawn as the shape a value of it has.
 *
 * Nested objects are collapsed until asked for. The document describes a
 * product whose option groups hold options, a quote that holds priced lines
 * that hold applied rules — opened all the way down, one quote fills a screen
 * with punctuation and tells the reader nothing they came for.
 *
 * `seen` carries the named schemas already open above this one, which is what
 * stops a self-referential model from expanding forever.
 */

type Props = {
  doc: OpenApiDoc;
  schema: Schema;
  seen?: string[];
};

/** Whether a row has anything under it worth opening. */
function hasChildren(doc: OpenApiDoc, schema: Schema, seen: string[]): boolean {
  const named = refName(schema);
  if (named && seen.includes(named)) return false;

  const node = resolve(doc, schema);
  if (node.properties || Array.isArray(node.allOf)) return true;
  if (node.type === "array") return hasChildren(doc, resolve(doc, node.items), named ? [...seen, named] : seen);
  return false;
}

/** The schema a row expands into: an array opens as the shape of its items. */
function childSchema(doc: OpenApiDoc, schema: Schema): Schema {
  const node = resolve(doc, schema);
  return node.type === "array" ? (node.items as Schema) : schema;
}

function EnumValues({ values }: { values: unknown[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {values.map((value, index) => (
        <span key={index} className="rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]">
          {value === "" ? '""' : String(value)}
        </span>
      ))}
    </div>
  );
}

function Property({
  doc,
  name,
  schema,
  required,
  seen,
}: {
  doc: OpenApiDoc;
  name: string;
  schema: Schema;
  required: boolean;
  seen: string[];
}) {
  const [open, setOpen] = useState(false);

  const node = resolve(doc, schema);
  const child = childSchema(doc, schema);
  const childName = refName(child);
  const expandable = hasChildren(doc, schema, seen);
  const notes = constraints(node);

  return (
    <div className="border-t py-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="-ml-1 flex items-center gap-1 rounded font-mono text-xs font-medium text-foreground hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
            {name}
          </button>
        ) : (
          <span className="font-mono text-xs font-medium text-foreground">{name}</span>
        )}

        <span className="font-mono text-[11px] text-primary/80">{typeLabel(doc, schema)}</span>

        {required && <span className="text-[11px] font-medium text-destructive">required</span>}

        {notes.map(note => (
          <span key={note} className="text-[11px] text-muted-foreground/80">
            {note}
          </span>
        ))}
      </div>

      {typeof node.description === "string" && node.description && (
        <Markdown source={node.description} className="mt-0.5 text-xs" />
      )}

      {Array.isArray(node.enum) && <EnumValues values={node.enum} />}

      {open && (
        <div className="mt-2 rounded-md border bg-background/60 p-3">
          <SchemaView doc={doc} schema={child} seen={childName ? [...seen, childName] : seen} />
        </div>
      )}
    </div>
  );
}

export function SchemaView({ doc, schema, seen = [] }: Props) {
  const named = refName(schema);
  const node = resolve(doc, schema);
  const nested = named ? [...seen, named] : seen;

  // An `allOf` is the sum of its parts; the document only uses it to add the
  // stored fields to an input shape, so its parts are drawn one after another.
  if (Array.isArray(node.allOf)) {
    return (
      <div className="space-y-2">
        {node.allOf.map((entry, index) => (
          <SchemaView key={index} doc={doc} schema={entry as Schema} seen={nested} />
        ))}
      </div>
    );
  }

  const alternatives = node.oneOf ?? node.anyOf;
  if (Array.isArray(alternatives) && alternatives.length) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">Any one of these shapes:</p>
        {alternatives.map((entry, index) => (
          <div key={index} className="rounded-md border bg-background/60 p-3">
            <SchemaView doc={doc} schema={entry as Schema} seen={nested} />
          </div>
        ))}
      </div>
    );
  }

  if (node.type === "array") {
    return (
      <div className="space-y-2">
        <p className="font-mono text-[11px] text-muted-foreground">array of {typeLabel(doc, node.items)}</p>
        <SchemaView doc={doc} schema={node.items as Schema} seen={nested} />
      </div>
    );
  }

  const properties = Object.entries((node.properties as Record<string, Schema> | undefined) ?? {});
  const required = Array.isArray(node.required) ? node.required.map(String) : [];

  if (!properties.length) {
    return (
      <div className="space-y-1">
        <p className="font-mono text-xs text-primary/80">{typeLabel(doc, schema)}</p>
        {typeof node.description === "string" && node.description && (
          <Markdown source={node.description} className="text-xs" />
        )}
        {Array.isArray(node.enum) && <EnumValues values={node.enum} />}
        {node.additionalProperties !== undefined && node.additionalProperties !== false && (
          <p className="text-[11px] text-muted-foreground">Free-form: any key is allowed.</p>
        )}
      </div>
    );
  }

  return (
    <div>
      {properties.map(([name, property]) => (
        <Property key={name} doc={doc} name={name} schema={property} required={required.includes(name)} seen={nested} />
      ))}
    </div>
  );
}
