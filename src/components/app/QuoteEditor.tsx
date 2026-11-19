import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileDown,
  FileText,
  Loader2,
  Plus,
  Receipt,
  Save,
  Send,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccess } from "./access";
import { addDaysTo, today } from "@/lib/clock";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Notice, Section, StatusBadge, formatters } from "./common";
import { Attachments } from "./Attachments";
import { LineConfigurator } from "./LineConfigurator";
import { ProductPicker } from "./ProductPicker";
import { QuoteLines } from "./QuoteLines";
import { TotalsPanel } from "./TotalsPanel";
import { api, type QuoteBody, type SessionUser } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { actionableFor, approvalProgress, evaluateApprovals } from "@/lib/approvals";
import { defaultSelection } from "@/lib/configurator";
import { asCurrency } from "@/lib/money";
import { expandBundle, priceQuote } from "@/lib/pricing";
import { localId } from "@/lib/validate";
import { cn } from "@/lib/utils";
import type { Preferences } from "@/lib/preferences";
import {
  CURRENCIES,
  QUOTE_TRANSITIONS,
  isEditableStatus,
  type Account,
  type ApprovalRule,
  type PriceBook,
  type PricingRule,
  type Product,
  type ProposalTemplate,
  type Quote,
  type QuoteLineInput,
  type QuoteStatus,
} from "@/lib/types";

type Props = {
  /** null while a brand-new quote is being written. */
  quote: Quote | null;
  me: SessionUser;
  preferences: Preferences;
  products: Product[];
  priceBooks: PriceBook[];
  accounts: Account[];
  pricingRules: PricingRule[];
  approvalRules: ApprovalRule[];
  templates: ProposalTemplate[];
  onSaved: (quote: Quote) => void;
  onDeleted: () => void;
  onBack: () => void;
  onShare: (id: string, title: string) => void;
  /** Opens another quote — the revision that superseded this one. */
  onOpenQuote: (id: string) => void;
  /** An invoice was raised from this quote: open it, and say what the server warned. */
  onInvoiced: (invoiceId: string, warnings: string[]) => void;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
  confirmed: (message: string) => boolean;
};

type Draft = {
  name: string;
  accountId: string | null;
  /** Untouched (`undefined`), a save keeps the quote's opportunity; null unlinks it. */
  opportunityId?: string | null;
  priceBookId: string;
  currency: string;
  termMonths: number;
  discountPercent: number;
  taxPercent: number;
  shipping: number;
  validUntil: string;
  notes: string;
  internalNotes: string;
  lines: QuoteLineInput[];
};

/** `days` from today in the organization's calendar — the same date the server would pick. */
const validUntilFrom = (days: number) => addDaysTo(today(), days);

function draftFrom(quote: Quote | null, preferences: Preferences): Draft {
  if (!quote) {
    return {
      name: "",
      accountId: null,
      priceBookId: preferences.defaultPriceBookId,
      currency: preferences.defaultCurrency,
      termMonths: preferences.defaultTermMonths,
      discountPercent: 0,
      taxPercent: preferences.defaultTaxPercent,
      shipping: 0,
      validUntil: validUntilFrom(preferences.quoteValidDays),
      notes: preferences.defaultQuoteNotes,
      internalNotes: "",
      lines: [],
    };
  }

  return {
    name: quote.name,
    accountId: quote.customer.accountId,
    priceBookId: quote.priceBookId,
    currency: quote.currency,
    termMonths: quote.termMonths,
    discountPercent: quote.discountPercent,
    taxPercent: quote.taxPercent,
    shipping: quote.shipping,
    validUntil: quote.validUntil,
    notes: quote.notes,
    internalNotes: quote.internalNotes,
    // The stored lines carry their snapshot; the engine reprices them from
    // the live catalogue anyway, so only the input fields matter here.
    lines: quote.lines.map(line => ({
      id: line.id,
      productId: line.productId,
      quantity: line.quantity,
      discountPercent: line.discountPercent,
      unitPriceOverride: line.unitPriceOverride,
      selectedOptions: line.selectedOptions,
      termMonths: line.termMonths,
      description: line.description,
      parentId: line.parentId,
      sortOrder: line.sortOrder,
    })),
  };
}

