import { serve } from "bun";
import index from "./index.html";
import { authRoutes, sessionUser } from "./server/auth";
import {
  createAccount,
  createApprovalRule,
  createPriceBook,
  createPricingRule,
  createProduct,
  createProposalTemplate,
  databaseMeta,
  databaseUrl,
  deleteAccount,
  deleteApprovalRule,
  deletePriceBook,
  deletePricingRule,
  deleteProduct,
  deleteProposalTemplate,
  deleteQuote,
  getAccount,
  getApprovalRule,
  getPriceBook,
  getPricingRule,
  getProduct,
  getProposalTemplate,
  getInvoice,
  getQuote,
  listAccounts,
  listApprovalRules,
  listPriceBooks,
  listPricingRules,
  listProducts,
  listProposalTemplates,
  listQuotes,
  listCredits,
  listInvoices,
  listInvoicesForAccount,
  listPayments,
  listQuotesAwaiting,
  listQuotesForAccount,
  updateAccount,
  updateApprovalRule,
  updatePriceBook,
  updatePricingRule,
  updateProduct,
  updateProposalTemplate,
} from "./server/db";
import {
  agingRows,
  creditRows,
  exportResponse,
  fileResponse,
  invoiceLineRows,
  invoiceRows,
  paymentRows,
  productRows,
  quoteRows,
} from "./server/export";
import { ApiError, asRecord, fail, formatParam, handler, intParam, query, readJson } from "./server/http";
import { readPreferences, writePreferences } from "./server/preferences";
import {
  createPricedQuote,
  decideQuote,
  loadCatalogue,
  repriceQuote,
  reviseQuote,
  saveQuote,
  snapshotCustomer,
  submitQuote,
  transitionQuote,
  withExpiry,
} from "./server/quotes";
import {
  ageReceivables,
  createBlankInvoice,
  discardInvoice,
  invoiceQuote,
  issueInvoice,
  recordCredit,
  recordPayment,
  removeCredit,
  removePayment,
  saveInvoice,
  voidInvoice,
} from "./server/invoices";
import { installSample } from "./server/seed";
import { requireToken } from "./server/session";
import {
  addShare,
  listDirectory,
  listShares,
  removeShare,
  SHAREABLE_KINDS,
  readEmail,
  type Shareable,
} from "./server/share";
import { catalogFileName, parseCatalogFile, serializeCatalogFile } from "./lib/catalogFile";
import { defaultSelection, validateConfiguration } from "./lib/configurator";
import { evaluateApprovals } from "./lib/approvals";
import { FUNCTION_NAMES, parseFormula } from "./lib/formula";
import { DEFAULT_PREFERENCES } from "./lib/preferences";
import { PRICING_VARIABLES, lineVariableNames, quoteVariableNames } from "./lib/pricing";
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } from "./lib/image";
import {
  CONTENT_TYPES,
  LINE_TOKENS,
  LINES_CLOSE,
  LINES_OPEN,
  MAX_PDF_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_BODY_LENGTH,
  PROPOSAL_TOKENS,
  proposalFileName,
  renderProposal,
} from "./lib/proposal";
import { PAGE_SIZES, pdfResponse } from "./lib/pdf";
import { FONT_FAMILIES } from "./lib/pdfFonts";
import { BLOCK_TYPES, LINE_ITEM_FIELDS, TOTALS_FIELDS, renderPdf } from "./lib/pdfTemplate";
import { serializeWorkspaceFile, workspaceFileName } from "./lib/workspaceFile";
import {
  APPROVAL_METRIC_LABELS,
  BILLING_PERIODS,
  CHARGE_TYPES,
  CURRENCIES,
  INVOICE_STATES,
  PAYMENT_METHODS,
  CREDIT_REASONS,
  PRODUCT_RULE_KINDS,
  PROPOSAL_FORMATS,
  QUOTE_STATUSES,
  QUOTE_TRANSITIONS,
  type QuoteStatus,
} from "./lib/types";
import { asCurrency } from "./lib/money";
import { today } from "./lib/receivable";
import {
  readAccount,
  readApprovalRule,
  readCredit,
  readInvoiceHeader,
  readInvoiceLines,
  readPayment,
  readPdfTemplate,
  readPriceBook,
  readPricingRule,
  readProduct,
  readProposalTemplate,
  readQuoteHeader,
  readQuoteLines,
} from "./lib/validate";

/**
 * A route that needs an account.
 *
 * The token goes on to PocketBase untouched, which is what actually decides
 * whether the caller may see a record — this only refuses the anonymous case
 * up front, where PocketBase would otherwise answer with an empty list rather
 * than an error.
 */
function guarded<T extends { params?: Record<string, string> }>(
  fn: (token: string, req: Request & T) => Promise<Response> | Response,
) {
  return handler<T>(req => fn(requireToken(req), req));
}

/** Unwraps a validator, turning its one sentence into a 400. */
function must<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new ApiError(result.error);
  return result.value;
}

const body = async (req: Request) => asRecord(await readJson(req));

/** `GET`/`POST`/`DELETE` for one record type's share list. */
function shareRoutes(kind: Shareable) {
  return {
    GET: guarded<{ params: { id: string } }>(async (token, req) =>
      Response.json(await listShares(token, kind, req.params.id)),
    ),
    POST: guarded<{ params: { id: string } }>(async (token, req) =>
      Response.json(await addShare(token, kind, req.params.id, readEmail((await body(req)).email))),
    ),
    DELETE: guarded<{ params: { id: string } }>(async (token, req) =>
      Response.json(await removeShare(token, kind, req.params.id, readEmail(query(req).get("email")))),
    ),
  };
}

/**
 * The five catalogue and policy collections share one shape: list, create,
 * read, replace, delete, with one validator each. Spelling them out five times
 * would be five chances for them to drift apart.
 */
