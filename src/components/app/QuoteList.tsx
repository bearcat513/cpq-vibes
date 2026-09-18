import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { EmptyState, Section, StatusBadge, formatters } from "./common";
import { QUOTE_STATUSES, type QuoteStatus, type QuoteSummary } from "@/lib/types";
import type { Preferences } from "@/lib/preferences";
import { cn } from "@/lib/utils";

type Props = {
  quotes: QuoteSummary[];
  preferences: Preferences;
  onOpen: (id: string) => void;
  onNew: () => void;
};

/**
 * Every quote, newest first.
 *
 * The status filter is a row of counts rather than a dropdown, because the
 * question a rep opens this screen with is almost always "what is waiting on
 * something" — and a count answers it before anything is clicked.
 */
export function QuoteList({ quotes, preferences, onOpen, onNew }: Props) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<QuoteStatus | "all">("all");

  const counts = useMemo(() => {
    const tally = new Map<QuoteStatus, number>();
    for (const quote of quotes) tally.set(quote.status, (tally.get(quote.status) ?? 0) + 1);
    return tally;
  }, [quotes]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return quotes.filter(
      quote =>
        (status === "all" || quote.status === status) &&
        (!needle ||
          quote.name.toLowerCase().includes(needle) ||
          quote.number.toLowerCase().includes(needle) ||
          quote.customer.name.toLowerCase().includes(needle)),
    );
  }, [quotes, search, status]);

  return (
    <Section
      title="Quotes"
      description={`${quotes.length} quote${quotes.length === 1 ? "" : "s"}`}
      actions={
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search"
              className="h-8 w-44 pl-8"
            />
          </div>
          <Button size="sm" onClick={onNew}>
            <Plus /> New quote
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
        <FilterChip label="All" count={quotes.length} on={status === "all"} onClick={() => setStatus("all")} />
        {QUOTE_STATUSES.filter(candidate => counts.get(candidate)).map(candidate => (
          <FilterChip
            key={candidate}
            label={candidate.replace("_", " ")}
            count={counts.get(candidate) ?? 0}
            on={status === candidate}
            onClick={() => setStatus(candidate)}
          />
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState title={quotes.length ? "Nothing matches" : "No quotes yet"}>
          {quotes.length
            ? "Try a different search, or clear the status filter."
            : "Start one from the catalogue — or install the worked example from Settings to see the whole thing running."}
        </EmptyState>
      ) : (
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
          <Tbody>
            {visible.map(quote => {
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
        "rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}
