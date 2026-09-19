/**
 * The workspace file: one JSON document holding everything an account has —
 * the catalogue, the customers, the proposal templates, the quotes, the
 * receivables ledger, and the preferences.
 *
 * Where a `*.cpq.json` file moves a catalogue between instances, this moves
 * the whole workspace: a backup to keep in a repository, the thing you hand
 * someone standing up their own instance, and the answer to "can I get my data
 * out" that does not involve a support ticket.
 *
 * The `catalog` key is itself a complete `*.cpq.json` document, built by the
 * same `buildCatalogFile` the catalogue download uses, so the catalogue lifted
 * out of a workspace bundle imports through the ordinary import endpoint
 * unchanged and the two exports can never disagree.
 *
 * Quotes *are* included, unlike the generated data the tool this grew out of
 * left behind. A quote is a few kilobytes and it is the point of the app —
 * an export that dropped them would be a backup of the filing cabinet without
 * the contracts.
 *
 * So are invoices, and with their ledgers. An export that kept what you
 * offered but not what you are owed would be the half of the filing cabinet
 * nobody chases, and a payment that exists only in this app is a payment you
 * cannot prove you received.
 */
import { buildCatalogFile, type CatalogFile } from "./catalogFile";
import type { Preferences } from "./preferences";
import type {
  Account,
  ApprovalRule,
  Invoice,
  PriceBook,
  PricingRule,
  Product,
  ProposalTemplate,
  Quote,
} from "./types";

export const WORKSPACE_FILE_KIND = "cpq/workspace";
export const WORKSPACE_FILE_VERSION = 1;

/** Marks the records that came from someone else's account. */
type Shared = { sharedWithMe?: true };

export type WorkspaceTemplateEntry = Pick<ProposalTemplate, "name" | "format" | "body"> & Shared;

export type WorkspaceAccountEntry = Omit<Account, "id" | "ownerId" | "createdAt" | "updatedAt">;

/**
 * A quote as exported: everything except the ownership plumbing. Lines and
 * totals are kept exactly as they were priced — a quote is a record of what
 * was offered, and re-deriving it from a catalogue that has since changed
 * would be a different document wearing the same number.
 */
export type WorkspaceQuoteEntry = Omit<Quote, "ownerId" | "sharedWith" | "approverIds"> & Shared;

/**
 * An invoice as exported: the document, its lines and its whole ledger.
 *
 * Derived fields are conspicuously absent, because there are none stored to
 * export — an invoice's status and its aging are worked out from what is here
 * by `src/lib/receivable.ts`, so a file read back in a year ages itself
 * against that day rather than carrying yesterday's answer.
 */
export type WorkspaceInvoiceEntry = Omit<Invoice, "ownerId" | "sharedWith"> & Shared;

export type WorkspaceFile = {
  kind: typeof WORKSPACE_FILE_KIND;
  version: number;
  exportedAt: string;
  /** The account the export was taken from. */
  exportedBy: string;
  preferences: Preferences;
  catalog: CatalogFile;
  accounts: WorkspaceAccountEntry[];
  proposalTemplates: WorkspaceTemplateEntry[];
  quotes: WorkspaceQuoteEntry[];
  invoices: WorkspaceInvoiceEntry[];
};

export type WorkspaceInput = {
  /** Whose export this is — decides what counts as "shared with me". */
  ownerId: string;
  email: string;
  products: Product[];
  priceBooks: PriceBook[];
  pricingRules: PricingRule[];
  approvalRules: ApprovalRule[];
  accounts: Account[];
  templates: ProposalTemplate[];
  quotes: Quote[];
  invoices: Invoice[];
  preferences: Preferences;
};

export function buildWorkspaceFile(input: WorkspaceInput): WorkspaceFile {
  const shared = (record: { ownerId: string }): Shared =>
    record.ownerId === input.ownerId ? {} : { sharedWithMe: true as const };

  return {
    kind: WORKSPACE_FILE_KIND,
    version: WORKSPACE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: input.email,
    preferences: input.preferences,
    catalog: buildCatalogFile({
      name: `${input.email}'s catalogue`,
      products: input.products,
      priceBooks: input.priceBooks,
      pricingRules: input.pricingRules,
      approvalRules: input.approvalRules,
    }),
    accounts: input.accounts.map(({ id, ownerId, createdAt, updatedAt, ...rest }) => rest),
    proposalTemplates: input.templates.map(template => ({
      name: template.name,
      format: template.format,
      body: template.body,
      ...shared(template),
    })),
    quotes: input.quotes.map(quote => {
      const { ownerId, sharedWith, approverIds, ...rest } = quote;
      return { ...rest, ...shared(quote) };
    }),
    invoices: input.invoices.map(invoice => {
      const { ownerId, sharedWith, ...rest } = invoice;
      return { ...rest, ...shared(invoice) };
    }),
  };
}

export const serializeWorkspaceFile = (input: WorkspaceInput): string =>
  JSON.stringify(buildWorkspaceFile(input), null, 2);

/** "cpq-workspace-2026-09-17.json" — sortable, and obvious a year later. */
export function workspaceFileName(date = new Date()): string {
  return `cpq-workspace-${date.toISOString().slice(0, 10)}.json`;
}
