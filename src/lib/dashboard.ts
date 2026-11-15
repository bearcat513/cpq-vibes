/**
 * The arithmetic behind the home screen, kept out of the component so it can
 * be tested and so it obeys the same two rules as everything else that adds
 * money up here:
 *
 * - **Never add two currencies.** A quote written in something other than the
 *   currency being totalled is counted and reported, not summed.
 * - **Say when a number is partial.** The dashboard reads a page of quotes,
 *   not every quote; a total over a page that was full says so.
 */
import { addDaysTo, today } from "./clock";
import { round } from "./money";
import type { CurrencyCode, QuoteStatus, QuoteSummary } from "./types";

/** Statuses where a quote is still in play — neither won, lost nor retired. */
export const OPEN_STATUSES: QuoteStatus[] = ["draft", "in_review", "approved", "sent"];

/** Statuses where the customer has answered, or the clock answered for them. */
export const DECIDED_STATUSES: QuoteStatus[] = ["accepted", "declined", "expired"];

export type PipelineSummary = {
  open: number;
  accepted: number;
  decided: number;
  /** accepted ÷ decided, 0-100; null until something has been decided. */
  winRate: number | null;
};

/** What the per-status counts (`GET /api/quotes/counts`) say about the pipeline. */
export function pipelineSummary(counts: Record<string, number>): PipelineSummary {
  const sum = (statuses: QuoteStatus[]) => statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);
  const accepted = counts.accepted ?? 0;
  const decided = sum(DECIDED_STATUSES);
  return {
    open: sum(OPEN_STATUSES),
    accepted,
    decided,
    winRate: decided > 0 ? Math.round((accepted / decided) * 1000) / 10 : null,
  };
}

export type CurrencyTotal = {
  currency: CurrencyCode;
  amount: number;
  /** How many quotes were added up. */
  count: number;
  /** Quotes in another currency: counted, never summed. */
  otherCurrency: number;
};

/** The grand totals of the quotes in `currency`, and how many were left out. */
export function totalIn(quotes: readonly QuoteSummary[], currency: CurrencyCode): CurrencyTotal {
  let amount = 0;
  let count = 0;
  let otherCurrency = 0;
  for (const quote of quotes) {
    if (quote.currency !== currency) {
      otherCurrency += 1;
      continue;
    }
    amount = round(amount + round(quote.totals?.grandTotal ?? 0, currency), currency);
    count += 1;
  }
  return { currency, amount, count, otherCurrency };
}

/**
 * Sent quotes whose pricing runs out within `days` (today included), soonest
 * first. A quote with no `validUntil` never expires and is never listed; one
 * already past it is `expired`, not sent, and the server has filtered it out.
 */
export function expiringWithin(quotes: readonly QuoteSummary[], days: number, asOf: string = today()): QuoteSummary[] {
  const until = addDaysTo(asOf, days);
  return quotes
    .filter(quote => quote.status === "sent" && quote.validUntil && quote.validUntil >= asOf && quote.validUntil <= until)
    .sort((a, b) => a.validUntil.localeCompare(b.validUntil));
}

/** "Good morning" and friends, from the hour on the reader's own clock. */
export function greeting(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
