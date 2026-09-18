/**
 * A worked example: a catalogue, the policy around it, two customers and the
 * documents to send them.
 *
 * An empty CPQ is not explorable. You cannot see what a volume tier does
 * without a product that has one, what an approval rule does without a
 * discount deep enough to trip it, or what a bundle does without a bundle. So
 * a new account can install this in one click and then take it apart — every
 * feature in the app is represented by something here that uses it.
 *
 * It is deliberately a *plausible* B2B software catalogue rather than a
 * minimal one: tiers that overlap the way published price breaks do, a
 * services family with its own discount ceiling, a bundle whose components
 * carry the price, and an approval ladder that a 30% discount actually walks
 * up. The numbers are made up; the shapes are not.
 *
 * Everything here goes through `src/lib/validate.ts` on its way in, exactly
 * like an imported file, so the sample cannot encode anything the app would
 * otherwise refuse.
 */
import { priceQuote } from "./pricing";
import { starterPdfTemplate, type PdfTemplate } from "./pdfTemplate";
import type { ProposalFormat, Product, Quote } from "./types";
import type { AccountInput, ApprovalRuleInput, PriceBookInput, PricingRuleInput, ProductInput } from "./validate";

/* -------------------------------- products ------------------------------- */

export const SAMPLE_PRODUCTS: ProductInput[] = [
  {
    sku: "PLAT-CORE",
    name: "Nimbus Platform",
    description: "The core platform, licensed per named user.",
    family: "Software",
    chargeType: "recurring",
    billingPeriod: "monthly",
    unitOfMeasure: "user",
    listPrice: 120,
    cost: 28,
    currency: "USD",
    active: true,
    minQuantity: 5,
    maxQuantity: 0,
    floorDiscountPercent: 20,
    optionGroups: [
      {
        id: "grp_tier",
        key: "tier",
        name: "Edition",
        description: "Every user on the subscription is on the same edition.",
        select: "one",
        required: true,
        options: [
          { id: "opt_std", key: "standard", name: "Standard", description: "Core platform.", priceDelta: 0, priceFactor: 1, default: true },
          { id: "opt_pro", key: "professional", name: "Professional", description: "Adds workflow automation and the reporting suite.", priceDelta: 0, priceFactor: 1.35 },
          { id: "opt_ent", key: "enterprise", name: "Enterprise", description: "Adds residency controls, audit and the admin API.", priceDelta: 0, priceFactor: 1.8 },
        ],
      },
      {
        id: "grp_addons",
        key: "addons",
        name: "Add-ons",
        description: "Priced per user, per month, on top of the edition.",
        select: "many",
        required: false,
        maxSelect: 3,
        options: [
          { id: "opt_sso", key: "sso", name: "SSO and SCIM", description: "SAML sign-on and directory sync.", priceDelta: 12 },
          { id: "opt_audit", key: "audit_log", name: "Audit log export", description: "Streams the audit log to your SIEM.", priceDelta: 8 },
          { id: "opt_hsm", key: "hsm", name: "Customer-managed keys", description: "Keys held in your own HSM.", priceDelta: 25 },
        ],
      },
    ],
    rules: [
      {
        id: "prl_hsm",
        kind: "requires",
        when: ["hsm"],
        then: ["enterprise"],
        message: "Customer-managed keys are an Enterprise capability.",
      },
      {
        id: "prl_sso",
        kind: "recommend",
        when: ["enterprise"],
        then: ["sso"],
        message: "Enterprise buyers almost always want SSO and SCIM — worth asking.",
      },
      {
        id: "prl_ent_min",
        kind: "validate",
        when: ["enterprise"],
        then: [],
        expression: "quantity >= 25",
        message: "Enterprise starts at 25 users.",
      },
    ],
    components: [],
    volumeTiers: [
      { minQuantity: 5, maxQuantity: 24, kind: "percent", value: 0 },
      { minQuantity: 25, maxQuantity: 99, kind: "percent", value: 10 },
      { minQuantity: 100, maxQuantity: 499, kind: "percent", value: 18 },
      { minQuantity: 500, maxQuantity: null, kind: "override", value: 75 },
    ],
    attributes: { Hosting: "Multi-tenant SaaS", SLA: "99.9%", "Data residency": "EU or US" },
  },
  {
    sku: "PLAT-API",
    name: "API Gateway",
    description: "Programmatic access, metered in millions of calls per month.",
    family: "Software",
    chargeType: "recurring",
    billingPeriod: "monthly",
    unitOfMeasure: "million calls",
    listPrice: 90,
    cost: 22,
    currency: "USD",
    active: true,
    minQuantity: 1,
    maxQuantity: 0,
    floorDiscountPercent: 20,
    optionGroups: [],
    rules: [],
    components: [],
    volumeTiers: [
      { minQuantity: 1, maxQuantity: 9, kind: "percent", value: 0 },
      { minQuantity: 10, maxQuantity: null, kind: "percent", value: 15 },
    ],
    attributes: { "Rate limit": "5,000 rps" },
  },
  {
    sku: "STOR",
    name: "Managed Storage",
    description: "Replicated object storage, billed per terabyte per month.",
    family: "Software",
    chargeType: "recurring",
    billingPeriod: "monthly",
    unitOfMeasure: "TB",
    listPrice: 18,
    cost: 6,
    currency: "USD",
    active: true,
    minQuantity: 1,
    maxQuantity: 0,
    floorDiscountPercent: 25,
    optionGroups: [],
    rules: [],
    components: [],
    volumeTiers: [
      { minQuantity: 1, maxQuantity: 49, kind: "percent", value: 0 },
      { minQuantity: 50, maxQuantity: 199, kind: "percent", value: 12 },
      { minQuantity: 200, maxQuantity: null, kind: "override", value: 11 },
    ],
    attributes: { Durability: "11 nines", Replication: "Three zones" },
  },
  {
    sku: "API-OVERAGE",
    name: "API overage",
    description: "Calls beyond the committed volume, billed in arrears. Quote the volume you expect.",
    family: "Software",
    chargeType: "usage",
    billingPeriod: "monthly",
    unitOfMeasure: "thousand calls",
    listPrice: 0.4,
    cost: 0.09,
    currency: "USD",
    active: true,
    minQuantity: 0,
    maxQuantity: 0,
    floorDiscountPercent: 10,
    optionGroups: [],
    rules: [],
    components: [],
    volumeTiers: [],
    attributes: {},
  },
  {
    sku: "ONBOARD",
    name: "Onboarding and migration",
    description: "A fixed-scope implementation: environment setup, data migration and go-live support.",
    family: "Services",
    chargeType: "one-time",
    billingPeriod: "monthly",
    unitOfMeasure: "engagement",
    listPrice: 12_000,
    cost: 6_500,
    currency: "USD",
    active: true,
    minQuantity: 1,
    maxQuantity: 4,
    floorDiscountPercent: 10,
    optionGroups: [
      {
        id: "grp_scope",
        key: "scope",
        name: "Scope",
        select: "one",
        required: true,
        options: [
          { id: "opt_std_scope", key: "standard_scope", name: "Standard", description: "Up to two source systems.", priceDelta: 0, default: true },
          { id: "opt_complex", key: "complex_scope", name: "Complex", description: "Three or more source systems, or custom transforms.", priceDelta: 0, priceFactor: 1.6 },
        ],
      },
    ],
    rules: [],
    components: [],
    volumeTiers: [],
    attributes: { Duration: "6-10 weeks" },
  },
  {
    sku: "TRAIN",
    name: "Administrator training",
    description: "Two days of instructor-led training, priced per attendee.",
    family: "Services",
    chargeType: "one-time",
    billingPeriod: "monthly",
    unitOfMeasure: "seat",
    listPrice: 450,
    cost: 180,
    currency: "USD",
    active: true,
    minQuantity: 1,
    maxQuantity: 40,
    floorDiscountPercent: 15,
    optionGroups: [],
    rules: [],
    components: [],
    // No volume tier here on purpose: the group rate for ten or more seats is
    // expressed once, as the pricing rule below. A tier *and* a rule saying
    // the same thing would discount the line twice, which is the classic way
    // a CPQ quietly sells something at 64% of list.
    volumeTiers: [],
    attributes: {},
  },
  {
    sku: "SUPPORT-PREM",
    name: "Premium support",
    description: "24×7 cover, one-hour response, a named technical account manager.",
    family: "Support",
    chargeType: "recurring",
    billingPeriod: "annual",
    unitOfMeasure: "subscription",
    listPrice: 9_600,
    cost: 3_200,
    currency: "USD",
    active: true,
    minQuantity: 1,
    maxQuantity: 1,
    floorDiscountPercent: 15,
    optionGroups: [],
    rules: [],
    components: [],
    volumeTiers: [],
    attributes: { Response: "1 hour, 24×7" },
  },
  {
    // A bundle: the header carries no price of its own, and the components it
    // pulls in carry theirs — which is what lets the customer see what they
    // are getting rather than one number with no parts.
    sku: "SUITE-ENT",
    name: "Enterprise suite",
    description: "Platform, premium support and onboarding, bought together.",
    family: "Bundles",
    chargeType: "one-time",
    billingPeriod: "monthly",
    unitOfMeasure: "bundle",
    listPrice: 0,
    cost: 0,
    currency: "USD",
    active: true,
    minQuantity: 1,
    maxQuantity: 1,
    floorDiscountPercent: 0,
    optionGroups: [],
    rules: [],
    components: [
      { id: "cmp_plat", sku: "PLAT-CORE", quantity: 1, required: true, discountPercent: 0 },
      { id: "cmp_sup", sku: "SUPPORT-PREM", quantity: 1, required: true, discountPercent: 25 },
      { id: "cmp_onb", sku: "ONBOARD", quantity: 1, required: false, discountPercent: 50 },
    ],
    volumeTiers: [],
    attributes: {},
  },
];

