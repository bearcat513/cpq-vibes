import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Building2,
  CircleDollarSign,
  CircleUser,
  Globe,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { AccountStatusBadge, EmptyState, InvoiceStatusBadge, Notice, Section, StatusBadge, formatters } from "./common";
import { api } from "@/lib/api";
import { customerStats, EMPTY_STATS, type CustomerStats } from "@/lib/customers";
import { agingReport, creditPosition, daysOverdue, invoiceStatus, today } from "@/lib/receivable";
import type { Preferences } from "@/lib/preferences";
import {
  CONTACT_ROLE_LABELS,
  primaryContact,
  type Account,
  type AccountContact,
  type Address,
  type InvoiceSummary,
  type PriceBook,
  type QuoteSummary,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  account: Account;
  priceBooks: PriceBook[];
  preferences: Preferences;
  onBack: () => void;
  onEdit: () => void;
  onOpenQuote: (id: string) => void;
  /** Takes the reader to the receivables screen, where an invoice can be acted on. */
  onOpenReceivables: () => void;
  onError: (error: unknown) => void;
};

/**
 * One customer, and how it has gone with them.
 *
 * The editor answers "what is true of this customer". This screen answers the
 * other half — who do we know there, what have we quoted, and did any of it
 * land — which until now was only visible by squinting at the quote list and
 * remembering the company name.
 *
 * The quote history comes from the server rather than from the list already
 * in memory: that list is capped at a page and sorted across every customer,
 * so a long-standing account would have shown whichever of its quotes
 * happened to be recent, and the totals underneath would have been wrong in a
 * way nobody could see.
 */
