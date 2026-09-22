/**
 * The browser's view of the REST API in `src/index.ts`.
 *
 * One function per endpoint, so a component never builds a URL. The session
 * rides in an httpOnly cookie the page cannot read, which is why there is no
 * token handling anywhere in here.
 */
import type { Preferences } from "./preferences";
import type { AgingReport } from "./receivable";
import type {
  Account,
  Invoice,
  InvoiceCredit,
  InvoicePayment,
  InvoiceSummary,
  ApprovalRequest,
  ApprovalRule,
  PriceBook,
  PricedLine,
  PricingRule,
  Product,
  ProposalTemplate,
  Quote,
  QuoteLineInput,
  QuoteStatus,
  QuoteSummary,
  QuoteTotals,
} from "./types";
import type {
  AccountInput,
  ApprovalRuleInput,
  CreditInput,
  InvoiceHeaderInput,
  PaymentInput,
  PriceBookInput,
  PricingRuleInput,
  ProductInput,
  ProposalTemplateInput,
} from "./validate";

/** An API failure that kept its status, so 401 can be told from 400. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError((payload as { error?: string }).error ?? `Request failed (${response.status})`, response.status);
  }
  return payload as T;
}

const send = <T>(url: string, method: string, payload?: unknown) =>
  request<T>(url, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });

/** The exact bytes a download link serves, as a string for the clipboard. */
async function fetchText(url: string, whatFailed: string): Promise<string> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    const message = (() => {
      try {
        return (JSON.parse(text) as { error?: string }).error;
      } catch {
        return undefined;
      }
    })();
    throw new Error(message ?? `${whatFailed} failed (${response.status})`);
  }
  return text;
}

/* --------------------------------- types --------------------------------- */

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  verified: boolean;
  createdAt: string;
  /** Sent with the session, so the first paint already has the right theme. */
  preferences: Preferences;
};

/** What the server will say about one record's sharing. */
export type Shares = {
  owner: string;
  sharedWith: string[];
  canShare: boolean;
};

export type Shareable = "products" | "price-books" | "quotes" | "invoices" | "proposal-templates";

/**
 * An API key, as the server will describe one after it exists.
 *
 * The secret is not here, and cannot be: only its SHA-256 is stored, so
 * `IssuedApiKey` — the response that created it — is the one shape that ever
 * carries the key itself.
 */
export type ApiKey = {
  id: string;
  name: string;
  createdAt: string;
  /** Empty when the key never expires. */
  expiresAt: string;
  /** Empty until it is first used. Written at most every few minutes. */
  lastUsedAt: string;
};

export type IssuedApiKey = ApiKey & { key: string };

export type QuoteBody = {
  name: string;
  accountId: string | null;
  priceBookId: string;
  currency: string;
  termMonths: number;
  discountPercent: number;
  taxPercent: number;
  shipping: number;
  validUntil: string;
  notes: string;
  internalNotes: string;
  lines: QuoteLineInput[];
};

export type SavedQuote = { quote: Quote; issues: string[]; warnings: string[] };

export type SubmitResult = SavedQuote & { required: ApprovalRequest[]; unresolved: string[] };

export type QuotePreview = {
  lines: PricedLine[];
  totals: QuoteTotals;
  priceBookId: string;
  issues: string[];
  warnings: string[];
  approvalsRequired: ApprovalRequest[];
  autoApproved: boolean;
};

export type ConfigureResult = {
  valid: boolean;
  selected: string[];
  optionNames: string[];
  unitDelta: number;
  unitFactor: number;
  errors: string[];
  warnings: string[];
  defaults: string[];
};

export type FormulaCheck =
  | { valid: true; references: string[]; available: string[] }
  | { valid: false; error: string; available: string[] };

export type SeedReport = {
  created: Record<string, number>;
  skipped: Record<string, number>;
  quoteId: string | null;
  notes: string[];
};

export type CatalogImportReport = {
  created: Record<string, number>;
  skipped: string[];
  warnings: string[];
};

/** Only the text formats answer with this; a PDF template answers with the PDF. */
export type RenderedDocument = {
  text: string;
  format: "html" | "markdown" | "text";
  templateId: string;
  templateName: string;
  unknownTokens: string[];
};

/** The body both invoice write endpoints take. Totals are the server's. */
export type InvoiceBody = Partial<InvoiceHeaderInput> & { lines?: unknown[] };