/* ------------------------------ price books ------------------------------ */

export const SAMPLE_PRICE_BOOKS: PriceBookInput[] = [
  {
    name: "Global list",
    description: "The published price. Every product's catalogue price, with the floors below which nothing sells.",
    currency: "USD",
    isDefault: true,
    active: true,
    validFrom: "",
    validTo: "",
    entries: [
      { sku: "PLAT-CORE", unitPrice: 120, minPrice: 72, active: true },
      { sku: "PLAT-API", unitPrice: 90, minPrice: 58, active: true },
      { sku: "STOR", unitPrice: 18, minPrice: 11, active: true },
      { sku: "API-OVERAGE", unitPrice: 0.4, minPrice: 0.3, active: true },
      { sku: "ONBOARD", unitPrice: 12_000, minPrice: 9_000, active: true },
      { sku: "TRAIN", unitPrice: 450, minPrice: 320, active: true },
      { sku: "SUPPORT-PREM", unitPrice: 9_600, minPrice: 7_200, active: true },
      { sku: "SUITE-ENT", unitPrice: 0, minPrice: 0, active: true },
    ],
  },
  {
    name: "Partner",
    description: "Resale pricing. Already discounted, so the floors are what keep a partner deal from going underwater.",
    currency: "USD",
    isDefault: false,
    active: true,
    validFrom: "",
    validTo: "",
    entries: [
      { sku: "PLAT-CORE", unitPrice: 96, minPrice: 72, active: true },
      { sku: "PLAT-API", unitPrice: 72, minPrice: 58, active: true },
      { sku: "STOR", unitPrice: 14.5, minPrice: 11, active: true },
      { sku: "ONBOARD", unitPrice: 10_200, minPrice: 9_000, active: true },
      { sku: "TRAIN", unitPrice: 382, minPrice: 320, active: true },
      { sku: "SUPPORT-PREM", unitPrice: 8_160, minPrice: 7_200, active: true },
      { sku: "SUITE-ENT", unitPrice: 0, minPrice: 0, active: true },
    ],
  },
];

