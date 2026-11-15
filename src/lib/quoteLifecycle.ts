/**
 * The two quote statuses that are read rather than stored.
 *
 * `expired` is a fact about the calendar and `superseded` a fact about another
 * record, and a status that only becomes true when something sweeps it is a
 * status that lies between sweeps. So the stored value is left alone and
 * these are worked out on every read — which also means that deleting a
 * revision, or reopening an expired quote as a draft, needs nothing undone.
 *
 * Pure, and shared by the server and the browser.
 */
import { today } from "./clock";
import type { QuoteStatus } from "./types";

type Lifecycle = { status: QuoteStatus; validUntil: string; supersededById?: string | null };

/**
 * The status a quote actually has today.
 *
 * Superseded wins: once a newer version exists, whether the old one has also
 * run out is beside the point. An accepted quote is never superseded — it is a
 * contract, and revising one is refused (see `reviseQuote`).
 */
export function effectiveStatus(quote: Lifecycle, asOf: string = today()): QuoteStatus {
  if (quote.supersededById && quote.status !== "accepted") return "superseded";
  if (quote.status === "sent" && quote.validUntil && quote.validUntil < asOf) return "expired";
  return quote.status;
}

/** The quote with its effective status in place of its stored one. */
export function withLifecycle<T extends Lifecycle>(quote: T, asOf: string = today()): T {
  const status = effectiveStatus(quote, asOf);
  return status === quote.status ? quote : { ...quote, status };
}
