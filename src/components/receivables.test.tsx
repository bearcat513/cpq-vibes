/**
 * The receivables screens, rendered.
 *
 * Static markup catches the two failures that matter here: a screen that
 * throws on first paint, and a screen that shows a number before it has the
 * records to compute it. The second one is specific to this part of the app —
 * "£0 outstanding" drawn while the ledger is still loading is a lie a finance
 * person would act on.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceEditor } from "@/components/app/InvoiceEditor";
import { ReceivablesView } from "@/components/app/ReceivablesView";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { EMPTY_ADDRESS, type Account } from "@/lib/types";

const account = (): Account => ({
  id: "acc_1",
  name: "Harbour Logistics",
  industry: "Transport",
  website: "",
  status: "customer",
  tags: [],
  contacts: [
    {
      id: "con_1",
      name: "Dana Okafor",
      title: "VP Operations",
      email: "dana@harbour.example.com",
      phone: "",
      role: "commercial",
      primary: true,
    },
  ],
  billingAddress: { ...EMPTY_ADDRESS, city: "San Francisco" },
  shippingAddress: { ...EMPTY_ADDRESS, city: "San Francisco" },
  shippingSameAsBilling: true,
  currency: "USD",
  priceBookId: "",
  paymentTerms: "Net 30",
  paymentTermDays: 30,
  creditLimit: 250_000,
  defaultDiscountPercent: 0,
  taxExempt: false,
  taxPercent: 8.5,
  notes: "",
  ownerId: "u",
  createdAt: "",
  updatedAt: "",
});

const noop = () => {};
const asyncNoop = async () => {};

describe("the receivables screen", () => {
  const html = renderToStaticMarkup(
    <ReceivablesView
      accounts={[account()]}
      preferences={DEFAULT_PREFERENCES}
      onError={noop}
      onNotice={noop}
      confirmed={() => true}
    />,
  );

  test("the aging columns are all five, always, including the empty ones", () => {
    // A report that hid its empty buckets would make a clean ledger and a
    // broken query look identical.
    expect(html).toContain("Not yet due");
    expect(html).toContain("1–30 days");
    expect(html).toContain("31–60 days");
    expect(html).toContain("61–90 days");
    expect(html).toContain("90+ days");
  });

  test("no figure is asserted before the ledger has been read", () => {
    // First paint happens before the fetch resolves. Every money cell is a
    // dash until there are records behind it.
    expect(html).toContain("Outstanding");
    expect(html).toContain("Reading the ledger…");
    expect(html).not.toContain("$0.00");
  });

  test("the way in is there: a new invoice, and the export", () => {
    expect(html).toContain("New invoice");
    expect(html).toContain("/api/invoices/export?format=csv");
    expect(html).toContain("Search invoices");
  });
});

describe("a new invoice", () => {
  const html = renderToStaticMarkup(
    <InvoiceEditor
      invoiceId={null}
      accounts={[account()]}
      preferences={DEFAULT_PREFERENCES}
      onBack={noop}
      onChanged={asyncNoop}
      onError={noop}
      confirmed={() => true}
    />,
  );

  test("opens as a draft and says that nothing is owed yet", () => {
    expect(html).toContain("New invoice");
    expect(html).toContain("Nothing is owed until it is issued");
    expect(html).toContain("Nothing on it yet");
  });

  test("the customer is a searchable list, not a box to mistype into", () => {
    // The app-wide rule: a field naming another record is a Combobox. It
    // renders closed — the list is portalled when it opens — so what is
    // assertable here is that it is a combobox rather than a text input.
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Customer"');
    expect(html).toContain("Choose a customer");
  });

  test("a draft offers no ledger — there is nothing to pay against it", () => {
    expect(html).not.toContain("Record payment");
    expect(html).not.toContain("Ledger");
    // And none of the acts that only apply to a document somebody has.
    expect(html).not.toContain("Void");
  });

  test("it can be saved and given lines", () => {
    expect(html).toContain("Add a line");
    expect(html).toContain("Save");
    expect(html).toContain("Their PO number");
  });
});

describe("the layout rules still hold", () => {
  test("the invoice page is a page, and its small forms are panels", async () => {
    // A line table, a ledger and a totals block do not fit in a 500px
    // column; recording one payment does.
    const source = await Bun.file(new URL("./app/InvoiceEditor.tsx", import.meta.url)).text();

    expect(source).toContain("components/ui/sheet");
    expect(source).not.toContain("components/ui/dialog");
    // The panels inside it size against the panel, not the window.
    expect(source).toContain("@md:grid-cols-2");
    expect(source).not.toContain("sm:grid-cols-");
  });

  test("the receivables list is a page and opens no modal of its own", async () => {
    const source = await Bun.file(new URL("./app/ReceivablesView.tsx", import.meta.url)).text();
    expect(source).not.toContain("components/ui/dialog");
    expect(source).not.toContain("components/ui/sheet");
  });
});