/**
 * Writing a quote.
 *
 * Everything on screen is priced **locally**, by the same engine the server
 * runs (`src/lib/pricing.ts`), so a discount typed into a box moves the total,
 * the margin and the approval list on the same keystroke rather than after a
 * round trip. The server prices it again on save and its answer replaces this
 * one — the local copy is for the rep's eyes, the stored copy is the truth.
 *
 * A quote stops being editable the moment it leaves the rep's hands. That is
 * enforced by the server; here it just means the inputs go away, so nobody
 * types into a form that is going to refuse them.
 */
export function QuoteEditor(props: Props) {
  const { quote, me, preferences, products, priceBooks, accounts, pricingRules, approvalRules } = props;

  // Only a quote template renders a quote: an invoice one would resolve every
  // token to a blank, and the server refuses it for that reason.
  const templates = props.templates.filter(template => template.kind === "quote");

  const [draft, setDraft] = useState<Draft>(() => draftFrom(quote, preferences));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [picking, setPicking] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [document, setDocument] = useState<{ text: string; name: string } | null>(null);
  /** A PDF preview is the PDF itself, shown in the browser's own viewer. */
  const [pdfPreview, setPdfPreview] = useState<{ url: string; name: string } | null>(null);

  // A different quote arriving (saved, revised, opened) resets the form.
  useEffect(() => {
    setDraft(draftFrom(quote, preferences));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id, quote?.updatedAt]);

  // What the role allows (an admin any quote, a sales member their own), and
  // then what the quote's status allows. PocketBase enforces the first half
  // whatever this shows; hiding the buttons just saves a refused click.
  const access = useAccess();
  const canEdit = quote ? access.canEditQuote(quote) : access.can("quotes.create");
  const editable = canEdit && (!quote || isEditableStatus(quote.status));
  const canRevise = canEdit && Boolean(quote) && quote?.status !== "superseded" && quote?.status !== "accepted";
  const currency = asCurrency(draft.currency);
  const format = formatters(currency, preferences.locale);

  // An accepted quote is a contract, and billing it is finance's (or an
  // admin's) to do. The server re-checks both: the status in invoiceQuote,
  // the role in the invoices create rule.
  const canInvoice = Boolean(quote) && quote?.status === "accepted" && access.can("invoices.write") && access.isOurs(quote!);

  const invoiceIt = async () => {
    if (!quote) return;
    setBusy("invoice");
    try {
      const raised = await api.invoiceQuote(quote.id);
      props.onInvoiced(raised.invoice.id, [`Draft invoice raised from ${quote.number}.`, ...raised.warnings]);
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy("");
    }
  };

  const byId = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const bySku = useMemo(() => new Map(products.map(product => [product.sku, product])), [products]);

  /** The live price, recomputed whenever anything it depends on changes. */
  const priced = useMemo(() => {
    const book =
      priceBooks.find(entry => entry.id === draft.priceBookId) ??
      priceBooks.find(entry => entry.isDefault && entry.active && entry.currency === currency) ??
      null;

    return priceQuote(
      draft.lines,
      {
        currency,
        termMonths: draft.termMonths,
        discountPercent: draft.discountPercent,
        taxPercent: draft.taxPercent,
        shipping: draft.shipping,
      },
      { products: byId, priceBook: book, rules: pricingRules },
    );
  }, [draft, currency, priceBooks, byId, pricingRules]);

  /** And what submitting it would ask for. */
  const approvalsRequired = useMemo(() => {
    const floorByLineId = new Map(
      priced.lines.map(line => [line.id, byId.get(line.productId)?.floorDiscountPercent ?? 0]),
    );
    return evaluateApprovals(
      { totals: priced.totals, lines: priced.lines, termMonths: draft.termMonths, floorByLineId },
      approvalRules,
    ).required;
  }, [priced, byId, approvalRules, draft.termMonths]);

  const patch = (changes: Partial<Draft>) => {
    setDraft(current => ({ ...current, ...changes }));
    setDirty(true);
  };

  /* ------------------------------- the lines ----------------------------- */

  const addProduct = (product: Product) => {
    setPicking(false);

    const line: QuoteLineInput = {
      id: localId("ln"),
      productId: product.id,
      quantity: Math.max(1, product.minQuantity),
      discountPercent: 0,
      unitPriceOverride: null,
      selectedOptions: defaultSelection(product),
      termMonths: 0,
      description: "",
      parentId: null,
      sortOrder: draft.lines.length,
    };

    // A bundle brings its components in as their own lines, exactly as the
    // server would — the quote stores what it prices.
    const children = expandBundle(line, product, bySku, () => localId("ln"));

    patch({ lines: [...draft.lines, line, ...children] });
    // Straight into the configurator when there is something to configure.
    if (product.optionGroups.length) setConfiguring(line.id);
  };

  const changeLine = (id: string, changes: Partial<QuoteLineInput>) =>
    patch({ lines: draft.lines.map(line => (line.id === id ? { ...line, ...changes } : line)) });

  const removeLine = (id: string) =>
    // A bundle's components go with it; they have no meaning on their own.
    patch({ lines: draft.lines.filter(line => line.id !== id && line.parentId !== id) });

  /* -------------------------------- actions ------------------------------ */

  const bodyOf = (source: Draft): QuoteBody => ({
    name: source.name.trim() || "Untitled quote",
    accountId: source.accountId,
    ...(source.opportunityId !== undefined ? { opportunityId: source.opportunityId } : {}),
    priceBookId: source.priceBookId,
    currency: source.currency,
    termMonths: source.termMonths,
    discountPercent: source.discountPercent,
    taxPercent: source.taxPercent,
    shipping: source.shipping,
    validUntil: source.validUntil,
    notes: source.notes,
    internalNotes: source.internalNotes,
    lines: source.lines,
  });

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      try {
        await action();
      } catch (error) {
        props.onError(error);
      } finally {
        setBusy("");
      }
    },
    [props],
  );

  const save = () =>
    run("Saving", async () => {
      const result = quote
        ? await api.updateQuote(quote.id, bodyOf(draft))
        : await api.createQuote(bodyOf(draft));
      setDirty(false);
      props.onSaved(result.quote);
      if (result.warnings.length) props.onNotice(result.warnings);
    });

  const submit = () =>
    run("Submitting", async () => {
      // Submitting prices what is *stored*, so an unsaved change would be
      // approved in a form nobody has seen. Save first, always.
      const saved = quote ? await api.updateQuote(quote.id, bodyOf(draft)) : await api.createQuote(bodyOf(draft));
      setDirty(false);

      const result = await api.submitQuote(saved.quote.id);
      props.onSaved(result.quote);

      const lines: string[] = [];
      if (result.quote.status === "approved") {
        lines.push("Nothing on this quote needed approval — it is ready to send.");
      } else {
        lines.push(
          `Submitted. Waiting on ${[...new Set(result.required.flatMap(request => request.approverEmails))].join(", ")}.`,
        );
      }
      if (result.unresolved.length) {
        lines.push(
          `No account here matches ${result.unresolved.join(", ")} — those approvals cannot be answered until they register.`,
        );
      }
      props.onNotice(lines);
    });

  const moveTo = (status: QuoteStatus) =>
    quote &&
    run(status === "sent" ? "Sending" : "Updating", async () => {
      props.onSaved(await api.setQuoteStatus(quote.id, status));
    });

  const revise = () =>
    quote &&
    run("Revising", async () => {
      const result = await api.reviseQuote(quote.id);
      props.onSaved(result.quote);
      props.onNotice([`Revision ${result.quote.version} created as ${result.quote.number}. The original is untouched.`]);
    });

  const remove = () =>
    quote &&
    props.confirmed(`Delete ${quote.number}? This cannot be undone.`) &&
    run("Deleting", async () => {
      await api.deleteQuote(quote.id);
      props.onDeleted();
    });

  const preview = (template: ProposalTemplate) =>
    quote &&
    run("Rendering", async () => {
      // A PDF is handed to the browser's viewer rather than pulled apart into
      // text — the point of a preview is to see the document that will be sent.
      if (template.format === "pdf") {
        setPdfPreview({ url: api.documentInlineUrl(quote.id, template.id), name: template.name });
        return;
      }

      const rendered = await api.renderDocument(quote.id, template.id);
      setDocument({ text: rendered.text, name: rendered.templateName });
      if (rendered.unknownTokens.length) {
        props.onNotice([`“${rendered.templateName}” uses tokens this app does not know: ${rendered.unknownTokens.join(", ")}.`]);
      }
    });

  /* -------------------------------- render ------------------------------- */

  // The template the header's PDF button uses: the account's preferred one
  // when it is a PDF, otherwise the first PDF template there is.
  const pdfTemplate =
    templates.find(entry => entry.id === preferences.defaultProposalTemplateId && entry.format === "pdf") ??
    templates.find(entry => entry.format === "pdf");

  const configuringLine = configuring ? draft.lines.find(line => line.id === configuring) : undefined;
  const configuringProduct = configuringLine ? byId.get(configuringLine.productId) : undefined;
  const transitions = quote && canEdit ? (QUOTE_TRANSITIONS[quote.status] ?? []) : [];
  const blocked = priced.issues.length > 0;

  return (
    <div className="space-y-4">
      {/* ------------------------------ header ----------------------------- */}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Button variant="ghost" size="icon-sm" onClick={props.onBack} aria-label="Back to quotes">
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold">{draft.name || "New quote"}</h1>
              {quote && <StatusBadge status={quote.status} />}
              {quote && quote.version > 1 && <Badge tone="outline">rev {quote.version}</Badge>}
              {dirty && <Badge tone="pending">unsaved</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {quote ? `${quote.number} · ` : ""}
              {priced.totals.lineCount} line{priced.totals.lineCount === 1 ? "" : "s"} ·{" "}
              {format.money(priced.totals.grandTotal)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <Button variant="outline" onClick={save} disabled={Boolean(busy)}>
              {busy === "Saving" ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
          )}

          {editable && (
            <Button onClick={submit} disabled={Boolean(busy) || blocked || !draft.lines.length}>
              {busy === "Submitting" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {approvalsRequired.length ? "Submit for approval" : "Submit"}
            </Button>
          )}

          {transitions.includes("sent") && (
            <Button onClick={() => moveTo("sent")} disabled={Boolean(busy)}>
              {busy === "Sending" ? <Loader2 className="animate-spin" /> : <Send />} Mark as sent
            </Button>
          )}
          {transitions.includes("accepted") && (
            <Button onClick={() => moveTo("accepted")} disabled={Boolean(busy)}>
              <Check /> Accepted
            </Button>
          )}
          {transitions.includes("declined") && (
            <Button variant="outline" onClick={() => moveTo("declined")} disabled={Boolean(busy)}>
              <X /> Declined
            </Button>
          )}
          {transitions.includes("draft") && (
            <Button variant="outline" onClick={() => moveTo("draft")} disabled={Boolean(busy)}>
              Reopen as draft
            </Button>
          )}

          {canInvoice && (
            <Button onClick={() => void invoiceIt()} disabled={Boolean(busy)} title="Raise a draft invoice for this quote">
              {busy === "invoice" ? <Loader2 className="animate-spin" /> : <Receipt />} Create invoice
            </Button>
          )}

          {quote && pdfTemplate && (
            <Button variant="outline" asChild title={`Download as PDF — ${pdfTemplate.name}`}>
              <a href={api.documentUrl(quote.id, pdfTemplate.id)}>
                <FileDown /> PDF
              </a>
            </Button>
          )}

          {quote && (
            <>
              {canRevise && (
                <Button variant="outline" onClick={revise} disabled={Boolean(busy)} title="Create the next revision">
                  New revision
                </Button>
              )}
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => props.onShare(quote.id, quote.number)}
                  aria-label="Share this quote"
                  title="Share"
                >
                  <Share2 />
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" asChild title="Download as CSV">
                <a href={api.quoteExportUrl(quote.id, "csv")} aria-label="Download this quote as CSV">
                  <Download />
                </a>
              </Button>
            </>
          )}
        </div>
      </div>

      {quote?.status === "superseded" && quote.supersededById && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            This version has been superseded by a newer revision. It can no longer be sent, accepted or invoiced.
          </span>
          <Button variant="outline" size="sm" onClick={() => props.onOpenQuote(quote.supersededById!)}>
            Open the latest revision
          </Button>
        </div>
      )}

      <Notice kind="error" lines={priced.issues} />
      <Notice kind="warning" lines={priced.warnings} />

      {quote && quote.approvals.length > 0 && (
        <ApprovalHistory
          quote={quote}
          me={me}
          canEdit={canEdit}
          locale={preferences.locale}
          onDecided={props.onSaved}
          onError={props.onError}
          confirmed={props.confirmed}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {/* ---------------------------- details --------------------------- */}

          <Section title="Details">
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Quote name" className="sm:col-span-2 lg:col-span-1">
                <Input
                  value={draft.name}
                  onChange={event => patch({ name: event.target.value })}
                  placeholder="Acme — platform expansion"
                  disabled={!editable}
                />
              </Field>

              <Field
                label="Customer"
                hint={
                  quote?.opportunityId && draft.opportunityId !== null ? (
                    <OpportunityLink
                      id={quote.opportunityId}
                      onUnlink={editable ? () => patch({ opportunityId: null }) : undefined}
                    />
                  ) : undefined
                }
              >
                <Select
                  value={draft.accountId ?? "none"}
                  onValueChange={value => patch({ accountId: value === "none" ? null : value })}
                  disabled={!editable}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No customer yet</SelectItem>
                    {accounts.map(account => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Price book">
                <Select
                  value={draft.priceBookId || "default"}
                  onValueChange={value => patch({ priceBookId: value === "default" ? "" : value })}
                  disabled={!editable}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default for this currency</SelectItem>
                    {priceBooks.map(book => (
                      <SelectItem key={book.id} value={book.id}>
                        {book.name} ({book.currency}){book.isDefault ? " · default" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Currency">
                <Select value={draft.currency} onValueChange={value => patch({ currency: value })} disabled={!editable}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(code => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Term (months)" hint="Recurring lines are priced across this.">
                <Input
                  type="number"
                  min={0}
                  value={draft.termMonths}
                  onChange={event => patch({ termMonths: Number(event.target.value) })}
                  disabled={!editable}
                />
              </Field>

              <Field label="Valid until">
                <Input
                  type="date"
                  value={draft.validUntil}
                  onChange={event => patch({ validUntil: event.target.value })}
                  disabled={!editable}
                />
              </Field>

              <Field label="Quote discount %">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step="0.5"
                  value={draft.discountPercent}
                  onChange={event => patch({ discountPercent: Number(event.target.value) })}
                  disabled={!editable}
                />
              </Field>

              <Field label="Tax %">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step="0.25"
                  value={draft.taxPercent}
                  onChange={event => patch({ taxPercent: Number(event.target.value) })}
                  disabled={!editable}
                />
              </Field>

              <Field label="Shipping">
                <Input
                  type="number"
                  min={0}
                  value={draft.shipping}
                  onChange={event => patch({ shipping: Number(event.target.value) })}
                  disabled={!editable}
                />
              </Field>
            </div>
          </Section>

          {/* ----------------------------- lines ---------------------------- */}

          <Section
            title="Lines"
            description={
              editable
                ? undefined
                : !canEdit
                  ? "Read only — this quote is another rep's, and your role cannot change it."
                  : quote?.status === "superseded"
                    ? "Superseded — edit the latest revision instead."
                    : "This quote is no longer editable — create a revision to change it."
            }
            actions={
              editable && (
                <Button size="sm" onClick={() => setPicking(true)}>
                  <Plus /> Add product
                </Button>
              )
            }
          >
            <QuoteLines
              priced={priced.lines}
              format={format}
              editable={editable}
              showMargin={preferences.showMargin}
              onChange={changeLine}
              onConfigure={setConfiguring}
              onRemove={removeLine}
            />
          </Section>

          {/* ----------------------------- notes ---------------------------- */}

          <Section title="Notes">
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <Field label="On the proposal" hint="The customer reads this.">
                <Textarea
                  value={draft.notes}
                  onChange={event => patch({ notes: event.target.value })}
                  disabled={!editable}
                  rows={4}
                />
              </Field>
              <Field label="Internal" hint="Never rendered into a document.">
                <Textarea
                  value={draft.internalNotes}
                  onChange={event => patch({ internalNotes: event.target.value })}
                  disabled={!editable}
                  rows={4}
                />
              </Field>
            </div>
          </Section>

          {/* -------------------------- attachments ------------------------- */}

          {/* Whatever the status: a signed order form belongs on an accepted quote. */}
          {quote && (
            <Attachments
              target="quotes"
              recordId={quote.id}
              canUpload={canEdit}
              description="Order forms, statements of work, the customer's PO. Approvers and anyone it is shared with see them too."
              locale={preferences.locale}
              onError={props.onError}
              confirmed={props.confirmed}
            />
          )}

          {/* --------------------------- proposal --------------------------- */}

          {quote && (
            <Section title="Proposal" description="Render this quote through a template.">
              <div className="flex flex-wrap items-center gap-2 p-4">
                {templates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No proposal templates yet — create one under <strong>Templates</strong>.
                  </p>
                ) : (
                  templates.map(template => (
                    <div key={template.id} className="flex items-center gap-1 rounded-md border px-2 py-1">
                      <FileText className="size-3.5 text-muted-foreground" />
                      <span className="text-xs">{template.name}</span>
                      <Badge tone="outline">{template.format}</Badge>
                      <Button variant="ghost" size="sm" onClick={() => preview(template)} disabled={Boolean(busy)}>
                        Preview
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <a href={api.documentUrl(quote.id, template.id)}>Download</a>
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </Section>
          )}

          {quote && editable && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={remove} className="text-muted-foreground hover:text-destructive">
                Delete this quote
              </Button>
            </div>
          )}
        </div>

        {/* ----------------------------- totals ----------------------------- */}

        <div className="lg:sticky lg:top-4 lg:self-start">
          <TotalsPanel
            totals={priced.totals}
            format={format}
            showMargin={preferences.showMargin}
            approvalsRequired={approvalsRequired}
            termMonths={draft.termMonths}
          />
        </div>
      </div>

      {/* ----------------------------- dialogs ------------------------------ */}

      {picking && (
        <ProductPicker
          products={products}
          currency={currency}
          locale={preferences.locale}
          onPick={addProduct}
          onClose={() => setPicking(false)}
        />
      )}

      {configuringLine && configuringProduct && (
        <LineConfigurator
          product={configuringProduct}
          line={configuringLine}
          currency={currency}
          locale={preferences.locale}
          quoteTermMonths={draft.termMonths}
          onSave={line => {
            changeLine(line.id, line);
            setConfiguring(null);
          }}
          onClose={() => setConfiguring(null)}
        />
      )}

      {pdfPreview && (
        <Dialog
          title={pdfPreview.name}
          description="Rendered from the stored quote, by the same code that produces the download."
          onClose={() => setPdfPreview(null)}
          className="max-w-5xl"
          footer={
            <Button variant="outline" asChild>
              <a href={pdfPreview.url.replace("&inline", "")}>
                <FileDown /> Download
              </a>
            </Button>
          }
        >
          <iframe src={pdfPreview.url} title={pdfPreview.name} className="h-[70vh] w-full rounded-md border bg-muted" />
        </Dialog>
      )}

      {document && (
        <Dialog
          title={document.name}
          description="Rendered from the stored quote."
          onClose={() => setDocument(null)}
          className="max-w-4xl"
          footer={
            <Button variant="outline" onClick={() => void copyText(document.text)}>
              <Copy /> Copy
            </Button>
          }
        >
          <pre className="max-h-[65vh] overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {document.text}
          </pre>
        </Dialog>
      )}
    </div>
  );
}

/* ---------------------------- approval history ---------------------------- */

/**
 * The approvals on a quote, and — if the person looking is the one being asked
 * — the two buttons that answer them.
 *
 * Every request addressed to you at the level in play is answered at once. An
 * approver is deciding about the quote, and asking them the same question four
 * times because it tripped four rules is how approvals stop being read.
 */
function ApprovalHistory({
  quote,
  me,
  canEdit,
  locale,
  onDecided,
  onError,
  confirmed,
}: {
  quote: Quote;
  me: SessionUser;
  /** Whether this person may edit the quote — and so attach its case for approval. */
  canEdit: boolean;
  locale: string;
  onDecided: (quote: Quote) => void;
  onError: (error: unknown) => void;
  confirmed: (message: string) => boolean;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const pending = quote.approvals.filter(request => request.status === "pending");
  const lowest = pending.length ? Math.min(...pending.map(request => request.level)) : 0;

  // What this person can actually answer right now. Approvals are collectable
  // at the level in play; a rejection lands wherever it is addressed.
  const canApprove = actionableFor(quote.approvals, me.email, "approved");
  const canReject = actionableFor(quote.approvals, me.email, "rejected");
  const isApprover = quote.approvals.some(request => request.approverEmails.includes(me.email.toLowerCase()));

  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      const result = await api.decideQuote(quote.id, decision, comment);
      setComment("");
      onDecided(result.quote);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Approvals" description={lowest ? `Level ${lowest} is the one in play.` : undefined}>
      <ul className="divide-y">
        {quote.approvals.map(request => {
          const progress = approvalProgress(request);
          const quorum = request.approverEmails.length > 1;

          return (
            <li key={request.id} className="space-y-1.5 px-4 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={request.status === "approved" ? "success" : request.status === "rejected" ? "danger" : "pending"}
                >
                  {request.status}
                </Badge>
                <span className="font-medium">{request.ruleName}</span>
                <span className="text-xs text-muted-foreground">level {request.level}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{request.reason}</span>
                {quorum && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {progress.approved} of {progress.needed} approved
                    {progress.rejected > 0 ? ` · ${progress.rejected} of ${progress.toReject} rejected` : ""}
                  </span>
                )}
              </div>

              {/* Everyone asked, and what each has said so far. */}
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {request.approverEmails.map(email => {
                  const answer = request.decisions.find(decision => decision.approverEmail === email);
                  return (
                    <li
                      key={email}
                      className={cn(
                        "flex items-center gap-1",
                        answer?.decision === "approved" && "text-emerald-700 dark:text-emerald-400",
                        answer?.decision === "rejected" && "text-destructive",
                        !answer && "text-muted-foreground",
                      )}
                      title={answer?.comment || undefined}
                    >
                      {answer?.decision === "approved" ? (
                        <Check className="size-3" />
                      ) : answer?.decision === "rejected" ? (
                        <X className="size-3" />
                      ) : (
                        <span className="inline-block size-1.5 rounded-full bg-current opacity-40" />
                      )}
                      {email === me.email.toLowerCase() ? "you" : email}
                    </li>
                  );
                })}
              </ul>

              {request.decisions
                .filter(decision => decision.comment)
                .map(decision => (
                  <p key={decision.approverEmail} className="text-xs text-muted-foreground">
                    {decision.approverEmail}: “{decision.comment}”
                  </p>
                ))}
            </li>
          );
        })}
      </ul>

      {/* The case for the discount, and the approvers' own evidence — anyone
          asked may add to it, from whichever organization they are in. */}
      <Attachments
        bare
        target="approvals"
        recordId={quote.id}
        title="Supporting files"
        canUpload={canEdit || isApprover}
        locale={locale}
        onError={onError}
        confirmed={confirmed}
      />

      {(canApprove.length > 0 || canReject.length > 0) && (
        <div className="space-y-2 border-t bg-muted/30 p-4">
          <p className="text-sm font-medium">
            {canApprove.length > 0
              ? `This quote is waiting on you — ${canApprove.length} request${canApprove.length === 1 ? "" : "s"} at level ${lowest}.`
              : "You are an approver at a later level. You can object now; approving waits its turn."}
          </p>
          <Textarea
            value={comment}
            onChange={event => setComment(event.target.value)}
            placeholder="A note for the person who asked (optional)"
            rows={2}
          />
          <div className="flex gap-2">
            <Button onClick={() => void decide("approved")} disabled={busy || canApprove.length === 0}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Approve
            </Button>
            <Button variant="outline" onClick={() => void decide("rejected")} disabled={busy}>
              <X /> Reject
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * The deal a quote is written for, under its customer. Unlinking takes effect
 * on the next save, like any other change to the draft; the customer cannot be
 * moved off the deal's while it is linked (the server refuses it).
 */
function OpportunityLink({ id, onUnlink }: { id: string; onUnlink?: () => void }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getOpportunity(id).then(
      opportunity => live && setName(opportunity.name),
      () => live && setName(""),
    );
    return () => {
      live = false;
    };
  }, [id]);

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      For opportunity <span className="font-medium text-foreground">{name === null ? "…" : name || "(not visible to you)"}</span>
      {onUnlink && (
        <button type="button" className="underline underline-offset-2" onClick={onUnlink}>
          Unlink
        </button>
      )}
    </span>
  );
}
