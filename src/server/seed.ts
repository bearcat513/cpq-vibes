/**
 * Installing a worked example: `src/lib/samples.ts` or
 * `src/lib/samplesHealthcare.ts`.
 *
 * One call fills an empty account with a catalogue, the policy around it,
 * customers and quotes that actually trip the approval ladder — and, in the
 * first set, seven proposal templates and a receivables book spread across the
 * aging — so the first thing a new account sees is the app doing its job rather
 * than nine empty lists.
 *
 * Everything goes in through the same validators and the same pricing engine
 * as anything else. The sample has no privileged path: if it would not import
 * as a file, it does not install either.
 *
 * It is additive and idempotent by SKU and name — running it twice does not
 * produce two catalogues, and it never overwrites something you have edited.
 * Anything that already exists is left exactly as it is and reported as
 * skipped.
 */
import {
  SAMPLE_ACCOUNTS,
  SAMPLE_INVOICES,
  SAMPLE_PRICE_BOOKS,
  SAMPLE_PRICING_RULES,
  SAMPLE_PRODUCTS,
  SAMPLE_QUOTE,
  SAMPLE_TEMPLATES,
  sampleApprovalRules,
  type SampleSetName,
} from "../lib/samples";
import {
  HEALTHCARE_ACCOUNTS,
  HEALTHCARE_PRICE_BOOKS,
  HEALTHCARE_PRICING_RULES,
  HEALTHCARE_PRODUCTS,
  HEALTHCARE_QUOTES,
  healthcareApprovalRules,
  type SampleQuote,
  type SampleQuoteStage,
} from "../lib/samplesHealthcare";
import { defaultSelection } from "../lib/configurator";
import { round } from "../lib/money";
import {
  readAccount,
  readApprovalRule,
  readPriceBook,
  readPricingRule,
  readProduct,
  readProposalTemplate,
  localId,
  type AccountInput,
  type ApprovalRuleInput,
  type PriceBookInput,
  type PricingRuleInput,
  type ProductInput,
} from "../lib/validate";
import type { PriceableLine } from "../lib/pricing";
import {
  createAccount,
  createApprovalRule,
  createPriceBook,
  createPricingRule,
  createProduct,
  createProposalTemplate,
  listAccounts,
  listApprovalRules,
  listInvoices,
  listPriceBooks,
  listPricingRules,
  listProducts,
  listProposalTemplates,
  listQuotes,
} from "./db";
import { createPricedQuote, decideQuote, submitQuote, transitionQuote } from "./quotes";
import { createBlankInvoice, discardInvoice, issueInvoice, recordPayment } from "./invoices";
import { addDays, today } from "../lib/receivable";
import { ApiError } from "./http";

export type SeedReport = {
  created: Record<string, number>;
  skipped: Record<string, number>;
  /** The quote the sample built, when it built one. */
  quoteId: string | null;
  notes: string[];
};

type SampleSet = {
  products: ProductInput[];
  priceBooks: PriceBookInput[];
  pricingRules: PricingRuleInput[];
  approvalRules: (approverEmail: string) => ApprovalRuleInput[];
  /** `priceBookName` points the customer at a book installed by the same set. */
  accounts: (AccountInput & { priceBookName?: string })[];
  templates: typeof SAMPLE_TEMPLATES;
  quotes: readonly SampleQuote[];
  invoices: typeof SAMPLE_INVOICES;
};

