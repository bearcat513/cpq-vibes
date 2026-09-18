/**
 * Installing the worked example from `src/lib/samples.ts`.
 *
 * One call fills an empty account with a catalogue, the policy around it, two
 * customers, three proposal templates and a quote that actually trips the
 * approval ladder — so the first thing a new account sees is the app doing its
 * job rather than eight empty lists.
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
  SAMPLE_PRICE_BOOKS,
  SAMPLE_PRICING_RULES,
  SAMPLE_PRODUCTS,
  SAMPLE_QUOTE,
  SAMPLE_TEMPLATES,
  sampleApprovalRules,
} from "../lib/samples";
import { defaultSelection } from "../lib/configurator";
import { readAccount, readApprovalRule, readPriceBook, readPricingRule, readProduct, readProposalTemplate, localId } from "../lib/validate";
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
  listPriceBooks,
  listPricingRules,
  listProducts,
  listProposalTemplates,
} from "./db";
import { createPricedQuote } from "./quotes";
import { ApiError } from "./http";

export type SeedReport = {
  created: Record<string, number>;
  skipped: Record<string, number>;
  /** The quote the sample built, when it built one. */
  quoteId: string | null;
  notes: string[];
};

/**
 * `approverEmail` is the installing account's own address, so the approval
 * ladder can be walked end to end by one person in a demo. The sample's own
 * documentation says to point it at real colleagues afterwards.
 */
export async function installSample(token: string, approverEmail: string, validDays: number): Promise<SeedReport> {
  const created: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const notes: string[] = [];

  const count = (bucket: Record<string, number>, key: string) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  /* ----------------------------- the catalogue ---------------------------- */

  const existingProducts = await listProducts(token);
  const haveSku = new Set(existingProducts.map(product => product.sku));

  for (const sample of SAMPLE_PRODUCTS) {
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

  for (const sample of SAMPLE_PRICE_BOOKS) {
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
  for (const sample of SAMPLE_PRICING_RULES) {
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
  for (const sample of sampleApprovalRules(approverEmail)) {
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

  for (const sample of SAMPLE_ACCOUNTS) {
    const parsed = readAccount(sample);
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.name}): ${parsed.error}`, 500);
    if (haveAccount.has(parsed.value.name.toLowerCase())) {
      count(skipped, "accounts");
      continue;
    }
    const account = await createAccount(token, parsed.value);
    haveAccount.set(account.name.toLowerCase(), account);
    count(created, "accounts");
  }

  /* ------------------------------- documents ------------------------------ */

  const haveTemplate = new Set((await listProposalTemplates(token)).map(template => template.name.toLowerCase()));
  for (const sample of SAMPLE_TEMPLATES) {
    const parsed = readProposalTemplate(sample);
    if (!parsed.ok) throw new ApiError(`The built-in sample is invalid (${sample.name}): ${parsed.error}`, 500);
    if (haveTemplate.has(parsed.value.name.toLowerCase())) {
      count(skipped, "proposalTemplates");
      continue;
    }
    await createProposalTemplate(token, parsed.value);
    count(created, "proposalTemplates");
  }

  /* -------------------------------- a quote ------------------------------- */

  // Only when the products it needs were actually installed by this run or a
  // previous one — a sample quote referencing nothing is worse than none.
  const catalogue = new Map((await listProducts(token)).map(product => [product.sku, product]));
  const account = haveAccount.get(SAMPLE_QUOTE.accountName.toLowerCase()) ?? null;

  const lines: PriceableLine[] = SAMPLE_QUOTE.lines
    .map((sample, index): PriceableLine | null => {
      const product = catalogue.get(sample.sku);
      if (!product) return null;
      return {
        id: localId("ln"),
        productId: product.id,
        quantity: sample.quantity,
        discountPercent: sample.discountPercent,
        unitPriceOverride: null,
        // Fall back to the product's own defaults if the sample named options
        // that the installed product does not have.
        selectedOptions: sample.options.length ? [...sample.options] : defaultSelection(product),
        termMonths: 0,
        description: "",
        parentId: null,
        sortOrder: index,
      };
    })
    .filter((line): line is PriceableLine => line !== null);

  let quoteId: string | null = null;
  if (lines.length && account) {
    const result = await createPricedQuote(
      token,
      {
        name: SAMPLE_QUOTE.name,
        accountId: account.id,
        priceBookId: "",
        currency: "USD",
        termMonths: SAMPLE_QUOTE.termMonths,
        discountPercent: 0,
        taxPercent: account.taxPercent,
        shipping: 0,
        validUntil: "",
        notes: SAMPLE_QUOTE.notes,
        internalNotes: SAMPLE_QUOTE.internalNotes,
      },
      lines,
      validDays,
    );
    quoteId = result.quote.id;
    count(created, "quotes");
    notes.push(
      `“${result.quote.name}” is deep enough to need approval — submit it and you will see the ladder work.`,
    );
  } else if (!account) {
    notes.push("The sample quote was skipped: its customer already exists under a different name.");
  }

  return { created, skipped, quoteId, notes };
}