/** What the invoice endpoints answer with: the record, and anything worth saying. */
export type SavedInvoice = { invoice: Invoice; warnings: string[] };

/** An account, as the pickers that name a person see it. */
export type DirectoryUser = { id: string; email: string; name: string };

export type Meta = {
  url: string;
  reachable: boolean;
  accounts: number | null;
  products: number | null;
  priceBooks: number | null;
  quotes: number | null;
  invoices: number | null;
  proposalTemplates: number | null;
};

/* --------------------------------- urls ---------------------------------- */

const sharesUrl = (kind: Shareable, id: string) => `/api/${kind}/${encodeURIComponent(id)}/shares`;

const quoteExportUrl = (id: string, format: "csv" | "json") => `/api/quotes/${id}/export?format=${format}`;

const invoiceExportUrl = (id: string, format: "csv" | "json") => `/api/invoices/${id}/export?format=${format}`;

const documentUrl = (quoteId: string, templateId: string) =>
  `/api/quotes/${quoteId}/document?templateId=${encodeURIComponent(templateId)}`;

/**
 * The same document, asked for inline.
 *
 * For a PDF template this is what an `<iframe>` points at — the browser's own
 * viewer renders it, so a preview needs nothing shipped. For the text formats
 * it returns the JSON envelope instead; see `renderDocument`.
 */
const documentInlineUrl = (quoteId: string, templateId: string) => `${documentUrl(quoteId, templateId)}&inline`;

/** The same two, for an invoice rendered through an invoice template. */
const invoiceDocumentUrl = (invoiceId: string, templateId: string) =>
  `/api/invoices/${invoiceId}/document?templateId=${encodeURIComponent(templateId)}`;

const invoiceDocumentInlineUrl = (invoiceId: string, templateId: string) =>
  `${invoiceDocumentUrl(invoiceId, templateId)}&inline`;

const OPENAPI_URL = "/api/openapi.json";

const WORKSPACE_EXPORT_URL = "/api/export";
const CATALOG_EXPORT_URL = "/api/catalog/export";

/* ---------------------------------- api ---------------------------------- */

