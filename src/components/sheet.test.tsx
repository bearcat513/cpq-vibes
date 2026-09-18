/**
 * The shape of the editing surface.
 *
 * Every form in this app is a right-hand panel, and everything meant to be
 * *read* — a rendered proposal, a PDF — is still a wide modal. That split is
 * easy to break by reaching for the nearest component, so it is asserted here
 * rather than left to review.
 *
 * These render to static markup, which is enough to catch the two things that
 * actually go wrong: a form that throws on first paint, and a form that sizes
 * itself against the window instead of against the panel it is in.
 */
import { expect, test, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sheet } from "@/components/ui/sheet";
import { LineConfigurator } from "@/components/app/LineConfigurator";
import { PriceBookEditor } from "@/components/app/PriceBookEditor";
import { ProductEditor } from "@/components/app/ProductEditor";
import { ProductPicker } from "@/components/app/ProductPicker";
import { ShareDialog } from "@/components/app/ShareDialog";
import { specimenQuote } from "@/lib/samples";
import type { PriceBook, Product } from "@/lib/types";

const product = (): Product => ({
  id: "prd_1",
  sku: "PLAT",
  name: "Platform",
  description: "Core platform",
  family: "Software",
  chargeType: "recurring",
  billingPeriod: "monthly",
  unitOfMeasure: "user",
  listPrice: 120,
  cost: 28,
  currency: "USD",
  active: true,
  minQuantity: 1,
  maxQuantity: 0,
  floorDiscountPercent: 20,
  optionGroups: [
    {
      id: "g",
      key: "tier",
      name: "Edition",
      select: "one",
      required: true,
      options: [
        { id: "o1", key: "std", name: "Standard", priceDelta: 0, default: true },
        { id: "o2", key: "ent", name: "Enterprise", priceDelta: 0, priceFactor: 1.8 },
      ],
    },
  ],
  rules: [],
  components: [],
  volumeTiers: [{ minQuantity: 25, maxQuantity: null, kind: "percent", value: 10 }],
  attributes: { SLA: "99.9%" },
  ownerId: "u",
  sharedWith: [],
  createdAt: "",
  updatedAt: "",
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
  entries: [{ sku: "PLAT", unitPrice: 120, minPrice: 72, active: true }],
  ownerId: "u",
  sharedWith: [],
  createdAt: "",
  updatedAt: "",
});

const noop = () => {};
const asyncNoop = async () => {};

describe("the panel", () => {
  test("is pinned right, full height, and a third of the window", () => {
    const html = renderToStaticMarkup(
      <Sheet title="Edit" description="A description" onClose={noop} footer={<button>Save</button>}>
        <p>body</p>
      </Sheet>,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("justify-end");
    expect(html).toContain("h-full");
    expect(html).toContain("sm:w-[35%]");
    // A floor, so it stays a usable form on a laptop rather than a column.
    expect(html).toContain("sm:min-w-[26rem]");
    expect(html).toContain("slide-in-from-right");

    // Header, scrolling body and footer are separate: only the middle moves.
    expect(html).toContain("@container");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("body");
    expect(html).toContain("Save");
  });
});

describe("every form is a panel", () => {
  const cases: [string, () => string][] = [
    [
      "product editor",
      () => renderToStaticMarkup(<ProductEditor product={product()} products={[product()]} onSave={asyncNoop} onClose={noop} />),
    ],
    [
      "price book editor",
      () =>
        renderToStaticMarkup(
          <PriceBookEditor book={priceBook()} products={[product()]} onSave={asyncNoop} onClose={noop} />,
        ),
    ],
    [
      "product picker",
      () =>
        renderToStaticMarkup(
          <ProductPicker products={[product()]} currency="USD" locale="en-US" onPick={noop} onClose={noop} />,
        ),
    ],
    [
      "line configurator",
      () =>
        renderToStaticMarkup(
          <LineConfigurator
            product={product()}
            line={{ ...specimenQuote().lines[0]!, productId: "prd_1", selectedOptions: ["std"] }}
            currency="USD"
            locale="en-US"
            quoteTermMonths={12}
            onSave={noop}
            onClose={noop}
          />,
        ),
    ],
    [
      "share dialog",
      () =>
        renderToStaticMarkup(
          <ShareDialog
            kind="products"
            id="prd_1"
            title="Platform"
            viewerEmail="me@example.com"
            directory={[{ id: "u1", email: "other@example.com", name: "Other Person" }]}
            onClose={noop}
            onChanged={noop}
          />,
        ),
    ],
  ];

  for (const [name, render] of cases) {
    test(`the ${name} renders as a panel, sized against the panel`, () => {
      const html = render();

      expect(html).toContain("sm:w-[35%]");
      // A viewport breakpoint inside a panel is the bug this guards: on a wide
      // screen `sm:grid-cols-4` is still four columns in a 500px panel.
      expect(html).not.toContain("sm:grid-cols-");
    });
  }

  test("a product editor's dense form lays out against the panel", () => {
    const html = renderToStaticMarkup(<ProductEditor product={product()} products={[product()]} onSave={asyncNoop} onClose={noop} />);

    expect(html).toContain("@md:grid-cols-2");
    expect(html).toContain("Platform");
    // The tab row stays put while the form under it scrolls.
    expect(html).toContain("sticky");
  });
});

describe("what stays a modal", () => {
  test("forms use the panel and only the previews use the dialog", async () => {
    // Expressed here because it is a rule about the app rather than about any
    // one component, and the easiest way to break it is to import the nearest
    // thing to hand.
    const forms = [
      "app/ProductEditor",
      "app/PriceBookEditor",
      "app/AccountsView",
      "app/RulesView",
      "app/LineConfigurator",
      "app/ProductPicker",
      "app/ShareDialog",
    ];

    for (const name of forms) {
      const source = await Bun.file(new URL(`./${name}.tsx`, import.meta.url)).text();
      expect(source).toContain("components/ui/sheet");
      expect(source).not.toContain("components/ui/dialog");
    }

    // The quote editor renders a proposal and a PDF, which need the width.
    const quoteEditor = await Bun.file(new URL("./app/QuoteEditor.tsx", import.meta.url)).text();
    expect(quoteEditor).toContain("components/ui/dialog");
  });
});