/* ----------------------------- pricing rules ----------------------------- */

export const SAMPLE_PRICING_RULES: PricingRuleInput[] = [
  {
    name: "Three-year commitment",
    description: "A term discount that never undercuts a better one the rep already gave.",
    scope: "line",
    condition: "termMonths >= 36 && isRecurring == 1",
    target: "discountPercent",
    expression: "max(discountPercent, 8)",
    appliesToFamily: "",
    appliesToSku: "",
    priority: 10,
    active: true,
    message: "3-year commitment",
  },
  {
    name: "Training group rate",
    description: "Ten or more training seats are sold at a fixed group rate.",
    scope: "line",
    condition: "quantity >= 10",
    target: "discountPercent",
    expression: "max(discountPercent, 20)",
    appliesToFamily: "",
    appliesToSku: "TRAIN",
    priority: 20,
    active: true,
    message: "Group rate",
  },
  {
    name: "Enterprise rebate",
    description: "A rebate on large deals, applied to the quote rather than to any one line.",
    scope: "quote",
    condition: "subtotal >= 250000",
    target: "discountPercent",
    expression: "max(discountPercent, 5)",
    appliesToFamily: "",
    appliesToSku: "",
    priority: 30,
    active: true,
    message: "Enterprise rebate",
  },
];

