
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## This project

A CPQ app: catalogue (products with options, configuration rules, volume tiers and bundles), price
books, pricing and approval rules, quotes, proposal documents, and the receivables ledger the
accepted ones turn into.

Storage is **PocketBase**, not `bun:sqlite`. The app and the database run together under Docker
Compose (`bun run docker:up`).

**Access control lives in PocketBase, not in the Bun server.** Every request carries the caller's
own credential — an httpOnly cookie, an `Authorization` header, or an `X-API-Key` — and the
collection rules decide what they may see. The server holds no credentials and can grant nothing on
its own. Never reintroduce a superuser client for ordinary reads and writes; if something needs
privilege, it belongs in `docker/pb_hooks/` as a route, the way sharing, approver stamping and key
issuing do.

**An API key is a credential, not a second access model.** `cpq_` plus 40 random characters; only
its SHA-256 is stored, hidden, so the raw value exists in the issuing response and nowhere else. A
middleware in `docker/pb_hooks/lib/apiKeys.js` resolves one to its owner's `@request.auth`, which is
the whole point: every rule already written applies to a key unchanged. `clientFor` in
`src/server/pocketbase.ts` picks the header by the prefix and everything downstream passes one
string through without caring which it holds. **A key may not manage keys** — issuing and revoking
take `requireSessionToken`, and PocketBase refuses a key of its own accord, because revocation is
how you recover from a leak. `api_keys` is the one collection deliberately *not* in `OWNED`: it
keys off `user`, set by the hook that creates the record. **A key belongs to the organization it was
issued in, and is refused (403) while its owner works in another.** It cannot carry an organization
of its own: PocketBase resolves `@request.auth.*` in a rule by reading the *stored* user record, not
the in-memory `e.auth` the middleware sets, so overriding `org` on the auth record changes nothing a
rule sees. Refusing the key is the only honest option.

**Records belong to an organization; roles decide who changes them.** `organizations`,
`memberships` (org, user, role) and `invitations` are collections; `users` carries a denormalized
`org` (the one you are working in) and `role` (your role there), because a rule can only read
`@request.auth.<field>`. Only the hooks in `docker/pb_hooks/lib/orgs.js` write those two fields or
a membership — `setup/members.js` clears them from any user create or update request, and keeps
`role` in step with the active membership. Every `OWNED` collection has an `org` relation, stamped
and restored by `rules/ownership.js` exactly like `owner`. The rules are built from `IN_ORG` and
`role(...)` in `1750000010_organizations.js`: everybody in the org reads, and writes go to

| Role | Writes |
| --- | --- |
| `admin` | everything, the organization and its members included |
| `sales` | accounts, and quotes it owns (an admin edits any quote) |
| `finance` | accounts (not deleting them), invoices, payments, credits |
| `viewer` | nothing |

There is no approver role: approving is being named by a rule, which still grants read access to
that one quote across organizations. `sharedWith` is now for reaching someone *outside* the
organization. `src/lib/organization.ts` holds the same table as `PERMISSIONS` — the UI hides what a
role cannot do (`components/app/access.tsx`, `useAccess()`), and `requirePermission` in
`src/server/context.ts` refuses a batch write (a sample install, a catalogue import) before its
first write rather than halfway through. Neither grants anything; the rules do. **Change a role's
reach in both places**, the migration's rules and `PERMISSIONS`, or the UI will offer what PocketBase
refuses. A new user joins every org that invited its address, or gets a personal org as admin;
`CPQ_SIGNUP=invite` (an env var on the `pocketbase` service) refuses an uninvited sign-up except the
very first account. The last admin cannot be removed or demoted.

**Every request knows its organization.** `guarded` in `src/index.ts` asks PocketBase
(`GET /api/cpq/context`) who the credential is, and runs the handler inside an AsyncLocalStorage
(`src/server/context.ts`). `requireContext()` gives the user, org, role and memberships — use it
rather than another round trip. **"Today" is the organization's date**: `src/lib/clock.ts` has
`today()` read a time-zone provider, which the server points at the request's org and the browser at
the signed-in org, so expiry, due dates and overdue all turn over at the org's midnight. Never write
`new Date().toISOString().slice(0, 10)` for a business date — use `today()` or `addDaysTo`.

