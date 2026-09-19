import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Ban,
  Check,
  CircleDollarSign,
  Download,
  Loader2,
  Lock,
  Plus,
  Scissors,
  Send,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Field, InvoiceStatusBadge, Notice, Section, formatters } from "./common";
import { api } from "@/lib/api";
import { daysOverdue, dueDateFor, invoiceStatus, invoiceTotals, pricedLines, today } from "@/lib/receivable";
import type { Preferences } from "@/lib/preferences";
import {
  CREDIT_REASONS,
  CREDIT_REASON_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type Account,
  type CreditReason,
  type Invoice,
  type InvoiceLine,
  type PaymentMethod,
} from "@/lib/types";
import { localId, type CreditInput, type PaymentInput } from "@/lib/validate";
import { cn } from "@/lib/utils";

type Props = {
  /** null raises a new one; an id opens the one that exists. */
  invoiceId: string | null;
  accounts: Account[];
  preferences: Preferences;
  onBack: () => void;
  onChanged: (notices: string[]) => Promise<void>;
  /**
   * Called once, with the invoice a *create* produced. The caller needs it to
   * stay on the new invoice rather than bouncing back to the list — the next
   * thing anybody does after writing an invoice is issue it.
   */
  onCreated?: (invoice: Invoice) => void;
  onError: (error: unknown) => void;
  confirmed: (message: string) => boolean;
};

/**
 * One invoice.
 *
 * A page rather than a panel, for the same reason the quote editor is one:
 * it holds a line table, a ledger and a totals block, and none of those fit
 * in a 500px column. The small forms inside it — recording a payment,
 * raising a credit — are panels, which is where that rule still applies.
 *
 * What is editable depends entirely on the state, and the screen says so
 * rather than letting somebody find out from a 409. A draft is a document
 * being written; an issued invoice is a document somebody has, and the only
 * way to change what it is worth is to credit it.
 */
