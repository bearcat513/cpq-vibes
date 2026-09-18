import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Notice } from "./common";
import { ImagePicker } from "./ImagePicker";
import { PAGE_SIZES } from "@/lib/pdf";
import { FONT_FAMILIES } from "@/lib/pdfFonts";
import {
  BLOCK_TYPES,
  DEFAULT_LINE_COLUMNS,
  DEFAULT_TOTALS_ROWS,
  LINE_ITEM_FIELDS,
  TOTALS_FIELDS,
  blankBlock,
  renderPdf,
  type LineItemColumn,
  type PdfBlock,
  type PdfHeader,
  type PdfTemplate,
  type TotalsRow,
} from "@/lib/pdfTemplate";
import type { ProposalContext } from "@/lib/proposal";
import { cn } from "@/lib/utils";

type Props = {
  template: PdfTemplate;
  /** A real quote when one is open, otherwise the built-in specimen. */
  context: ProposalContext;
  onChange: (next: PdfTemplate) => void;
};

/**
 * Designing a PDF template.
 *
 * The blocks on the left, the document on the right, re-rendered on every
 * change — by the same `renderPdf` the server runs, so the preview *is* the
 * output rather than an impression of it. That is the whole reason the
 * renderer is pure: a template editor whose preview can disagree with the file
 * is worse than no preview.
 *
 * The preview is a blob URL in an iframe. Every browser this app targets has a
 * PDF viewer, so there is nothing to render ourselves and nothing to ship.
 */