export const api = {
  /* --------------------------------- auth -------------------------------- */

  register: (payload: { email: string; password: string; name?: string }) =>
    send<{ user: SessionUser }>("/api/auth/register", "POST", payload),
  login: (payload: { email: string; password: string }) =>
    send<{ user: SessionUser }>("/api/auth/login", "POST", payload),
  logout: () => send<{ ok: true }>("/api/auth/logout", "POST"),
  me: () => request<{ user: SessionUser }>("/api/auth/me"),
  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    send<{ user: SessionUser }>("/api/auth/password", "POST", payload),

  /* --------------------------------- meta -------------------------------- */

  meta: () => request<Meta>("/api/meta"),

  /* ------------------------------- api keys ------------------------------ */

  listApiKeys: () => request<ApiKey[]>("/api/keys"),
  /** The one response that carries the key — there is no second chance to read it. */
  createApiKey: (payload: { name: string; expiresInDays?: number }) =>
    send<IssuedApiKey>("/api/keys", "POST", payload),
  deleteApiKey: (id: string) => send<{ ok: true }>(`/api/keys/${encodeURIComponent(id)}`, "DELETE"),

  /* --------------------------------- docs -------------------------------- */

  /** What `/docs` renders, and what Postman and friends import. */
  openApiUrl: OPENAPI_URL,
  openApiFileName: "cpq.openapi.json",
  openApiText: () => fetchText(OPENAPI_URL, "The OpenAPI document"),

  /** Everyone with an account here — what the approver and share pickers offer. */
  directory: () => request<{ users: DirectoryUser[]; truncated: boolean }>("/api/directory"),
  getPreferences: () => request<Preferences>("/api/preferences"),
  savePreferences: (preferences: Preferences) => send<Preferences>("/api/preferences", "PUT", preferences),

  /* ------------------------------- customers ----------------------------- */

  listAccounts: () => request<Account[]>("/api/accounts"),
  createAccount: (payload: AccountInput) => send<Account>("/api/accounts", "POST", payload),
  updateAccount: (id: string, payload: AccountInput) => send<Account>(`/api/accounts/${id}`, "PUT", payload),
  deleteAccount: (id: string) => send<{ ok: true }>(`/api/accounts/${id}`, "DELETE"),
  /** One customer's whole quote history — what the customer screen totals. */
  accountQuotes: (id: string) => request<QuoteSummary[]>(`/api/accounts/${id}/quotes`),

  /* ------------------------------- catalogue ----------------------------- */

  listProducts: () => request<Product[]>("/api/products"),
  createProduct: (payload: ProductInput) => send<Product>("/api/products", "POST", payload),
  updateProduct: (id: string, payload: ProductInput) => send<Product>(`/api/products/${id}`, "PUT", payload),
  deleteProduct: (id: string) => send<{ ok: true }>(`/api/products/${id}`, "DELETE"),
  configure: (id: string, payload: { selectedOptions: string[]; quantity: number; termMonths: number }) =>
    send<ConfigureResult>(`/api/products/${id}/configure`, "POST", payload),

  listPriceBooks: () => request<PriceBook[]>("/api/price-books"),
  createPriceBook: (payload: PriceBookInput) => send<PriceBook>("/api/price-books", "POST", payload),
  updatePriceBook: (id: string, payload: PriceBookInput) => send<PriceBook>(`/api/price-books/${id}`, "PUT", payload),
  deletePriceBook: (id: string) => send<{ ok: true }>(`/api/price-books/${id}`, "DELETE"),

  listPricingRules: () => request<PricingRule[]>("/api/pricing-rules"),
  createPricingRule: (payload: PricingRuleInput) => send<PricingRule>("/api/pricing-rules", "POST", payload),
  updatePricingRule: (id: string, payload: PricingRuleInput) =>
    send<PricingRule>(`/api/pricing-rules/${id}`, "PUT", payload),
  deletePricingRule: (id: string) => send<{ ok: true }>(`/api/pricing-rules/${id}`, "DELETE"),

  listApprovalRules: () => request<ApprovalRule[]>("/api/approval-rules"),
  createApprovalRule: (payload: ApprovalRuleInput) => send<ApprovalRule>("/api/approval-rules", "POST", payload),
  updateApprovalRule: (id: string, payload: ApprovalRuleInput) =>
    send<ApprovalRule>(`/api/approval-rules/${id}`, "PUT", payload),
  deleteApprovalRule: (id: string) => send<{ ok: true }>(`/api/approval-rules/${id}`, "DELETE"),

  validateFormula: (expression: string, scope: "line" | "quote" | "product", optionKeys?: string[]) =>
    send<FormulaCheck>("/api/formula/validate", "POST", { expression, scope, optionKeys }),

  /* --------------------------------- quotes ------------------------------ */

  listQuotes: (limit?: number) => request<QuoteSummary[]>(`/api/quotes${limit === undefined ? "" : `?limit=${limit}`}`),
  quotesAwaitingMe: () => request<QuoteSummary[]>("/api/quotes/awaiting"),
  getQuote: (id: string) => request<Quote>(`/api/quotes/${id}`),
  createQuote: (payload: QuoteBody) => send<SavedQuote>("/api/quotes", "POST", payload),
  updateQuote: (id: string, payload: QuoteBody) => send<SavedQuote>(`/api/quotes/${id}`, "PUT", payload),
  deleteQuote: (id: string) => send<{ ok: true }>(`/api/quotes/${id}`, "DELETE"),
  previewQuote: (payload: QuoteBody) => send<QuotePreview>("/api/quotes/preview", "POST", payload),
  submitQuote: (id: string) => send<SubmitResult>(`/api/quotes/${id}/submit`, "POST"),
  decideQuote: (id: string, decision: "approved" | "rejected", comment: string) =>
    send<{ quote: Quote; changed: number }>(`/api/quotes/${id}/decision`, "POST", { decision, comment }),
  setQuoteStatus: (id: string, status: QuoteStatus) => send<Quote>(`/api/quotes/${id}/status`, "POST", { status }),
  reviseQuote: (id: string) => send<SavedQuote>(`/api/quotes/${id}/revise`, "POST"),

  /* ------------------------------ receivables ---------------------------- */

  listInvoices: () => request<InvoiceSummary[]>("/api/invoices"),
  accountInvoices: (id: string) => request<InvoiceSummary[]>(`/api/accounts/${id}/invoices`),
  getInvoice: (id: string) => request<Invoice>(`/api/invoices/${id}`),
  createInvoice: (payload: InvoiceBody) => send<SavedInvoice>("/api/invoices", "POST", payload),
  updateInvoice: (id: string, payload: InvoiceBody) => send<SavedInvoice>(`/api/invoices/${id}`, "PUT", payload),
  /** Drafts only — the server refuses anything that was ever issued. */
  deleteInvoice: (id: string) => send<{ ok: true }>(`/api/invoices/${id}`, "DELETE"),
  invoiceQuote: (quoteId: string) => send<SavedInvoice>(`/api/quotes/${quoteId}/invoice`, "POST"),

  issueInvoice: (id: string, issueDate?: string) => send<Invoice>(`/api/invoices/${id}/issue`, "POST", { issueDate }),
  voidInvoice: (id: string) => send<Invoice>(`/api/invoices/${id}/void`, "POST"),

  recordPayment: (id: string, payload: PaymentInput) =>
    send<SavedInvoice>(`/api/invoices/${id}/payments`, "POST", payload),
  removePayment: (id: string, paymentId: string) =>
    send<Invoice>(`/api/invoices/${id}/payments/${paymentId}`, "DELETE"),
  recordCredit: (id: string, payload: CreditInput) => send<SavedInvoice>(`/api/invoices/${id}/credits`, "POST", payload),
  removeCredit: (id: string, creditId: string) => send<Invoice>(`/api/invoices/${id}/credits/${creditId}`, "DELETE"),

  /** Every payment received — the cash receipts list, across invoices. */
  listPaymentsReceived: () => request<InvoicePayment[]>("/api/payments"),
  listCreditsIssued: () => request<InvoiceCredit[]>("/api/credits"),
  invoicePayments: (id: string) => request<InvoicePayment[]>(`/api/invoices/${id}/payments`),
  invoiceCredits: (id: string) => request<InvoiceCredit[]>(`/api/invoices/${id}/credits`),

  paymentsCsvUrl: "/api/payments?format=csv",
  creditsCsvUrl: "/api/credits?format=csv",

  aging: (currency: string, asOf?: string) =>
    request<AgingReport>(`/api/receivables/aging?currency=${currency}${asOf ? `&asOf=${asOf}` : ""}`),

  receivablesCsvUrl: "/api/invoices/export?format=csv",
  invoiceExportUrl,
  invoiceExportText: (id: string, format: "csv" | "json") => fetchText(invoiceExportUrl(id, format), "Export"),

  /* ------------------------------- documents ----------------------------- */

  listProposalTemplates: () => request<ProposalTemplate[]>("/api/proposal-templates"),
  createProposalTemplate: (payload: ProposalTemplateInput) =>
    send<ProposalTemplate>("/api/proposal-templates", "POST", payload),
  updateProposalTemplate: (id: string, payload: ProposalTemplateInput) =>
    send<ProposalTemplate>(`/api/proposal-templates/${id}`, "PUT", payload),
  deleteProposalTemplate: (id: string) => send<{ ok: true }>(`/api/proposal-templates/${id}`, "DELETE"),

  documentUrl,
  documentInlineUrl,
  renderDocument: (quoteId: string, templateId: string) =>
    request<RenderedDocument>(documentInlineUrl(quoteId, templateId)),

  invoiceDocumentUrl,
  invoiceDocumentInlineUrl,
  renderInvoiceDocument: (invoiceId: string, templateId: string) =>
    request<RenderedDocument>(invoiceDocumentInlineUrl(invoiceId, templateId)),

  /* -------------------------------- sharing ------------------------------ */

  listShares: (kind: Shareable, id: string) => request<Shares>(sharesUrl(kind, id)),
  addShare: (kind: Shareable, id: string, email: string) => send<Shares>(sharesUrl(kind, id), "POST", { email }),
  removeShare: (kind: Shareable, id: string, email: string) =>
    send<Shares>(`${sharesUrl(kind, id)}?email=${encodeURIComponent(email)}`, "DELETE"),

  /* -------------------------- files and the sample ----------------------- */

  quoteExportUrl,
  quoteExportText: (id: string, format: "csv" | "json") => fetchText(quoteExportUrl(id, format), "Export"),

  catalogExportUrl: CATALOG_EXPORT_URL,
  productsCsvUrl: "/api/products/export?format=csv",
  importCatalog: (file: unknown) => send<CatalogImportReport>("/api/catalog/import", "POST", file),

  workspaceExportUrl: WORKSPACE_EXPORT_URL,
  workspaceExportText: () => fetchText(WORKSPACE_EXPORT_URL, "The workspace export"),

  installSample: () => send<SeedReport>("/api/sample", "POST"),
};