export function InvoiceEditor({
  invoiceId,
  accounts,
  preferences,
  onBack,
  onChanged,
  onCreated,
  onError,
  confirmed,
}: Props) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(invoiceId !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ledgerForm, setLedgerForm] = useState<"payment" | "credit" | null>(null);

  /* The draft being edited. Only meaningful while the invoice is a draft. */
  const [accountId, setAccountId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [lines, setLines] = useState<InvoiceLine[]>([]);

  const adopt = (next: Invoice) => {
    setInvoice(next);
    setAccountId(next.customer.accountId ?? "");
    setPoNumber(next.poNumber);
    setNotes(next.notes);
    setInternalNotes(next.internalNotes);
    setLines(next.lines);
  };

  useEffect(() => {
    if (!invoiceId) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    void api
      .getInvoice(invoiceId)
      .then(found => live && adopt(found))
      .catch(failure => live && onError(failure))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [invoiceId, onError]);

  const currency = invoice?.currency ?? accounts.find(one => one.id === accountId)?.currency ?? preferences.defaultCurrency;
  const format = formatters(currency, preferences.locale);
  const draft = !invoice || invoice.state === "draft";
  const issued = invoice?.state === "issued";

  /**
   * The totals as they stand in the browser, from the same function the
   * server stores. A line typed here shows its effect before it is saved,
   * and cannot disagree with what comes back.
   */
  const live = useMemo(
    () => invoiceTotals(lines, invoice?.payments ?? [], invoice?.credits ?? [], currency),
    [lines, invoice, currency],
  );

  const accountOptions: ComboboxOption[] = useMemo(
    () =>
      [...accounts]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(account => ({
          value: account.id,
          label: account.name,
          hint: account.paymentTerms || `${account.paymentTermDays} days`,
          badge: account.currency,
        })),
    [accounts],
  );

  /* ------------------------------ actions ------------------------------- */

  const run = async (what: () => Promise<{ invoice: Invoice; warnings: string[] } | Invoice>, notice?: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await what();
      const next = "invoice" in result ? result.invoice : result;
      const said = "warnings" in result ? result.warnings : [];
      adopt(next);
      setWarnings(said);
      await onChanged(notice ? [notice, ...said] : said);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const body = () => ({ accountId: accountId || null, poNumber, notes, internalNotes, lines });

  const save = () =>
    run(async () => {
      if (invoice) return api.updateInvoice(invoice.id, body());
      const raised = await api.createInvoice(body());
      onCreated?.(raised.invoice);
      return raised;
    }, "Invoice saved.");

  const issue = () => {
    if (!invoice) return;
    const due = dueDateFor(today(), invoice.paymentTermDays);
    if (!confirmed(`Issue ${invoice.number}? It becomes a receivable due ${due}, and its lines are then fixed.`)) return;
    void run(() => api.issueInvoice(invoice.id), `${invoice.number} issued.`);
  };

  const voidIt = () => {
    if (!invoice) return;
    if (!confirmed(`Void ${invoice.number}? It stays on the ledger as a void invoice — the number is not reused.`)) {
      return;
    }
    void run(() => api.voidInvoice(invoice.id), `${invoice.number} voided.`);
  };

  const discard = async () => {
    if (!invoice) return;
    if (!confirmed(`Delete this draft? Nothing has been issued, so there is nothing to keep.`)) return;
    try {
      await api.deleteInvoice(invoice.id);
      await onChanged(["Draft deleted."]);
      onBack();
    } catch (failure) {
      onError(failure);
    }
  };

  /* ------------------------------- lines -------------------------------- */

  const patchLine = (id: string, changes: Partial<InvoiceLine>) =>
    setLines(current => current.map(line => (line.id === id ? { ...line, ...changes } : line)));

  const addLine = () =>
    setLines(current => [
      ...current,
      {
        id: localId("inl"),
        sourceLineId: null,
        sku: "",
        description: "",
        quantity: 1,
        unitPrice: 0,
        amount: 0,
        // A new line inherits the rate already on the invoice, which is right
        // far more often than zero is.
        taxPercent: current[current.length - 1]?.taxPercent ?? 0,
        taxAmount: 0,
      },
    ]);

  if (loading) {
    return (
      <Section title="Invoice" description="Reading…">
        <p className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Opening it…
        </p>
      </Section>
    );
  }

  const status = invoice ? invoiceStatus(invoice, today()) : "draft";
  const late = invoice ? daysOverdue(invoice, today()) : 0;
  const shown = draft ? pricedLines(lines, currency) : invoice!.lines;

  return (
    <div className="space-y-4">
      <Section
        title={invoice ? invoice.number : "New invoice"}
        description={
          invoice
            ? [invoice.customer.name, invoice.quoteNumber ? `from ${invoice.quoteNumber}` : ""]
                .filter(Boolean)
                .join(" · ")
            : "A draft. Nothing is owed until it is issued."
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft /> Receivables
            </Button>

            {invoice && (
              <Button variant="outline" size="sm" asChild>
                <a href={api.invoiceExportUrl(invoice.id, "csv")} download>
                  <Download /> CSV
                </a>
              </Button>
            )}

            {draft && (
              <Button size="sm" onClick={() => void save()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
              </Button>
            )}
            {draft && invoice && (
              <>
                <Button variant="outline" size="sm" onClick={issue} disabled={busy}>
                  <Send /> Issue
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => void discard()} aria-label="Delete this draft">
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </>
            )}
            {issued && (
              <>
                <Button size="sm" onClick={() => setLedgerForm("payment")} disabled={busy}>
                  <CircleDollarSign /> Record payment
                </Button>
                <Button variant="outline" size="sm" onClick={() => setLedgerForm("credit")} disabled={busy}>
                  <Scissors /> Credit
                </Button>
                <Button variant="ghost" size="sm" onClick={voidIt} disabled={busy}>
                  <Ban /> Void
                </Button>
              </>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
          <InvoiceStatusBadge status={status} />
          <Badge tone="outline">{currency}</Badge>
          {invoice?.issueDate && <Badge tone="outline">issued {format.date(invoice.issueDate)}</Badge>}
          {invoice?.dueDate && (
            <Badge tone={late > 0 ? "danger" : "outline"}>
              due {format.date(invoice.dueDate)}
              {late > 0 ? ` · ${late} days ago` : ""}
            </Badge>
          )}
          {invoice && <Badge tone="outline">{invoice.paymentTermDays}-day terms</Badge>}
          {!draft && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Lock className="size-3" /> The customer has this document — change it with a credit
            </span>
          )}
        </div>

        <Notice kind="error" lines={error ? [error] : []} className="m-3" />
        <Notice kind="warning" lines={warnings} className="m-3" />

        {/* ------------------------------ header --------------------------- */}

        <div className="grid gap-3 border-b px-4 py-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Customer">
            {draft ? (
              <Combobox
                value={accountId}
                onChange={setAccountId}
                options={accountOptions}
                placeholder="Choose a customer"
                aria-label="Customer"
              />
            ) : (
              <p className="flex h-9 items-center text-sm">{invoice!.customer.name || "—"}</p>
            )}
          </Field>
          <Field label="Their PO number" hint={draft ? "Many will not pay an invoice without one." : undefined}>
            {draft ? (
              <Input value={poNumber} onChange={event => setPoNumber(event.target.value)} />
            ) : (
              <p className="flex h-9 items-center text-sm">{invoice!.poNumber || "—"}</p>
            )}
          </Field>
          <Field label="Billed to">
            <p className="text-sm">
              {invoice?.customer.contactName || "—"}
              {invoice?.customer.contactEmail && (
                <span className="block text-xs text-muted-foreground">{invoice.customer.contactEmail}</span>
              )}
            </p>
          </Field>
          <Field label="Balance">
            <p
              className={cn(
                "font-serif text-lg font-semibold tabular-nums",
                status === "overdue" && "text-clay dark:text-chart-2",
                status === "paid" && "text-primary",
              )}
            >
              {format.money(draft ? live.total : invoice!.totals.balance)}
            </p>
          </Field>
        </div>

        {/* ------------------------------- lines --------------------------- */}

        {shown.length === 0 ? (
          <EmptyState title="Nothing on it yet">
            An invoice needs at least one line before it can be issued.
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Description</Th>
                <Th>SKU</Th>
                <Th numeric>Qty</Th>
                <Th numeric>Unit price</Th>
                <Th numeric>Tax %</Th>
                <Th numeric>Amount</Th>
                {draft && <Th className="w-10" aria-label="Actions" />}
              </Tr>
            </Thead>
            <Tbody>
              {shown.map(line => (
                <Tr key={line.id}>
                  <Td>
                    {draft ? (
                      <Input
                        value={line.description}
                        onChange={event => patchLine(line.id, { description: event.target.value })}
                        placeholder="What it is for"
                        aria-label="Description"
                        className="h-8"
                      />
                    ) : (
                      line.description
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {draft ? (
                      <Input
                        value={line.sku}
                        onChange={event => patchLine(line.id, { sku: event.target.value })}
                        aria-label="SKU"
                        className="h-8 w-24"
                      />
                    ) : (
                      line.sku || "—"
                    )}
                  </Td>
                  <Td numeric>
                    {draft ? (
                      <Input
                        type="number"
                        min={0}
                        value={line.quantity}
                        onChange={event => patchLine(line.id, { quantity: Number(event.target.value) })}
                        aria-label="Quantity"
                        className="h-8 w-20 text-right"
                      />
                    ) : (
                      line.quantity
                    )}
                  </Td>
                  <Td numeric>
                    {draft ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={line.unitPrice}
                        onChange={event => patchLine(line.id, { unitPrice: Number(event.target.value) })}
                        aria-label="Unit price"
                        className="h-8 w-28 text-right"
                      />
                    ) : (
                      format.money(line.unitPrice)
                    )}
                  </Td>
                  <Td numeric>
                    {draft ? (
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step="0.25"
                        value={line.taxPercent}
                        onChange={event => patchLine(line.id, { taxPercent: Number(event.target.value) })}
                        aria-label="Tax percent"
                        className="h-8 w-20 text-right"
                      />
                    ) : (
                      `${line.taxPercent}%`
                    )}
                  </Td>
                  <Td numeric className="font-medium">
                    {format.money(line.amount)}
                  </Td>
                  {draft && (
                    <Td>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setLines(current => current.filter(other => other.id !== line.id))}
                        aria-label={`Remove ${line.description || "this line"}`}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </Td>
                  )}
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}

        {draft && (
          <div className="border-t px-4 py-2">
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus /> Add a line
            </Button>
          </div>
        )}

        {/* ------------------------------ totals --------------------------- */}

        <dl className="flex flex-wrap justify-end gap-x-8 gap-y-2 border-t px-4 py-3 text-sm">
          <Total label="Subtotal" value={format.money(draft ? live.subtotal : invoice!.totals.subtotal)} />
          <Total label="Tax" value={format.money(draft ? live.taxAmount : invoice!.totals.taxAmount)} />
          <Total label="Total" value={format.money(draft ? live.total : invoice!.totals.total)} strong />
          {!draft && invoice!.totals.paidAmount > 0 && (
            <Total label="Paid" value={format.money(invoice!.totals.paidAmount)} />
          )}
          {!draft && invoice!.totals.creditedAmount > 0 && (
            <Total label="Credited" value={format.money(invoice!.totals.creditedAmount)} />
          )}
          {!draft && <Total label="Balance" value={format.money(invoice!.totals.balance)} strong />}
        </dl>

        <div className="grid gap-3 border-t px-4 py-3 md:grid-cols-2">
          <Field label="Notes" hint="Printed on the invoice.">
            {draft ? (
              <Textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{invoice!.notes || "—"}</p>
            )}
          </Field>
          <Field label="Internal notes" hint="Never shown to the customer.">
            {draft ? (
              <Textarea value={internalNotes} onChange={event => setInternalNotes(event.target.value)} rows={2} />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{invoice!.internalNotes || "—"}</p>
            )}
          </Field>
        </div>
      </Section>

      {/* ------------------------------- ledger ---------------------------- */}

      {invoice && invoice.state !== "draft" && (
        <Section
          title="Ledger"
          description={
            invoice.payments.length + invoice.credits.length === 0
              ? "Nothing against it yet"
              : `${invoice.payments.length} payment${invoice.payments.length === 1 ? "" : "s"}, ` +
                `${invoice.credits.length} credit${invoice.credits.length === 1 ? "" : "s"}`
          }
        >
          {invoice.payments.length + invoice.credits.length === 0 ? (
            <EmptyState title="Nothing received">
              Record a payment when the money lands, or credit the invoice if it will not be paid in full.
            </EmptyState>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Date</Th>
                  <Th>What</Th>
                  <Th>Reference</Th>
                  <Th numeric>Amount</Th>
                  <Th className="w-10" aria-label="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {invoice.payments.map(payment => (
                  <Tr key={payment.id}>
                    <Td className="text-muted-foreground">{format.date(payment.receivedOn)}</Td>
                    <Td>
                      <Badge tone="success">{PAYMENT_METHOD_LABELS[payment.method]}</Badge>
                      {payment.note && <p className="text-xs text-muted-foreground">{payment.note}</p>}
                    </Td>
                    <Td className="font-mono text-xs text-muted-foreground">{payment.reference || "—"}</Td>
                    <Td numeric className="font-medium">
                      {format.money(payment.amount)}
                    </Td>
                    <Td>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove the payment of ${format.money(payment.amount)}`}
                        onClick={() => {
                          if (!confirmed("Remove this payment? Use this only for one entered in error.")) return;
                          void run(() => api.removePayment(invoice.id, payment.id), "Payment removed.");
                        }}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </Td>
                  </Tr>
                ))}
                {invoice.credits.map(credit => (
                  <Tr key={credit.id}>
                    <Td className="text-muted-foreground">{format.date(credit.issuedOn)}</Td>
                    <Td>
                      <Badge tone={credit.reason === "write_off" ? "danger" : "pending"}>
                        {CREDIT_REASON_LABELS[credit.reason]}
                      </Badge>
                      {credit.note && <p className="text-xs text-muted-foreground">{credit.note}</p>}
                    </Td>
                    <Td className="text-muted-foreground">—</Td>
                    <Td numeric className="font-medium">
                      −{format.money(credit.amount)}
                    </Td>
                    <Td>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove the credit of ${format.money(credit.amount)}`}
                        onClick={() => {
                          if (!confirmed("Remove this credit? Use this only for one entered in error.")) return;
                          void run(() => api.removeCredit(invoice.id, credit.id), "Credit removed.");
                        }}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Section>
      )}

      {ledgerForm === "payment" && invoice && (
        <PaymentPanel
          outstanding={invoice.totals.balance}
          currency={currency}
          locale={preferences.locale}
          onClose={() => setLedgerForm(null)}
          onSave={async input => {
            await run(() => api.recordPayment(invoice.id, input), "Payment recorded.");
            setLedgerForm(null);
          }}
        />
      )}

      {ledgerForm === "credit" && invoice && (
        <CreditPanel
          outstanding={invoice.totals.balance}
          currency={currency}
          locale={preferences.locale}
          onClose={() => setLedgerForm(null)}
          onSave={async input => {
            await run(() => api.recordCredit(invoice.id, input), "Credit recorded.");
            setLedgerForm(null);
          }}
        />
      )}
    </div>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="text-right">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", strong && "font-serif text-base font-semibold")}>{value}</dd>
    </div>
  );
}

/* -------------------------------- the panels ------------------------------ */

function PaymentPanel({
  outstanding,
  currency,
  locale,
  onClose,
  onSave,
}: {
  outstanding: number;
  currency: Invoice["currency"];
  locale: string;
  onClose: () => void;
  onSave: (input: PaymentInput) => Promise<void>;
}) {
  const format = formatters(currency, locale);
  // Defaulting to the balance is right almost every time, and the times it
  // is wrong the person is already typing a different number.
  const [amount, setAmount] = useState(String(outstanding > 0 ? outstanding : 0));
  const [receivedOn, setReceivedOn] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const value = Number(amount);
  const over = value > outstanding;

  return (
    <Sheet
      title="Record a payment"
      description={`${format.money(outstanding)} outstanding`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !(value > 0)}
            onClick={() => {
              setBusy(true);
              void onSave({ amount: value, receivedOn, method, reference, note }).finally(() => setBusy(false));
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Record
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Amount">
            <Input type="number" step="0.01" min={0} value={amount} onChange={event => setAmount(event.target.value)} autoFocus />
          </Field>
          <Field label="Received on" hint="The day the money arrived, not today.">
            <Input type="date" value={receivedOn} onChange={event => setReceivedOn(event.target.value)} />
          </Field>
          <Field label="Method">
            <Select value={method} onValueChange={next => setMethod(next as PaymentMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    {PAYMENT_METHOD_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Reference" hint="What ties it to the bank statement.">
            <Input value={reference} onChange={event => setReference(event.target.value)} />
          </Field>
        </div>

        <Field label="Note">
          <Textarea value={note} onChange={event => setNote(event.target.value)} rows={2} />
        </Field>

        <Notice
          kind="warning"
          lines={
            over
              ? [
                  `That is ${format.money(value - outstanding)} more than is outstanding. It will be recorded, ` +
                    `and the invoice will show as overpaid.`,
                ]
              : []
          }
        />
      </div>
    </Sheet>
  );
}

function CreditPanel({
  outstanding,
  currency,
  locale,
  onClose,
  onSave,
}: {
  outstanding: number;
  currency: Invoice["currency"];
  locale: string;
  onClose: () => void;
  onSave: (input: CreditInput) => Promise<void>;
}) {
  const format = formatters(currency, locale);
  const [amount, setAmount] = useState("");
  const [issuedOn, setIssuedOn] = useState(today());
  const [reason, setReason] = useState<CreditReason>("adjustment");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const value = Number(amount);
  const tooBig = value > outstanding;

  return (
    <Sheet
      title="Credit this invoice"
      description={`${format.money(outstanding)} outstanding`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !(value > 0) || tooBig}
            onClick={() => {
              setBusy(true);
              void onSave({ amount: value, issuedOn, reason, note }).finally(() => setBusy(false));
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Credit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Amount">
            <Input type="number" step="0.01" min={0} value={amount} onChange={event => setAmount(event.target.value)} autoFocus />
          </Field>
          <Field label="Issued on">
            <Input type="date" value={issuedOn} onChange={event => setIssuedOn(event.target.value)} />
          </Field>
        </div>

        <Field
          label="Reason"
          hint="A write-off is the admission that the money is not coming — it is reported separately."
        >
          <Select value={reason} onValueChange={next => setReason(next as CreditReason)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CREDIT_REASONS.map(candidate => (
                <SelectItem key={candidate} value={candidate}>
                  {CREDIT_REASON_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Note">
          <Textarea value={note} onChange={event => setNote(event.target.value)} rows={2} />
        </Field>

        <Notice
          kind="error"
          lines={
            tooBig
              ? [`A credit cannot be more than the ${format.money(outstanding)} still owed on this invoice.`]
              : []
          }
        />
      </div>
    </Sheet>
  );
}