function crudRoutes<T, Input>(config: {
  what: string;
  read: (raw: unknown) => { ok: true; value: Input } | { ok: false; error: string };
  list: (token: string) => Promise<T[]>;
  get: (token: string, id: string) => Promise<T | null>;
  create: (token: string, input: Input) => Promise<T>;
  update: (token: string, id: string, input: Input) => Promise<T | null>;
  remove: (token: string, id: string) => Promise<boolean>;
}) {
  const { what } = config;
  return {
    collection: {
      GET: guarded(async token => Response.json(await config.list(token))),
      POST: guarded(async (token, req) =>
        Response.json(await config.create(token, must(config.read(await body(req)))), { status: 201 }),
      ),
    },
    record: {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const record = await config.get(token, req.params.id);
        return record ? Response.json(record) : fail(`${what} not found.`, 404);
      }),
      PUT: guarded<{ params: { id: string } }>(async (token, req) => {
        const updated = await config.update(token, req.params.id, must(config.read(await body(req))));
        // Shared, not owned, lands here too: PocketBase refuses the write and
        // the record reads as missing, which is the same answer either way.
        return updated ? Response.json(updated) : fail(`${what} not found, or not yours to change.`, 404);
      }),
      DELETE: guarded<{ params: { id: string } }>(async (token, req) =>
        (await config.remove(token, req.params.id))
          ? Response.json({ ok: true })
          : fail(`${what} not found, or not yours to delete.`, 404),
      ),
    },
  };
}

const products = crudRoutes({
  what: "Product",
  read: readProduct,
  list: listProducts,
  get: getProduct,
  create: createProduct,
  update: updateProduct,
  remove: deleteProduct,
});

const priceBooks = crudRoutes({
  what: "Price book",
  read: readPriceBook,
  list: listPriceBooks,
  get: getPriceBook,
  create: createPriceBook,
  update: updatePriceBook,
  remove: deletePriceBook,
});

const pricingRules = crudRoutes({
  what: "Pricing rule",
  read: readPricingRule,
  list: listPricingRules,
  get: getPricingRule,
  create: createPricingRule,
  update: updatePricingRule,
  remove: deletePricingRule,
});

const approvalRules = crudRoutes({
  what: "Approval rule",
  read: readApprovalRule,
  list: listApprovalRules,
  get: getApprovalRule,
  create: createApprovalRule,
  update: updateApprovalRule,
  remove: deleteApprovalRule,
});

const accounts = crudRoutes({
  what: "Account",
  read: readAccount,
  list: listAccounts,
  get: getAccount,
  create: createAccount,
  update: updateAccount,
  remove: deleteAccount,
});

const proposalTemplates = crudRoutes({
  what: "Proposal template",
  read: readProposalTemplate,
  list: listProposalTemplates,
  get: getProposalTemplate,
  create: createProposalTemplate,
  update: updateProposalTemplate,
  remove: deleteProposalTemplate,
});

/** Header and lines, as both the create and the save endpoints read them. */
async function readQuoteBody(req: Request) {
  const raw = await body(req);
  return { header: must(readQuoteHeader(raw)), lines: must(readQuoteLines(raw.lines)) };
}

