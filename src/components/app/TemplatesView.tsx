import { useMemo, useState } from "react";
import { FileText, Loader2, Plus, Save, Share2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, Notice, Section } from "./common";
import { PdfTemplateEditor } from "./PdfTemplateEditor";
import { api, type Shareable } from "@/lib/api";
import { LINES_CLOSE, LINES_OPEN, unknownTokensIn, type TokenDescription } from "@/lib/document";
import { INVOICE_LINE_TOKENS, INVOICE_TOKENS } from "@/lib/invoiceDocument";
import { LINE_TOKENS, PROPOSAL_TOKENS } from "@/lib/proposal";
import {
  invoicePdfSource,
  quotePdfSource,
  starterPdfTemplate,
  type PdfSource,
  type PdfTemplate,
} from "@/lib/pdfTemplate";
import { SAMPLE_TEMPLATES, specimenInvoice, specimenQuote, starterTemplateBody } from "@/lib/samples";
import { readPdfTemplate } from "@/lib/validate";
import {
  PROPOSAL_FORMATS,
  TEMPLATE_KIND_LABELS,
  TEMPLATE_KINDS,
  type ProposalFormat,
  type ProposalTemplate,
  type TemplateKind,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** The token vocabulary a template of this kind may use. */
const vocabulary = (kind: TemplateKind): { scalar: TokenDescription[]; line: TokenDescription[]; title: string } =>
  kind === "invoice"
    ? { scalar: INVOICE_TOKENS, line: INVOICE_LINE_TOKENS, title: "Invoice and customer" }
    : { scalar: PROPOSAL_TOKENS, line: LINE_TOKENS, title: "Quote and customer" };

type Props = {
  templates: ProposalTemplate[];
  /** Who the specimen preview is "from". */
  sellerName: string;
  sellerEmail: string;
  locale: string;
  myId: string;
  onChanged: () => Promise<void>;
  onShare: (kind: Shareable, id: string, title: string) => void;
  onError: (error: unknown) => void;
  confirmed: (message: string) => boolean;
};

/**
 * Templates: the documents a customer actually reads.
 *
 * Two kinds, one editor. A quote template and an invoice template differ in
 * exactly one thing — the tokens they may reach — so the kind is a field on
 * the template rather than a second screen, and everything else here is
 * shared. What it changes is real, though: the token list, the columns a PDF
 * line table may show, the totals its footer may print, and the specimen the
 * preview is drawn against.
 *
 * The token list beside the editor is the whole contract — a template can
 * reach exactly these values and nothing else, and clicking one inserts it at
 * the end rather than making people transcribe `{{totals.grandTotal}}` by
 * hand. Anything the app does not recognise is called out as you type, because
 * an unresolved token renders as a blank in a document going to a customer.
 */
export function TemplatesView({ templates, sellerName, sellerEmail, locale, myId, onChanged, onShare, onError, confirmed }: Props) {
  const [activeId, setActiveId] = useState<string | null>(templates[0]?.id ?? null);
  /** Which kind the list is showing, and what New makes. */
  const [listKind, setListKind] = useState<TemplateKind>(templates[0]?.kind ?? "quote");
  const [draft, setDraft] = useState<{
    name: string;
    kind: TemplateKind;
    format: ProposalFormat;
    body: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const active = templates.find(template => template.id === activeId) ?? null;
  const editing =
    draft ?? (active ? { name: active.name, kind: active.kind, format: active.format, body: active.body } : null);
  const mine = !active || active.ownerId === myId;

  const isPdf = editing?.format === "pdf";
  const kind = editing?.kind ?? "quote";
  const tokens = vocabulary(kind);

  const unknown = useMemo(
    () => (editing && !isPdf ? unknownTokensIn(editing.body, [tokens.scalar, tokens.line]) : []),
    [editing, isPdf, tokens],
  );

  /**
   * A PDF template's body is JSON, so it is parsed once here and handed to the
   * block editor as a structure. Parsing through `readPdfTemplate` — the same
   * function the server uses — means a body written by hand against the API
   * opens in the editor with exactly the defaults it will be stored with.
   */
  const pdfTemplate = useMemo<PdfTemplate | null>(() => {
    if (!isPdf || !editing) return null;
    const parsed = readPdfTemplate(editing.body, kind);
    return parsed.ok ? parsed.value : starterPdfTemplate(kind);
  }, [isPdf, editing, kind]);

  /**
   * What the preview is drawn against: a specimen of whichever kind is being
   * edited, priced and totalled by the real engines — see src/lib/samples.ts.
   */
  const previewSource = useMemo<PdfSource>(() => {
    const seller = { sellerName: sellerName || sellerEmail, sellerEmail, locale: locale || undefined };
    return kind === "invoice"
      ? invoicePdfSource({ invoice: specimenInvoice(), ...seller })
      : quotePdfSource({ quote: specimenQuote(), ...seller });
  }, [kind, sellerName, sellerEmail, locale]);

  const startNew = (newKind: TemplateKind) => {
    setActiveId(null);
    setDraft({
      name: newKind === "invoice" ? "New invoice" : "New proposal",
      kind: newKind,
      format: "pdf",
      body: JSON.stringify(starterPdfTemplate(newKind)),
    });
  };

  /**
   * Starting from one of the shipped examples.
   *
   * The examples are the documentation for this format: between them they use
   * every block, the letterhead and the whole totals list, and opening one and
   * taking it apart is a faster way to learn what a block does than reading
   * about it. It is a copy in the draft, not a saved record — nothing exists
   * until Save, exactly like New.
   */
  const startFromExample = (name: string) => {
    const example = SAMPLE_TEMPLATES.find(entry => entry.name === name);
    if (!example) return;
    setActiveId(null);
    setDraft({ name: example.name, kind: example.kind, format: example.format, body: example.body });
  };

  const open = (template: ProposalTemplate) => {
    setActiveId(template.id);
    setDraft(null);
  };

  const patch = (changes: Partial<NonNullable<typeof editing>>) =>
    setDraft(current => ({ ...(current ?? editing!), ...changes }));

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      // Saving a template someone shared with you keeps your own copy, the
      // same way the rest of the app treats a shared record.
      const saved =
        active && mine
          ? await api.updateProposalTemplate(active.id, editing)
          : await api.createProposalTemplate(
              active && !mine ? { ...editing, name: `${editing.name} (my copy)` } : editing,
            );
      await onChanged();
      setActiveId(saved.id);
      setDraft(null);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (template: ProposalTemplate) => {
    if (!confirmed(`Delete the template “${template.name}”?`)) return;
    try {
      await api.deleteProposalTemplate(template.id);
      await onChanged();
      setActiveId(null);
      setDraft(null);
    } catch (error) {
      onError(error);
    }
  };

  const insert = (token: string) => editing && patch({ body: `${editing.body}{{${token}}}` });

  const listed = templates.filter(template => template.kind === listKind);

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Section
        title="Templates"
        actions={
          <Button size="sm" onClick={() => startNew(listKind)}>
            <Plus /> New
          </Button>
        }
      >
        {/* The two kinds are listed apart rather than mixed with a badge: you
            are looking for the invoice templates or the quote ones, never
            both, and New then has an obvious meaning. */}
        <div className="flex gap-1 border-b p-2">
          {TEMPLATE_KINDS.map(entry => (
            <button
              key={entry}
              type="button"
              onClick={() => setListKind(entry)}
              aria-pressed={listKind === entry}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs transition-colors",
                listKind === entry ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              {TEMPLATE_KIND_LABELS[entry]}s
              <span className="ml-1 tabular-nums opacity-60">
                {templates.filter(template => template.kind === entry).length}
              </span>
            </button>
          ))}
        </div>

        <div className="border-b p-2">
          <Select value="" onValueChange={startFromExample}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Start from an example…" />
            </SelectTrigger>
            <SelectContent>
              {SAMPLE_TEMPLATES.map(example => (
                <SelectItem key={example.name} value={example.name}>
                  {example.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {listed.length === 0 ? (
          <EmptyState title={`No ${TEMPLATE_KIND_LABELS[listKind].toLowerCase()} templates`}>
            Create one to render {listKind === "invoice" ? "an invoice" : "a quote"} into a document.
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {listed.map(template => (
              <li key={template.id} className="group flex items-center gap-1 px-2 py-1">
                <button
                  type="button"
                  onClick={() => open(template)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                    activeId === template.id && "bg-accent",
                  )}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{template.name}</span>
                  <Badge tone="outline">{template.format}</Badge>
                </button>
                {template.ownerId === myId && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => onShare("proposal-templates", template.id, template.name)}
                      aria-label={`Share ${template.name}`}
                    >
                      <Share2 />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => void remove(template)}
                      aria-label={`Delete ${template.name}`}
                    >
                      <Trash2 className="text-muted-foreground hover:text-destructive" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {editing ? (
        <Section
          title={active ? active.name : "New template"}
          description={mine ? undefined : "Shared with you — saving keeps your own copy."}
          actions={
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
          }
        >
          <div className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_9rem_9rem]">
              <Field label="Name">
                <Input value={editing.name} onChange={event => patch({ name: event.target.value })} />
              </Field>
              <Field label="For" hint="Decides which tokens exist.">
                <Select
                  value={editing.kind}
                  onValueChange={value => {
                    const next = value as TemplateKind;
                    if (next === editing.kind) return;
                    // The vocabularies do not overlap: `{{quote.validUntil}}`
                    // on an invoice resolves to a blank. Carrying the body
                    // across would produce a document full of holes, so the
                    // kind's own starter takes its place.
                    patch({
                      kind: next,
                      body:
                        editing.format === "pdf"
                          ? JSON.stringify(starterPdfTemplate(next))
                          : starterTemplateBody(next),
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_KINDS.map(entry => (
                      <SelectItem key={entry} value={entry}>
                        {TEMPLATE_KIND_LABELS[entry]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Format" hint={isPdf ? "A laid-out document." : "Decides how values are escaped."}>
                <Select
                  value={editing.format}
                  onValueChange={value => {
                    const format = value as ProposalFormat;
                    // The two kinds of body are not interchangeable: JSON in a
                    // Markdown template is gibberish, and prose is not a
                    // document description. Swap in a sensible starter rather
                    // than carrying one across.
                    const changingKind = (format === "pdf") !== isPdf;
                    patch({
                      format,
                      ...(changingKind
                        ? {
                            body:
                              format === "pdf"
                                ? JSON.stringify(starterPdfTemplate(kind))
                                : starterTemplateBody(kind),
                          }
                        : {}),
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROPOSAL_FORMATS.map(format => (
                      <SelectItem key={format} value={format}>
                        {format}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {isPdf && pdfTemplate ? (
              <PdfTemplateEditor
                template={pdfTemplate}
                source={previewSource}
                onChange={next => patch({ body: JSON.stringify(next) })}
              />
            ) : (
              <>
                <Field label="Body">
                  <Textarea
                    value={editing.body}
                    onChange={event => patch({ body: event.target.value })}
                    rows={20}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                </Field>

                <Notice
                  kind="warning"
                  lines={
                    unknown.length
                      ? [`These tokens are not ones this app knows, and will render as blanks: ${unknown.join(", ")}.`]
                      : []
                  }
                />

                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">
                    Click a token to append it. <code>{LINES_OPEN}</code> … <code>{LINES_CLOSE}</code> repeats for each
                    line, and the line tokens only work inside it.
                  </p>

                  <TokenRow title={tokens.title} tokens={tokens.scalar} onInsert={insert} />
                  <TokenRow title="Inside the line block" tokens={tokens.line} onInsert={insert} />

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patch({ body: `${editing.body}\n${LINES_OPEN}\n\n${LINES_CLOSE}\n` })}
                  >
                    Insert a line block
                  </Button>
                </div>
              </>
            )}
          </div>
        </Section>
      ) : (
        <Section title="Nothing open">
          <EmptyState title="Pick a template, or create one">
            A template turns a quote or an invoice into a PDF, HTML, Markdown or plain-text document you
            can send. Start from an example to see what a branded, laid-out document is made of.
          </EmptyState>
        </Section>
      )}
    </div>
  );
}

function TokenRow({
  title,
  tokens,
  onInsert,
}: {
  title: string;
  tokens: TokenDescription[];
  onInsert: (token: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      <div className="flex flex-wrap gap-1">
        {tokens.map(entry => (
          <button
            key={entry.token}
            type="button"
            title={entry.description}
            onClick={() => onInsert(entry.token)}
            className="rounded border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent"
          >
            {entry.token}
          </button>
        ))}
      </div>
    </div>
  );
}