**Numbers come from counters, through a hook.** `counters` (org, kind, year, value; no user rules
at all) is incremented inside a transaction by `POST /api/cpq/numbers/{kind}` — two reps saving at
once get two numbers. Quotes take one on create; **an invoice takes one when it is issued**
(`POST /api/cpq/invoices/{id}/issue`), and is `DRAFT-<id>` until then, so a discarded draft leaves
no gap. The update hook refuses moving an invoice from draft to issued any other way.

**Signing out revokes the token.** `revoked_tokens` holds the SHA-256 of each signed-out token until
its own expiry, a `routerUse` middleware in `lib/sessions.js` refuses one with a 401, and a daily
cron sweeps the table. "Sign out everywhere" rotates the user's `tokenKey`, which kills every JWT
at once. Neither touches API keys.

**The API documents itself from one list.** `src/server/openapi.ts` holds every endpoint, and all
three surfaces print it: `GET /api/openapi.json` (the document), `GET /api` (its index, via
`endpointIndex()`), and `/docs` (a React page that fetches and renders it, and can call it). Adding
a route means adding an operation there — never a second list somewhere else, and never a bound
retyped rather than imported from `lib/`. `src/lib/openapiDoc.ts` reads a document back and knows
nothing about this API, so a new endpoint appears on `/docs` with nothing else to change.
`src/server/openapi.test.ts` asserts that every documented path is one the route table answers on.
OpenAPI 3.0.3, not 3.1 — every tool reads 3.0 today.

**The server prices every quote and totals every invoice it stores.** Totals in a request body are
ignored and overwritten. The engine is pure and lives in `src/lib/`, so the browser runs it for live
feedback and the server runs the same code for the record — never fork them. For an invoice the
stakes are sharper: a client that could set its own balance could mark its own debts paid.

- `src/lib/pricing.ts` — the pricing pipeline, and `PRICING_VARIABLES` for the rule editors
- `src/lib/money.ts` — round at every step, to the currency's precision; sum rounded numbers only
- `src/lib/formula.ts` — the expression language (no `eval`), shared by pricing, approvals and
  product validation
- `src/lib/configurator.ts` — option groups and configuration rules
- `src/lib/customers.ts` — the customer roll-up (open pipeline, won, win rate) and the searching
  and sorting behind the customers list. Pure, and it **never adds up two currencies**: a quote
  written in something other than the account's currency is counted and reported, never summed
- `src/lib/approvals.ts` — the approval ladder. Levels are cumulative, an edit voids decisions, and
  a rule asks several people with separate approve/reject quorums. A request's `status` is derived
  by `requestStatus` from the votes it carries, never assigned
- `src/lib/receivable.ts` — accounts receivable, and the one file to read before touching an
  invoice. **Nothing about an invoice's condition is stored**: only `state` (draft / issued / void)
  is recorded, and `invoiceStatus` derives open, part paid, paid and overdue from the ledger and the
  date every time they are asked for — a stored "overdue" is wrong the morning after it is written.
  The totals split in two for the same reason: `lineTotals` is a pure function of the invoice's own
  lines and is stored with it, while `settlement` (paid, credited, **balance**) is a function of two
  other collections and is recomputed on every read. A balance **may go negative** — an overpaid
  invoice owes money back, and clamping it at zero loses a customer's money. Aging buckets the
  balance, not the total, and never adds two currencies
- `src/lib/document.ts` — `{{token}}` rendering, escaped per format, and the repeating line
  block. It knows nothing about quotes or invoices: a **vocabulary** supplies the values