/* ---------------------------- approval rules ----------------------------- */

/**
 * The approver is the account installing the sample, so the ladder can
 * actually be walked in a demo: submit a quote, approve it as yourself, send
 * it. Point them at real colleagues once there are some.
 *
 * Each rule asks one person here for the same reason — a quorum of two cannot
 * be met by one account, and a sample you cannot finish is worse than a simple
 * one. The shape is what the editor is for: add a second approver to the VP
 * rule and set it to two, and the demo turns into a board.
 */
export const sampleApprovalRules = (approverEmail: string): ApprovalRuleInput[] => [
  {
    name: "Sales manager",
    scope: "quote",
    metric: "discountPercent",
    comparator: ">",
    threshold: 15,
    condition: "",
    level: 1,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "Discounts past 15% need a manager.",
    active: true,
  },
  {
    name: "Deal desk — product ceiling",
    scope: "line",
    metric: "floorBreach",
    comparator: ">",
    threshold: 0,
    condition: "",
    level: 1,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "A line was discounted past the ceiling its own product allows.",
    active: true,
  },
  {
    name: "VP Sales",
    scope: "quote",
    metric: "discountPercent",
    comparator: ">",
    threshold: 30,
    condition: "",
    level: 2,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "Discounts past 30% need the VP.",
    active: true,
  },
  {
    name: "Finance — thin margin",
    scope: "quote",
    metric: "marginPercent",
    comparator: "<",
    threshold: 45,
    condition: "",
    level: 2,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "Margin below 45% needs finance.",
    active: true,
  },
  {
    name: "Finance — services heavy",
    scope: "quote",
    metric: "custom",
    comparator: ">",
    threshold: 0,
    condition: "oneTimeTotal > recurringTotal * 0.5 && oneTimeTotal > 20000",
    level: 2,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "Services are more than half the subscription value.",
    active: true,
  },
];

/* -------------------------------- accounts ------------------------------- */

export const SAMPLE_ACCOUNTS: AccountInput[] = [
  {
    name: "Harbour Logistics",
    industry: "Transport and logistics",
    website: "https://harbour.example.com",
    contactName: "Dana Okafor",
    contactEmail: "dana.okafor@harbour.example.com",
    contactPhone: "+1 415 555 0142",
    billingAddress: {
      line1: "1200 Embarcadero",
      line2: "Suite 400",
      city: "San Francisco",
      state: "CA",
      postalCode: "94107",
      country: "United States",
    },
    currency: "USD",
    priceBookId: "",
    paymentTerms: "Net 30",
    defaultDiscountPercent: 0,
    taxExempt: false,
    taxPercent: 8.5,
    notes: "Renewal in Q3. Evaluating a move to Enterprise for the residency controls.",
  },
  {
    name: "Meridian Health",
    industry: "Healthcare",
    website: "https://meridian.example.org",
    contactName: "Sam Ellery",
    contactEmail: "s.ellery@meridian.example.org",
    contactPhone: "+1 617 555 0199",
    billingAddress: {
      line1: "88 Longwood Avenue",
      line2: "",
      city: "Boston",
      state: "MA",
      postalCode: "02115",
      country: "United States",
    },
    currency: "USD",
    priceBookId: "",
    paymentTerms: "Net 45",
    defaultDiscountPercent: 5,
    taxExempt: true,
    taxPercent: 0,
    notes: "Tax exempt — certificate on file. Procurement requires two quotes on every renewal.",
  },
];

