/**
 * What a customer looks like across every quote you have written them.
 *
 * The account record says what is *true* of a customer — their terms, their
 * tax position, who to call. This file answers the other question a rep opens
 * a customer for: how has this gone so far. Both the roll-up and the
 * searching are pure functions over records the app already has, so the
 * customers screen filters and totals without a round trip, and the numbers
 * are testable without a database.
 *
 * **Only one currency is ever added up.** An account is denominated in one
 * currency, but nothing stops a quote for them being written in another — a
 * price book in EUR, a one-off in GBP — and a pipeline figure that quietly
 * summed those would be a wrong number presented confidently. Quotes in
 * another currency are counted and reported as such, never added.
 */
import { percentBetween, round, sum } from "./money";
import type {
  Account,
  AccountStatus,
  CurrencyCode,
  QuoteStatus,
  QuoteSummary,
} from "./types";

/* -------------------------------- roll-up -------------------------------- */

/**
 * Quotes still in play: nobody has said yes or no, and the clock has not run
 * out. `rejected` is in here because an approval that came back is a deal
 * still being worked, not a deal lost.
 */
const OPEN_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  "draft",
  "in_review",
  "approved",
  "rejected",
  "sent",
]);

/** Quotes the customer answered. `expired` is not one of them — see below. */
const WON: QuoteStatus = "accepted";
const LOST: QuoteStatus = "declined";

export type CustomerStats = {
  /** The account's own currency — the only one anything here is summed in. */
  currency: CurrencyCode;
  quoteCount: number;
  openCount: number;
  /** What is still in play, at grand total. */
  openValue: number;
  wonCount: number;
  /** Everything they have accepted, at grand total. */
  wonValue: number;
  lostCount: number;
  /**
   * Won over won-plus-lost, as a percentage. Quotes nobody answered are left
   * out of both halves: an expired quote is a question that went unasked, and
   * counting it as a loss makes a rep who follows up look worse than one who
   * does not.
   */
  winRate: number;
  /** The newest quote's timestamp, ISO, or "" when there are none. */
  lastQuotedAt: string;
  /** Quotes written in some other currency: counted, never added up. */
  otherCurrencyCount: number;
};

export const EMPTY_STATS = (currency: CurrencyCode): CustomerStats => ({
  currency,
  quoteCount: 0,
  openCount: 0,
  openValue: 0,
  wonCount: 0,
  wonValue: 0,
  lostCount: 0,
  winRate: 0,
  lastQuotedAt: "",
  otherCurrencyCount: 0,
});

/**
 * Everything the customer detail screen puts at the top of the page.
 *
 * `quotes` is whatever the caller has for this customer — the server's
 * per-account list, or the quote list already in memory filtered down. Order
 * does not matter; a superseded revision counts like any other quote, because
 * it was a document that was sent.
 */
export function customerStats(quotes: QuoteSummary[], currency: CurrencyCode): CustomerStats {
  const stats = EMPTY_STATS(currency);
  const open: number[] = [];
  const won: number[] = [];

  for (const quote of quotes) {
    stats.quoteCount += 1;

    const when = quote.updatedAt || quote.createdAt;
    if (when > stats.lastQuotedAt) stats.lastQuotedAt = when;

    const comparable = quote.currency === currency;
    if (!comparable) stats.otherCurrencyCount += 1;

    if (OPEN_STATUSES.has(quote.status)) {
      stats.openCount += 1;
      if (comparable) open.push(round(quote.totals?.grandTotal ?? 0, currency));
    } else if (quote.status === WON) {
      stats.wonCount += 1;
      if (comparable) won.push(round(quote.totals?.grandTotal ?? 0, currency));
    } else if (quote.status === LOST) {
      stats.lostCount += 1;
    }
  }

  stats.openValue = sum(open, currency);
  stats.wonValue = sum(won, currency);
  stats.winRate = percentBetween(stats.wonCount, stats.wonCount + stats.lostCount);
  return stats;
}

/* ------------------------------- searching ------------------------------- */

/**
 * Everything about a customer that is worth typing into a search box, as one
 * lowercased string.
 *
 * Contacts are in it because the name a rep remembers is very often the
 * person's, not the company's, and the city is in it because "the Boston
 * one" is how a customer gets described out loud.
 */
function haystack(account: Account): string {
  const contacts = account.contacts.flatMap(contact => [contact.name, contact.email, contact.title]);
  return [
    account.name,
    account.industry,
    account.website,
    account.paymentTerms,
    ...account.tags,
    ...contacts,
    account.billingAddress.city,
    account.billingAddress.state,
    account.billingAddress.country,
  ]
    .join(" ")
    .toLowerCase();
}

export type AccountFilter = {
  search?: string;
  /** "" is every status. */
  status?: AccountStatus | "";
  /** "" is every tag. */
  tag?: string;
};

/**
 * Every term has to match, in any field.
 *
 * Splitting on whitespace is what makes "harbour dana" find the account by
 * company and contact at once, which a single substring match cannot.
 */
export function filterAccounts(accounts: Account[], filter: AccountFilter): Account[] {
  const terms = (filter.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const { status, tag } = filter;

  return accounts.filter(account => {
    if (status && account.status !== status) return false;
    if (tag && !account.tags.includes(tag)) return false;
    if (!terms.length) return true;

    const text = haystack(account);
    return terms.every(term => text.includes(term));
  });
}

export type AccountSort = "name" | "recent" | "status";

export const ACCOUNT_SORTS: { value: AccountSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Recently changed" },
  { value: "status", label: "Status" },
];

/** Status order for sorting: the ones you are working on, first. */
const STATUS_ORDER: Record<AccountStatus, number> = { prospect: 0, customer: 1, inactive: 2 };

/** Sorts a copy — the caller's array is somebody else's state. */
export function sortAccounts(accounts: Account[], sort: AccountSort): Account[] {
  const byName = (a: Account, b: Account) => a.name.localeCompare(b.name);

  return [...accounts].sort((a, b) => {
    if (sort === "recent") return (b.updatedAt || "").localeCompare(a.updatedAt || "") || byName(a, b);
    if (sort === "status") return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byName(a, b);
    return byName(a, b);
  });
}

/** Every tag in use, sorted, for the filter that offers them. */
export const accountTags = (accounts: Account[]): string[] =>
  [...new Set(accounts.flatMap(account => account.tags))].sort();
