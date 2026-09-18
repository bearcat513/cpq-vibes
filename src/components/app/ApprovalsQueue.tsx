import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { EmptyState, Section, StatusBadge, formatters } from "./common";
import type { Preferences } from "@/lib/preferences";
import type { QuoteSummary } from "@/lib/types";

type Props = {
  quotes: QuoteSummary[];
  preferences: Preferences;
  onOpen: (id: string) => void;
};

/**
 * Quotes somebody else has asked this account to approve.
 *
 * These are the only records of another person's that are visible here, and
 * only while the quote is waiting — PocketBase's own rules decide that, not
 * this screen. Opening one shows the quote in full, with the approve and
 * reject buttons on it.
 */
export function ApprovalsQueue({ quotes, preferences, onOpen }: Props) {
  return (
    <Section
      title="Waiting on you"
      description="Quotes other people have submitted for your approval."
      actions={quotes.length > 0 && <Badge tone="pending">{quotes.length}</Badge>}
    >
      {quotes.length === 0 ? (
        <EmptyState title="Nothing to approve">
          <span className="flex items-center justify-center gap-1.5">
            <ShieldCheck className="size-3.5" /> When a colleague submits a quote that trips one of your approval rules,
            it appears here.
          </span>
        </EmptyState>
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Quote</Th>
              <Th>Customer</Th>
              <Th>Why</Th>
              <Th numeric>Discount</Th>
              <Th numeric>Total</Th>
              <Th>Status</Th>
            </Tr>
          </Thead>
          <Tbody>
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
                    <span className="font-mono text-xs text-muted-foreground">{quote.number}</span>
                  </Td>
                  <Td>{quote.customer.name || "—"}</Td>
                  <Td className="text-xs text-muted-foreground">
                    {quote.pendingApprovals} outstanding request{quote.pendingApprovals === 1 ? "" : "s"}
                  </Td>
                  <Td numeric>{format.percent(quote.totals?.effectiveDiscountPercent ?? 0)}</Td>
                  <Td numeric className="font-medium">
                    {format.money(quote.totals?.grandTotal ?? 0)}
                  </Td>
                  <Td>
                    <StatusBadge status={quote.status} />
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      )}
    </Section>
  );
}
