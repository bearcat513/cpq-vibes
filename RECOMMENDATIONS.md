# Recommendations

What it would take to turn this from a well-built single-seller CPQ into a complete one. Written
against the code as of 2026-11-13 (`main` @ `9d963a9`).

The foundation is unusually solid. Pricing is pure and shared between browser and server, money is
rounded the right way, approvals are cumulative and voided by edits, invoice status is derived
rather than stored, and access control sits in PocketBase. Most of what follows is **breadth**: the
parts of the quote-to-cash loop that a CPQ buyer expects and this app does not have yet. The first
section is the exception. It lists defects that exist today and should be fixed before anything is
built on top of them.

Each item has a priority:

| | Meaning |
| --- | --- |
| **P0** | A defect that produces a wrong document or a wrong number today |
| **P1** | Expected of any production CPQ; its absence blocks real use |
| **P2** | Expected of a mature CPQ; its absence limits who can adopt it |
| **P3** | Differentiators and polish |

## Status

**Done:** all of §1 (fixes 1.1–1.8), all of §2 (documentation drift), and §3.1 (organisations and
roles). Two places differ from this plan:

- **There is no `approver` role.** Approving is being named in a rule, whatever your role, so the
  roles are `admin`, `sales`, `finance` and `viewer`.
- **An API key works only in the organisation it was issued in.** It is refused with a 403 while its
  owner works in another. PocketBase reads `@request.auth` from the stored user record, so a key
  cannot carry an organisation of its own.

