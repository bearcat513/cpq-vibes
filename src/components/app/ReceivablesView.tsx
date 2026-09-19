import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { EmptyState, InvoiceStatusBadge, Notice, Section, formatters } from "./common";
import { InvoiceEditor } from "./InvoiceEditor";
import { api } from "@/lib/api";
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  agingBucketFor,
  agingReport,
  daysOverdue,
  invoiceStatus,
  today,
  type AgingBucket,
} from "@/lib/receivable";
import type { Preferences } from "@/lib/preferences";
import {
  INVOICE_STATUS_LABELS,
  type Account,
  type CurrencyCode,
  type InvoiceStatus,
  type InvoiceSummary,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  accounts: Account[];
  preferences: Preferences;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
  confirmed: (message: string) => boolean;
};

/**
 * Receivables: what is owed, how old it is, and who owes it.
 *
 * The aging across the top is computed here rather than fetched, from the
 * same `agingReport` the server uses for `/api/receivables/aging` and for the
 * CSV. That is the whole reason it is pure: the number on screen and the
 * number in the export cannot drift, because they are the same function
 * applied to the same records.
 *
 * Only one currency is ever added up — an account is denominated in one, but
 * nothing stops an invoice being raised in another, and a book that quietly
 * summed them would be a confident wrong number. The selector is how you look
 * at the other one, and the count of what was left out is on the page.
 */
