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
import { LINE_TOKENS, LINES_CLOSE, LINES_OPEN, PROPOSAL_TOKENS, unknownTokensIn } from "@/lib/proposal";
import { starterPdfTemplate, type PdfTemplate } from "@/lib/pdfTemplate";
import { STARTER_TEMPLATE_BODY, specimenQuote } from "@/lib/samples";
import { readPdfTemplate } from "@/lib/validate";
import { PROPOSAL_FORMATS, type ProposalFormat, type ProposalTemplate } from "@/lib/types";
import { cn } from "@/lib/utils";

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
 * Proposal templates: the document a customer actually reads.
 *
 * The token list beside the editor is the whole contract — a template can
 * reach exactly these values and nothing else, and clicking one inserts it at
 * the end rather than making people transcribe `{{totals.grandTotal}}` by
 * hand. Anything the app does not recognise is called out as you type, because
 * an unresolved token renders as a blank in a document going to a customer.
 */
export function TemplatesView({ templates, sellerName, sellerEmail, locale, myId, onChanged, onShare, onError, confirmed }: Props) {
  const [activeId, setActiveId] = useState<string | null>(templates[0]?.id ?? null);
  const [draft, setDraft] = useState<{ name: string; format: ProposalFormat; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const active = templates.find(template => template.id === activeId) ?? null;
  const editing = draft ?? (active ? { name: active.name, format: active.format, body: active.body } : null);
  const mine = !active || active.ownerId === myId;

  const isPdf = editing?.format === "pdf";

  const unknown = useMemo(() => (editing && !isPdf ? unknownTokensIn(editing.body) : []), [editing, isPdf]);

  /**
   * A PDF template's body is JSON, so it is parsed once here and handed to the
   * block editor as a structure. Parsing through `readPdfTemplate` — the same
   * function the server uses — means a body written by hand against the API
   * opens in the editor with exactly the defaults it will be stored with.
   */
  const pdfTemplate = useMemo<PdfTemplate | null>(() => {
    if (!isPdf || !editing) return null;
    const parsed = readPdfTemplate(editing.body);
    return parsed.ok ? parsed.value : starterPdfTemplate();
  }, [isPdf, editing]);

  /** Templates are designed against a real quote where possible, a specimen otherwise. */
  const previewContext = useMemo(
    () => ({ quote: specimenQuote(), sellerName: sellerName || sellerEmail, sellerEmail, locale: locale || undefined }),
    [sellerName, sellerEmail, locale],
  );

  const startNew = () => {
    setActiveId(null);
    setDraft({ name: "New proposal", format: "pdf", body: JSON.stringify(starterPdfTemplate()) });
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

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Section
        title="Templates"
        actions={
          <Button size="sm" onClick={startNew}>
            <Plus /> New
          </Button>
        }
      >
        {templates.length === 0 ? (
          <EmptyState title="No templates">Create one to render a quote into a document.</EmptyState>
        ) : (
          <ul className="divide-y">
            {templates.map(template => (
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
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <Field label="Name">
                <Input value={editing.name} onChange={event => patch({ name: event.target.value })} />
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
                        ? { body: format === "pdf" ? JSON.stringify(starterPdfTemplate()) : STARTER_TEMPLATE_BODY }
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
                context={previewContext}
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

                  <TokenRow title="Quote and customer" tokens={PROPOSAL_TOKENS} onInsert={insert} />
                  <TokenRow title="Inside the line block" tokens={LINE_TOKENS} onInsert={insert} />

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
            A template turns a quote into an HTML, Markdown or plain-text document you can send.
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
  tokens: { token: string; description: string }[];
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