/* --------------------------- proposal templates -------------------------- */

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{{quote.name}} — {{quote.number}}</title>
    <style>
      body { font: 15px/1.55 -apple-system, Segoe UI, Roboto, sans-serif; color: #18181b; margin: 0; padding: 48px; }
      header { display: flex; justify-content: space-between; align-items: start; border-bottom: 2px solid #18181b; padding-bottom: 16px; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .muted { color: #71717a; font-size: 13px; }
      .parties { display: flex; gap: 48px; margin: 28px 0; }
      table { border-collapse: collapse; width: 100%; margin-top: 8px; }
      th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #71717a; border-bottom: 1px solid #e4e4e7; padding: 8px 10px; }
      td { padding: 10px; border-bottom: 1px solid #f4f4f5; }
      th:nth-child(n+3), td:nth-child(n+3) { text-align: right; white-space: nowrap; }
      .totals { margin-left: auto; width: 320px; margin-top: 20px; }
      .totals td { border: 0; padding: 4px 10px; }
      .totals tr:last-child td { border-top: 2px solid #18181b; font-weight: 600; font-size: 17px; padding-top: 10px; }
      footer { margin-top: 40px; border-top: 1px solid #e4e4e7; padding-top: 16px; }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>{{quote.name}}</h1>
        <div class="muted">Quote {{quote.number}} · revision {{quote.version}} · {{quote.date}}</div>
      </div>
      <div class="muted">Valid until <strong>{{quote.validUntil}}</strong></div>
    </header>

    <div class="parties">
      <div>
        <div class="muted">Prepared for</div>
        <strong>{{customer.name}}</strong><br />
        {{customer.contactName}}<br />
        {{customer.address}}
      </div>
      <div>
        <div class="muted">Prepared by</div>
        <strong>{{seller.name}}</strong><br />
        {{seller.email}}<br />
        Terms: {{customer.paymentTerms}}
      </div>
    </div>

    <table>
      <thead>
        <tr><th>Item</th><th>Billing</th><th>Qty</th><th>Unit</th><th>Total</th></tr>
      </thead>
      <tbody>
        {{#lines}}<tr>
          <td><strong>{{line.name}}</strong><div class="muted">{{line.options}}{{line.description}}</div></td>
          <td class="muted">{{line.billing}}</td>
          <td>{{line.quantity}}</td>
          <td>{{line.unitPrice}}</td>
          <td>{{line.total}}</td>
        </tr>{{/lines}}
      </tbody>
    </table>

    <table class="totals">
      <tr><td class="muted">List</td><td>{{totals.listTotal}}</td></tr>
      <tr><td class="muted">Discount ({{totals.discountPercent}})</td><td>−{{totals.discount}}</td></tr>
      <tr><td class="muted">Shipping</td><td>{{totals.shipping}}</td></tr>
      <tr><td class="muted">Tax</td><td>{{totals.tax}}</td></tr>
      <tr><td>Total ({{quote.termMonths}} months)</td><td>{{totals.grandTotal}}</td></tr>
    </table>

    <footer>
      <p>{{quote.notes}}</p>
      <p class="muted">Recurring charges shown across the full {{quote.termMonths}}-month term ({{totals.mrr}} per month). Pricing is valid until {{quote.validUntil}}.</p>
    </footer>
  </body>
</html>`;

const MARKDOWN_TEMPLATE = `# {{quote.name}}

**Quote {{quote.number}}** · revision {{quote.version}} · {{quote.date}}
Valid until **{{quote.validUntil}}**

| Prepared for | Prepared by |
| --- | --- |
| {{customer.name}}<br>{{customer.contactName}}<br>{{customer.contactEmail}} | {{seller.name}}<br>{{seller.email}} |

## Items

{{lines.table}}

## Totals

| | |
| --- | --- |
| List | {{totals.listTotal}} |
| Discount ({{totals.discountPercent}}) | −{{totals.discount}} |
| Tax | {{totals.tax}} |
| **Total ({{quote.termMonths}} months)** | **{{totals.grandTotal}}** |

Monthly recurring: {{totals.mrr}} · Annual recurring: {{totals.arr}} · One-time: {{totals.oneTime}}

{{quote.notes}}

Payment terms: {{customer.paymentTerms}}`;

const TEXT_TEMPLATE = `{{quote.name}}
Quote {{quote.number}} (rev {{quote.version}}), {{quote.date}}
Valid until {{quote.validUntil}}

FOR
{{customer.name}}
{{customer.contactName}}
{{customer.address}}

FROM
{{seller.name}} <{{seller.email}}>

ITEMS
{{lines.table}}

List .......... {{totals.listTotal}}
Discount ...... -{{totals.discount}} ({{totals.discountPercent}})
Tax ........... {{totals.tax}}
TOTAL ......... {{totals.grandTotal}}  over {{quote.termMonths}} months

{{quote.notes}}

Payment terms: {{customer.paymentTerms}}`;

/* ----------------------------- PDF templates ----------------------------- */

/**
 * The PDF a customer receives, in two registers.
 *
 * `starterPdfTemplate()` is the full proposal — addresses, line items with
 * their configured options, a totals panel and signature lines. The compact
 * one below is the same quote as a one-page summary: no signature block, no
 * notes, tighter type. Between them they show both ends of what the block
 * format can do, which is the point of shipping two rather than one.
 */
const PDF_SUMMARY: PdfTemplate = {
  page: {
    size: "A4",
    margins: { top: 48, right: 44, bottom: 48, left: 44 },
    family: "helvetica",
    fontSize: 9.5,
    textColor: "#18181b",
    mutedColor: "#71717a",
    accentColor: "#1d4ed8",
  },
  blocks: [
    { type: "heading", text: "Quote {{quote.number}}", size: 16, color: "#1d4ed8" },
    { type: "text", text: "{{quote.name}}", size: 11, spaceAfter: 2 },
    {
      type: "text",
      text: "Prepared for {{customer.name}} · valid until {{quote.validUntil}} · {{quote.termMonths}}-month term",
      size: 8.5,
      color: "#71717a",
    },
    { type: "divider", color: "#1d4ed8", thickness: 1.5 },
    { type: "spacer", height: 4 },
    {
      type: "lineItems",
      columns: [
        { field: "name", header: "Item", width: 6 },
        { field: "quantity", header: "Qty", width: 1, align: "right" },
        { field: "unitPrice", header: "Unit", width: 1.8, align: "right" },
        { field: "discountPercent", header: "Disc.", width: 1.2, align: "right" },
        { field: "total", header: "Total", width: 2.2, align: "right" },
      ],
      showOptions: true,
      showDescription: false,
      headerFill: "#eff6ff",
      fontSize: 9,
    },
    {
      type: "totals",
      width: 230,
      rows: [
        { label: "Subtotal", field: "subtotal" },
        { label: "Discount", field: "totalDiscount", omitIfZero: true },
        { label: "Tax", field: "taxAmount", omitIfZero: true },
        { label: "Total", field: "grandTotal", emphasis: true },
      ],
    },
    { type: "spacer", height: 6 },
    {
      type: "fields",
      rows: [
        { label: "Monthly recurring", value: "{{totals.mrr}}" },
        { label: "Annual recurring", value: "{{totals.arr}}" },
        { label: "One-time charges", value: "{{totals.oneTime}}" },
        { label: "Total contract value", value: "{{totals.tcv}}" },
      ],
    },
  ],
  footer: { text: "{{quote.number}} · prepared by {{seller.email}}", showPageNumbers: true },
};

export const SAMPLE_TEMPLATES: { name: string; format: ProposalFormat; body: string }[] = [
  { name: "Proposal — PDF", format: "pdf", body: JSON.stringify(starterPdfTemplate()) },
  { name: "Quote summary — PDF", format: "pdf", body: JSON.stringify(PDF_SUMMARY) },
  { name: "Proposal — letterhead", format: "html", body: HTML_TEMPLATE },
  { name: "Proposal — Markdown", format: "markdown", body: MARKDOWN_TEMPLATE },
  { name: "Quote summary — plain text", format: "text", body: TEXT_TEMPLATE },
];

/** What a brand-new template starts as, so the tokens are discoverable. */
export const STARTER_TEMPLATE_BODY = MARKDOWN_TEMPLATE;

/**
 * The quote the sample installs, written against SKUs rather than ids — the
 * seeder resolves them once the products exist.
 *
 * It is built to trip the approval ladder: 40 Enterprise users at 22% off,
 * with services, lands past the manager's 15% and drags the deal desk in on
 * the training line.
 */
export const SAMPLE_QUOTE = {
  name: "Harbour Logistics — platform expansion",
  accountName: "Harbour Logistics",
  termMonths: 36,
  notes: "Pricing assumes a 36-month commitment and a single production environment.",
  internalNotes: "Dana wants the residency controls; the training seats are the negotiable part.",
  lines: [
    { sku: "PLAT-CORE", quantity: 40, discountPercent: 22, options: ["enterprise", "sso", "audit_log"] },
    { sku: "STOR", quantity: 60, discountPercent: 10, options: [] },
    { sku: "ONBOARD", quantity: 1, discountPercent: 0, options: ["standard_scope"] },
    { sku: "TRAIN", quantity: 12, discountPercent: 0, options: [] },
  ],
} as const;

/* ----------------------------- the specimen ------------------------------ */

/**
 * A fully priced quote to design templates against.
 *
 * Built by running the real pricing engine over products defined right here,
 * rather than hand-written — a specimen whose totals do not add up is exactly
 * the thing a template preview must never show. It carries the awkward cases
 * on purpose: a long configured product name, an options line, a one-time
 * services line and a discount deep enough to be worth printing.
 */
export function specimenQuote(): Quote {
  const product = (overrides: Partial<Product>): Product => ({
    id: overrides.sku ?? "prd",
    sku: "SKU",
    name: "Product",
    description: "",
    family: "",
    chargeType: "recurring",
    billingPeriod: "monthly",
    unitOfMeasure: "unit",
    listPrice: 0,
    cost: 0,
    currency: "USD",
    active: true,
    minQuantity: 1,
    maxQuantity: 0,
    floorDiscountPercent: 0,
    optionGroups: [],
    rules: [],
    components: [],
    volumeTiers: [],
    attributes: {},
    ownerId: "",
    sharedWith: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  });

  const products = [
    product({
      sku: "PLAT-CORE",
      name: "Nimbus Platform",
      unitOfMeasure: "user",
      listPrice: 120,
      cost: 28,
      optionGroups: [
        {
          id: "g",
          key: "edition",
          name: "Edition",
          select: "one",
          required: true,
          options: [
            { id: "o1", key: "enterprise", name: "Enterprise", priceDelta: 0, priceFactor: 1.8 },
            { id: "o2", key: "sso", name: "SSO and SCIM", priceDelta: 12 },
          ],
        },
      ],
    }),
    product({ sku: "STOR", name: "Managed Storage", unitOfMeasure: "TB", listPrice: 18, cost: 6 }),
    product({
      sku: "ONBOARD",
      name: "Onboarding and migration",
      chargeType: "one-time",
      unitOfMeasure: "engagement",
      listPrice: 12_000,
      cost: 6_500,
    }),
  ];

  const line = (productId: string, quantity: number, discountPercent: number, options: string[], sortOrder: number) => ({
    id: `ln_${productId}`,
    productId,
    quantity,
    discountPercent,
    unitPriceOverride: null,
    selectedOptions: options,
    termMonths: 0,
    description: "",
    parentId: null,
    sortOrder,
  });

  const priced = priceQuote(
    [
      line("PLAT-CORE", 40, 22, ["enterprise", "sso"], 0),
      line("STOR", 60, 10, [], 1),
      line("ONBOARD", 1, 0, [], 2),
    ],
    { currency: "USD", termMonths: 36, discountPercent: 0, taxPercent: 8.5, shipping: 0 },
    { products: new Map(products.map(entry => [entry.id, entry])), priceBook: null, rules: [] },
  );

  const today = new Date();
  const validUntil = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  return {
    id: "qte_specimen",
    number: "Q-2026-0042",
    name: "Harbour Logistics — platform expansion",
    status: "sent",
    version: 1,
    supersedesId: null,
    customer: {
      accountId: "acc_specimen",
      name: "Harbour Logistics",
      contactName: "Dana Okafor",
      contactEmail: "dana.okafor@harbour.example.com",
      contactPhone: "+1 415 555 0142",
      billingAddress: {
        line1: "1200 Embarcadero",
        line2: "Suite 400",
        city: "San Francisco",
        state: "CA",
        postalCode: "94107",
        country: "United States",
      },
      paymentTerms: "Net 30",
    },
    priceBookId: "",
    currency: "USD",
    termMonths: 36,
    discountPercent: 0,
    taxPercent: 8.5,
    shipping: 0,
    validUntil: validUntil.toISOString().slice(0, 10),
    notes: "Pricing assumes a 36-month commitment and a single production environment.",
    internalNotes: "",
    lines: priced.lines,
    totals: priced.totals,
    approvals: [],
    approverIds: [],
    ownerId: "",
    sharedWith: [],
    sentAt: today.toISOString(),
    decidedAt: "",
    createdAt: today.toISOString(),
    updatedAt: today.toISOString(),
  };
}
