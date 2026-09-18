
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
books, pricing and approval rules, quotes, and proposal documents.

Storage is **PocketBase**, not `bun:sqlite`. The app and the database run together under Docker
Compose (`bun run docker:up`).

**Access control lives in PocketBase, not in the Bun server.** Every request carries the caller's
own token (httpOnly cookie, or an `Authorization` header) and the collection rules decide what they
may see — the server holds no credentials and can grant nothing on its own. Never reintroduce a
superuser client for ordinary reads and writes; if something needs privilege, it belongs in
`docker/pb_hooks/` as a route, the way sharing and approver stamping do.

**The server prices every quote it stores.** Totals in a request body are ignored and overwritten.
The engine is pure and lives in `src/lib/`, so the browser runs it for live feedback and the server
runs the same code for the record — never fork them.

- `src/lib/pricing.ts` — the pricing pipeline, and `PRICING_VARIABLES` for the rule editors
- `src/lib/money.ts` — round at every step, to the currency's precision; sum rounded numbers only
- `src/lib/formula.ts` — the expression language (no `eval`), shared by pricing, approvals and
  product validation
- `src/lib/configurator.ts` — option groups and configuration rules
- `src/lib/approvals.ts` — the approval ladder. Levels are cumulative, an edit voids decisions, and
  a rule asks several people with separate approve/reject quorums. A request's `status` is derived
  by `requestStatus` from the votes it carries, never assigned
- `src/lib/proposal.ts` — `{{token}}` rendering, escaped per format; owns the token vocabulary
- `src/lib/pdf.ts` / `pdfFonts.ts` — a dependency-free PDF writer: a top-down cursor, tables that
  paginate, the standard 14 fonts and WinAnsi encoding. No images, no embedded fonts
- `src/lib/pdfTemplate.ts` — PDF templates as a block document. Pure, so the editor's preview is
  rendered by the same code as the download. Its totals list is closed and customer-facing: a
  proposal template has no way to name cost or margin
- `src/lib/validate.ts` — every untrusted input, shared by the REST API and the file importer
- `src/server/quotes.ts` — pricing orchestration, lifecycle and revisions
- `src/server/db.ts` — the collections. Every call takes a token and is async
- `src/server/share.ts` — proxies to PocketBase's `/api/cpq/...` hook routes: sharing, approver
  stamping, and the account directory (`GET /api/directory`, id/email/name only). All three need to
  read `users`, which no user token may do, so they live in `docker/pb_hooks/`
- `docker/pb_migrations/` — collections, ownership fields, API rules. A schema change is a new
  migration file here, not a dashboard edit, or a fresh volume comes up without it. **A JSON field
  reaches the JSVM as a byte array (`types.JSONRaw`)**, so reading one, mutating it and saving runs
  without error and writes nothing — do data backfills in SQL with SQLite's `json_set`, the way
  `1750000004_multi_approver.js` does, and test the statement (`src/server/migration.test.ts`)
- `docker/pb_hooks/` — server-side JS run by PocketBase's own JSVM, not by Bun. **A hook body
  cannot see its file's scope**: declare what a handler needs inside the handler, or `require` it
  there. Code that breaks this rule registers fine and fails only at runtime

Each collection keeps real columns for what the database queries on and one JSON field for the
nested domain object the app reads whole.

**Forms are panels, previews are modals.** Every editor opens in `components/ui/sheet.tsx` — a
right-hand, full-height panel. Only things meant to be read (a rendered proposal, a PDF) use
`components/ui/dialog.tsx`. The sheet's body is a `@container`, so forms inside it use container
queries (`@md:grid-cols-2`), never viewport ones — `sm:grid-cols-4` would still be four columns in
a 500px panel. `src/components/sheet.test.tsx` asserts both halves of that rule.

**A field that names another record is a `Combobox`, not an `Input`.** `components/ui/combobox.tsx`
— searchable, portalled to `document.body` so the panel's `overflow-y-auto` cannot clip it, and
dismissing on an outside click without also closing the panel behind it. `productOptions` and
`familyOptions` build the lists. `src/components/combobox.test.tsx` asserts each reference field is
bound to one. Approver and share pickers offer the account directory; anything a
picker cannot find is still typable, since an address may be named before it registers.

Anything that persists lives in the account's preferences (`src/lib/preferences.ts`); nothing in
the UI writes to `localStorage`.

`bun test` builds and starts throwaway PocketBase containers; without Docker, those tests skip.