export function PdfTemplateEditor({ template, context, onChange }: Props) {
  const [open, setOpen] = useState<number | null>(0);
  const [showPage, setShowPage] = useState(false);
  const [showHeader, setShowHeader] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const previous = useRef("");

  /* ------------------------------ the preview ---------------------------- */

  const rendered = useMemo(() => {
    try {
      return { ...renderPdf(template, context), error: "" };
    } catch (failure) {
      return {
        bytes: null,
        unknownTokens: [] as string[],
        imageProblems: [] as string[],
        pageCount: 0,
        error: failure instanceof Error ? failure.message : "This template could not be rendered.",
      };
    }
  }, [template, context]);

  useEffect(() => {
    setError(rendered.error);
    if (!rendered.bytes) return;

    // A blob URL is a document-lifetime resource; leaking one per keystroke
    // would hold every intermediate render in memory for the session.
    const blob = new Blob([rendered.bytes as unknown as BlobPart], { type: "application/pdf" });
    const next = URL.createObjectURL(blob);
    if (previous.current) URL.revokeObjectURL(previous.current);
    previous.current = next;
    setUrl(next);
  }, [rendered]);

  useEffect(
    () => () => {
      if (previous.current) URL.revokeObjectURL(previous.current);
    },
    [],
  );

  /* ------------------------------- editing ------------------------------- */

  const patchPage = (changes: Partial<PdfTemplate["page"]>) =>
    onChange({ ...template, page: { ...template.page, ...changes } });

  const patchHeader = (changes: Partial<PdfHeader>) =>
    onChange({ ...template, header: { ...(template.header ?? {}), ...changes } });

  const header: PdfHeader = template.header ?? {};

  const patchBlock = (index: number, changes: Record<string, unknown>) =>
    onChange({
      ...template,
      blocks: template.blocks.map((block, at) => (at === index ? ({ ...block, ...changes } as PdfBlock) : block)),
    });

  const addBlock = (type: PdfBlock["type"]) => {
    onChange({ ...template, blocks: [...template.blocks, blankBlock(type)] });
    setOpen(template.blocks.length);
  };

  const removeBlock = (index: number) => {
    onChange({ ...template, blocks: template.blocks.filter((_, at) => at !== index) });
    setOpen(null);
  };

  const moveBlock = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= template.blocks.length) return;
    const blocks = [...template.blocks];
    const [moved] = blocks.splice(index, 1);
    blocks.splice(target, 0, moved!);
    onChange({ ...template, blocks });
    setOpen(target);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_minmax(20rem,26rem)]">
      {/* ------------------------------ blocks ----------------------------- */}

      <div className="space-y-3">
        <div className="rounded-md border">
          <button
            type="button"
            onClick={() => setShowPage(!showPage)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-accent"
          >
            Page setup
            <span className="text-xs font-normal text-muted-foreground">
              {template.page.size} · {template.page.family} · {template.page.fontSize}pt
            </span>
          </button>

          {showPage && (
            <div className="grid gap-3 border-t p-3 sm:grid-cols-3">
              <Field label="Paper">
                <Select value={template.page.size} onValueChange={value => patchPage({ size: value as never })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZES.map(size => (
                      <SelectItem key={size} value={size}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Typeface">
                <Select value={template.page.family} onValueChange={value => patchPage({ family: value as never })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FONT_FAMILIES.map(family => (
                      <SelectItem key={family} value={family}>
                        {family}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Body size (pt)">
                <Input
                  type="number"
                  min={6}
                  max={18}
                  step="0.5"
                  value={template.page.fontSize}
                  onChange={event => patchPage({ fontSize: Number(event.target.value) })}
                />
              </Field>

              <ColorField label="Text" value={template.page.textColor} onChange={textColor => patchPage({ textColor })} />
              <ColorField label="Muted" value={template.page.mutedColor} onChange={mutedColor => patchPage({ mutedColor })} />
              <ColorField label="Accent" value={template.page.accentColor} onChange={accentColor => patchPage({ accentColor })} />

              {(["top", "right", "bottom", "left"] as const).map(edge => (
                <Field key={edge} label={`Margin ${edge} (pt)`}>
                  <Input
                    type="number"
                    min={12}
                    max={200}
                    value={template.page.margins[edge]}
                    onChange={event =>
                      patchPage({ margins: { ...template.page.margins, [edge]: Number(event.target.value) } })
                    }
                  />
                </Field>
              ))}
            </div>
          )}
        </div>

        {/* --------------------------- the letterhead ------------------------ */}

        <div className="rounded-md border">
          <button
            type="button"
            onClick={() => setShowHeader(!showHeader)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-accent"
          >
            Letterhead
            <span className="text-xs font-normal text-muted-foreground">
              {header.logo || header.text
                ? [header.logo ? "logo" : "", header.text ? "address" : "", header.firstPageOnly ? "page 1 only" : "every page"]
                    .filter(Boolean)
                    .join(" · ")
                : "none"}
            </span>
          </button>

          {showHeader && (
            <div className="space-y-3 border-t p-3">
              <ImagePicker
                value={header.logo ?? ""}
                onChange={logo => patchHeader({ logo: logo || undefined })}
                hint="Drawn in the top margin. Give the page a bigger top margin to make room for a taller logo."
              />

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Logo width (pt)">
                  <Input
                    type="number"
                    min={8}
                    max={400}
                    value={header.logoWidth ?? 110}
                    onChange={event => patchHeader({ logoWidth: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Logo side">
                  <Select
                    value={header.logoAlign ?? "left"}
                    onValueChange={value => patchHeader({ logoAlign: value === "right" ? "right" : undefined })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="right">Right</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <ColorField
                  label="Text colour"
                  value={header.color ?? ""}
                  onChange={color => patchHeader({ color: color || undefined })}
                  allowEmpty
                />
              </div>

              <Field label="Text" hint="Opposite the logo. One line each; tokens work here too.">
                <Textarea
                  value={header.text ?? ""}
                  onChange={event => patchHeader({ text: event.target.value || undefined })}
                  rows={3}
                  className="text-xs"
                  placeholder={"Nimbus Software Ltd\n14 Harbour Road, Bristol"}
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Rule under it">
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={header.rule ?? false}
                      onChange={event => patchHeader({ rule: event.target.checked || undefined })}
                    />
                  </div>
                </Field>
                <Field label="First page only" hint="Letterhead on page one, plain paper after.">
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={header.firstPageOnly ?? false}
                      onChange={event => patchHeader({ firstPageOnly: event.target.checked || undefined })}
                    />
                  </div>
                </Field>
              </div>
            </div>
          )}
        </div>

        <ul className="space-y-2">
          {template.blocks.map((block, index) => {
            const meta = BLOCK_TYPES.find(entry => entry.type === block.type);
            const expanded = open === index;

            return (
              <li key={index} className="rounded-md border">
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : index)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent"
                  >
                    <Badge tone="outline">{meta?.label ?? block.type}</Badge>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summarise(block)}</span>
                  </button>

                  <Button variant="ghost" size="icon-sm" onClick={() => moveBlock(index, -1)} aria-label="Move up" disabled={index === 0}>
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => moveBlock(index, 1)}
                    aria-label="Move down"
                    disabled={index === template.blocks.length - 1}
                  >
                    <ChevronDown />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => removeBlock(index)} aria-label="Remove block">
                    <Trash2 className="text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>

                {expanded && (
                  <div className="space-y-3 border-t p-3">
                    <BlockFields block={block} onChange={changes => patchBlock(index, changes)} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap gap-1.5">
          {BLOCK_TYPES.map(entry => (
            <Button key={entry.type} variant="outline" size="sm" onClick={() => addBlock(entry.type)} title={entry.description}>
              <Plus /> {entry.label}
            </Button>
          ))}
        </div>

        <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_auto]">
          <Field label="Footer" hint="Tokens work here too.">
            <Input
              value={template.footer.text}
              onChange={event => onChange({ ...template, footer: { ...template.footer, text: event.target.value } })}
            />
          </Field>
          <Field label="Page numbers">
            <div className="flex h-9 items-center">
              <Switch
                checked={template.footer.showPageNumbers}
                onChange={event =>
                  onChange({ ...template, footer: { ...template.footer, showPageNumbers: event.target.checked } })
                }
              />
            </div>
          </Field>
        </div>
      </div>

      {/* ------------------------------ preview ---------------------------- */}

      <div className="space-y-2 xl:sticky xl:top-4 xl:self-start">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Preview</p>
          <p className="text-xs text-muted-foreground">
            {rendered.pageCount} page{rendered.pageCount === 1 ? "" : "s"}
            {context.quote.number ? ` · ${context.quote.number}` : " · specimen quote"}
          </p>
        </div>

        <Notice kind="error" lines={error ? [error] : []} />
        <Notice
          kind="warning"
          lines={[
            ...(rendered.unknownTokens.length
              ? [`Not tokens this app knows, so they render blank: ${rendered.unknownTokens.join(", ")}`]
              : []),
            // An image that cannot be embedded is left out of the document
            // rather than failing the render — so the only place it shows up
            // is here.
            ...rendered.imageProblems,
          ]}
        />

        {url ? (
          <iframe
            src={`${url}#toolbar=0&navpanes=0`}
            title="Template preview"
            className="h-[34rem] w-full rounded-md border bg-muted"
          />
        ) : (
          <div className="flex h-[34rem] items-center justify-center rounded-md border text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Rendering…
          </div>
        )}

        {url && (
          <Button variant="outline" size="sm" asChild className="w-full">
            <a href={url} download="preview.pdf">
              Download this preview
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ block editors ---------------------------- */

function BlockFields({ block, onChange }: { block: PdfBlock; onChange: (changes: Record<string, unknown>) => void }) {
  switch (block.type) {
    case "heading":
    case "text":
      return (
        <>
          <Field label="Text" hint="Tokens like {{customer.name}} are filled in when a quote is rendered.">
            <Textarea
              value={block.text}
              onChange={event => onChange({ text: event.target.value })}
              rows={block.type === "heading" ? 2 : 4}
              className="text-xs"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Size (pt)">
              <Input
                type="number"
                min={5}
                max={72}
                step="0.5"
                value={block.size ?? ""}
                placeholder="auto"
                onChange={event => onChange({ size: event.target.value === "" ? undefined : Number(event.target.value) })}
              />
            </Field>
            <Field label="Align">
              <AlignSelect value={block.align} onChange={align => onChange({ align })} />
            </Field>
            <ColorField label="Colour" value={block.color ?? ""} onChange={color => onChange({ color: color || undefined })} allowEmpty />
            {block.type === "text" && (
              <Field label="Weight">
                <div className="flex h-9 items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs">
                    <Switch checked={block.bold ?? false} onChange={event => onChange({ bold: event.target.checked })} />
                    Bold
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <Switch checked={block.italic ?? false} onChange={event => onChange({ italic: event.target.checked })} />
                    Italic
                  </label>
                </div>
              </Field>
            )}
          </div>
        </>
      );

    case "image":
      return (
        <>
          <ImagePicker
            value={block.source}
            onChange={source => onChange({ source })}
            hint="Transparency is flattened onto white, because that is what the page is."
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Width (pt)" hint="72pt is an inch. The height follows.">
              <Input
                type="number"
                min={8}
                max={900}
                value={block.width}
                onChange={event => onChange({ width: Number(event.target.value) })}
              />
            </Field>
            <Field label="Align">
              <AlignSelect value={block.align} onChange={align => onChange({ align })} />
            </Field>
            <Field label="Caption">
              <Input
                value={block.caption ?? ""}
                onChange={event => onChange({ caption: event.target.value || undefined })}
                placeholder="none"
              />
            </Field>
          </div>
        </>
      );

    case "spacer":
      return (
        <Field label="Height (pt)">
          <Input type="number" min={0} max={400} value={block.height} onChange={event => onChange({ height: Number(event.target.value) })} />
        </Field>
      );

    case "divider":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <ColorField label="Colour" value={block.color ?? ""} onChange={color => onChange({ color: color || undefined })} allowEmpty />
          <Field label="Thickness (pt)">
            <Input
              type="number"
              min={0.1}
              max={8}
              step="0.25"
              value={block.thickness ?? 0.75}
              onChange={event => onChange({ thickness: Number(event.target.value) })}
            />
          </Field>
        </div>
      );

    case "columns":
      return (
        <>
          {block.columns.map((column, index) => (
            <div key={index} className="space-y-2 rounded border p-2">
              <div className="grid gap-2 sm:grid-cols-[1fr_7rem_2rem]">
                <Field label="Heading">
                  <Input
                    value={column.heading ?? ""}
                    onChange={event => replaceColumn(index, { heading: event.target.value || undefined })}
                  />
                </Field>
                <Field label="Align">
                  <AlignSelect value={column.align} onChange={align => replaceColumn(index, { align })} />
                </Field>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="self-end"
                  onClick={() => onChange({ columns: block.columns.filter((_, at) => at !== index) })}
                  aria-label="Remove column"
                >
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
              <Field label="Text">
                <Textarea
                  value={column.text}
                  onChange={event => replaceColumn(index, { text: event.target.value })}
                  rows={3}
                  className="text-xs"
                />
              </Field>
            </div>
          ))}
          {block.columns.length < 4 && (
            <Button variant="outline" size="sm" onClick={() => onChange({ columns: [...block.columns, { text: "" }] })}>
              <Plus /> Column
            </Button>
          )}
        </>
      );

    case "fields":
      return (
        <>
          {block.rows.map((row, index) => (
            <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_2rem]">
              <Field label={index === 0 ? "Label" : ""}>
                <Input value={row.label} onChange={event => replaceRow(index, { label: event.target.value })} />
              </Field>
              <Field label={index === 0 ? "Value" : ""}>
                <Input value={row.value} onChange={event => replaceRow(index, { value: event.target.value })} className="text-xs" />
              </Field>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange({ rows: block.rows.filter((_, at) => at !== index) })}
                aria-label="Remove row"
              >
                <Trash2 className="text-muted-foreground hover:text-destructive" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => onChange({ rows: [...block.rows, { label: "", value: "" }] })}>
            <Plus /> Row
          </Button>
        </>
      );

    case "lineItems":
      return (
        <>
          <p className="text-xs text-muted-foreground">
            Widths are shares of the table, so the columns fit any paper size and any margin.
          </p>

          {block.columns.map((column, index) => (
            <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_5rem_6rem_2rem]">
              <Field label={index === 0 ? "Shows" : ""}>
                <Select value={column.field} onValueChange={value => replaceLineColumn(index, { field: value as never })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LINE_ITEM_FIELDS.map(entry => (
                      <SelectItem key={entry.field} value={entry.field}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={index === 0 ? "Heading" : ""}>
                <Input value={column.header} onChange={event => replaceLineColumn(index, { header: event.target.value })} />
              </Field>
              <Field label={index === 0 ? "Width" : ""}>
                <Input
                  type="number"
                  min={0.1}
                  step="0.1"
                  value={column.width}
                  onChange={event => replaceLineColumn(index, { width: Number(event.target.value) })}
                />
              </Field>
              <Field label={index === 0 ? "Align" : ""}>
                <AlignSelect value={column.align} onChange={align => replaceLineColumn(index, { align })} />
              </Field>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange({ columns: block.columns.filter((_, at) => at !== index) })}
                aria-label="Remove column"
              >
                <Trash2 className="text-muted-foreground hover:text-destructive" />
              </Button>
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange({ columns: [...block.columns, { field: "sku", header: "SKU", width: 2 }] })}
          >
            <Plus /> Column
          </Button>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Options line">
              <div className="flex h-9 items-center">
                <Switch checked={block.showOptions !== false} onChange={event => onChange({ showOptions: event.target.checked })} />
              </div>
            </Field>
            <Field label="Line note">
              <div className="flex h-9 items-center">
                <Switch
                  checked={block.showDescription !== false}
                  onChange={event => onChange({ showDescription: event.target.checked })}
                />
              </div>
            </Field>
            <ColorField
              label="Header fill"
              value={block.headerFill ?? ""}
              onChange={headerFill => onChange({ headerFill: headerFill || undefined })}
              allowEmpty
            />
            <ColorField
              label="Zebra"
              value={block.zebra ?? ""}
              onChange={zebra => onChange({ zebra: zebra || undefined })}
              allowEmpty
            />
          </div>
        </>
      );

    case "totals":
      return (
        <>
          <p className="text-xs text-muted-foreground">
            Only customer-facing numbers are offered — a proposal template has no way to print cost or margin.
          </p>

          {block.rows.map((row, index) => (
            <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_4rem_4rem_2rem]">
              <Field label={index === 0 ? "Label" : ""}>
                <Input value={row.label} onChange={event => replaceTotalsRow(index, { label: event.target.value })} />
              </Field>
              <Field label={index === 0 ? "Shows" : ""}>
                <Select value={row.field} onValueChange={value => replaceTotalsRow(index, { field: value as never })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOTALS_FIELDS.map(entry => (
                      <SelectItem key={entry.field} value={entry.field}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={index === 0 ? "Bold" : ""}>
                <div className="flex h-9 items-center">
                  <Switch checked={row.emphasis ?? false} onChange={event => replaceTotalsRow(index, { emphasis: event.target.checked })} />
                </div>
              </Field>
              <Field label={index === 0 ? "Hide 0" : ""}>
                <div className="flex h-9 items-center">
                  <Switch
                    checked={row.omitIfZero ?? false}
                    onChange={event => replaceTotalsRow(index, { omitIfZero: event.target.checked })}
                  />
                </div>
              </Field>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange({ rows: block.rows.filter((_, at) => at !== index) })}
                aria-label="Remove row"
              >
                <Trash2 className="text-muted-foreground hover:text-destructive" />
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-end gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ rows: [...block.rows, { label: "Subtotal", field: "subtotal" }] })}
            >
              <Plus /> Row
            </Button>
            <Field label="Panel width (pt)">
              <Input
                type="number"
                min={120}
                max={600}
                value={block.width ?? 260}
                onChange={event => onChange({ width: Number(event.target.value) })}
                className="w-28"
              />
            </Field>
          </div>
        </>
      );

    case "signatures":
      return (
        <>
          {block.parties.map((party, index) => (
            <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_2rem]">
              <Field label={index === 0 ? "Label" : ""}>
                <Input value={party.label} onChange={event => replaceParty(index, { label: event.target.value })} />
              </Field>
              <Field label={index === 0 ? "Caption" : ""}>
                <Input value={party.caption ?? ""} onChange={event => replaceParty(index, { caption: event.target.value || undefined })} />
              </Field>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange({ parties: block.parties.filter((_, at) => at !== index) })}
                aria-label="Remove party"
              >
                <Trash2 className="text-muted-foreground hover:text-destructive" />
              </Button>
            </div>
          ))}
          {block.parties.length < 4 && (
            <Button variant="outline" size="sm" onClick={() => onChange({ parties: [...block.parties, { label: "" }] })}>
              <Plus /> Party
            </Button>
          )}
        </>
      );

    case "pageBreak":
      return <p className="text-xs text-muted-foreground">Everything after this starts on a new page.</p>;
  }

  /* --- helpers that close over the block, so the editors stay readable --- */

  function replaceColumn(index: number, changes: Record<string, unknown>) {
    if (block.type !== "columns") return;
    onChange({ columns: block.columns.map((column, at) => (at === index ? { ...column, ...changes } : column)) });
  }

  function replaceRow(index: number, changes: Record<string, unknown>) {
    if (block.type !== "fields") return;
    onChange({ rows: block.rows.map((row, at) => (at === index ? { ...row, ...changes } : row)) });
  }

  function replaceLineColumn(index: number, changes: Partial<LineItemColumn>) {
    if (block.type !== "lineItems") return;
    onChange({ columns: block.columns.map((column, at) => (at === index ? { ...column, ...changes } : column)) });
  }

  function replaceTotalsRow(index: number, changes: Partial<TotalsRow>) {
    if (block.type !== "totals") return;
    onChange({ rows: block.rows.map((row, at) => (at === index ? { ...row, ...changes } : row)) });
  }

  function replaceParty(index: number, changes: Record<string, unknown>) {
    if (block.type !== "signatures") return;
    onChange({ parties: block.parties.map((party, at) => (at === index ? { ...party, ...changes } : party)) });
  }
}

/* -------------------------------- controls ------------------------------- */

function AlignSelect({
  value,
  onChange,
}: {
  value: "left" | "center" | "right" | undefined;
  onChange: (value: "left" | "center" | "right") => void;
}) {
  return (
    <Select value={value ?? "left"} onValueChange={next => onChange(next as "left" | "center" | "right")}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="left">Left</SelectItem>
        <SelectItem value="center">Centre</SelectItem>
        <SelectItem value="right">Right</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** A swatch and a hex box, kept in step. */
function ColorField({
  label,
  value,
  onChange,
  allowEmpty,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
          onChange={event => onChange(event.target.value)}
          className="h-9 w-9 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
          aria-label={`${label} colour`}
        />
        <Input
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={allowEmpty ? "none" : "#000000"}
          className={cn("font-mono text-xs", allowEmpty && !value && "text-muted-foreground")}
        />
      </div>
    </Field>
  );
}

/** The one-line description beside a collapsed block. */
function summarise(block: PdfBlock): string {
  switch (block.type) {
    case "heading":
    case "text":
      return block.text.replace(/\s+/g, " ").slice(0, 70) || "empty";
    case "image":
      return block.source ? `${block.width}pt wide${block.caption ? ` · ${block.caption}` : ""}` : "no image chosen";
    case "spacer":
      return `${block.height}pt`;
    case "divider":
      return block.color ?? "rule";
    case "columns":
      return block.columns.map(column => column.heading || "column").join(" · ");
    case "fields":
      return block.rows.map(row => row.label).filter(Boolean).join(" · ") || "no rows";
    case "lineItems":
      return block.columns.map(column => column.header || column.field).join(" · ");
    case "totals":
      return block.rows.map(row => row.label).filter(Boolean).join(" · ");
    case "signatures":
      return block.parties.map(party => party.label || "party").join(" · ");
    case "pageBreak":
      return "new page";
  }
}