- `src/lib/proposal.ts` / `src/lib/invoiceDocument.ts` — the two vocabularies, one per
  `TemplateKind`. Templates are **one collection with a `kind`**, because a template is a
  template — same editor, same letterhead, same block language — and only the meaning of a
  token differs. A quote template will not render an invoice: every token would resolve to a
  blank, so the route refuses it rather than sending a document full of holes. The invoice
  vocabulary derives `{{invoice.status}}` and the balance **as it renders** — see
  `receivable.ts` — so an invoice printed the morning after it falls due says so
- `src/lib/pdf.ts` / `pdfFonts.ts` — a dependency-free PDF writer: a top-down cursor, tables that
  paginate, the standard 14 fonts and WinAnsi encoding, image XObjects, and one `ExtGState` per
  distinct transparency (what a watermark is drawn through). No embedded fonts. Text literals reach
  the content stream as **byte runs marked with NULs** — `drawTextAt` writes `` `\0${bytes}\0 Tj` ``
  and `serializeOperators` splices them; write that marker as a space and the operator is emitted
  as the literal digits. `onEachPage(draw, { beneath: true })` puts an overlay *under* the page's
  own content, by drawing into an empty operator list and splicing it in front
- `src/lib/image.ts` — what may go on a document. It **decodes nothing**: a JPEG is PDF's
  `DCTDecode` stream and a PNG's `IDAT` is `FlateDecode` with a predictor, so an embeddable image
  is copied in byte for byte and everything else (alpha, interlace, CMYK, progressive) is refused
  with a sentence. `src/lib/imageFile.ts` is the browser-only converter that makes those refusals
  invisible in the UI — it flattens and re-encodes through a canvas
- `src/lib/pdfTemplate.ts` — PDF templates as a block document. Pure, so the editor's preview is
  rendered by the same code as the download. One renderer, two vocabularies: it draws a
  `PdfSource` (`quotePdfSource` / `invoicePdfSource`) and never sees a quote or an invoice
  itself. Its totals lists are closed and customer-facing: no template of either kind has a
  way to name cost or margin, and neither can name the other kind's numbers. Branding — an `image` block, and a `header`
  letterhead drawn on every page — lives **inside the template** as a `data:` URL, so it survives
  an export, a share and an import; `tools/sampleBrand.ts` draws the sample workspace's logo.
  A template is four things beside its blocks: `page` (paper, margins, face, colours), `style`,
  `header` and `watermark`
- **The house style is `PdfStyle`, and it is where a renderer constant goes to become a setting.**
  Leading, the paragraph gap, the heading scale, an optional heading face, capitals, the rule
  colour, and the line-item table's fill, header colour, zebra, grid, padding and row lines. Two
  rules: **every default reproduces the constant it replaced**, so a template written before it
  existed renders as it did — which is why `defaultStyle` derives `headingScale` from the body size
  rather than fixing it (a heading used to be body + 9pt, a *step*, not a ratio) — and **a block
  still wins over the document** where it says anything, so one template can hold two tables that
  do not look alike. `style` is optional on the type and resolved by the renderer, but the
  validator always writes one, so a stored body carries its whole style and the defaults cannot
  shift under it later. The exceptions worth knowing: the totals rule stays the accent colour (it
  underlines the number the document is about), and the table grid is its own colour rather than
  `ruleColor` (a grid is read *through*; a divider is read)
- **A `watermark` is page furniture, not a block.** Token-resolved like everything else — the
  sample order form stamps `{{quote.status}}` in capitals, so the stamp reads the record rather
  than the template — and drawn *beneath* the content, so a stamped document is no harder to read
  than a clean one. No text is no watermark: the key is dropped rather than stored empty, the same
  rule the letterhead follows
- `src/lib/validate.ts` — every untrusted input, shared by the REST API and the file importer
- `src/lib/samples.ts` / `samplesHealthcare.ts` — the two worked examples, installed by
  `src/server/seed.ts` (`POST /api/sample?set=`). The second is the workbook in `tools/`, and its
  header explains how block and percent-of-license pricing map onto this engine
