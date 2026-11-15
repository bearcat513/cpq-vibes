import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { EmptyState, Section, StatusBadge, formatters, statusLabel } from "./common";
import { useAccess } from "./access";
import { api } from "@/lib/api";
import { QUOTE_STATUSES, type QuoteStatus, type QuoteSummary } from "@/lib/types";
import type { Preferences } from "@/lib/preferences";
import { cn } from "@/lib/utils";

type Props = {
  preferences: Preferences;
  /** Bumped whenever something may have changed, so the page is read again. */
  version: number;
  onOpen: (id: string) => void;
  onNew: () => void;
  onError: (error: unknown) => void;
  /** Arrive filtered to one status — the dashboard's tiles link here. */
  initialStatus?: QuoteStatus;
};

/** How long typing has to pause before the search goes to the server. */
const SEARCH_DELAY_MS = 250;

/**
 * Every quote in the organization, newest first, a page at a time.
 *
 * The search and the status filter run on the server. They used to run here,
 * over the newest fifty, so a quote from last year could not be found at all
 * once fifty newer ones existed. The status filter is a row of counts rather
 * than a dropdown, because the question a rep opens this screen with is
 * almost always "what is waiting on something" — and a count answers it
 * before anything is clicked.
 */
export function QuoteList({ preferences, version, onOpen, onNew, onError, initialStatus }: Props) {
  const access = useAccess();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<QuoteStatus | "all">(initialStatus ?? "all");
  const [page, setPage] = useState(1);
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const perPage = Math.max(1, preferences.quoteListLimit || 50);
  const pages = Math.max(1, Math.ceil(total / perPage));

  // The search box answers as you type, but the server is asked once you pause.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    Promise.all([
      api.searchQuotes({ q: query, status: status === "all" ? "" : status, page, perPage }),
      api.quoteCounts(query),
    ])
      .then(([result, tally]) => {
        if (!current) return;
        setQuotes(result.items);
        setTotal(result.total);
        setCounts(tally);
      })
      .catch(error => current && onError(error))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [query, status, page, perPage, version, onError]);

  const everything = counts.all ?? 0;

  return (
    <Section
      title="Quotes"
      description={`${everything} quote${everything === 1 ? "" : "s"}`}
      actions={
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search"
              aria-label="Search quotes by number, name or customer"
              className="h-8 w-44 pl-8"
            />
          </div>
          {access.can("quotes.create") && (
            <Button size="sm" onClick={onNew}>
              <Plus /> New quote
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
        <FilterChip
          label="All"
          count={everything}
          on={status === "all"}
          onClick={() => {
            setStatus("all");
            setPage(1);
          }}
        />
        {QUOTE_STATUSES.filter(candidate => counts[candidate] || status === candidate).map(candidate => (
          <FilterChip
            key={candidate}
            label={statusLabel(candidate)}
            count={counts[candidate] ?? 0}
            on={status === candidate}
            onClick={() => {
              setStatus(candidate);
              setPage(1);
            }}
          />
        ))}
      </div>

      {quotes.length === 0 ? (
        loading ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <EmptyState title={everything ? "Nothing matches" : "No quotes yet"}>
            {everything
              ? "Try a different search, or clear the status filter."
              : "Start one from the catalogue — or install the worked example from Settings to see the whole thing running."}
          </EmptyState>
        )
      ) : (
        <>
          <Table>
            <Thead>
              <Tr>
                <Th>Quote</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th numeric>Lines</Th>
                <Th numeric>Discount</Th>
                <Th numeric>Total</Th>
                <Th>Valid until</Th>
              </Tr>
            </Thead>
            <Tbody className={cn(loading && "opacity-60")}>
              {quotes.map(quote => {
                const format = formatters(quote.currency, preferences.locale);
                return (
                  <Tr
                    key={quote.id}
                    onClick={() => onOpen(quote.id)}
                    className="cursor-pointer"
                    tabIndex={0}
                    onKeyDown={event => event.key === "Enter" && onOpen(quote.id)}
                  >
                    <Td>
                      <span className="block font-medium">{quote.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {quote.number}
                        {quote.version > 1 ? ` · rev ${quote.version}` : ""}
                      </span>
                    </Td>
                    <Td>{quote.customer.name || <span className="text-muted-foreground">—</span>}</Td>
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
                      {format.percent(quote.totals?.effectiveDiscountPercent ?? 0)}
                    </Td>
                    <Td numeric className="font-medium">
                      {format.money(quote.totals?.grandTotal ?? 0)}
                    </Td>
                    <Td className="text-muted-foreground">{format.date(quote.validUntil)}</Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>

          {pages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1 || loading}
                  aria-label="Previous page"
                >
                  <ChevronLeft />
                </Button>
                <span className="tabular-nums">
                  Page {page} of {pages}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(Math.min(pages, page + 1))}
                  disabled={page >= pages || loading}
                  aria-label="Next page"
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function FilterChip({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}