Still open from §1.6: invoice lists are not paged on the server yet; only quotes are. Still open
from §3.1: team visibility within an organisation (a manager seeing their team's pipeline), and
approval rules that name a role instead of a person.

Since then, three things not in this plan are done: a **Home dashboard** (the starting screen), a
**desktop window layout with a phone layout** (tab bar, More sheet), and a **launcher** (Ctrl/⌘ K)
with single-key shortcuts. The dashboard covers the "today" end of §3.10; the reporting itself
(trends over time, win/loss by rep and product, saved reports) is still open.

Everything else in §3 is still to do.

---

## 1. Fixes: defects in the current code

### 1.1 P0: Quote and invoice numbers count records the caller can *see*, not records they *own*

`nextQuoteNumber` (`src/server/db.ts:788`) and `nextInvoiceNumber` (`src/server/db.ts:1190`) take
`countRecords(token, …)`. That count runs through the collection's list rule. For quotes the rule is
`MINE_SHARED_OR_APPROVER`, and for invoices it is `MINE_OR_SHARED`. The result:

- Every quote shared with you, and every quote you have been asked to approve, moves your next
  number forward. The sequence picks up gaps that have no explanation.
- When a share is revoked or an approval finishes, the count *drops*. The next number then collides
  with one you already used. `insert` retries only four times (`src/server/invoices.ts:162`). The
  quote path does the same. A big enough drop therefore makes creation fail outright.
- The year in the prefix is cosmetic. The count never resets, so the first quote of 2027 is
  `Q-2027-0143`, not `Q-2027-0001`.
- Invoice numbers are assigned when the **draft** is created, not when it is issued. Discarding a
  draft in the middle of the run leaves a hole in the issued sequence. The code comments call that
  sequence gapless, and in many jurisdictions it must be.

**Fix:** add a `counters` collection keyed `(owner, kind, year)` and increment it from a
`docker/pb_hooks/` route, inside a transaction. Assign the invoice number in `issueInvoice`, not in
`createBlankInvoice`. A draft can show "Draft" instead of a number. Add a test that shares five
quotes with an account and checks that its next number is unaffected.

### 1.2 P0: A revision of a revision is numbered `Q-…-r2-r3`

`reviseQuote` (`src/server/quotes.ts:616`) builds the new number as
`${existing.number}-r${existing.version + 1}`. When `existing` is already a revision, the suffix
piles up. The existing test (`src/server/api.test.ts:489`) only checks for `-r2`. **Fix:** strip any
trailing `-r\d+` from the number first, or store the base number in its own field. Extend the test
to a third revision.

### 1.3 P0: A superseded quote stays live

Revising a quote does nothing to the original. The original can still be accepted, and
`invoiceQuote` will still bill it. Billing two revisions of one deal is not a warning case
(`src/server/invoices.ts:216` only warns about *the same* quote being invoiced twice). It is a
double charge. **Fix:**

- Add a derived `superseded` state: the quote has a newer revision.
- Refuse `sent → accepted` and invoicing on a superseded quote.
- Optionally move the original to `declined`/`superseded` once a revision is sent.
- Decide, and enforce, whether an `accepted` quote may be revised at all. Today it can. Revising an
  accepted quote is really an amendment (see 3.4).

### 1.4 P0: Rupee amounts print as `?` in PDFs

`formatMoney(1234.5, "INR")` returns `₹1,234.50`. U+20B9 is not in WinAnsi, so `encodeWinAnsi`
(`src/lib/pdfFonts.ts:205`) emits byte 63, and every INR quote and invoice reads `?1,234.50`. I ran
this to confirm it. INR is in `CURRENCIES`, so any customer can hit this. **Fix:** add `₹ → "Rs."`
(or `"INR "`) to the degrade table, and add a test that formats every currency in `CURRENCIES` and
asserts the encoded form contains no `?` the source text did not.

### 1.5 P1: "Today" is UTC everywhere

`today()` (`src/lib/receivable.ts:44`), the default payment and credit dates
(`src/lib/validate.ts:1289`, `:1306`), availability windows (`src/lib/configurator.ts:474`) and
quote expiry all use `toISOString().slice(0, 10)`. For a US West Coast business, an invoice due
today turns overdue at 4pm the day before, and a payment banked in the evening is dated tomorrow.
**Fix:** add a workspace timezone setting, and pass `today(tz)` through each of these call sites
rather than calling `new Date()` inside `lib/`.

### 1.6 P1: Quote search only covers the first page

`QuoteList` filters on the client (`src/components/app/QuoteList.tsx:37`). The list comes from
`listQuotes`, which is capped at the preference-sized page (`src/server/db.ts:725`, default 50).
Searching for an old quote by number or customer finds nothing, and says nothing about why.
**Fix:** take `q`, `status`, `page` and `perPage` on `GET /api/quotes`, translate them into a
PocketBase filter, and return `{ items, page, totalItems }`. Apply the same change to invoices.
Document both in `openapi.ts`.

### 1.7 P1: Logging out does not end the session

`/api/auth/logout` (`src/server/auth.ts:108`) clears the cookie. The PocketBase JWT inside it
stays valid until it expires, a week later. A copied cookie survives logout. **Fix:** rotate the
user's `tokenKey` on logout through a hook route. That invalidates every token for the account.
Alternatively, keep a short-lived token with refresh, and offer "sign out everywhere" in Settings.

### 1.8 P2: Usage lines are priced as one-time

`chargeType: "usage"` exists in the type but has no handling in `src/lib/pricing.ts`. `oneTime` is
`netTotal` for any line that is not recurring (`:433`), so a usage line lands in one-time revenue
and in TCV as if its estimated quantity were a firm commitment. Either price it properly (see 3.3),
or report usage separately in `QuoteTotals` (`estimatedUsageTotal`) and keep it out of TCV.

---

## 2. Documentation drift

These cost nothing to fix, and they matter, because both the docs and `CLAUDE.md` are written to be
relied on.

| Where | Says | Reality |
| --- | --- | --- |
| `README.md:24` | "warm parchment… walnut ink… forest green… titles set in a serif" | `CLAUDE.md` and `styles/globals.css`: steel and concrete, oklch, no serif chrome |
| `README.md:404` | "This app resolves an address but never lists one — there is no directory" | `GET /api/directory` exists and is described 75 lines later |
| `PROJECT_STRUCTURE.md` §9, §11 | Telegram notifications, `lib/telegram.ts`, `<APP>_SCRIPT_*` user scripts | None of these exist. The file appears to come from the dummy-data generator this grew out of |
| `README.md:500` | "eleven collections" | Correct today, but the number is hand-maintained. Generate the table, or drop the count |
| `package.json` | `"version": "0.0.01"` | Not valid semver (leading zero). Use `0.1.0` |

Also consider descriptive commit messages. The recent history is five commits named `.`, and that
makes `git log`/`git bisect` useless for anyone reading the decisions this codebase documents so
carefully.

---

## 3. Features

### 3.1 Organisations, roles and a shared workspace (P1, the largest gap)

Today every account is its own island. Each user has their own catalogue, price books, pricing
rules and approval ladder, and sharing is read-only and per record. A sales team cannot use that:
the catalogue and the commercial policy have to be **one set, owned by the company**, edited by a
few people and quoted from by everyone.

- **`organizations` collection plus `memberships(user, org, role)`.** Roles: `admin` (catalogue,
  rules, templates, members), `sales` (quotes and customers), `approver`, `finance` (invoices,
  payments, credits), `viewer`.
- **Every owned record gains `org`.** Rules become `org.memberships.user ?= @request.auth.id` plus
  a role check, and this stays in PocketBase, as `CLAUDE.md` requires. `OWNED` in
  `docker/pb_hooks/rules/ownership.js` stamps `org` from the caller's active membership.
- **Record-level ownership stays for quotes and customers**, with team visibility (a sales manager
  sees their team's pipeline).
- **Invite-only sign-up** per organisation, which also closes the "anyone who registers sees every
  address" exposure in the directory (`README.md:482`).
- **Migration path:** each existing user becomes the admin of a one-person org. The
  `1750000004_multi_approver.js` SQL-backfill pattern applies.

Most other P1 items get simpler once this exists: counters keyed by org, approvals that name
roles, finance-only screens.

### 3.2 Getting the quote to the customer, and back (P1)

The lifecycle ends at `sent`, but nothing is sent. `accepted` is a button the rep presses.

- **Email delivery.** Send a quote or an invoice from the app with the rendered PDF attached.
  PocketBase already has an SMTP mailer (`$app.newMailClient()`), so this belongs in a hook route.
  Record each send (to, at, template, message id) on the quote.
- **A customer-facing quote page.** A signed, expiring, unguessable link (`/q/:token`) that renders
  the quote, lets the buyer download the PDF, and accepts or declines it with name, title, PO
  number and a typed signature. Acceptance stamps `decidedAt`, the signer's details, the IP and a
  hash of the rendered document, so "what did they sign" stays answerable. The token resolves to
  a single quote through a hook, and the buyer never gets a PocketBase account.
- **E-signature integration** (DocuSign, Dropbox Sign) as an alternative to the built-in accept,
  for buyers whose legal team insists.
- **View tracking.** First opened, last opened, how many times. Reps rely on it.
- **Expiry reminders.** "Your quote expires in 3 days" to the buyer, and "Q-0042 expired unsigned"
  to the rep. Expiry is already derived, so this is a scheduled job (`cronAdd` in a hook) that
  reads it.

### 3.3 Pricing depth (P1–P2)

| Feature | Why | Notes |
| --- | --- | --- |
| **Usage and consumption pricing** (P1) | Most SaaS and services deals include it | Rate cards (per-unit, tiered, volume), committed spend with drawdown, overage rates, estimated quantity kept separate from TCV. Fixes 1.8 |
| **Per-product tax** (P1) | One `taxPercent` per quote (`src/lib/pricing.ts:514`) cannot quote a taxable product and an exempt service together | `taxCode` on products, rate by code and ship-to jurisdiction on the account; invoice lines already carry `taxPercent` per line. Later, an Avalara or TaxJar adapter behind the same interface |
| **Multi-currency with FX** (P2) | Today a non-USD quote needs its own price book with every price retyped | An FX rate table (dated, manual or fetched), price books that derive from a base book with a rate and rounding rule (`× 0.92, round to .99`), and the rate snapshotted on the quote |
| **Term and ramp deals** (P2) | Multi-year deals often step up: year 1 at 60%, year 2 at 80%, year 3 at full price | Per-segment lines (`segment: 1..n`, own start/end, quantity, discount); totals by year; the proposal renders a year-by-year table |
| **Discount schedules** (P2) | Term-length and cumulative-quantity discounts are expressible as pricing rules today, but awkwardly | First-class schedules attachable to a product, editable as a table |
| **Cost-plus and percent-of-total pricing** (P2) | Services, support and maintenance are often "18% of the licence total" | The healthcare sample works around this; make it a `pricing method` on the product: `list`, `costPlus(markup)`, `percentOf(family/sku, %)` |
| **Price book versioning** (P2) | `validFrom`/`validTo` exist, but editing a book changes it in place | Book versions, so next year's prices can be staged and a quote reprices against the version that was in effect |
| **Proration and co-terming** (P2) | Needed for adding seats mid-term | Depends on contracts (3.4) |
| **Rounding rules** (P3) | "Prices end in .99", "round to the nearest 10" | A per-book rounding step after rules, before the floor |

### 3.4 After "accepted": contracts, subscriptions and billing (P1–P2)

Today the only downstream object is an invoice for the whole contract value. A subscription CPQ
needs the contract it created:

- **`contracts` / `subscriptions` collection** (P1), created on acceptance: the recurring lines,
  start and end dates, quantities, and the accepted price per unit. This is what the next quote for
  the customer starts from.
- **Billing schedules** (P1), which `CLAUDE.md` already names as the next layer. Generate the
  invoice run from the contract (annual in advance, quarterly, milestones for services) rather than
  one invoice for the TCV. A scheduled hook raises the drafts as they come due.
- **Amendments** (P2). "Add 20 seats from March" produces a quote whose lines are *deltas* against
  the contract, prorated and co-termed to its end date. This replaces revising an accepted quote
  (see 1.3).
- **Renewals** (P2). A renewal quote is generated N days before the end date, at the contract
  prices plus an uplift rule (`renewal uplift 5%`), and shows in a renewals pipeline.
- **Cancellation and downgrade** (P3), with credit and proration handling.

### 3.5 Deals and pipeline (P2)

A quote is currently the top-level object, and revisions are linked only by `supersedesId`.

- **`opportunities`** (or "deals"): the account, the expected close date, the stage and the owner.
  An opportunity holds several quotes (alternatives as well as revisions) and marks one as
  **primary**, which is the one counted in pipeline.
- **Quote comparison.** A side-by-side view of two revisions or two alternatives: lines added,
  removed or changed, and totals moved. The data is already there, because every line snapshots its
  price walk.
- **Win/loss reason** on decline, as a picklist, so reporting means something.

### 3.6 Approvals (P1–P2)

The ladder itself is strong. What surrounds it is thin.

- **Notifications** (P1). Email (and optionally Slack or Teams) to approvers when their level comes
  up, and to the rep when a decision lands. Today an approver has to open the Approvals screen to
  find out.
- **Approve from the notification** (P2): a signed one-click link that records the decision through
  the same hook (`docker/pb_hooks/rules/approvals.js`).
- **Delegation and out-of-office** (P2). An approver names a delegate for a date range. Without
  this, a quote sits in review for as long as the VP is on holiday.
- **Escalation and SLA** (P2). A request pending past N hours escalates to the next level or to
  a named fallback.
- **Role-based approvers** (P2, after 3.1). "Any `finance` member" rather than a list of emails
  that rots as people leave.
- **Requester justification** (P2). The rep attaches a reason at submit time, and the approver sees
  it next to the numbers.

### 3.7 Audit trail (P1)

Finance and compliance will ask who changed a price, who approved a discount, and who voided an
invoice. Add an append-only `events` collection, written by a hook on create, update and delete for
quotes, invoices, payments, credits, products, price books and rules. Store actor, time, action,
the fields changed, and old and new values for scalar columns. Make it readable by the record's
owner and org admins, and writable by nobody through the API. Show it as a timeline on the quote,
invoice and product screens.

### 3.8 Receivables (P2)

- **Online payment** via a Stripe or PayPal payment link on the invoice and on its customer page.
  A webhook (in a hook route, verified by signature) records the payment, so the ledger fills
  itself.
- **Dunning.** Reminder schedules relative to the due date ("3 days before", "on the day", "7 days
  late", "30 days late"), using the template system's invoice vocabulary.
- **Credit notes as documents.** A credit currently exists only as a ledger row. Many jurisdictions
  require a numbered credit note document. Add a `credit_note` template kind with its own
  vocabulary, following the "adding a third kind" checklist in `TEMPLATES.md` §4.
- **Customer statements.** All open items and ageing for one account, as a PDF.
- **Refunds** for an overpaid (negative-balance) invoice, as a ledger entry of their own.
- **Deposits and partial invoicing** from a quote (a percentage or a set of lines) as a guided
  action, instead of hand-editing the invoice that `invoiceQuote` raises.

### 3.9 Catalogue (P2)

- **Product images** on the product and in the picker, using the same `data:` URL and `image.ts`
  path that templates already use, so a proposal can show them.
- **Categories as a hierarchy** rather than one flat `family` string, with browsing in the product
  picker.
- **Guided selling.** A short questionnaire ("How many users? Do you need on-prem?") that
  recommends products and pre-selects options. The formula language and `visibleWhen` already
  provide most of the machinery.
- **Quote line templates and favourites.** Save a set of configured lines as a starter ("Standard
  mid-market bundle") and insert it into any quote.
- **Bulk edit.** Raise every price in a family by 5%, or deactivate a set of SKUs, with a preview.
  Today this is a per-product sheet or a round trip through CSV.
- **Product lifecycle.** Beyond `active`: `end_of_sale` (no new quotes, renewals allowed) and
  `end_of_life`, with a replacement SKU the configurator suggests.

### 3.10 Reporting and dashboards (P2)

There is no home screen. A rep opens the app to a list and a manager has nowhere to look.
`src/lib/customers.ts` already computes pipeline and win rate per account. Lift that to the
workspace:

- **Sales:** open pipeline by stage and close month, win rate, average discount, average deal size,
  quote-to-close time.
- **Pricing health:** discount distribution by product and by rep, floor breaches, how often each
  pricing rule fires, and margin by family (cost-visible roles only).
- **Approvals:** cycle time per level, approval and rejection rates, and the oldest pending items.
- **Revenue:** booked ARR, MRR and TCV by month, and renewals due.
- **Receivables:** DSO, ageing trend, collected versus invoiced.

Keep the aggregation pure in `lib/` and never add two currencies together, as `customers.ts`
already insists. Report per currency, or convert at a stated rate once FX (3.3) exists.

### 3.11 Integrations and automation (P2)

- **Outbound webhooks.** Subscribe a URL to `quote.sent`, `quote.accepted`, `invoice.issued`,
  `payment.recorded` and so on. Sign each delivery with HMAC, and retry with backoff. Configure
  them per org next to API keys. Most integrations need nothing more.
- **CRM sync** (Salesforce, HubSpot): accounts and contacts in, quotes and their status out,
  keyed by external id fields on `accounts` and `quotes`.
- **Accounting sync** (QuickBooks, Xero): issued invoices, payments and credits out. Customers
  matched by external id.
- **Generated API client.** The OpenAPI 3.0.3 document is already complete. Publish a typed
  TypeScript client generated from it, and use it in `src/lib/api.ts` so the UI cannot drift from
  the contract.
- **Idempotency keys** on `POST` (`Idempotency-Key` header), so a retried script cannot create two
  quotes or record a payment twice. This matters more now that API keys invite automation.

### 3.12 Authentication and accounts (P1–P2)

- **Password reset and email verification** (P1). PocketBase supports both natively. They need
  SMTP configured and two screens.
- **Login rate limiting** (P1). Turn on PocketBase's built-in rate limiter for the auth endpoints
  in a migration, so a fresh volume gets it too.
- **SSO** (P2): OAuth2 (Google, Microsoft) through PocketBase's providers, and SAML/OIDC per org
  after 3.1.
- **MFA** (P2): PocketBase supports OTP and MFA on auth collections.
- **API key scopes** (P3). Read-only keys and per-collection keys, enforced in the key middleware by
  refusing write methods. A key cannot widen its owner's access, only narrow it.

### 3.13 UX (P2–P3)

- **Clone a quote** (P2) as a new deal, as distinct from a revision. A different customer is the
  common case.
- **Keyboard flow in the quote editor** (P2): add a line, search products and move between rows
  without the mouse. Reps build quotes at speed.
- **Bulk line actions** (P2): apply a discount or a term to selected lines, and reorder lines by
  drag (`sortOrder` already exists).
- **Unsaved-changes guard** (P2) when closing a sheet with edits in it.
- **Optimistic concurrency** (P2). Two people editing one record silently last-write-wins. Send
  PocketBase's `updated` as an `If-Match` and refuse a stale write with a sentence.
- **Accessibility pass** (P3): focus management in `Sheet` and `Dialog`, an `aria-live` region for
  the totals that reprice as you type, and a check of the combobox against the WAI-ARIA pattern.
- **Localisation** (P3). A `locale` preference exists. Externalise the UI strings and the proposal
  vocabulary labels, and expand the PDF writer past WinAnsi (an embedded subset font) so non-Latin
  customer names render. That is a real dependency decision, given the no-embedded-fonts trade the
  writer makes on purpose.

### 3.14 Operations (P1)

- **Backups.** `pb_data` is a single Docker volume with no backup story. Document and schedule
  PocketBase's built-in backups (to S3-compatible storage). Add a restore runbook and test it.
- **CI.** There is no `.github/`. Run `bun test` (with Docker, so the PocketBase suite actually
  runs), `tsc --noEmit` and `bun run build` on every push.
- **Production deployment guide.** HTTPS termination (the cookie's `Secure` flag depends on
  detecting it), `POCKETBASE_URL`, keeping PocketBase's port private, SMTP, and backup
  configuration.
- **Structured logging and request ids.** Log one line per request with method, path, status,
  duration and a request id echoed in the response, and add the id to error bodies so a user's
  bug report can be traced.
- **Health detail.** `/api/health` should report PocketBase reachability and the migration version,
  so a deploy probe can fail on a fresh volume that is missing a migration.

---

## 4. Suggested order

1. **The P0 fixes (§1.1–1.4)**, each with the test that would have caught it. They are small, and
   two of them (numbering and superseded quotes) put wrong numbers in front of customers and
   accountants.
2. **Docs drift (§2) and CI (§3.14)**, so later work lands on a pipeline that runs the PocketBase
   suite.
3. **Organisations and roles (§3.1).** This is the one change that alters every collection rule, so
   it should come before anything else adds collections that would have to be migrated twice.
4. **Server-side search and pagination (§1.6), the audit trail (§3.7), and auth basics (§3.12
   P1).**
5. **Email, the customer quote page and approval notifications (§3.2, §3.6).** This closes the loop
   from "sent" to "accepted" without the rep pressing a button for the customer.
6. **Contracts, billing schedules and per-product tax (§3.4, §3.3).** This turns an accepted quote
   into recurring revenue instead of one invoice.
7. **Everything else**, ordered by what your first real users ask for. Reporting (§3.10) and
   webhooks (§3.11) are usually first.