export function CustomerDetail({
  account,
  priceBooks,
  preferences,
  onBack,
  onEdit,
  onOpenQuote,
  onOpenReceivables,
  onError,
}: Props) {
  const [quotes, setQuotes] = useState<QuoteSummary[] | null>(null);
  const [stats, setStats] = useState<CustomerStats>(() => EMPTY_STATS(account.currency));
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);

  const format = formatters(account.currency, preferences.locale);
  const book = priceBooks.find(candidate => candidate.id === account.priceBookId);

  useEffect(() => {
    let live = true;
    setInvoices(null);

    // A failure here is not worth a banner: the aging panel says it could not
    // be read, and the rest of the page is still worth looking at.
    void api
      .accountInvoices(account.id)
      .then(found => live && setInvoices(found))
      .catch(() => live && setInvoices([]));

    return () => {
      live = false;
    };
  }, [account.id]);

  const aging = useMemo(
    () => agingReport(invoices ?? [], account.currency, today()),
    [invoices, account.currency],
  );
  const credit = useMemo(
    () => creditPosition(account.creditLimit, aging.outstanding, account.currency),
    [account.creditLimit, account.currency, aging.outstanding],
  );

  useEffect(() => {
    let live = true;
    setQuotes(null);

    void api
      .accountQuotes(account.id)
      .then(history => {
        if (!live) return;
        setQuotes(history);
        setStats(customerStats(history, account.currency));
      })
      .catch(error => {
        if (!live) return;
        // The rest of the screen is still worth reading without the history.
        setQuotes([]);
        onError(error);
      });

    return () => {
      live = false;
    };
  }, [account.id, account.currency, onError]);

  const loading = quotes === null;

  return (
    <div className="space-y-4">
      <Section
        title={account.name}
        description={[account.industry, account.website].filter(Boolean).join(" · ") || "Customer"}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft /> All customers
            </Button>
            <Button size="sm" onClick={onEdit}>
              <Pencil /> Edit
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
          <AccountStatusBadge status={account.status} />
          <Badge tone="outline">{account.currency}</Badge>
          {account.taxExempt ? (
            <Badge tone="info">tax exempt</Badge>
          ) : account.taxPercent > 0 ? (
            <Badge tone="outline">{account.taxPercent}% tax</Badge>
          ) : null}
          {account.defaultDiscountPercent > 0 && (
            <Badge tone="outline">{account.defaultDiscountPercent}% standing discount</Badge>
          )}
          {account.tags.map(tag => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
        </div>

        {/* The four numbers a rep opens a customer to see. */}
        <div className="grid grid-cols-2 gap-px border-b bg-border/60 md:grid-cols-4">
          <Stat label="Open" value={loading ? "—" : format.money(stats.openValue)} hint={`${stats.openCount} in play`} />
          <Stat label="Won" value={loading ? "—" : format.money(stats.wonValue)} hint={`${stats.wonCount} accepted`} />
          <Stat
            label="Win rate"
            value={loading ? "—" : format.percent(stats.winRate)}
            hint={stats.wonCount + stats.lostCount ? `of ${stats.wonCount + stats.lostCount} decided` : "nothing decided"}
          />
          <Stat
            label="Last quoted"
            value={loading ? "—" : stats.lastQuotedAt ? format.date(stats.lastQuotedAt) : "Never"}
            hint={`${stats.quoteCount} quote${stats.quoteCount === 1 ? "" : "s"}`}
          />
        </div>

        <Notice
          kind="info"
          className="m-3"
          lines={
            stats.otherCurrencyCount
              ? [
                  `${stats.otherCurrencyCount} quote${stats.otherCurrencyCount === 1 ? " is" : "s are"} in another ` +
                    `currency and ${stats.otherCurrencyCount === 1 ? "is" : "are"} counted but not added to these totals.`,
                ]
              : []
          }
        />

        <dl className="grid gap-x-6 gap-y-3 px-4 py-3 text-sm md:grid-cols-2 xl:grid-cols-3">
          <Fact label="Payment terms" value={account.paymentTerms} />
          <Fact label="Price book" value={book ? `${book.name} (${book.currency})` : "The default book"} />
          <Fact label="Website" value={account.website} Icon={Globe} />
          <AddressFact label="Billing address" address={account.billingAddress} Icon={MapPin} />
          <AddressFact
            label="Shipping address"
            address={account.shippingAddress}
            Icon={Truck}
            note={account.shippingSameAsBilling ? "Same as billing" : ""}
          />
          {account.notes && (
            <div className="md:col-span-2 xl:col-span-3">
              <dt className="text-xs text-muted-foreground">Notes</dt>
              <dd className="mt-0.5 whitespace-pre-wrap">{account.notes}</dd>
            </div>
          )}
        </dl>
      </Section>

      <Section
        title="Receivables"
        description={
          invoices === null
            ? "Reading…"
            : aging.invoiceCount + aging.draftCount === 0
              ? "Nothing invoiced"
              : `${format.money(aging.outstanding)} outstanding`
        }
        actions={
          invoices && invoices.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={onOpenReceivables}>
              <CircleDollarSign /> Open receivables
            </Button>
          ) : undefined
        }
      >
        {invoices === null ? (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading their ledger…
          </p>
        ) : invoices.length === 0 ? (
          <EmptyState title="Nothing invoiced yet">
            Raise an invoice from an accepted quote, and what they owe shows up here.
          </EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px border-b bg-border/60 md:grid-cols-4">
              <Stat
                label="Outstanding"
                value={format.money(aging.outstanding)}
                hint={`${aging.invoiceCount} unpaid`}
              />
              <Stat
                label="Overdue"
                value={format.money(aging.overdue)}
                hint={aging.maxDaysOverdue ? `oldest ${aging.maxDaysOverdue} days` : "nothing late"}
                tone={aging.overdue > 0 ? "warn" : undefined}
              />
              <Stat label="Collected" value={format.money(aging.paidAmount)} hint="settled invoices" />
              <Stat
                label={credit.hasLimit ? "Credit available" : "Credit limit"}
                value={credit.hasLimit ? format.money(credit.available) : "Not set"}
                hint={credit.hasLimit ? `${credit.usedPercent}% of ${format.money(credit.limit)} used` : "no limit"}
                tone={credit.overLimit ? "warn" : undefined}
              />
            </div>

            <Notice
              kind="warning"
              className="m-3"
              lines={
                credit.overLimit
                  ? [
                      `${account.name} owes ${format.money(credit.outstanding)} against a ` +
                        `${format.money(credit.limit)} limit — ${format.money(-credit.available)} over. ` +
                        `Nothing here blocks a quote; it is a conversation to have before the next invoice.`,
                    ]
                  : []
              }
            />

            <Table>
              <Thead>
                <Tr>
                  <Th>Invoice</Th>
                  <Th>Status</Th>
                  <Th>Due</Th>
                  <Th numeric>Total</Th>
                  <Th numeric>Balance</Th>
                </Tr>
              </Thead>
              <Tbody>
                {invoices.map(one => {
                  const row = formatters(one.currency, preferences.locale);
                  const late = daysOverdue(one, today());
                  return (
                    <Tr key={one.id}>
                      <Td>
                        <span className="block font-mono text-xs font-medium">{one.number}</span>
                        {one.quoteNumber && (
                          <span className="text-xs text-muted-foreground">from {one.quoteNumber}</span>
                        )}
                      </Td>
                      <Td>
                        <InvoiceStatusBadge status={invoiceStatus(one, today())} />
                      </Td>
                      <Td className="text-muted-foreground">
                        {one.dueDate ? (
                          <>
                            {row.date(one.dueDate)}
                            {late > 0 && <span className="text-alert"> · {late}d</span>}
                          </>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td numeric className="text-muted-foreground">
                        {row.money(one.totals.total)}
                      </Td>
                      <Td numeric className="font-medium">
                        {row.money(one.totals.balance)}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </>
        )}
      </Section>

      <Section
        title="Contacts"
        description={`${account.contacts.length} ${account.contacts.length === 1 ? "person" : "people"}`}
      >
        {account.contacts.length === 0 ? (
          <EmptyState title="Nobody named yet">
            A proposal has to be addressed to someone. Add a contact on the customer and every new quote picks them up.
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {account.contacts.map(contact => (
              <ContactRow key={contact.id} contact={contact} primary={contact.id === primaryContact(account)?.id} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Quote history"
        description={loading ? "Reading…" : `${stats.quoteCount} quote${stats.quoteCount === 1 ? "" : "s"}`}
      >
        {loading ? (
          <p className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading their quotes…
          </p>
        ) : quotes.length === 0 ? (
          <EmptyState title="No quotes yet">
            Nothing has been quoted to {account.name}. Start one and it will show up here with everything that follows
            it.
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Quote</Th>
                <Th>Status</Th>
                <Th numeric>Lines</Th>
                <Th numeric>Discount</Th>
                <Th numeric>Total</Th>
                <Th>Updated</Th>
              </Tr>
            </Thead>
            <Tbody>
              {quotes.map(quote => {
                const row = formatters(quote.currency, preferences.locale);
                return (
                  <Tr
                    key={quote.id}
                    onClick={() => onOpenQuote(quote.id)}
                    className="cursor-pointer"
                    tabIndex={0}
                    onKeyDown={event => event.key === "Enter" && onOpenQuote(quote.id)}
                  >
                    <Td>
                      <span className="block font-medium">{quote.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {quote.number}
                        {quote.version > 1 ? ` · rev ${quote.version}` : ""}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={quote.status} />
                        {quote.pendingApprovals > 0 && <Badge tone="pending">{quote.pendingApprovals} pending</Badge>}
                      </div>
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {quote.lineCount}
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {row.percent(quote.totals?.effectiveDiscountPercent ?? 0)}
                    </Td>
                    <Td numeric className="font-medium">
                      {row.money(quote.totals?.grandTotal ?? 0)}
                    </Td>
                    <Td className="text-muted-foreground">{row.date(quote.updatedAt)}</Td>
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

/** One number, set in the display face the rest of the app reserves for figures. */
function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "warn" }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-display text-lg font-semibold tabular-nums",
          tone === "warn" && "text-alert",
        )}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Fact({ label, value, Icon }: { label: string; value: string; Icon?: typeof Globe }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex items-start gap-1.5">
        {Icon && value && <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0 break-words", !value && "text-muted-foreground")}>{value || "—"}</span>
      </dd>
    </div>
  );
}

function AddressFact({
  label,
  address,
  Icon,
  note,
}: {
  label: string;
  address: Address;
  Icon: typeof MapPin;
  note?: string;
}) {
  const lines = [
    address.line1,
    address.line2,
    [address.city, address.state, address.postalCode].filter(Boolean).join(" "),
    address.country,
  ].filter(line => line.trim() !== "");

  return (
    <div>
      <dt className="text-xs text-muted-foreground">
        {label}
        {note && lines.length > 0 && <span className="ml-1.5 opacity-70">· {note}</span>}
      </dt>
      <dd className="mt-0.5 flex items-start gap-1.5">
        {lines.length > 0 && <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
        {lines.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="min-w-0">
            {lines.map(line => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </span>
        )}
      </dd>
    </div>
  );
}

function ContactRow({ contact, primary }: { contact: AccountContact; primary: boolean }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
      <div className="flex min-w-[12rem] flex-1 items-start gap-2">
        <CircleUser className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{contact.name}</span>
            {primary && <Badge tone="success">primary</Badge>}
            <Badge tone="outline">{CONTACT_ROLE_LABELS[contact.role]}</Badge>
          </div>
          {contact.title && <p className="text-xs text-muted-foreground">{contact.title}</p>}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="flex items-center gap-1.5 hover:text-foreground">
            <Mail className="size-3.5 shrink-0" />
            <span className="break-all">{contact.email}</span>
          </a>
        )}
        {contact.phone && (
          <span className="flex items-center gap-1.5">
            <Phone className="size-3.5 shrink-0" />
            {contact.phone}
          </span>
        )}
        {!contact.email && !contact.phone && (
          <span className="flex items-center gap-1.5">
            <Building2 className="size-3.5 shrink-0" /> No way to reach them yet
          </span>
        )}
      </div>
    </li>
  );
}
