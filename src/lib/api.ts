/**
 * The browser's view of the REST API in `src/index.ts`.
 *
 * One function per endpoint, so a component never builds a URL. The session
 * rides in an httpOnly cookie the page cannot read, which is why there is no
 * token handling anywhere in here.
 */
import type { Attachment, AttachmentTarget } from "./attachments";
import type { MemberListing, Membership, Organization, Role } from "./organization";
import type { TablePage, TableRecord } from "./dataTable";
import type { FormLayout, RecordFormConfig, RecordWithForm } from "./recordForm";
import type { WorkspaceLayout, WorkspaceView } from "./workspace";
import type { FieldInfo } from "./dataTable";
import type { Preferences } from "./preferences";
import type { AgingReport } from "./receivable";
import type { SampleSetName } from "./samples";
import type { Lead, Opportunity } from "./pipeline";
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
  LeadConversionInput,
  LeadInput,
  OpportunityInput,
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
  /** The organization this account is working in; null between organizations. */
  org: Organization | null;
  /** Its role there — what the UI hides buttons by. PocketBase enforces it. */
  role: Role | "";
  /** Every organization it belongs to, for the switcher. */
  memberships: Membership[];
};

/** A collection's layouts, as `GET /api/record-forms/:collection` returns them. */
export type LayoutConfig = {
  collection: string;
  configId: string | null;
  title: string;
  description: string;
  layout: FormLayout;
  workspace: WorkspaceLayout;
  fields: FieldInfo[];
  writable: boolean;
  readOnlyReason: string | null;
};

/** One page of quotes, and how many matched in all. */
export type QuotePage = { items: QuoteSummary[]; total: number };

export type QuoteQuery = { q?: string; status?: QuoteStatus | ""; page?: number; perPage?: number };

