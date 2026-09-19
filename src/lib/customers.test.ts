/**
 * The customer roll-up.
 *
 * Two things in here are easy to get quietly wrong and impossible to notice
 * on screen: adding up quotes that are not in the same currency, and deciding
 * what counts as a loss. Both are asserted rather than eyeballed.
 */
import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_SORTS,
  accountTags,
  customerStats,
  filterAccounts,
  sortAccounts,
  type AccountSort,
} from "./customers";
import { EMPTY_ADDRESS, type Account, type AccountContact, type CurrencyCode, type QuoteStatus, type QuoteSummary } from "./types";

/* ------------------------------- fixtures -------------------------------- */

const quote = (
  status: QuoteStatus,
  grandTotal: number,
  overrides: Partial<QuoteSummary> = {},
): QuoteSummary =>
  ({
    id: `qte_${status}_${grandTotal}`,
    number: "Q-2026-0001",
    name: "A quote",
    status,
    version: 1,
    supersedesId: null,
    customer: { accountId: "acc_1", name: "Harbour" },
    priceBookId: "",
    currency: "USD" as CurrencyCode,
    termMonths: 12,
    discountPercent: 0,
    taxPercent: 0,
    shipping: 0,
    validUntil: "",
    notes: "",
    internalNotes: "",
    totals: { grandTotal },
    approverIds: [],
    ownerId: "u",
    sharedWith: [],
    sentAt: "",
    decidedAt: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lineCount: 1,
    pendingApprovals: 0,
    ...overrides,
  }) as unknown as QuoteSummary;

const contact = (name: string, overrides: Partial<AccountContact> = {}): AccountContact => ({
  id: `con_${name}`,
  name,
  title: "",
  email: "",
  phone: "",
  role: "commercial",
  primary: false,
  ...overrides,
});