const SETS: Record<SampleSetName, SampleSet> = {
  nimbus: {
    products: SAMPLE_PRODUCTS,
    priceBooks: SAMPLE_PRICE_BOOKS,
    pricingRules: SAMPLE_PRICING_RULES,
    approvalRules: sampleApprovalRules,
    accounts: SAMPLE_ACCOUNTS,
    templates: SAMPLE_TEMPLATES,
    quotes: [
      {
        ...SAMPLE_QUOTE,
        note: `“${SAMPLE_QUOTE.name}” is deep enough to need approval — submit it and you will see the ladder work.`,
      },
    ],
    invoices: SAMPLE_INVOICES,
  },
  healthcare: {
    products: HEALTHCARE_PRODUCTS,
    priceBooks: HEALTHCARE_PRICE_BOOKS,
    pricingRules: HEALTHCARE_PRICING_RULES,
    approvalRules: healthcareApprovalRules,
    accounts: HEALTHCARE_ACCOUNTS,
    templates: [],
    quotes: HEALTHCARE_QUOTES,
    invoices: [],
  },
};

/**
 * Walks a new quote through the ordinary lifecycle to where the sample leaves
 * it. Each step is the one a person would take, so this cannot reach a state
 * the app would refuse. The approval rules name the installer, which is what
 * lets one account answer them — unless the workspace already had rules naming
 * somebody else, and then the quote stops where it got to, which is true.
 */
async function walkQuote(token: string, id: string, approverEmail: string, stage: SampleQuoteStage): Promise<void> {
  if (stage === "draft") return;
  let { quote } = await submitQuote(token, id);
  if (stage === "in_review") return;

  while (quote.status === "in_review") {
    ({ quote } = await decideQuote(token, id, approverEmail, "approved", "Approved as part of the worked example."));
  }
  if (stage === "approved") return;

  await transitionQuote(token, id, "sent");
  if (stage === "accepted") await transitionQuote(token, id, "accepted");
}

/**
 * `approverEmail` is the installing account's own address, so the approval
 * ladder can be walked end to end by one person in a demo. The sample's own
 * documentation says to point it at real colleagues afterwards.
 */