export type OrgDescription = {
  org: Organization | null;
  role: Role | "";
  memberships: Membership[];
  roles: { role: Role; description: string }[];
  timeZones: string[];
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
  /** Left out, a save keeps the quote's opportunity; null unlinks it. */
  opportunityId?: string | null;
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

/** A converted lead, and what it became. */
export type LeadConversion = { lead: Lead; account: Account; opportunity: Opportunity | null };

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
  /** Ends this session for real; `everywhere` ends every session the account has. */
  logout: (everywhere = false) =>
    send<{ ok: true; revoked: boolean }>(`/api/auth/logout${everywhere ? "?everywhere=1" : ""}`, "POST"),
  me: () => request<{ user: SessionUser }>("/api/auth/me"),
  updateProfile: (payload: { name: string }) => send<{ user: SessionUser }>("/api/auth/profile", "PATCH", payload),
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

  /* ------------------------------ attachments ---------------------------- */

  listAttachments: (target: AttachmentTarget, recordId: string) =>
    request<Attachment[]>(`/api/attachments?${new URLSearchParams({ target, recordId })}`),
  /** Multipart, so the browser writes the boundary — no JSON Content-Type here. */
  uploadAttachment: async (target: AttachmentTarget, recordId: string, file: File, note = "") => {
    const form = new FormData();
    form.set("target", target);
    form.set("recordId", recordId);
    if (note) form.set("note", note);
    form.set("file", file, file.name);
    const response = await fetch("/api/attachments", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError((payload as { error?: string }).error ?? `Upload failed (${response.status})`, response.status);
    }
    return payload as Attachment;
  },
  deleteAttachment: (id: string) => send<{ ok: true }>(`/api/attachments/${encodeURIComponent(id)}`, "DELETE"),
  attachmentUrl: (id: string, inline = false) =>
    `/api/attachments/${encodeURIComponent(id)}/file${inline ? "?inline=1" : ""}`,

  /* --------------------------------- docs -------------------------------- */

  /** What `/docs` renders, and what Postman and friends import. */
  openApiUrl: OPENAPI_URL,
  openApiFileName: "cpq.openapi.json",
  openApiText: () => fetchText(OPENAPI_URL, "The OpenAPI document"),

  /* ------------------------------ data table ----------------------------- */

  /** One page of a collection, as stored. Aborting `signal` drops a stale page. */
  tablePage: (
    collection: string,
    params: { filter: string; sort: string; page: number; perPage: number },
    signal?: AbortSignal,
  ) => {
    const search = new URLSearchParams({ page: String(params.page), perPage: String(params.perPage) });
    if (params.filter.trim()) search.set("filter", params.filter);
    if (params.sort) search.set("sort", params.sort);
    return request<TablePage>(`/api/table/${encodeURIComponent(collection)}?${search}`, { signal });
  },

  /** One record and the form to edit it with — what a click on a row opens. */
  tableRecord: (collection: string, id: string, signal?: AbortSignal) =>
    request<RecordWithForm>(`/api/table/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { signal }),

  updateTableRecord: (collection: string, id: string, values: TableRecord, updated: string | null) =>
    send<RecordWithForm>(`/api/table/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, "PATCH", {
      values,
      updated,
    }),

  /** A record, its form, and its workspace — related-list counts and the computed summary. */
  recordWorkspace: (collection: string, id: string, signal?: AbortSignal) =>
    request<RecordWithForm & WorkspaceView>(
      `/api/workspace/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      { signal },
    ),
  /** The summary and counts a draft workspace would show. Stores nothing. */
  previewWorkspace: (collection: string, id: string, workspace: WorkspaceLayout, signal?: AbortSignal) =>
    request<WorkspaceView>(`/api/workspace/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/preview`, {
      method: "POST",
      body: JSON.stringify({ workspace }),
      signal,
    }),
  /** Both layouts for a collection, stored or default, with its fields. */
  layoutConfig: (collection: string, signal?: AbortSignal) =>
    request<LayoutConfig>(`/api/record-forms/${encodeURIComponent(collection)}`, { signal }),
  saveLayoutConfig: (
    collection: string,
    payload: { title: string; description: string; layout: FormLayout; workspace: WorkspaceLayout },
  ) => send<LayoutConfig>(`/api/record-forms/${encodeURIComponent(collection)}`, "PUT", payload),
  /** A new record through its collection's form; `link` points it at the record it belongs to. */
  createTableRecord: (collection: string, values: TableRecord, link: TableRecord) =>
    send<TableRecord>(`/api/table/${encodeURIComponent(collection)}`, "POST", { values, link }),

  /** Store a collection's default form layout in `record_forms`, to edit there. */
  createRecordForm: (collection: string) =>
    send<RecordFormConfig>(`/api/record-forms/${encodeURIComponent(collection)}`, "POST"),

  /* ----------------------------- organization ---------------------------- */

  org: () => request<OrgDescription>("/api/org"),
  updateOrg: (payload: { name?: string; timeZone?: string }) => send<Organization>("/api/org", "PUT", payload),
  members: () => request<MemberListing>("/api/org/members"),
  addMember: (email: string, role: Role) => send<MemberListing>("/api/org/members", "POST", { email, role }),
  changeMemberRole: (id: string, role: Role) =>
    send<MemberListing>(`/api/org/members/${encodeURIComponent(id)}`, "PUT", { role }),
  removeMember: (id: string) =>
    send<MemberListing & { left?: boolean }>(`/api/org/members/${encodeURIComponent(id)}`, "DELETE"),
  revokeInvitation: (id: string) => send<MemberListing>(`/api/org/invitations/${encodeURIComponent(id)}`, "DELETE"),
  switchOrg: (orgId: string) => send<{ org: Organization; role: Role }>("/api/org/switch", "POST", { orgId }),
  createOrg: (name: string) => send<{ org: Organization; role: Role }>("/api/orgs", "POST", { name }),

  /** Your organization's members — what the approver and share pickers offer. */
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

  /* ------------------------------- pipeline ------------------------------ */

  listLeads: () => request<Lead[]>("/api/leads"),
  createLead: (payload: LeadInput) => send<Lead>("/api/leads", "POST", payload),
  updateLead: (id: string, payload: LeadInput) => send<Lead>(`/api/leads/${id}`, "PUT", payload),
  deleteLead: (id: string) => send<{ ok: true }>(`/api/leads/${id}`, "DELETE"),
  convertLead: (id: string, payload: Partial<LeadConversionInput>) =>
    send<LeadConversion>(`/api/leads/${id}/convert`, "POST", payload),

  listOpportunities: (accountId?: string) =>
    request<Opportunity[]>(`/api/opportunities${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`),
  getOpportunity: (id: string) => request<Opportunity>(`/api/opportunities/${id}`),
  createOpportunity: (payload: OpportunityInput) => send<Opportunity>("/api/opportunities", "POST", payload),
  updateOpportunity: (id: string, payload: OpportunityInput) => send<Opportunity>(`/api/opportunities/${id}`, "PUT", payload),
  deleteOpportunity: (id: string) => send<{ ok: true }>(`/api/opportunities/${id}`, "DELETE"),
  opportunityQuotes: (id: string) => request<QuoteSummary[]>(`/api/opportunities/${id}/quotes`),
  /** A new draft quote for the deal's customer, linked to it. */
  quoteOpportunity: (id: string) => send<SavedQuote>(`/api/opportunities/${id}/quotes`, "POST"),

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

  /** One page of quotes, searched and filtered by the server. */
  searchQuotes: async (query: QuoteQuery = {}): Promise<QuotePage> => {
    const params = new URLSearchParams();
    if (query.q?.trim()) params.set("q", query.q.trim());
    if (query.status) params.set("status", query.status);
    if (query.page) params.set("page", String(query.page));
    if (query.perPage) params.set("perPage", String(query.perPage));
    const response = await fetch(`/api/quotes?${params}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError((payload as { error?: string }).error ?? `Request failed (${response.status})`, response.status);
    }
    return { items: payload as QuoteSummary[], total: Number(response.headers.get("X-Total-Count") ?? 0) };
  },
  /** How many quotes are in each status, plus `all` — the list's filter chips. */
  quoteCounts: (q = "") =>
    request<Record<string, number>>(`/api/quotes/counts${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`),
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

  installSample: (set: SampleSetName = "nimbus") => send<SeedReport>(`/api/sample?set=${set}`, "POST"),
};
