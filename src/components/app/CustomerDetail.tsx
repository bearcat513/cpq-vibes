import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Building2,
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
import { AccountStatusBadge, EmptyState, Notice, Section, StatusBadge, formatters } from "./common";
import { api } from "@/lib/api";
import { customerStats, EMPTY_STATS, type CustomerStats } from "@/lib/customers";
import type { Preferences } from "@/lib/preferences";
import {
  CONTACT_ROLE_LABELS,
  primaryContact,
  type Account,
  type AccountContact,
  type Address,
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
export function CustomerDetail({ account, priceBooks, preferences, onBack, onEdit, onOpenQuote, onError }: Props) {
  const [quotes, setQuotes] = useState<QuoteSummary[] | null>(null);
  const [stats, setStats] = useState<CustomerStats>(() => EMPTY_STATS(account.currency));

  const format = formatters(account.currency, preferences.locale);
  const book = priceBooks.find(candidate => candidate.id === account.priceBookId);

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

/** One number, set in the serif the rest of the app reserves for printed matter. */
function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="leaf px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-serif text-lg font-semibold tabular-nums">{value}</p>
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