export function ReceivablesView({ accounts, preferences, onError, onNotice, confirmed }: Props) {
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<AgingBucket | "">("");
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const [currency, setCurrency] = useState<CurrencyCode>(preferences.defaultCurrency);

  const asOf = today();

  const load = async () => {
    try {
      setInvoices(await api.listInvoices());
    } catch (error) {
      setInvoices([]);
      onError(error);
    }
  };

  useEffect(() => {
    void load();
    // Loaded once on mount; every mutation below refreshes it explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Currencies actually in use, so the selector offers only real choices. */
  const currencies = useMemo(() => {
    const seen = new Set<CurrencyCode>(invoices?.map(invoice => invoice.currency) ?? []);
    seen.add(preferences.defaultCurrency);
    return [...seen].sort();
  }, [invoices, preferences.defaultCurrency]);

  const report = useMemo(() => agingReport(invoices ?? [], currency, asOf), [invoices, currency, asOf]);

  const visible = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return (invoices ?? []).filter(invoice => {
      const condition = invoiceStatus(invoice, asOf);
      if (status && condition !== status) return false;
      if (bucket) {
        // A bucket is a property of an outstanding invoice; everything
        // settled, drafted or voided is simply not in one.
        if (condition === "draft" || condition === "paid" || condition === "void") return false;
        if (agingBucketFor(daysOverdue(invoice, asOf)) !== bucket) return false;
      }
      if (!terms.length) return true;

      const haystack = [invoice.number, invoice.customer.name, invoice.quoteNumber, invoice.poNumber]
        .join(" ")
        .toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }, [invoices, search, status, bucket, asOf]);

  const afterChange = async (lines: string[]) => {
    await load();
    if (lines.length) onNotice(lines);
  };

  /*
   * The id alone decides what is on screen — the editor reads its own record
   * rather than being handed one out of this list. That is what lets a newly
   * created invoice stay open: it exists before the list has been reloaded.
   */
  if (openId) {
    return (
      <InvoiceEditor
        invoiceId={openId}
        accounts={accounts}
        preferences={preferences}
        onBack={() => setOpenId(null)}
        onChanged={afterChange}
        onError={onError}
        confirmed={confirmed}
      />
    );
  }

  if (creating) {
    return (
      <InvoiceEditor
        invoiceId={null}
        accounts={accounts}
        preferences={preferences}
        onBack={() => setCreating(false)}
        onChanged={afterChange}
        onCreated={raised => {
          setCreating(false);
          setOpenId(raised.id);
        }}
        onError={onError}
        confirmed={confirmed}
      />
    );
  }

  const format = formatters(currency, preferences.locale);
  const loading = invoices === null;

  return (
    <div className="space-y-4">
      <Section
        title="Receivables"
        description={`Aged ${format.date(report.asOf)}`}
        actions={
          <>
            {currencies.length > 1 && (
              <Select value={currency} onValueChange={value => setCurrency(value as CurrencyCode)}>
                <SelectTrigger className="h-8 w-24" aria-label="Currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map(code => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" size="sm" asChild>
              <a href={api.receivablesCsvUrl} download>
                <Download /> Aged CSV
              </a>
            </Button>
            {/* Cash received, across invoices — the sheet a bank
                reconciliation is done against. */}
            <Button variant="outline" size="sm" asChild>
              <a href={api.paymentsCsvUrl} download>
                <Download /> Receipts CSV
              </a>
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New invoice
            </Button>
          </>
        }
      >
        {/* The aging, and the two numbers underneath it that matter most. */}
        <div className="grid grid-cols-2 gap-px border-b bg-border/60 md:grid-cols-5">
          {AGING_BUCKETS.map(candidate => {
            const cell = report.buckets[candidate];
            const on = bucket === candidate;
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => setBucket(on ? "" : candidate)}
                aria-pressed={on}
                className={cn(
                  "leaf px-4 py-3 text-left transition-colors",
                  on ? "bg-accent" : "hover:bg-accent/50",
                  // Anything past 60 days is the part of the book that needs
                  // a phone call, so it is coloured like a warning.
                  candidate === "61-90" || candidate === "90+" ? "text-clay dark:text-chart-2" : "",
                )}
              >
                <p className="text-xs text-muted-foreground">{AGING_BUCKET_LABELS[candidate]}</p>
                <p className="font-serif text-lg font-semibold tabular-nums">
                  {loading ? "—" : format.money(cell.amount)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {cell.count} invoice{cell.count === 1 ? "" : "s"}
                </p>
              </button>
            );
          })}
        </div>

        <dl className="flex flex-wrap gap-x-8 gap-y-2 border-b px-4 py-2.5 text-sm">
          <Figure label="Outstanding" value={loading ? "—" : format.money(report.outstanding)} strong />
          <Figure
            label="Overdue"
            value={loading ? "—" : format.money(report.overdue)}
            tone={report.overdue > 0 ? "warn" : undefined}
          />
          <Figure label="Collected" value={loading ? "—" : format.money(report.paidAmount)} />
          {report.draftCount > 0 && (
            <Figure label="Drafts not issued" value={`${report.draftCount} · ${format.money(report.draftAmount)}`} />
          )}
          {report.maxDaysOverdue > 0 && <Figure label="Oldest" value={`${report.maxDaysOverdue} days past due`} />}
        </dl>

        <Notice
          kind="info"
          className="m-3"
          lines={
            report.otherCurrencyCount
              ? [
                  `${report.otherCurrencyCount} invoice${report.otherCurrencyCount === 1 ? " is" : "s are"} in ` +
                    `another currency and ${report.otherCurrencyCount === 1 ? "is" : "are"} not in these totals. ` +
                    `Switch the currency above to see ${report.otherCurrencyCount === 1 ? "it" : "them"}.`,
                ]
              : []
          }
        />
      </Section>

      <Section
        title="Invoices"
        description={
          loading
            ? "Reading…"
            : visible.length === (invoices?.length ?? 0)
              ? `${visible.length} invoice${visible.length === 1 ? "" : "s"}`
              : `${visible.length} of ${invoices?.length ?? 0}`
        }
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search"
                aria-label="Search invoices"
                className="h-8 w-44 pl-8"
              />
            </div>
            <Select value={status || "all"} onValueChange={value => setStatus(value === "all" ? "" : (value as InvoiceStatus))}>
              <SelectTrigger className="h-8 w-36" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                {(Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatus[]).map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    {INVOICE_STATUS_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bucket && (
              <Button variant="ghost" size="sm" onClick={() => setBucket("")}>
                Clear {AGING_BUCKET_LABELS[bucket]}
              </Button>
            )}
          </>
        }
      >
        {loading ? (
          <p className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading the ledger…
          </p>
        ) : visible.length === 0 ? (
          <EmptyState title={invoices?.length ? "Nothing matches" : "No invoices yet"}>
            {invoices?.length
              ? "Try a different search, or clear the status and aging filters."
              : "Raise one from an accepted quote, or start a blank one. Nothing is owed until it is issued."}
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Due</Th>
                <Th numeric>Total</Th>
                <Th numeric>Balance</Th>
              </Tr>
            </Thead>
            <Tbody>
              {visible.map(invoice => {
                const row = formatters(invoice.currency, preferences.locale);
                const late = daysOverdue(invoice, asOf);
                const condition = invoiceStatus(invoice, asOf);

                return (
                  <Tr
                    key={invoice.id}
                    onClick={() => setOpenId(invoice.id)}
                    className="cursor-pointer"
                    tabIndex={0}
                    onKeyDown={event => event.key === "Enter" && setOpenId(invoice.id)}
                  >
                    <Td>
                      <span className="block font-mono text-xs font-medium">{invoice.number}</span>
                      {invoice.quoteNumber && (
                        <span className="text-xs text-muted-foreground">from {invoice.quoteNumber}</span>
                      )}
                    </Td>
                    <Td>{invoice.customer.name || <span className="text-muted-foreground">—</span>}</Td>
                    <Td>
                      <InvoiceStatusBadge status={condition} />
                    </Td>
                    <Td className="text-muted-foreground">
                      {invoice.dueDate ? (
                        <>
                          {row.date(invoice.dueDate)}
                          {late > 0 && <span className="text-clay dark:text-chart-2"> · {late}d</span>}
                        </>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {row.money(invoice.totals.total)}
                    </Td>
                    <Td
                      numeric
                      className={cn(
                        "font-medium",
                        condition === "paid" && "text-muted-foreground",
                        condition === "overdue" && "text-clay dark:text-chart-2",
                      )}
                    >
                      {row.money(invoice.totals.balance)}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function Figure({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "warn";
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          strong && "font-serif text-base font-semibold",
          tone === "warn" && "text-clay dark:text-chart-2",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