export async function installSample(
  token: string,
  approverEmail: string,
  validDays: number,
  setName: SampleSetName = "nimbus",
): Promise<SeedReport> {
  const set = SETS[setName];
  const created: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const notes: string[] = [];

  const count = (bucket: Record<string, number>, key: string) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  /* ----------------------------- the catalogue ---------------------------- */

  const existingProducts = await listProducts(token);
  const haveSku = new Set(existingProducts.map(product => product.sku));

  // Pricing and approval rules apply to the whole workspace, so a second
  // catalogue's quotes are also weighed by whatever policy was already here.
  if (existingProducts.length && !set.products.some(sample => haveSku.has(sample.sku))) {
    notes.push("This workspace already had a catalogue. Its pricing and approval rules also apply to the new quotes, so their totals and approvals may differ from a clean install.");
  }

  for (const sample of set.products) {
    const parsed = readProduct(sample);
    // A sample that does not validate is this app's bug, not the caller's.
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.sku}): ${parsed.error}`, 500);

    if (haveSku.has(parsed.value.sku)) {
      count(skipped, "products");
      continue;
    }
    await createProduct(token, parsed.value);
    haveSku.add(parsed.value.sku);
    count(created, "products");
  }

  const existingBooks = await listPriceBooks(token);
  const haveBook = new Set(existingBooks.map(book => book.name.toLowerCase()));
  // A second default book would quietly change which prices new quotes use.
  const haveDefault = existingBooks.some(book => book.isDefault);

  for (const sample of set.priceBooks) {
    const parsed = readPriceBook(sample);
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.name}): ${parsed.error}`, 500);

    if (haveBook.has(parsed.value.name.toLowerCase())) {
      count(skipped, "priceBooks");
      continue;
    }
    if (parsed.value.isDefault && haveDefault) {
      parsed.value.isDefault = false;
      notes.push(`"${parsed.value.name}" was installed without the default flag — you already have a default book.`);
    }
    await createPriceBook(token, parsed.value);
    haveBook.add(parsed.value.name.toLowerCase());
    count(created, "priceBooks");
  }

  /* -------------------------------- policy -------------------------------- */

  const havePricingRule = new Set((await listPricingRules(token)).map(rule => rule.name.toLowerCase()));
  for (const sample of set.pricingRules) {
    const parsed = readPricingRule(sample);
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.name}): ${parsed.error}`, 500);
    if (havePricingRule.has(parsed.value.name.toLowerCase())) {
      count(skipped, "pricingRules");
      continue;
    }
    await createPricingRule(token, parsed.value);
    count(created, "pricingRules");
  }

  const haveApprovalRule = new Set((await listApprovalRules(token)).map(rule => rule.name.toLowerCase()));
  for (const sample of set.approvalRules(approverEmail)) {
    const parsed = readApprovalRule(sample);
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.name}): ${parsed.error}`, 500);
    if (haveApprovalRule.has(parsed.value.name.toLowerCase())) {
      count(skipped, "approvalRules");
      continue;
    }
    await createApprovalRule(token, parsed.value);
    count(created, "approvalRules");
  }

  if (created.approvalRules) {
    notes.push(
      `The sample approval rules all name you (${approverEmail}) as the approver, so you can walk a quote ` +
        "through the whole ladder on your own. Point them at colleagues once there are some.",
    );
  }

  /* ------------------------------- customers ------------------------------ */

  const existingAccounts = await listAccounts(token);
  const haveAccount = new Map(existingAccounts.map(account => [account.name.toLowerCase(), account]));

  const bookId = new Map((await listPriceBooks(token)).map(book => [book.name.toLowerCase(), book.id]));

  for (const sample of set.accounts) {
    const parsed = readAccount(sample);
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.name}): ${parsed.error}`, 500);
    if (haveAccount.has(parsed.value.name.toLowerCase())) {
      count(skipped, "accounts");
      continue;
    }
    parsed.value.priceBookId = bookId.get(sample.priceBookName?.toLowerCase() ?? "") ?? "";
    const account = await createAccount(token, parsed.value);
    haveAccount.set(account.name.toLowerCase(), account);
    count(created, "accounts");
  }

  /* ------------------------------- documents ------------------------------ */

  const haveTemplate = new Set((await listProposalTemplates(token)).map(template => template.name.toLowerCase()));
  for (const sample of set.templates) {
    const parsed = readProposalTemplate(sample);
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.name}): ${parsed.error}`, 500);
    if (haveTemplate.has(parsed.value.name.toLowerCase())) {
      count(skipped, "proposalTemplates");
      continue;
    }
    await createProposalTemplate(token, parsed.value);
    count(created, "proposalTemplates");
  }

  /* --------------------------------- quotes -------------------------------- */

  // Only when the products they need were actually installed by this run or a
  // previous one — a sample quote referencing nothing is worse than none.
  const catalogue = new Map((await listProducts(token)).map(product => [product.sku, product]));
  const haveQuote = new Set((await listQuotes(token, 0)).map(quote => quote.name.toLowerCase()));
  let quoteId: string | null = null;

  for (const sample of set.quotes) {
    if (haveQuote.has(sample.name.toLowerCase())) {
      count(skipped, "quotes");
      continue;
    }

    const account = haveAccount.get(sample.accountName.toLowerCase()) ?? null;
    if (!account) {
      notes.push(`“${sample.name}” was skipped: its customer already exists under a different name.`);
      continue;
    }

    const lineIds = new Map(sample.lines.map(entry => [entry.sku, localId("ln")]));
    const lines: PriceableLine[] = sample.lines
      .map((entry, index): PriceableLine | null => {
        const product = catalogue.get(entry.sku);
        if (!product) return null;
        return {
          id: lineIds.get(entry.sku) as string,
          productId: product.id,
          quantity: entry.quantity,
          discountPercent: entry.discountPercent,
          unitPriceOverride: null,
          // Fall back to the product's own defaults if the sample named options
          // that the installed product does not have.
          selectedOptions: entry.options.length ? [...entry.options] : defaultSelection(product),
          termMonths: entry.termMonths ?? 0,
          description: entry.description ?? "",
          parentId: entry.parentSku ? (lineIds.get(entry.parentSku) ?? null) : null,
          sortOrder: index,
        };
      })
      .filter((line): line is PriceableLine => line !== null);

    if (!lines.length) continue;

    const result = await createPricedQuote(
      token,
      {
        name: sample.name,
        accountId: account.id,
        priceBookId: "",
        currency: "USD",
        termMonths: sample.termMonths,
        discountPercent: sample.discountPercent ?? 0,
        taxPercent: account.taxPercent,
        shipping: 0,
        validUntil: "",
        notes: sample.notes,
        internalNotes: sample.internalNotes,
      },
      lines,
      validDays,
    );
    quoteId ??= result.quote.id;
    count(created, "quotes");
    if (sample.note) notes.push(sample.note);

    try {
      await walkQuote(token, result.quote.id, approverEmail, sample.stage ?? "draft");
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      notes.push(`“${sample.name}” stopped short of ${sample.stage}: ${error.message}`);
    }
  }

  /* ------------------------------ receivables ----------------------------- */

  /*
   * Invoices go in through the ordinary path — raised as drafts, issued, then
   * paid against — rather than being written straight to storage with their
   * totals filled in. The sample has no privileged route, so an invoice that
   * would not reconcile through the API does not install either.
   *
   * Idempotency is by customer and PO reference, like everything above: a
   * second install finds them and leaves them alone.
   */
  const existingInvoices = await listInvoices(token);
  const invoiceSeen = new Set(
    existingInvoices.map(one => `${one.customer.name.toLowerCase()}|${one.poNumber}|${one.totals.total}`),
  );

  for (const sample of set.invoices) {
    const customer = haveAccount.get(sample.accountName.toLowerCase());
    if (!customer) {
      count(skipped, "invoices");
      continue;
    }

    const lines = sample.lines.map((entry, index) => ({
      id: localId("inl"),
      sourceLineId: null,
      sku: entry.sku,
      description: entry.description,
      quantity: entry.quantity,
      unitPrice: entry.unitPrice,
      amount: 0,
      taxPercent: customer.taxExempt ? 0 : entry.taxPercent,
      taxAmount: 0,
      sortOrder: index,
    }));

    try {
      const raised = await createBlankInvoice(
        token,
        {
          accountId: customer.id,
          quoteId: null,
          currency: customer.currency,
          issueDate: "",
          paymentTermDays: customer.paymentTermDays,
          poNumber: sample.poNumber,
          notes: sample.notes,
          internalNotes: "Part of the worked example.",
        },
        lines,
      );

      // Same customer, same reference, same money: this one is already here.
      const fingerprint = `${customer.name.toLowerCase()}|${sample.poNumber}|${raised.invoice.totals.total}`;
      if (invoiceSeen.has(fingerprint)) {
        await discardInvoice(token, raised.invoice.id);
        count(skipped, "invoices");
        continue;
      }
      invoiceSeen.add(fingerprint);

      const issued = await issueInvoice(token, raised.invoice.id, addDays(today(), -sample.issuedDaysAgo));
      count(created, "invoices");

      if (sample.paidFraction > 0) {
        const amount = round(issued.totals.total * sample.paidFraction, issued.currency);
        if (amount > 0) {
          await recordPayment(token, issued.id, {
            receivedOn: addDays(today(), -sample.paidDaysAgo),
            amount,
            method: "bank_transfer",
            reference: `FT-${sample.issuedDaysAgo}${sample.poNumber.slice(-3)}`,
            note: "",
          });
        }
      }
    } catch (error) {
      // An invoice that will not install is not worth failing the sample over.
      count(skipped, "invoices");
    }
  }

  if (created.invoices) {
    notes.push("The receivables book has one settled invoice, one a fortnight late and one badly overdue.");
  }

  return { created, skipped, quoteId, notes };
}
