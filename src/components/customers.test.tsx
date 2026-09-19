/**
 * The customer screens, rendered.
 *
 * Static markup is enough for the two things that actually break: a screen
 * that throws on first paint, and a screen that quietly stops showing
 * something a rep depends on — who the quote will be addressed to, and which
 * customers the filters have hidden.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountsView } from "@/components/app/AccountsView";
import { CustomerDetail } from "@/components/app/CustomerDetail";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { EMPTY_ADDRESS, type Account, type AccountContact, type PriceBook } from "@/lib/types";

const contact = (name: string, overrides: Partial<AccountContact> = {}): AccountContact => ({
  id: `con_${name.toLowerCase().replace(/\W+/g, "")}`,
  name,
  title: "",
  email: "",
  phone: "",
  role: "commercial",
  primary: false,
  ...overrides,
});

const harbour = (): Account => ({
  id: "acc_1",
  name: "Harbour Logistics",
  industry: "Transport and logistics",
  website: "https://harbour.example.com",
  status: "customer",
  tags: ["enterprise", "renewal-q3"],
  contacts: [
    contact("Dana Okafor", { title: "VP Operations", email: "dana@harbour.example.com", primary: true }),
    contact("Accounts Payable", { email: "ap@harbour.example.com", role: "billing" }),
  ],
  billingAddress: { ...EMPTY_ADDRESS, line1: "1200 Embarcadero", city: "San Francisco", country: "United States" },
  shippingAddress: { ...EMPTY_ADDRESS, line1: "3400 Pier 80 Access Road", city: "San Francisco" },
  shippingSameAsBilling: false,
  currency: "USD",
  priceBookId: "pb_1",
  paymentTerms: "Net 30",
  defaultDiscountPercent: 0,
  taxExempt: false,
  taxPercent: 8.5,
  notes: "Renewal in Q3.",
  ownerId: "u",
  createdAt: "",
  updatedAt: "2026-05-01T00:00:00Z",
});

const meridian = (): Account => ({
  ...harbour(),
  id: "acc_2",
  name: "Meridian Health",
  industry: "Healthcare",
  status: "prospect",
  tags: ["mid-market"],
  contacts: [contact("Sam Ellery", { email: "s.ellery@meridian.example.org", primary: true })],
  notes: "",
});

const priceBook = (): PriceBook => ({
  id: "pb_1",
  name: "Global list",
  description: "",
  currency: "USD",
  isDefault: true,
  active: true,
  validFrom: "",
  validTo: "",
  entries: [],
  ownerId: "u",
  sharedWith: [],
  createdAt: "",
  updatedAt: "",
});

const noop = () => {};
const asyncNoop = async () => {};

const list = (accounts: Account[]) =>
  renderToStaticMarkup(
    <AccountsView
      accounts={accounts}
      priceBooks={[priceBook()]}
      preferences={DEFAULT_PREFERENCES}
      onChanged={asyncNoop}
      onError={noop}
      onOpenQuote={noop}
      confirmed={() => true}
    />,
  );

describe("the customer list", () => {
  test("shows who a quote would be addressed to, and that there are others", () => {
    const html = list([harbour()]);

    expect(html).toContain("Harbour Logistics");
    expect(html).toContain("Dana Okafor");
    expect(html).toContain("dana@harbour.example.com");
    // The second contact is not listed, but its existence is.
    expect(html).toContain("+1 more");
    expect(html).not.toContain("ap@harbour.example.com");
  });

  test("standing and segmentation are on the row, not buried in the editor", () => {
    const html = list([harbour(), meridian()]);

    // Anchored, because "Customers" is also the heading above the table.
    expect(html).toContain(">Customer<");
    expect(html).toContain(">Prospect<");
    expect(html).toContain("enterprise");
    expect(html).toContain("renewal-q3");
    expect(html).toContain("mid-market");
  });

  test("the status filter counts every standing, including the empty ones", () => {
    // A zero beside "Inactive" is the answer to "have I archived anyone",
    // which a filter that hides its empty options cannot give.
    const html = list([harbour(), meridian()]);
    expect(html).toContain("Inactive");
    expect(html).toContain("Search customers");
    expect(html).toContain("Sort customers");
  });

  test("an empty workspace says so rather than showing an empty table", () => {
    const html = list([]);
    expect(html).toContain("No customers yet");
    expect(html).not.toContain("Primary contact");
    // Nothing is tagged, so the tag filter does not appear at all.
    expect(html).not.toContain("Filter by tag");
  });
});

describe("a customer's own page", () => {
  const detail = (account: Account) =>
    renderToStaticMarkup(
      <CustomerDetail
        account={account}
        priceBooks={[priceBook()]}
        preferences={DEFAULT_PREFERENCES}
        onBack={noop}
        onEdit={noop}
        onOpenQuote={noop}
        onError={noop}
      />,
    );

  test("reads as a dossier: everyone there, both addresses, and the terms", () => {
    const html = detail(harbour());

    expect(html).toContain("Harbour Logistics");
    expect(html).toContain("Dana Okafor");
    expect(html).toContain("VP Operations");
    expect(html).toContain("Accounts Payable");
    expect(html).toContain("Billing");
    expect(html).toContain("1200 Embarcadero");
    expect(html).toContain("3400 Pier 80 Access Road");
    expect(html).toContain("Net 30");
    expect(html).toContain("Global list");
  });

  test("the history is marked as still being read rather than as empty", () => {
    // The first paint happens before the fetch resolves, and "no quotes yet"
    // on a customer with twenty of them is a lie the user would act on.
    const html = detail(harbour());
    expect(html).toContain("Reading their quotes…");
    expect(html).not.toContain("No quotes yet");
  });

  test("a customer who ships where they are billed says so once", () => {
    const html = detail({ ...harbour(), shippingSameAsBilling: true, shippingAddress: harbour().billingAddress });
    expect(html).toContain("Same as billing");
  });

  test("a customer nobody is named at is told what is missing", () => {
    const html = detail({ ...harbour(), contacts: [] });
    expect(html).toContain("Nobody named yet");
  });
});