- `src/lib/quoteLifecycle.ts` — `effectiveStatus`: the two statuses that are **derived, never
  stored**. A sent quote past `validUntil` is `expired`; one with `supersededById` set (and not
  accepted) is `superseded`. Every read path that returns a quote applies `withLifecycle`, and every
  guard that asks "can this be sent / invoiced" asks `effectiveStatus`, not `quote.status`
- `src/server/quotes.ts` — pricing orchestration, lifecycle and revisions. A revision is numbered
  from the original (`Q-2026-0007-r3`, never `-r2-r3`), only the latest may be revised, an accepted
  quote may not be, and creating one stamps `supersededBy` on its parent — through a hook, which
  checks the named record really revises it. Delete the revision and the parent comes back
- `src/server/invoices.ts` — the receivables orchestration, and where three rules are enforced
  rather than left to the UI: **an issued invoice's lines are fixed** (change what is owed with a
  credit, not an edit), **only an issued invoice has a ledger** (nothing to pay against a draft),
  and **nothing ever issued is deleted** — invoice numbers have to be gapless, so a draft may be
  discarded and anything past that is voided. Voiding is refused once a payment exists; an
  over-credit is refused because unlike an overpayment it is always a typo on your own side.
  `invoiceQuote` bills a sent or accepted quote for its whole contract value, with the quote
  discount, any adjustment and shipping as their own lines, and warns rather than hides it when the
  total lands a penny off the quote's. Billing a subscription period by period is a billing
  schedule — the obvious next layer, and deliberately not here. The quote editor offers it as
  *Create invoice* on an accepted quote. Any draft can also name its quote (`quoteId`, the
  invoice's `quote` relation): omitted from a save it is kept, `null` unlinks it, and the quote is
  read as the caller, so one they cannot see is refused (`quoteReference`)
- `src/server/db.ts` — the collections. Every call takes a token and is async
- `src/server/share.ts` — proxies to PocketBase's `/api/cpq/...` hook routes: sharing, approver
  stamping, and the directory (`GET /api/directory`, id/email/name only, **members of your own
  organization only**). All three need to read `users`, which no user token may do, so they live in
  `docker/pb_hooks/`. Proxying goes through `callHook` in `src/server/pocketbase.ts`
- `src/server/orgs.ts` — the organization routes. Membership changes proxy to `orgs/routes.js`;
  renaming or retiming the org is a plain record update its rules limit to admins
- `src/server/apiKeys.ts` — listing and revoking are ordinary record calls the collection's own
  rules allow; only issuing proxies to a hook, because only issuing has to hash a secret and hand
  the raw value back once
- `src/lib/attachments.ts` / `src/server/attachments.ts` / `components/app/Attachments.tsx` — files
  on a customer, quote, invoice or approval, all in **one `sys_attachment` collection** keyed by
  `target` + `recordId` rather than a file field per collection. An approval attachment's
  `recordId` is the *quote's* id (requests are re-minted on every reprice). **You see an attachment
  if you can see its record** — the rules in `1750000012_attachments.js` join through
  `@collection.<name>:alias` to repeat each target's audience — and you attach where you could
  edit the record, plus any approver on the approval, from any org. `rules/attachments.js` stamps
  `org` from the **record**, not the uploader (so it is not in `OWNED`), takes name and size from
  the upload itself, caps files per record, and deletes a record's files when the record goes. The
  file field is `protected`; bytes are served only through `GET /api/attachments/:id/file`, which
  mints a file token as the caller and serves anything not in `INLINE_TYPES` as a sandboxed download
- `src/server/openapi.ts` — the document, and the only list of endpoints. See above
- `src/lib/openapiDoc.ts` / `markdown.ts` / `highlight.ts` / `curl.ts` — what `/docs` is built from,
  all pure: reading a document, the little Markdown a description carries, colouring JSON, and
  writing a request out as cURL with the credential as a shell variable rather than as itself
- `docker/pb_migrations/` — collections, ownership fields, API rules. A schema change is a new
  migration file here, not a dashboard edit, or a fresh volume comes up without it. **A JSON field
  reaches the JSVM as a byte array (`types.JSONRaw`)**, so reading one, mutating it and saving runs
  without error and writes nothing — do data backfills in SQL with SQLite's `json_set`, the way
  `1750000004_multi_approver.js` does, and test the statement (`src/server/migration.test.ts`).
  `1750000007_ledger_collections.js` fans a JSON array *out* into rows with `json_each`, and its
  statements are tested the same way — it is the one migration that moves data rather than adding
  to it, so a dropped row would be a customer's payment with nothing left to recover it from.
  `1750000010_organizations.js` gives every existing user a personal org (`org_<user id>`) as its
  admin and stamps every record with its owner's org — all as exported, tested SQL constants, and
  idempotent, so a re-run changes nothing. It also seeds the counters from the highest number
  already used, so the next one does not collide.
  `1750000014_account_normalize.js` breaks `accounts.details` into columns, `contacts` and
  `sys_physical_location` the same way — exported SQL, tested, idempotent, ids derived from the
  account's so a re-run finds its own rows. Mind SQL's NULLs there: `NOT (x AND json_type(…) = …)`
  is NULL, not true, when the path is missing, and silently skips the row.
  `1750000016_line_items.js` fans `quotes.lines` and `invoices.lines` out into `quote_lines` and
  `invoice_lines` the same way, and its down rebuilds both arrays exactly. Filter `json_each` rows on
  `entry.type = 'object'`, never `json_type(entry.value)`: a string element reaches `json_type` as
  bare text and the whole statement fails on "malformed JSON".
- `docker/pb_hooks/` — server-side JS run by PocketBase's own JSVM, not by Bun. **A hook body
  cannot see its file's scope**: declare what a handler needs inside the handler, or `require` it
  there. Code that breaks this rule registers fine and fails only at runtime

Each collection keeps real columns for what the database queries on and one JSON field for the
nested domain object the app reads whole.

**The look is steel and concrete, and it lives in `styles/globals.css`.** The palette is oklch —
cool concrete, graphite ink, and the signal colours of a plant floor for anything live, late or
wrong — with a dark mode that is the same shop on the night shift. Corners are machined rather
than moulded (`--radius` is `0.25rem`, so `rounded-sm` is square). Four utilities carry it: `slab`
(the page: flat concrete, a drafting grid and raking light), `panel` (a plate laid on it — cards,
form panels, menus), `rail` (the scribed line down the nav's mounting edge) and `seam` (the
hairline a panel seam leaves under a heading). Use those rather than `bg-card` / `bg-background`
for surfaces, and `font-display` for titles and for a number meant to read as machined.
`--font-serif` still exists, but only for the reading faces that offer a serif — no chrome is set
in it.

**The accent and the reading face are preferences.** Seven signal colours, each one a `--tint-hue`
and a chroma trim under `[data-accent=…]`, from which every tinted role (`--primary`, `--ring`,
the sidebar's live colours) is *derived* — so never write a colour literal for one of those
roles, and add an accent by adding the hue there and the name to `ACCENTS`. The status tones do
not follow it: `--signal` still means paid and `--alert` still means overdue, or a state told by
colour would start lying the moment somebody picked that colour. Those four (`signal`, `hazard`,
`alert`, `flare`) are mapped through `@theme inline`, so they change with the theme and
`text-alert` needs no `dark:` twin. **Their lightness is solved, not chosen**: a chip is the tone
at 10% over the panel behind it, and each tone is as dark (or as light) as it has to be to clear
4.5:1 against both that chip and the bare ground — which is why `--hazard` reads bronze in the
light theme. Retune one and check the pair again before shipping it. The face is `--font-sans`
under `[data-font=…]`, system stacks only; headings keep `--font-display`. `App.tsx` puts both on
`<html>`, which is why the settings swatches can carry their own `data-accent` and paint
themselves.

**Texture is a background layer, never anything text sits on**, and it is built from repeating
gradients rather than an SVG noise tile — a tiled `feTurbulence` seams visibly at the tile edges
and puts a faint checkerboard across the page. The drafting grid (`--mesh`) is on `slab` only: it
would restart at the corner of every panel laid on it, and a grid that does not line up with the
grid beside it is worse than none. The mill grain (`--tooth`) tiles at four pixels, so panels wear
that instead.

**Motion is `motion-safe:` and under half a second.** The named animations (`rise`, `extend`,
`settle`, `weld`, `tilt`, `drift`, `throb`) are declared as `--animate-*` in the theme, so use
`animate-rise` rather than an inline keyframe. They are machine motion — driven along an axis on a
sharp ease, nothing overshoots. Entrance animations fill `both` and therefore start at
`opacity: 0` — which is why a screenshot tool that does not run animations photographs an empty
page. `prefers-reduced-motion` is honoured globally at the bottom of the stylesheet.

**The frame is `components/app/Chrome.tsx`, and `components/app/navigation.tsx` is its one table.**
On `lg` and up the app is a desktop window — `h-dvh`, never scrolling as a page, with the sidebar,
a title bar and a status bar around `<main>`, the only scrolling region. Below `lg` those go and a
top bar plus a bottom tab bar (`MOBILE_TABS`, then *More*) replace them, and `<main>` pads itself
clear of the tab bar and the safe-area insets. `navigation.tsx` lists every screen (`VIEWS`, with
the letter of its `g` shortcut), everything that can be started (`CREATES`, with the permission it
needs) and `SHORTCUTS`; the sidebar, the tab bar, the launcher, the dashboard and the shortcut list
all read it, so **a new screen is added there** and gets its nav entry, launcher command and key
together. `src/components/shell.test.tsx` asserts no binding is the start of another. Arriving at a
screen with something to show — a record open, a form started, a filter on — is a `ViewIntent`
passed as that screen's initial state; its nonce is in the screen's key, so it remounts. The key
handler is one `keydown` listener in `App.tsx` over `SequenceMatcher` (`src/lib/commands.ts`, pure);
it stands down in a field, an open menu and under any `aria-modal`, and only Ctrl/⌘ K survives the
`keyboardShortcuts` preference being off.

**Overlays are portalled onto `<body>`** (`components/ui/portal.tsx`, used by `Sheet` and
`Dialog`). `position: fixed` is only fixed to the window while nothing above it has a transform,
and every screen renders inside `animate-extend` — so an overlay left where it was written is
pinned to, and sized against, the view that opened it.

**`/docs` is its own HTML entry point, not a screen in the app** (`src/docs.html` → `src/docs.tsx`
→ `src/components/docs/`). It is read by people who have not signed in, the document it renders
needs no credential, and none of the quote editor has to load for it. It applies the account's
theme, accent and face the same way `App.tsx` does, so it does not flash a different look. Every
`src/**/*.html` is a build entry point, so adding a page is adding a file. Both pages take the
account's look from `components/app/useAccountTheme.ts`.

**`/table?table_name=<collection>&query=<filter>` is the record browser**, an entry point like
`/docs` (`src/table.html` → `src/components/table/`). It reads `GET /api/table/:collection`
(`src/server/table.ts`), which lists through the caller's own credential, so the collection's rules
decide the rows and a hidden field never comes back. Rows are **stored records**, not domain objects
(no derived status or balance). A user token cannot read a schema, so the columns are **inferred**
from the visible records (`inferFields` in `src/lib/dataTable.ts`). The table is
`@tanstack/react-table` **v9** (`useTable`, `tableFeatures`, not v8's `useReactTable`), with sorting
and paging in manual mode: PocketBase does both. The filter is edited as a tree, and
`src/lib/filterQuery.ts` is the only code that writes the PocketBase string, so quoting is done in
one place. A filter the builder can't show opens as text and is still applied. Applying writes both
parameters back to the URL, which is the page's whole state.

**Clicking a row opens the record form** (`components/table/RecordForm.tsx`, `@tanstack/react-form`,
in a `Sheet` like every editor), and `&record=<id>` puts it in the URL. Its layout is data: the
`record_forms` collection (one per collection per org, admins write, everyone reads; in `OWNED`)
holds sections of fields with a widget, label and bounds each, checked by `readFormLayout` in
`src/lib/recordForm.ts`. With nothing stored, the form is built from the record (`fallbackLayout`).
`GET`/`PATCH /api/table/:collection/:id` (`src/server/recordForms.ts`) resolve the same layout, and
the server refuses any field the form does not offer as editable, re-runs each field's check, and
refuses a write whose `updated` stamp is stale (409). That narrows the route; the collection's rules
still decide. **Quotes, invoices, their lines, payments and credits are never written there** (`SERVER_OWNED`),
because a raw write would skip pricing and totals. Neither are `LOCKED_FIELDS` (owner, org, sharedWith…).

**A row opens the record workspace** (`components/table/RecordWorkspace.tsx`), full page, in three
panes: the details form (`RecordFormBody`, its bookkeeping sections folded), **related lists** (tabs
of the records whose link field holds this record's id — `RelatedLists.tsx`) and a **summary**
column (`SummaryPane.tsx`). Its layout is the `workspace` JSON on the same `record_forms` row as the
form, checked by `readWorkspaceLayout` in `src/lib/workspace.ts`, which also holds the built-in
defaults for accounts, quotes and invoices. A summary line is a field (a JSON path), a **roll-up**
(count/sum/avg/min/max over a related list, optionally filtered) or a **formula** over the keys
above it — and a formula with a blank input is blank, never a zero. The server works the summary out
(`src/server/workspace.ts`, `GET /api/workspace/:collection/:id`), reading every related row as the
caller and stopping at `MAX_ROLLUP_ROWS`, which the line then says. *Customize*
(`WorkspaceEditor.tsx`, admins) edits form and workspace together and previews the draft through
`POST …/preview`; `PUT /api/record-forms/:collection` saves both. *New* in a tab creates through
`POST /api/table/:collection` with the link prefilled — never in a `SERVER_OWNED` collection — and
the files tab uploads to `sys_attachment` instead.

**Forms are panels, previews are modals.** Every editor opens in `components/ui/sheet.tsx` — a
right-hand, full-height panel. Only things meant to be read (a rendered proposal, a PDF) use
`components/ui/dialog.tsx`. The sheet's body is a `@container`, so forms inside it use container
queries (`@md:grid-cols-2`), never viewport ones — `sm:grid-cols-4` would still be four columns in
a 500px panel. `src/components/sheet.test.tsx` asserts both halves of that rule.

**Receivables are separate collections, not a quote state.** A quote is an offer that gets revised
and superseded; an invoice is a number sitting in somebody's accounts payable. `invoices` keeps
`state`, `dueDate` and `total` as real columns, and keeps **no `status` and no `balance` column at
all** — both are derived, for the reason in `src/lib/receivable.ts`.

**A line is a record, not an entry in its parent's JSON.** `quote_lines` and `invoice_lines` (one
row per line, `position` for the order, a required cascade relation to the parent) replaced the
`lines` arrays. Every scalar is a column; a quote line's nested parts (options, tier, applied rules,
issues, warnings, and `unitPriceOverride`, which may be `null`) ride in `detail`, and anything a
`PricedLine` gains later lands there without a migration. The line's own id is the `lineId` column,
unique only within its parent, because a revision keeps its quote's line ids and `parentId` /
`sourceLineId` name them; the record id is minted. `saveWithLines` in `src/server/db.ts` writes the
parent and its lines in **one batch**, matched on `lineId`, so an unchanged line is not rewritten and
a quote is never stored with half its lines. That sizes the batch: `MAX_QUOTE_LINES` (1000, in
`validate.ts`) and `MAX_INVOICE_LINES` replace the old JSON byte caps, and the migration raises
`batch.maxRequests` to match. A line has its parent's audience, joined through the relation: a
quote line is read by the quote's org, its shares and its approvers, but written only by its
editors, which is why `decideQuote` saves with `{ lines: false }`. An invoice line is written only
while `invoice.state = "draft"`, so **an issued invoice's lines are fixed in the collection rule
too**, not only in `invoices.ts`. `lineCount` stays on the parent, so lists never read a line.

**A payment and a credit are records, not entries in the invoice's JSON.** `payments` and `credits`
are their own collections, each row belonging to one invoice, which buys three things: recording one
is an *insert*, so two people banking cash at the same moment cannot lose a payment (the old
read-modify-write of the whole invoice could, and `src/server/api.test.ts` has a concurrency test
that would catch a regression); "what came in last month" becomes answerable without opening every
invoice; and each row has an owner, a created date and a durable id. Their access rules key off
`invoice.owner` rather than the row's own owner — that is what stops a signed-in stranger filing a
payment against your invoice. Every list of invoices goes through `withLedgers` in
`src/server/db.ts`, which reads the ledger in **two queries for the whole page** rather than two per
invoice; no other code path may assemble a summary, or it would produce a balance that ignores the
payments behind it. An
account carries `paymentTermDays` (the number an invoice's due date is computed from, seeded out of
the free-text "Net 30" for rows written before receivables) and an advisory `creditLimit`: nothing
here blocks a quote on it, because a limit somebody typed last year would be wrong more often than
right. A new collection needs adding to `OWNED` in `docker/pb_hooks/rules/ownership.js`, or its
records are created with no owner and every rule misses them.

**A customer is three collections.** `accounts` keeps its own scalars as columns (status, tags,
terms, `paymentTermDays`, `creditLimit`, tax, notes — there is no `details` JSON any more). Its
people are `contacts` records (required `account` relation, cascade-deleted with it, ordered by
`position`, one of them `primary` — who a quote is addressed to and what `snapshotCustomer` flattens
onto the document). Its addresses are `sys_physical_location` records that `billingAddress` and
`shippingAddress` relate to; **"ship to billing" is both relations naming one record**, not a flag.
A location's `name` is its parts on one line, set on every save by `pb_hooks/rules/locations.js`
(`locationName` in `src/lib/locations.ts` is the same rule), and a location no account names any more
is deleted by the same hook, inside the save's transaction. **`contacts` is an auth collection
nobody can sign in to**: `authRule` is null and every method is off, because a contact carries
`org` and every rule grants `@request.auth.org` — a contact with a token would read the whole
organization. A customer portal needs every rule to check `@request.auth.collectionName = "users"`
first. For the same reason a contact's address is `contactEmail`; the auth `email` (unique across
every org, hidden from other users) stays blank. The API still speaks the nested `Account` shape:
`saveAccountGraph` in `src/server/db.ts` writes the account, its locations and its contacts in **one
PocketBase batch** (enabled by `1750000014_account_normalize.js`), keeps a contact's id only if this
account already has it, and mints the rest. `readAccount` still repairs a body: one written before
contacts existed (`contactName`/`contactEmail`/`contactPhone`) becomes a one-contact account, and a
list with no primary or several gets exactly one. The customers screen is a list until you pick one,
and then it is `CustomerDetail` — that customer's quote history from `GET /api/accounts/:id/quotes`,
because `/api/quotes` is capped at a page.

**A field that names another record is a `Combobox`, not an `Input`.** `components/ui/combobox.tsx`
— searchable, portalled to `document.body` so the panel's `overflow-y-auto` cannot clip it, and
dismissing on an outside click without also closing the panel behind it. `productOptions` and
`familyOptions` build the lists. `src/components/combobox.test.tsx` asserts each reference field is
bound to one. Approver and share pickers offer the organization's directory; anything a
picker cannot find is still typable, since an address may be named before it registers.

Anything that persists lives in the account's preferences (`src/lib/preferences.ts`); nothing in
the UI writes to `localStorage`.

`bun test` builds and starts throwaway PocketBase containers; without Docker, those tests skip.