const server = serve({
  routes: {
    /* -------------------------------- auth ------------------------------- */

    ...authRoutes,

    /* ------------------------------ discovery ---------------------------- */

    "/api": {
      GET: handler(() =>
        Response.json({
          name: "cpq",
          what: "Configure, price and quote. Every UI action is available here. Errors are { error: string }.",
          auth:
            "Every endpoint below needs an account, except /api, /api/health and /api/auth/*. " +
            "Sign in with POST /api/auth/login and keep the session cookie (curl: -c jar -b jar), " +
            "or send a PocketBase user token as `Authorization: <token>`.",
          endpoints: {
            "POST   /api/auth/register": "{ email, password, name? } → create an account and sign in",
            "POST   /api/auth/login": "{ email, password } → start a session",
            "POST   /api/auth/logout": "End the session",
            "GET    /api/auth/me": "The signed-in account, with its preferences",
            "POST   /api/auth/password": "{ currentPassword, newPassword } → change the password",
            "GET    /api/health": "Liveness check for this server",
            "GET    /api/meta": "PocketBase URL, reachability and this account's record counts",
            "GET    /api/directory": "The accounts on this instance (?search=) — id, email and name only",
            "GET    /api/preferences": "This account's preferences",
            "PUT    /api/preferences": "Replace this account's preferences",
            "GET    /api/export": "Download the whole workspace — catalogue, customers, quotes, templates",
            "POST   /api/sample": "Install the worked example: catalogue, policy, customers, a quote",
            "GET    /api/reference": "Every enum, pricing variable and proposal token this app knows",
            "POST   /api/formula/validate": "{ expression, scope } → check a pricing or approval formula",
            "GET    /api/accounts": "List customers",
            "POST   /api/accounts": "Create a customer",
            "GET    /api/accounts/:id": "Read one customer",
            "GET    /api/accounts/:id/quotes": "Every quote written for one customer, newest first",
            "PUT    /api/accounts/:id": "Replace one customer",
            "DELETE /api/accounts/:id": "Delete one customer",
            "GET    /api/products": "List products you own or that are shared with you",
            "POST   /api/products": "Create a product",
            "GET    /api/products/:id": "Read one product",
            "PUT    /api/products/:id": "Replace one product (owner only)",
            "DELETE /api/products/:id": "Delete one product (owner only)",
            "POST   /api/products/:id/configure": "{ selectedOptions, quantity, termMonths } → validate a configuration",
            "GET    /api/products/:id/shares": "Who a product is shared with",
            "POST   /api/products/:id/shares": "{ email } → share it with an account (owner only)",
            "DELETE /api/products/:id/shares": "?email= → stop sharing it (owner, or yourself)",
            "GET    /api/products/export": "Download the catalogue as CSV (?format=csv) or *.cpq.json",
            "GET    /api/price-books": "List price books",
            "POST   /api/price-books": "Create a price book",
            "GET    /api/price-books/:id": "Read one price book",
            "PUT    /api/price-books/:id": "Replace one price book (owner only)",
            "DELETE /api/price-books/:id": "Delete one price book (owner only)",
            "GET    /api/price-books/:id/shares": "Who a price book is shared with",
            "POST   /api/price-books/:id/shares": "{ email } → share it (owner only)",
            "DELETE /api/price-books/:id/shares": "?email= → stop sharing it",
            "GET    /api/pricing-rules": "List pricing rules",
            "POST   /api/pricing-rules": "Create a pricing rule",
            "GET    /api/pricing-rules/:id": "Read one pricing rule",
            "PUT    /api/pricing-rules/:id": "Replace one pricing rule",
            "DELETE /api/pricing-rules/:id": "Delete one pricing rule",
            "GET    /api/approval-rules": "List approval rules",
            "POST   /api/approval-rules": "Create an approval rule",
            "GET    /api/approval-rules/:id": "Read one approval rule",
            "PUT    /api/approval-rules/:id": "Replace one approval rule",
            "DELETE /api/approval-rules/:id": "Delete one approval rule",
            "GET    /api/catalog/export": "Download products, price books and rules as *.cpq.json",
            "POST   /api/catalog/import": "Create everything in a *.cpq.json body",
            "GET    /api/quotes": "List quotes (?limit=)",
            "POST   /api/quotes": "Create a quote — the server prices it",
            "GET    /api/quotes/awaiting": "Quotes waiting on your approval",
            "POST   /api/quotes/preview": "Price a quote without storing it",
            "GET    /api/quotes/:id": "Read one quote, with its lines and totals",
            "PUT    /api/quotes/:id": "Replace a draft quote — the server reprices it",
            "DELETE /api/quotes/:id": "Delete one quote",
            "POST   /api/quotes/:id/submit": "Reprice, run the approval rules, and submit",
            "POST   /api/quotes/:id/decision": "{ decision: approved|rejected, comment? } → answer as an approver",
            "POST   /api/quotes/:id/status": "{ status } → sent, accepted, declined, or back to draft",
            "POST   /api/quotes/:id/revise": "Create the next revision, leaving this one as it was",
            "GET    /api/quotes/:id/export": "Download a quote (?format=csv|json)",
            "GET    /api/quotes/:id/document": "Render a quote through a template (?templateId=, &inline). A PDF template answers with the PDF",
            "GET    /api/quotes/:id/shares": "Who a quote is shared with",
            "POST   /api/quotes/:id/shares": "{ email } → share it read-only (owner only)",
            "DELETE /api/quotes/:id/shares": "?email= → stop sharing it",
            "GET    /api/receivables/aging": "The aging report (?currency=, ?asOf=, ?format=csv)",
            "GET    /api/payments": "Every payment received (?invoiceId=, ?format=csv) — the cash receipts list",
            "GET    /api/credits": "Every credit and write-off (?invoiceId=, ?format=csv)",
            "GET    /api/invoices": "List invoices",
            "POST   /api/invoices": "Create a draft invoice for a customer",
            "GET    /api/invoices/export": "Download every invoice with its aging (?format=csv|json)",
            "GET    /api/invoices/:id": "Read one invoice, with its lines and ledger",
            "PUT    /api/invoices/:id": "Replace a draft invoice — the server re-totals it",
            "DELETE /api/invoices/:id": "Discard a draft. An issued invoice is voided, never deleted",
            "POST   /api/invoices/:id/issue": "{ issueDate? } → date it, set its due date, make it a receivable",
            "POST   /api/invoices/:id/void": "Cancel one. Refused once a payment is recorded",
            "GET    /api/invoices/:id/payments": "One invoice's payments",
            "POST   /api/invoices/:id/payments": "{ amount, receivedOn?, method?, reference? } → record cash received",
            "DELETE /api/invoices/:id/payments/:paymentId": "Remove a payment entered in error",
            "GET    /api/invoices/:id/credits": "One invoice's credits",
            "POST   /api/invoices/:id/credits": "{ amount, reason?, issuedOn? } → credit or write off",
            "DELETE /api/invoices/:id/credits/:creditId": "Remove a credit entered in error",
            "GET    /api/invoices/:id/export": "Download one invoice (?format=csv|json)",
            "GET    /api/invoices/:id/shares": "Who an invoice is shared with",
            "POST   /api/invoices/:id/shares": "{ email } → share it read-only (owner only)",
            "DELETE /api/invoices/:id/shares": "?email= → stop sharing it",
            "POST   /api/quotes/:id/invoice": "Raise an invoice for a sent or accepted quote",
            "GET    /api/accounts/:id/invoices": "One customer's invoices",
            "GET    /api/proposal-templates": "List templates you own or that are shared with you",
            "POST   /api/proposal-templates": "Create a proposal template",
            "GET    /api/proposal-templates/:id": "Read one template",
            "PUT    /api/proposal-templates/:id": "Replace one template (owner only)",
            "DELETE /api/proposal-templates/:id": "Delete one template (owner only)",
            "GET    /api/proposal-templates/:id/shares": "Who a template is shared with",
            "POST   /api/proposal-templates/:id/shares": "{ email } → share it (owner only)",
            "DELETE /api/proposal-templates/:id/shares": "?email= → stop sharing it",
          },
          pricing: {
            what: "The server prices every quote it stores. Totals in a request body are ignored.",
            pipeline: [
              "price book entry, or the product's list price",
              "configured options: the factor, then the delta",
              "the volume tier the quantity falls into",
              "a negotiated unit price override, which replaces the three above",
              "pricing rules, by formula, in priority order",
              "the discount — the rep's, or one a rule set",
              "the price book's floor, which nothing may go below",
              "the term: periods = months ÷ billing period",
            ],
            variables: PRICING_VARIABLES,
            functions: FUNCTION_NAMES,
            operators: "+ - * / % ^  < <= > >= == !=  && || !  and parentheses",
          },
          approvals: {
            what: "A submitted quote is repriced, then measured against every active approval rule.",
            metrics: APPROVAL_METRIC_LABELS,
            ladder: "Levels are cumulative: a quote needs every level at or below the highest it trips.",
            editing: "Editing a quote voids its approvals — they are recomputed from scratch on each submit.",
            visibility: "An approver can read and decide the quote they are asked about, and nothing else of yours.",
          },
          quotes: {
            statuses: QUOTE_STATUSES,
            transitions: QUOTE_TRANSITIONS,
            editable: "draft and rejected. Anything else is revised, not edited.",
            expiry: "A sent quote past validUntil reads as expired without being rewritten.",
            numbering: "Q-<year>-<sequence> per account; a revision appends -r<version>.",
          },
          receivables: {
            what: "The server totals every invoice it stores. Totals and balances in a request body are ignored.",
            states: INVOICE_STATES,
            derived:
              "Nothing about an invoice's condition is stored. open, part paid, paid and overdue are worked out " +
              "from the ledger and the date, every time they are asked for — a stored 'overdue' is wrong the " +
              "morning after it is written.",
            ledger:
              "Payments and credits are their own collections, each row belonging to one invoice. Recording one " +
              "is an insert, so two people banking cash at once cannot lose a payment, and the invoice's own " +
              "record is never rewritten.",
            balance:
              "total − payments − credits, computed on every read rather than cached — a stored balance can " +
              "disagree with the payments behind it. It may go negative: an overpaid invoice owes money back.",
            editing: "draft only. An issued invoice is changed with a credit, never an edit.",
            numbering: "INV-<year>-<sequence> per account. Nothing ever issued is deleted, so the run stays gapless.",
            paymentMethods: PAYMENT_METHODS,
            creditReasons: CREDIT_REASONS,
            aging: "Five buckets on the balance, not the total: not yet due, 1–30, 31–60, 61–90, 90+ days past due.",
            currency: "Nothing adds two currencies. Invoices in another are counted and reported, never summed.",
            fromQuotes:
              "A sent or accepted quote raises a draft invoice for its whole contract value, with the quote " +
              "discount, any adjustment and shipping as their own lines. Billing a subscription period by " +
              "period is a billing schedule, which this does not do.",
          },
          proposals: {
            what: "A quote rendered through a template — HTML, Markdown, plain text or PDF.",
            tokens: PROPOSAL_TOKENS,
            lineTokens: LINE_TOKENS,
            repeatingBlock: `${LINES_OPEN} … ${LINES_CLOSE} renders once per line.`,
            escaping: "Values are escaped for the template's format. Nothing in a template is executed.",
            pdf: {
              what: "A `pdf` template's body is a JSON document description rather than prose, because a PDF has no layout of its own.",
              blocks: BLOCK_TYPES,
              lineItemFields: LINE_ITEM_FIELDS,
              totalsFields: TOTALS_FIELDS,
              margin: "A PDF template cannot name cost or margin — the totals it may print is a closed, customer-facing list.",
              fonts: "The PDF standard 14 only, so a quote is a few kilobytes and needs no embedded font.",
              branding: {
                what: "An `image` block puts a picture in the flow; `header` is a letterhead drawn in the top margin of every page (or only the first, with `firstPageOnly`).",
                source: "A base64 `data:` URL held in the template itself, so branding travels with an export, a share and an import.",
                accepts: `PNG without an alpha channel, or baseline JPEG, ${Math.round(MAX_IMAGE_BYTES / 1000)} kB or less. A PDF stream carries no transparency, so the app flattens an image onto a background when you choose one in the editor; posted here, a transparent or progressive image is refused with a sentence and the block keeps its place.`,
                size: `A PDF template body may be ${MAX_PDF_TEMPLATE_BODY_LENGTH.toLocaleString()} characters, against ${MAX_TEMPLATE_BODY_LENGTH.toLocaleString()} for the text formats, because the pictures are in it.`,
              },
            },
          },
          sharing: {
            what: `${SHAREABLE_KINDS.join(", ")} can be shared with other accounts, read-only.`,
            recipientCan: "List, read, export it, and quote from it. The quotes they build are their own.",
            recipientCannot: "Rename, edit, delete, or re-share it.",
            accounts: "Customers and rules are never shared — a quote carries its customer's details itself.",
          },
          currencies: CURRENCIES,
        }),
      ),
    },

    // Liveness only — this is what the container HEALTHCHECK polls, and the
    // API being up is a separate fact from PocketBase being up (/api/meta).
    "/api/health": {
      GET: handler(() =>
        Response.json({
          status: "ok",
          uptime: Math.round(process.uptime()),
          env: process.env.NODE_ENV ?? "development",
        }),
      ),
    },

    "/api/meta": {
      GET: guarded(async token => Response.json(await databaseMeta(token))),
    },

    /**
     * The accounts on this instance: id, email and name, and nothing else.
     *
     * What the approver and share pickers offer. PocketBase answers it, since
     * reading the user list needs authority no user token has — and it is the
     * only way to see another account at all. See docker/pb_hooks/lib/directory.js.
     */
    "/api/directory": {
      GET: guarded(async (token, req) => Response.json(await listDirectory(token, query(req).get("search") ?? ""))),
    },

    /**
     * Every enum and vocabulary the UI builds its pickers from, in one place,
     * so the options on screen cannot drift from the ones the server accepts.
     */
    "/api/reference": {
      GET: guarded(() =>
        Response.json({
          currencies: CURRENCIES,
          chargeTypes: CHARGE_TYPES,
          billingPeriods: BILLING_PERIODS,
          productRuleKinds: PRODUCT_RULE_KINDS,
          quoteStatuses: QUOTE_STATUSES,
          quoteTransitions: QUOTE_TRANSITIONS,
          approvalMetrics: APPROVAL_METRIC_LABELS,
          pricingVariables: PRICING_VARIABLES,
          formulaFunctions: FUNCTION_NAMES,
          proposalTokens: PROPOSAL_TOKENS,
          lineTokens: LINE_TOKENS,
          proposalFormats: PROPOSAL_FORMATS,
          pdfBlocks: BLOCK_TYPES,
          pdfLineItemFields: LINE_ITEM_FIELDS,
          pdfTotalsFields: TOTALS_FIELDS,
          pdfPageSizes: PAGE_SIZES,
          pdfFontFamilies: FONT_FAMILIES,
          pdfImageMediaTypes: IMAGE_MEDIA_TYPES,
          preferenceDefaults: DEFAULT_PREFERENCES,
        }),
      ),
    },

    /* ---------------------------- preferences ---------------------------- */

    "/api/preferences": {
      GET: guarded(async token => Response.json(await readPreferences(token))),
      // A replace rather than a merge: the body is a whole preference set, and
      // anything missing from it falls back to that preference's default.
      PUT: guarded(async (token, req) => Response.json(await writePreferences(token, await readJson(req)))),
    },

    /* ------------------------------ formulas ----------------------------- */

    /**
     * Checks an expression against the variables its scope actually offers,
     * which is what the rule editors call on every keystroke.
     */
    "/api/formula/validate": {
      POST: guarded(async (_token, req) => {
        const raw = await body(req);
        if (typeof raw.expression !== "string") throw new ApiError('"expression" must be a string.');

        const scope = String(raw.scope ?? "line");
        const available =
          scope === "quote"
            ? quoteVariableNames()
            : scope === "product"
              ? ["quantity", "term", "termMonths", "selectedCount", ...(Array.isArray(raw.optionKeys) ? raw.optionKeys.map(key => `option.${String(key)}`) : [])]
              : lineVariableNames();

        const result = parseFormula(raw.expression, available);
        return Response.json(
          result.ok
            ? { valid: true, references: result.refs, available }
            : { valid: false, error: result.error, available },
        );
      }),
    },

    /* ---------------------------- the catalogue -------------------------- */

    "/api/accounts": accounts.collection,
    "/api/accounts/:id": accounts.record,

    /**
     * One customer's invoices — what they owe, and what they have paid.
     *
     * The aging of it is worked out by src/lib/receivable.ts from these
     * records, in the browser and on the server alike, rather than being a
     * number this endpoint asserts.
     */
    "/api/accounts/:id/invoices": {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const account = await getAccount(token, req.params.id);
        if (!account) return fail("Account not found.", 404);
        return Response.json(await listInvoicesForAccount(token, account.id));
      }),
    },

    /**
     * One customer's quote history, newest first.
     *
     * Separate from `/api/quotes` because that list is capped at a page and
     * sorted by recency across everybody: a customer with a long history
     * would show whichever of their quotes happened to be recent. This is
     * every one of them, and it is what the customer screen totals.
     */
    "/api/accounts/:id/quotes": {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const account = await getAccount(token, req.params.id);
        if (!account) return fail("Account not found.", 404);
        return Response.json(await listQuotesForAccount(token, account.id));
      }),
    },

    "/api/products": products.collection,

    "/api/products/export": {
      GET: guarded(async (token, req) => {
        const all = await listProducts(token);
        const format = formatParam(query(req));
        if (format === "csv") return exportResponse(productRows(all), "csv", "catalog");
        return fileResponse(
          serializeCatalogFile({ name: "Catalogue", products: all }),
          "application/json; charset=utf-8",
          catalogFileName("catalog"),
        );
      }),
    },

    "/api/products/:id": products.record,
    "/api/products/:id/shares": shareRoutes("products"),

    /**
     * Checks a set of chosen options against the product's rules, and says
     * what they do to the price. The editor calls it as options are clicked;
     * the same function runs again inside pricing when the quote is saved.
     */
    "/api/products/:id/configure": {
      POST: guarded<{ params: { id: string } }>(async (token, req) => {
        const product = await getProduct(token, req.params.id);
        if (!product) return fail("Product not found.", 404);

        const raw = await body(req);
        const selectedOptions = Array.isArray(raw.selectedOptions)
          ? raw.selectedOptions.map(String)
          : defaultSelection(product);

        const result = validateConfiguration(
          product,
          {
            selectedOptions,
            quantity: Number(raw.quantity) || product.minQuantity || 1,
            termMonths: Number(raw.termMonths) || 0,
          },
          product.currency,
        );

        return Response.json({ ...result, defaults: defaultSelection(product) });
      }),
    },

    "/api/price-books": priceBooks.collection,
    "/api/price-books/:id": priceBooks.record,
    "/api/price-books/:id/shares": shareRoutes("price-books"),

    "/api/pricing-rules": pricingRules.collection,
    "/api/pricing-rules/:id": pricingRules.record,

    "/api/approval-rules": approvalRules.collection,
    "/api/approval-rules/:id": approvalRules.record,

    /* ------------------------- catalogue as a file ----------------------- */

    "/api/catalog/export": {
      GET: guarded(async token => {
        const [productList, books, pricing, approvals] = await Promise.all([
          listProducts(token),
          listPriceBooks(token),
          listPricingRules(token),
          listApprovalRules(token),
        ]);
        return fileResponse(
          serializeCatalogFile({
            name: "Catalogue",
            products: productList,
            priceBooks: books,
            pricingRules: pricing,
            approvalRules: approvals,
          }),
          "application/json; charset=utf-8",
          catalogFileName("catalog"),
        );
      }),
    },

    /**
     * Imports a `*.cpq.json` file.
     *
     * The whole document is validated before anything is written, and a name
     * or SKU that is already taken is skipped rather than overwritten — an
     * import should never be the thing that silently changed a live price.
     */
    "/api/catalog/import": {
      POST: guarded(async (token, req) => {
        const parsed = parseCatalogFile(await readJson(req));
        if (!parsed.ok) return fail(parsed.error);

        const created: Record<string, number> = {};
        const skipped: string[] = [];
        const bump = (key: string) => {
          created[key] = (created[key] ?? 0) + 1;
        };

        const takenSku = new Set((await listProducts(token)).map(product => product.sku));
        for (const product of parsed.catalog.products) {
          if (takenSku.has(product.sku)) {
            skipped.push(`product ${product.sku}`);
            continue;
          }
          await createProduct(token, product);
          takenSku.add(product.sku);
          bump("products");
        }

        const takenBook = new Set((await listPriceBooks(token)).map(book => book.name.toLowerCase()));
        for (const book of parsed.catalog.priceBooks) {
          if (takenBook.has(book.name.toLowerCase())) {
            skipped.push(`price book "${book.name}"`);
            continue;
          }
          await createPriceBook(token, book);
          takenBook.add(book.name.toLowerCase());
          bump("priceBooks");
        }

        const takenPricing = new Set((await listPricingRules(token)).map(rule => rule.name.toLowerCase()));
        for (const rule of parsed.catalog.pricingRules) {
          if (takenPricing.has(rule.name.toLowerCase())) {
            skipped.push(`pricing rule "${rule.name}"`);
            continue;
          }
          await createPricingRule(token, rule);
          bump("pricingRules");
        }

        const takenApproval = new Set((await listApprovalRules(token)).map(rule => rule.name.toLowerCase()));
        for (const rule of parsed.catalog.approvalRules) {
          if (takenApproval.has(rule.name.toLowerCase())) {
            skipped.push(`approval rule "${rule.name}"`);
            continue;
          }
          await createApprovalRule(token, rule);
          bump("approvalRules");
        }

        return Response.json({ created, skipped, warnings: parsed.catalog.warnings }, { status: 201 });
      }),
    },

    /* -------------------------------- quotes ----------------------------- */

    "/api/quotes": {
      GET: guarded(async (token, req) => {
        const all = await listQuotes(token, intParam(query(req), "limit", 50));
        return Response.json(all.map(quote => withExpiry(quote)));
      }),
      POST: guarded(async (token, req) => {
        const { header, lines } = await readQuoteBody(req);
        const preferences = await readPreferences(token);
        const result = await createPricedQuote(token, header, lines, preferences.quoteValidDays);
        return Response.json(result, { status: 201 });
      }),
    },

    /** The approvals queue: quotes submitted to this account by someone else. */
    "/api/quotes/awaiting": {
      GET: guarded(async (token, req) => {
        const me = await sessionUser(req);
        if (!me) return fail("Sign in to continue.", 401);
        return Response.json(await listQuotesAwaiting(token, me.id));
      }),
    },

    /**
     * Prices a quote without storing it.
     *
     * The same code path a save takes, stopping short of the write — for a
     * script working out what something would cost, and for the editor to
     * confirm its own arithmetic against the server's.
     */
    "/api/quotes/preview": {
      POST: guarded(async (token, req) => {
        const { header, lines } = await readQuoteBody(req);
        const [catalogue, rules, approvalRuleList, account] = await Promise.all([
          loadCatalogue(token),
          listPricingRules(token),
          listApprovalRules(token),
          header.accountId ? getAccount(token, header.accountId) : Promise.resolve(null),
        ]);

        const priced = repriceQuote(
          {
            header,
            lines,
            number: "(preview)",
            status: "draft",
            version: 1,
            supersedesId: null,
            customer: snapshotCustomer(account),
            approvals: [],
            approverIds: [],
          },
          catalogue,
          rules,
        );

        const floorByLineId = new Map(
          priced.record.lines.map(line => [line.id, catalogue.byId.get(line.productId)?.floorDiscountPercent ?? 0]),
        );

        const outcome = evaluateApprovals(
          {
            totals: priced.record.totals,
            lines: priced.record.lines,
            termMonths: priced.record.termMonths,
            floorByLineId,
          },
          approvalRuleList,
        );

        return Response.json({
          lines: priced.record.lines,
          totals: priced.record.totals,
          priceBookId: priced.record.priceBookId,
          issues: priced.issues,
          warnings: priced.warnings,
          approvalsRequired: outcome.required,
          autoApproved: outcome.autoApproved,
        });
      }),
    },

    "/api/quotes/:id": {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const quote = await getQuote(token, req.params.id);
        return quote ? Response.json(withExpiry(quote)) : fail("Quote not found.", 404);
      }),
      PUT: guarded<{ params: { id: string } }>(async (token, req) => {
        const { header, lines } = await readQuoteBody(req);
        return Response.json(await saveQuote(token, req.params.id, header, lines));
      }),
      DELETE: guarded<{ params: { id: string } }>(async (token, req) =>
        (await deleteQuote(token, req.params.id))
          ? Response.json({ ok: true })
          : fail("Quote not found, or not yours to delete.", 404),
      ),
    },

    /**
     * Raises an invoice for a whole quote.
     *
     * The quote has to have been sent or accepted — a deposit invoice before
     * the signature comes back is ordinary, billing a draft is not. The
     * invoice arrives as a draft, with warnings naming anything worth reading
     * before it is issued: a quote already invoiced, or a total that does not
     * match the quote's to the penny.
     */
    "/api/quotes/:id/invoice": {
      POST: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await invoiceQuote(token, req.params.id), { status: 201 }),
      ),
    },

    "/api/quotes/:id/submit": {
      POST: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await submitQuote(token, req.params.id)),
      ),
    },

    "/api/quotes/:id/decision": {
      POST: guarded<{ params: { id: string } }>(async (token, req) => {
        const me = await sessionUser(req);
        if (!me) return fail("Sign in to continue.", 401);

        const raw = await body(req);
        const decision = String(raw.decision ?? "");
        if (decision !== "approved" && decision !== "rejected") {
          throw new ApiError('"decision" must be "approved" or "rejected".');
        }

        return Response.json(
          await decideQuote(token, req.params.id, me.email, decision, String(raw.comment ?? "").slice(0, 2_000)),
        );
      }),
    },

    "/api/quotes/:id/status": {
      POST: guarded<{ params: { id: string } }>(async (token, req) => {
        const status = String((await body(req)).status ?? "");
        if (!QUOTE_STATUSES.includes(status as QuoteStatus)) {
          throw new ApiError(`"status" must be one of ${QUOTE_STATUSES.join(", ")}.`);
        }
        return Response.json(await transitionQuote(token, req.params.id, status as QuoteStatus));
      }),
    },

    "/api/quotes/:id/revise": {
      POST: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await reviseQuote(token, req.params.id), { status: 201 }),
      ),
    },

    "/api/quotes/:id/export": {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const quote = await getQuote(token, req.params.id);
        if (!quote) return fail("Quote not found.", 404);
        return exportResponse(quoteRows(quote), formatParam(query(req)) ?? "json", quote.number, withExpiry(quote));
      }),
    },

    /**
     * A quote rendered into a proposal.
     *
     * A template shared with you works here exactly like one of your own, and
     * the render is a pure substitution — see src/lib/proposal.ts.
     */
    "/api/quotes/:id/document": {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const me = await sessionUser(req);
        if (!me) return fail("Sign in to continue.", 401);

        const quote = await getQuote(token, req.params.id);
        if (!quote) return fail("Quote not found.", 404);

        const params = query(req);
        const templateId = params.get("templateId");
        const templates = await listProposalTemplates(token);
        const template = templateId ? templates.find(entry => entry.id === templateId) : templates[0];
        if (!template) {
          return fail(
            templateId ? "Proposal template not found." : "There are no proposal templates yet — create one first.",
            404,
          );
        }

        const context = {
          quote: withExpiry(quote),
          sellerName: me.name || me.email,
          sellerEmail: me.email,
          locale: (await readPreferences(token)).locale || undefined,
        };

        const fileName = proposalFileName(
          `${quote.number}-${quote.customer.name || quote.name}`,
          template.format,
        );

        // A PDF template's body is a document description, not prose, so it
        // goes through the PDF renderer instead. `?inline` here means "render
        // it into an iframe" rather than "hand me the text" — a PDF preview is
        // the PDF, so the only thing that changes is the disposition.
        if (template.format === "pdf") {
          const parsed = readPdfTemplate(template.body);
          if (!parsed.ok) return fail(`“${template.name}” cannot be rendered: ${parsed.error}`, 422);

          const rendered = renderPdf(parsed.value, context);
          return pdfResponse(rendered.bytes, fileName, params.has("inline"));
        }

        const rendered = renderProposal(template.body, template.format, context);

        // `?inline` is for the preview pane, which wants the text and the
        // warnings rather than a download.
        if (params.has("inline")) {
          return Response.json({
            text: rendered.text,
            format: template.format,
            templateId: template.id,
            templateName: template.name,
            unknownTokens: rendered.unknownTokens,
          });
        }

        return fileResponse(rendered.text, CONTENT_TYPES[template.format], fileName);
      }),
    },

    "/api/quotes/:id/shares": shareRoutes("quotes"),

    /* ------------------------------ receivables -------------------------- */

    /**
     * The aging report: what is owed, in five columns, as of a date.
     *
     * `?currency=` because nothing here adds two currencies together — an
     * account is denominated in one, but it can hold an invoice in another,
     * and a book that quietly summed them would be a confident wrong number.
     * `?asOf=` ages it against a date other than today, which is how last
     * month's report gets reproduced.
     */
    "/api/receivables/aging": {
      GET: guarded(async (token, req) => {
        const parameters = query(req);
        const currency = asCurrency(parameters.get("currency") ?? undefined);
        const asOf = parameters.get("asOf") || today();
        const report = await ageReceivables(token, currency, asOf);

        const format = formatParam(parameters);
        if (format === "csv") return exportResponse(agingRows(report), "csv", `aging-${report.asOf}`);
        return Response.json(report);
      }),
    },

    /**
     * Every payment received, newest first — the cash receipts list.
     *
     * A question about payments rather than about invoices, and one that was
     * unaskable while the ledger lived inside the invoice's JSON. `?invoiceId=`
     * narrows it to one invoice's ledger.
     */
    "/api/payments": {
      GET: guarded(async (token, req) => {
        const invoiceId = query(req).get("invoiceId") ?? "";
        const payments = await listPayments(token, invoiceId ? `invoice = "${invoiceId.replace(/"/g, "")}"` : undefined);

        const format = formatParam(query(req));
        if (format !== "csv") return Response.json(payments);

        // The spreadsheet wants invoice numbers and customer names, not ids:
        // it is read beside a bank statement, not beside this database.
        return exportResponse(paymentRows(payments, await listInvoices(token)), "csv", "payments");
      }),
    },

    /** Every credit and write-off. `?invoiceId=` narrows it to one invoice. */
    "/api/credits": {
      GET: guarded(async (token, req) => {
        const invoiceId = query(req).get("invoiceId") ?? "";
        const credits = await listCredits(token, invoiceId ? `invoice = "${invoiceId.replace(/"/g, "")}"` : undefined);

        const format = formatParam(query(req));
        if (format !== "csv") return Response.json(credits);
        return exportResponse(creditRows(credits, await listInvoices(token)), "csv", "credits");
      }),
    },

    "/api/invoices": {
      GET: guarded(async token => Response.json(await listInvoices(token))),

      /**
       * A blank invoice for a customer.
       *
       * Raised as a draft, always: an invoice is issued by a separate,
       * deliberate act, because issuing is what makes it a receivable and
       * fixes its lines.
       */
      POST: guarded(async (token, req) => {
        const raw = await body(req);
        const header = must(readInvoiceHeader(raw));
        const lines = must(readInvoiceLines(raw.lines));
        return Response.json(await createBlankInvoice(token, header, lines), { status: 201 });
      }),
    },

    /** Every invoice as a spreadsheet, with its derived status and aging. */
    "/api/invoices/export": {
      GET: guarded(async (token, req) => {
        const all = await listInvoices(token);
        const format = formatParam(query(req));
        const asOf = query(req).get("asOf") || today();
        if (format === "csv") return exportResponse(invoiceRows(all, asOf), "csv", "receivables");
        return exportResponse(invoiceRows(all, asOf), "json", "receivables", all);
      }),
    },

    "/api/invoices/:id": {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const invoice = await getInvoice(token, req.params.id);
        return invoice ? Response.json(invoice) : fail("Invoice not found.", 404);
      }),
      /** Draft only — an issued invoice is changed with a credit, not an edit. */
      PUT: guarded<{ params: { id: string } }>(async (token, req) => {
        const raw = await body(req);
        const header = must(readInvoiceHeader(raw));
        const lines = must(readInvoiceLines(raw.lines));
        return Response.json(await saveInvoice(token, req.params.id, header, lines));
      }),
      /** Draft only. Anything ever issued is voided instead, to keep the numbers gapless. */
      DELETE: guarded<{ params: { id: string } }>(async (token, req) => {
        await discardInvoice(token, req.params.id);
        return Response.json({ ok: true });
      }),
    },

    "/api/invoices/:id/export": {
      GET: guarded<{ params: { id: string } }>(async (token, req) => {
        const invoice = await getInvoice(token, req.params.id);
        if (!invoice) return fail("Invoice not found.", 404);
        return exportResponse(
          invoiceLineRows(invoice),
          formatParam(query(req)) ?? "json",
          invoice.number,
          invoice,
        );
      }),
    },

    /** Dates it, works out when it falls due, and makes it a receivable. */
    "/api/invoices/:id/issue": {
      POST: guarded<{ params: { id: string } }>(async (token, req) => {
        const on = String((await body(req)).issueDate ?? "").slice(0, 10);
        return Response.json(await issueInvoice(token, req.params.id, on));
      }),
    },

    /** The admission that it should never have been raised. Refused once anything is paid. */
    "/api/invoices/:id/void": {
      POST: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await voidInvoice(token, req.params.id)),
      ),
    },

    "/api/invoices/:id/payments": {
      GET: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await listPayments(token, `invoice = "${req.params.id.replace(/"/g, "")}"`)),
      ),
      POST: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await recordPayment(token, req.params.id, must(readPayment(await body(req)))), { status: 201 }),
      ),
    },

    /** Removes a bookkeeping entry that should not have existed. Not a refund. */
    "/api/invoices/:id/payments/:paymentId": {
      DELETE: guarded<{ params: { id: string; paymentId: string } }>(async (token, req) =>
        Response.json(await removePayment(token, req.params.id, req.params.paymentId)),
      ),
    },

    "/api/invoices/:id/credits": {
      GET: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await listCredits(token, `invoice = "${req.params.id.replace(/"/g, "")}"`)),
      ),
      POST: guarded<{ params: { id: string } }>(async (token, req) =>
        Response.json(await recordCredit(token, req.params.id, must(readCredit(await body(req)))), { status: 201 }),
      ),
    },

    "/api/invoices/:id/credits/:creditId": {
      DELETE: guarded<{ params: { id: string; creditId: string } }>(async (token, req) =>
        Response.json(await removeCredit(token, req.params.id, req.params.creditId)),
      ),
    },

    "/api/invoices/:id/shares": shareRoutes("invoices"),

    /* --------------------------- proposal templates ---------------------- */

    "/api/proposal-templates": proposalTemplates.collection,
    "/api/proposal-templates/:id": proposalTemplates.record,
    "/api/proposal-templates/:id/shares": shareRoutes("proposal-templates"),

    /* --------------------------- workspace, sample ----------------------- */

    /**
     * Everything this account has, as one file: the catalogue, the policy, the
     * customers, the proposal templates and the quotes — its own and the ones
     * shared with it, which are marked as such.
     */
    "/api/export": {
      GET: guarded(async (token, req) => {
        const me = await sessionUser(req);
        if (!me) return fail("Sign in to continue.", 401);

        const [productList, books, pricing, approvals, accountList, templates, quoteList, invoiceList] =
          await Promise.all([
            listProducts(token),
            listPriceBooks(token),
            listPricingRules(token),
            listApprovalRules(token),
            listAccounts(token),
            listProposalTemplates(token),
            listQuotes(token, 0),
            listInvoices(token),
          ]);

        // The list views drop the lines, and a workspace export without them
        // would be a list of numbers. Read each one whole — an invoice for its
        // ledger as much as its lines.
        const [quotes, invoices] = await Promise.all([
          Promise.all(quoteList.map(summary => getQuote(token, summary.id))),
          Promise.all(invoiceList.map(summary => getInvoice(token, summary.id))),
        ]);

        return fileResponse(
          serializeWorkspaceFile({
            ownerId: me.id,
            email: me.email,
            products: productList,
            priceBooks: books,
            pricingRules: pricing,
            approvalRules: approvals,
            accounts: accountList,
            templates,
            quotes: quotes.filter((quote): quote is NonNullable<typeof quote> => quote !== null),
            invoices: invoices.filter((invoice): invoice is NonNullable<typeof invoice> => invoice !== null),
            preferences: me.preferences,
          }),
          "application/json; charset=utf-8",
          workspaceFileName(),
        );
      }),
    },

    "/api/sample": {
      POST: guarded(async (token, req) => {
        const me = await sessionUser(req);
        if (!me) return fail("Sign in to continue.", 401);
        const preferences = await readPreferences(token);
        return Response.json(await installSample(token, me.email, preferences.quoteValidDays), { status: 201 });
      }),
    },

    // Unknown API paths must not fall through to the SPA's HTML.
    "/api/*": handler(req => fail(`No such endpoint: ${req.method} ${new URL(req.url).pathname}. See GET /api.`, 404)),

    // Serve the SPA for everything else.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`📄 CPQ running at ${server.url}`);
console.log(`   data: ${databaseUrl()} (PocketBase)`);
console.log(`   API:  ${new URL("/api", server.url).href}`);