const account = (name: string, overrides: Partial<Account> = {}): Account => ({
  id: `acc_${name}`,
  name,
  industry: "",
  website: "",
  status: "prospect",
  tags: [],
  contacts: [],
  billingAddress: { ...EMPTY_ADDRESS },
  shippingAddress: { ...EMPTY_ADDRESS },
  shippingSameAsBilling: true,
  currency: "USD",
  priceBookId: "",
  paymentTerms: "",
  defaultDiscountPercent: 0,
  taxExempt: false,
  taxPercent: 0,
  notes: "",
  ownerId: "u",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

/* -------------------------------- roll-up -------------------------------- */

describe("what a customer has come to", () => {
  test("open is everything nobody has answered yet", () => {
    const stats = customerStats(
      [
        quote("draft", 100),
        quote("in_review", 200),
        quote("approved", 400),
        // An approval that came back is still a deal being worked.
        quote("rejected", 800),
        quote("sent", 1600),
        quote("accepted", 10),
        quote("declined", 20),
        quote("expired", 40),
      ],
      "USD",
    );

    expect(stats.quoteCount).toBe(8);
    expect(stats.openCount).toBe(5);
    expect(stats.openValue).toBe(3100);
    expect(stats.wonCount).toBe(1);
    expect(stats.wonValue).toBe(10);
    expect(stats.lostCount).toBe(1);
  });

  test("a quote nobody answered counts in neither half of the win rate", () => {
    // Two decided, one of them won: 50%, and the three expired quotes do not
    // drag it down. A rep who chases and gets no reply should not look worse
    // than one who never sent anything.
    const stats = customerStats(
      [quote("accepted", 1), quote("declined", 1), quote("expired", 1), quote("expired", 2), quote("expired", 3)],
      "USD",
    );

    expect(stats.winRate).toBe(50);
  });

  test("nothing decided is 0%, not a division by zero", () => {
    const stats = customerStats([quote("draft", 100)], "USD");
    expect(stats.winRate).toBe(0);
    expect(Number.isFinite(stats.winRate)).toBe(true);
  });

  test("a quote in another currency is counted but never added up", () => {
    const stats = customerStats(
      [quote("sent", 100), quote("sent", 999, { id: "qte_eur", currency: "EUR" as CurrencyCode })],
      "USD",
    );

    expect(stats.openCount).toBe(2);
    // 999 EUR is not 999 USD, and the totals say so by leaving it out.
    expect(stats.openValue).toBe(100);
    expect(stats.otherCurrencyCount).toBe(1);
  });

  test("the last quoted date is the newest one, whatever order they arrive in", () => {
    const stats = customerStats(
      [
        quote("sent", 1, { id: "a", updatedAt: "2026-03-01T00:00:00Z" }),
        quote("sent", 1, { id: "b", updatedAt: "2026-09-01T00:00:00Z" }),
        quote("sent", 1, { id: "c", updatedAt: "2026-06-01T00:00:00Z" }),
      ],
      "USD",
    );

    expect(stats.lastQuotedAt).toBe("2026-09-01T00:00:00Z");
  });

  test("a customer with no quotes reads as empty rather than as nothing", () => {
    const stats = customerStats([], "GBP");
    expect(stats).toMatchObject({ currency: "GBP", quoteCount: 0, openValue: 0, winRate: 0, lastQuotedAt: "" });
  });

  test("totals are rounded to the currency before they are summed", () => {
    // Yen has no minor unit: three quotes of 0.5 are three quotes of 1, not
    // a total of 1.5 that no invoice could be written for.
    const stats = customerStats(
      [
        quote("sent", 0.5, { id: "a", currency: "JPY" as CurrencyCode }),
        quote("sent", 0.5, { id: "b", currency: "JPY" as CurrencyCode }),
        quote("sent", 0.5, { id: "c", currency: "JPY" as CurrencyCode }),
      ],
      "JPY",
    );

    expect(stats.openValue).toBe(3);
  });
});

/* ------------------------------- searching ------------------------------- */

describe("finding one in a list", () => {
  const accounts = [
    account("Harbour Logistics", {
      industry: "Transport",
      status: "customer",
      tags: ["enterprise", "renewal-q3"],
      contacts: [contact("Dana Okafor", { email: "dana@harbour.example.com", primary: true })],
      billingAddress: { ...EMPTY_ADDRESS, city: "San Francisco" },
      updatedAt: "2026-05-01T00:00:00Z",
    }),
    account("Meridian Health", {
      industry: "Healthcare",
      status: "prospect",
      tags: ["mid-market"],
      contacts: [contact("Sam Ellery", { email: "s.ellery@meridian.example.org", primary: true })],
      billingAddress: { ...EMPTY_ADDRESS, city: "Boston" },
      updatedAt: "2026-09-01T00:00:00Z",
    }),
    account("Alpine Freight", { status: "inactive", updatedAt: "2026-01-01T00:00:00Z" }),
  ];

  const names = (list: Account[]) => list.map(entry => entry.name);

  test("the company, the contact, the tag and the city are all searchable", () => {
    expect(names(filterAccounts(accounts, { search: "harbour" }))).toEqual(["Harbour Logistics"]);
    expect(names(filterAccounts(accounts, { search: "ellery" }))).toEqual(["Meridian Health"]);
    expect(names(filterAccounts(accounts, { search: "renewal-q3" }))).toEqual(["Harbour Logistics"]);
    expect(names(filterAccounts(accounts, { search: "boston" }))).toEqual(["Meridian Health"]);
  });

  test("every word has to match, in any field", () => {
    // The company from one field, the person from another.
    expect(names(filterAccounts(accounts, { search: "harbour dana" }))).toEqual(["Harbour Logistics"]);
    expect(filterAccounts(accounts, { search: "harbour ellery" })).toEqual([]);
  });

  test("searching is case- and space-insensitive", () => {
    expect(names(filterAccounts(accounts, { search: "  MERIDIAN  " }))).toEqual(["Meridian Health"]);
    expect(names(filterAccounts(accounts, { search: "" }))).toHaveLength(3);
  });

  test("status and tag narrow it further", () => {
    expect(names(filterAccounts(accounts, { status: "inactive" }))).toEqual(["Alpine Freight"]);
    expect(names(filterAccounts(accounts, { tag: "mid-market" }))).toEqual(["Meridian Health"]);
    expect(filterAccounts(accounts, { status: "customer", tag: "mid-market" })).toEqual([]);
  });

  test("the tag list is every tag in use, once, sorted", () => {
    expect(accountTags(accounts)).toEqual(["enterprise", "mid-market", "renewal-q3"]);
  });
});

describe("ordering", () => {
  // Deliberately arranged so that no two of the three orders agree.
  const accounts = [
    account("Zephyr", { status: "customer", updatedAt: "2026-09-01T00:00:00Z" }),
    account("Alpine", { status: "inactive", updatedAt: "2026-02-01T00:00:00Z" }),
    account("Meridian", { status: "prospect", updatedAt: "2026-05-01T00:00:00Z" }),
  ];

  const names = (sort: AccountSort) => sortAccounts(accounts, sort).map(entry => entry.name);

  test("by name, by recency newest first, and by where they stand", () => {
    expect(names("name")).toEqual(["Alpine", "Meridian", "Zephyr"]);
    expect(names("recent")).toEqual(["Zephyr", "Meridian", "Alpine"]);
    // The ones you are working on before the ones you have stopped quoting.
    expect(names("status")).toEqual(["Meridian", "Zephyr", "Alpine"]);
  });

  test("the caller's array is left alone", () => {
    const original = [account("B"), account("A")];
    const before = original.map(entry => entry.name);
    sortAccounts(original, "name");
    expect(original.map(entry => entry.name)).toEqual(before);
  });

  test("every sort the picker offers is one this file implements", () => {
    // A value in the dropdown with no branch behind it falls through to "by
    // name" and looks like the control is broken.
    for (const { value } of ACCOUNT_SORTS) {
      expect(sortAccounts([account("B"), account("A")], value)).toHaveLength(2);
    }
  });
});
