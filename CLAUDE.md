
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
keys off `user`, set by the hook that creates the record.

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
  paginate, the standard 14 fonts and WinAnsi encoding, and image XObjects. No embedded fonts
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
  an export, a share and an import; `tools/sampleBrand.ts` draws the sample workspace's logo
- `src/lib/validate.ts` — every untrusted input, shared by the REST API and the file importer
- `src/server/quotes.ts` — pricing orchestration, lifecycle and revisions
- `src/server/invoices.ts` — the receivables orchestration, and where three rules are enforced
  rather than left to the UI: **an issued invoice's lines are fixed** (change what is owed with a
  credit, not an edit), **only an issued invoice has a ledger** (nothing to pay against a draft),
  and **nothing ever issued is deleted** — invoice numbers have to be gapless, so a draft may be
  discarded and anything past that is voided. Voiding is refused once a payment exists; an
  over-credit is refused because unlike an overpayment it is always a typo on your own side.
  `invoiceQuote` bills a sent or accepted quote for its whole contract value, with the quote
  discount, any adjustment and shipping as their own lines, and warns rather than hides it when the
  total lands a penny off the quote's. Billing a subscription period by period is a billing
  schedule — the obvious next layer, and deliberately not here
- `src/server/db.ts` — the collections. Every call takes a token and is async
- `src/server/share.ts` — proxies to PocketBase's `/api/cpq/...` hook routes: sharing, approver
  stamping, and the account directory (`GET /api/directory`, id/email/name only). All three need to
  read `users`, which no user token may do, so they live in `docker/pb_hooks/`
- `src/server/apiKeys.ts` — listing and revoking are ordinary record calls the collection's own
  rules allow; only issuing proxies to a hook, because only issuing has to hash a secret and hand
  the raw value back once
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
  to it, so a dropped row would be a customer's payment with nothing left to recover it from
- `docker/pb_hooks/` — server-side JS run by PocketBase's own JSVM, not by Bun. **A hook body
  cannot see its file's scope**: declare what a handler needs inside the handler, or `require` it
  there. Code that breaks this rule registers fine and fails only at runtime

Each collection keeps real columns for what the database queries on and one JSON field for the
nested domain object the app reads whole.

**The look is parchment and nature, and it lives in `styles/globals.css`.** The palette is oklch —
warm paper, walnut ink, forest and moss for anything live, clay and ochre for anything waiting or
wrong — with a dark mode that is the same wood at dusk. Four utilities carry it: `paper` (the page:
flat parchment, soft blotches and a laid-paper hatch), `leaf` (a sheet on it — cards, panels,
menus), `margin-rule` (the ruled binding edge on the nav) and `double-rule` (the hairline a printed
page sets under a heading). Use those rather than `bg-card` / `bg-background` for surfaces, and
`font-serif` for titles and for a number meant to read as printed matter.

**The accent and the reading face are preferences.** Seven earth tones, each one a `--tint-hue`
and a chroma trim under `[data-accent=…]`, from which every tinted role (`--primary`, `--ring`,
the sidebar's live colours) is *derived* — so never write a colour literal for one of those
roles, and add an accent by adding the hue there and the name to `ACCENTS`. The status tones do
not follow it: moss still means paid and clay still means overdue, or a state told by colour
would start lying the moment somebody picked that colour. The face is `--font-sans` under
`[data-font=…]`, system stacks only; headings keep the serif. `App.tsx` puts both on `<html>`,
which is why the settings swatches can carry their own `data-accent` and paint themselves.

**Texture is a background layer, never anything text sits on**, and it is built from repeating
gradients rather than an SVG noise tile — a tiled `feTurbulence` seams visibly at the tile edges
and puts a faint checkerboard across the page.

**Motion is `motion-safe:` and under half a second.** The named animations (`rise`, `unfurl`,
`settle`, `vein`, `sway`, `drift`, `ripen`) are declared as `--animate-*` in the theme, so use
`animate-rise` rather than an inline keyframe. Entrance animations fill `both` and therefore start
at `opacity: 0` — which is why a screenshot tool that does not run animations photographs an empty
page. `prefers-reduced-motion` is honoured globally at the bottom of the stylesheet.

**`/docs` is its own HTML entry point, not a screen in the app** (`src/docs.html` → `src/docs.tsx`
→ `src/components/docs/`). It is read by people who have not signed in, the document it renders
needs no credential, and none of the quote editor has to load for it. It applies the account's
theme, accent and face the same way `App.tsx` does, so it does not flash a different look. Every
`src/**/*.html` is a build entry point, so adding a page is adding a file.

**Forms are panels, previews are modals.** Every editor opens in `components/ui/sheet.tsx` — a
right-hand, full-height panel. Only things meant to be read (a rendered proposal, a PDF) use
`components/ui/dialog.tsx`. The sheet's body is a `@container`, so forms inside it use container
queries (`@md:grid-cols-2`), never viewport ones — `sm:grid-cols-4` would still be four columns in
a 500px panel. `src/components/sheet.test.tsx` asserts both halves of that rule.

**Receivables are separate collections, not a quote state.** A quote is an offer that gets revised
and superseded; an invoice is a number sitting in somebody's accounts payable. `invoices` keeps
`state`, `dueDate` and `total` as real columns, and keeps **no `status` and no `balance` column at
all** — both are derived, for the reason in `src/lib/receivable.ts`.

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

**A customer is a record with people in it.** An account carries a `contacts` list — one of them
`primary`, which is who a quote is addressed to and what `snapshotCustomer` flattens onto the
document — plus a lifecycle `status`, free-text `tags`, and a shipping address that is kept equal
to the billing one while `shippingSameAsBilling`. `readAccount` repairs rather than refuses: a body
written before contacts existed (`contactName`/`contactEmail`/`contactPhone`) becomes a one-contact
account, and a list with no primary or several gets exactly one. `toAccount` does the same for rows
stored before the list existed, which is why this shipped without a data migration. The customers
screen is a list until you pick one, and then it is `CustomerDetail` — that customer's quote
history from `GET /api/accounts/:id/quotes`, because `/api/quotes` is capped at a page.

**A field that names another record is a `Combobox`, not an `Input`.** `components/ui/combobox.tsx`
— searchable, portalled to `document.body` so the panel's `overflow-y-auto` cannot clip it, and
dismissing on an outside click without also closing the panel behind it. `productOptions` and
`familyOptions` build the lists. `src/components/combobox.test.tsx` asserts each reference field is
bound to one. Approver and share pickers offer the account directory; anything a
picker cannot find is still typable, since an address may be named before it registers.

Anything that persists lives in the account's preferences (`src/lib/preferences.ts`); nothing in
the UI writes to `localStorage`.

`bun test` builds and starts throwaway PocketBase containers; without Docker, those tests skip.
