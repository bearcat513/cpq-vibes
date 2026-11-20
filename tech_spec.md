# Technical Specification

How this project is built, what it is built with, and how to work on it. It covers architecture
and conventions only. The domain model is described in `README.md` and `CLAUDE.md`, and the
examples below use made-up names (`widgets`, `notes`, `projects`).

---

## 1. Overview

The app is a full-stack TypeScript web application with two runtimes:

| Runtime | Role |
| --- | --- |
| **Bun** | HTTP server, API routes, server-side orchestration, the bundler, the test runner, and the bundled browser frontend (React) |
| **PocketBase** | Storage (SQLite), authentication, **all access control** (collection API rules), and a small set of privileged server-side hooks |

Docker Compose runs them together. The Bun server holds **no database credentials**. Every request
carries the caller's own credential, and the Bun server passes it through to PocketBase. PocketBase
then decides what that caller may read or write.

```
 Browser ──cookie/header──▶ Bun server (src/index.ts) ──caller's token──▶ PocketBase
   │                          │  routes, validation,                         │  collections + API rules
   │  React SPA (bundled      │  orchestration, pure                         │  pb_hooks (JSVM)
   │  on demand by Bun)       │  domain logic from src/lib                   │  pb_migrations (schema)
   └──────────────────────────┴──────────────────────────────────────────────┴── SQLite (pb_data volume)
```

---

## 2. Tech stack

### Runtime and tooling
- **Bun 1.4** (`oven/bun` alpine image). It is the runtime, package manager (`bun install`,
  `bun.lock`), bundler (`Bun.build`, HTML imports), test runner (`bun test`) and shell (`Bun.$`).
  The project does not use Node, npm, Vite, webpack, Jest or dotenv. Bun loads `.env` automatically.
- **TypeScript**, strict, with `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and bundler module
  resolution. Nothing is emitted, because Bun runs `.ts`/`.tsx` directly. The path alias `@/*` maps
  to `src/*`.

### Backend
- **`Bun.serve()`** with its built-in `routes` table, which supports per-method handlers and
  `:param` segments. The project does not use Express.
- **PocketBase 0.40** as the database and auth server, accessed through the official `pocketbase`
  JS SDK.
- **PocketBase JSVM hooks** (`docker/pb_hooks/`) for the few operations that need privilege.
- **PocketBase JS migrations** (`docker/pb_migrations/`) for all schema and API rules.

### Frontend
- **React 19**, served through Bun HTML imports (`import index from "./index.html"`). Bun transpiles
  and bundles the page's `<script type="module">` on request, and HMR is on in development.
- **Tailwind CSS v4** through `bun-plugin-tailwind` (set up in `bunfig.toml`), with design tokens
  in `styles/globals.css` (`@theme`, oklch palette, CSS custom properties).
- **shadcn/ui-style primitives** (`components.json`, "new-york" style) built on **Radix UI**
  (`react-select`, `react-label`, `react-slot`), plus `class-variance-authority`, `clsx`,
  `tailwind-merge` and `tw-animate-css`.
- **TanStack Table v9** (`useTable`/`tableFeatures`) and **TanStack Form** for data grids and
  record forms.
- **lucide-react** for icons.

### Infrastructure
- **Docker Compose** with two long-running services (`app`, `pocketbase`) and a one-shot,
  profile-gated `pocketbase-init`.
- A single named volume, `pb_data`, holds all persistent state.

---

## 3. Repository layout

```
.
├── src/
│   ├── index.ts            # Bun.serve(): the route table and the request guard
│   ├── index.html          # main app entry → frontend.tsx → App.tsx
│   ├── docs.html/.tsx      # standalone API docs page (its own entry point)
│   ├── table.html/.tsx     # standalone record browser (its own entry point)
│   ├── App.tsx             # app shell: theme, keyboard handling, screen routing
│   ├── lib/                # PURE domain + utility code shared by browser and server
│   ├── server/             # server-only: routes' implementations, PocketBase access, context
│   └── components/
│       ├── ui/             # design-system primitives (button, sheet, dialog, combobox…)
│       ├── app/            # feature screens and editors
│       ├── docs/           # /docs page components
│       ├── table/          # /table page components
│       └── *.test.tsx      # structural UI tests
├── styles/globals.css      # theme tokens, surfaces, animations, accents
├── docker/
│   ├── bun.dockerfile      # app image
│   ├── pb.dockerfile       # PocketBase image (bakes in hooks + migrations)
│   ├── pb_migrations/      # schema, API rules, data backfills (timestamp-ordered)
│   └── pb_hooks/           # PocketBase server-side JS
│       ├── main.pb.js      # the only *.pb.js; registers every module below
│       ├── setup/ rules/   # boot setup, record lifecycle hooks
│       ├── lib/            # shared hook logic (sessions, api keys, orgs…)
│       └── */routes.js     # privileged custom routes under /api/cpq/...
├── tools/                  # dev scripts and source workbooks
├── build.ts                # optional static build of every src/**/*.html
├── docker-compose.yml      # base (deployable; publishes no ports)
├── docker-compose.override.yml  # local only: ports + live-mounted hooks/migrations
├── .env.example            # the single source of config for local and Docker
├── bunfig.toml  tsconfig.json  components.json  package.json
```

### The three-layer rule for `src/`

| Layer | May import | Contains |
| --- | --- | --- |
| `src/lib/` | only `src/lib/` | Pure functions and types: calculations, validation, parsing, formatting, document rendering. No I/O. |
| `src/server/` | `src/lib/`, `pocketbase` SDK | Request handling, PocketBase calls, orchestration, request context |
| `src/components/` + `App.tsx` | `src/lib/`, React, UI libs | UI. Talks to the server only through `src/lib/api.ts` (fetch wrappers) |

Because `lib/` is pure, **the browser and the server run the same code**. The browser uses it for
instant feedback, and the server uses it to produce the authoritative result it stores. Each piece
of logic has one implementation, and the two sides must never fork it.

---

## 4. Backend architecture

### 4.1 Request lifecycle

1. `Bun.serve` matches the path and method in the `routes` object in `src/index.ts`.
2. Protected routes are wrapped in **`guarded(fn)`**, which:
   - reads the credential: an httpOnly session cookie, `Authorization`, or `X-API-Key`
     (`server/session.ts`)
   - asks PocketBase once who the caller is (`GET /api/cpq/context`), which returns user,
     organization, role and memberships
   - runs the handler inside an **AsyncLocalStorage** context (`server/context.ts`), so any code can
     call `requireContext()` without threading parameters through
3. The handler validates input (`lib/validate.ts`), calls `server/*` orchestration, and that code
   calls PocketBase through `clientFor(token)`.
4. **`handler()`** (`server/http.ts`) catches thrown `ApiError`s, turns them into `{ error }` JSON
   with the right status, and logs `METHOD path → status (ms)`.

```ts
// src/index.ts — a typical resource
"/api/widgets/:id": {
  GET: guarded<{ params: { id: string } }>(async (token, req) =>
    Response.json(await getWidget(token, req.params.id))),
  PUT: guarded<{ params: { id: string } }>(async (token, req) =>
    Response.json(await updateWidget(token, req.params.id, must(readWidget(await body(req)))))),
},
```

### 4.2 Talking to PocketBase

- `clientFor(credential)` in `server/pocketbase.ts` builds **one SDK client per request**, signed in
  as the caller. It chooses the header from the credential's prefix (an API key vs a JWT), and
  everything downstream treats the credential as an opaque string.
- `callHook(credential, path, init)` calls a custom PocketBase hook route as the caller and maps
  PocketBase errors to `ApiError`.
- Every storage function in `server/db.ts` takes the token as its first argument and is async.
- Multi-record writes (a parent and its child rows, for example) go through **PocketBase batch
  requests**, so they commit atomically.

### 4.3 Access control model

- **Authorization lives only in PocketBase collection rules** (`listRule`, `viewRule`,
  `createRule`, `updateRule`, `deleteRule`), and migrations define them.
- Rules are assembled from shared fragments such as `IN_ORG` and `role("admin", "editor")`, so
  every collection follows the same tenancy and role pattern.
- The server also keeps a `PERMISSIONS` table in `lib/`. It is used only to hide UI and to refuse a
  multi-write batch up front, and it grants nothing. **When a role's reach changes, update both the
  migration rules and `PERMISSIONS`.**
- **Never add a superuser client to the Bun server.** If an operation needs privilege, such as
  reading the users table, minting a sequential number or hashing a secret, it goes in
  `docker/pb_hooks/` as a route that checks the caller itself.

### 4.4 PocketBase hooks (`docker/pb_hooks/`)

- `main.pb.js` is the only file PocketBase loads automatically. It `require`s each module and calls
  its `register()`, and a module that fails to register is logged without taking down the rest.
- **JSVM gotcha:** a handler body cannot see its file's top-level scope. Declare everything a
  handler needs, or `require` it, *inside* the handler. Code that breaks this rule registers fine
  and fails at runtime.
- Typical contents are `routerAdd(...)` custom routes, `routerUse(...)` global middleware (API key
  resolution, revoked-token checks), `onRecord*` lifecycle hooks (ownership stamping, derived
  fields, cleanup), and `cronAdd(...)` jobs.

```js
// docker/pb_hooks/widgets/routes.js
module.exports.register = () => {
  routerAdd("POST", "/api/cpq/widgets/{id}/publish",
    e => require(`${__hooks}/lib/widgets.js`).publish(e),   // require inside the handler
    $apis.requireAuth("users"));
};
```

### 4.5 Migrations (`docker/pb_migrations/`)

- Files are named `<unix-timestamp>_<name>.js` and PocketBase applies them on boot. **Every schema
  change is a new migration file, never a dashboard edit**, or a fresh volume comes up without it.
- Each migration has an `up` and a `down`.
- **Do data backfills in SQL** (`app.db().newQuery(...)`, SQLite `json_set` / `json_each`). In the
  JSVM a JSON field is a byte array, so reading it, mutating it and saving it in JS writes nothing.
- Export data-moving SQL as constants and test it in `src/server/migration.test.ts` against
  SQLite. Write it to be idempotent.
- Schema pattern: real columns for anything filtered or sorted on, and one JSON field for a nested
  object the app always reads whole.

### 4.6 The API describes itself

`src/server/openapi.ts` is the **single list of endpoints** (OpenAPI 3.0.3). It is served three
ways:
- `GET /api/openapi.json` returns the document
- `GET /api` returns a plain endpoint index
- `/docs` is an interactive React reference that can send requests and copy them as cURL

`openapi.test.ts` asserts that every documented path exists in the route table. **Adding a route
means adding its operation here.** Import bounds and enums from `lib/` rather than retyping them.

### 4.7 Cross-cutting conventions
- **Dates:** business dates come from `today()` / `addDaysTo` in `lib/clock.ts`, which resolve in
  the organization's time zone. Never use `new Date().toISOString().slice(0, 10)`.
- **Money:** round at each step to the currency's precision and only sum rounded values
  (`lib/money.ts`). Never add amounts in two different currencies.
- **Derived state is not stored.** Anything that depends on the clock or on other collections, such
  as status, balance or "overdue", is computed when it is read.
- **Server-computed values win.** The server ignores client-supplied totals and derived fields and
  overwrites them.
- **Validation** of every untrusted input lives in `lib/validate.ts`, and returns
  `{ ok: true, value } | { ok: false, error }`. The REST API and the file importer share it.

---

## 5. Frontend architecture

### 5.1 Entry points
Every `src/**/*.html` file is a build entry point. Adding a standalone page means adding an HTML
file and importing it in `src/index.ts`:

| Page | Entry | Notes |
| --- | --- | --- |
| `/` | `index.html` → `frontend.tsx` → `App.tsx` | The signed-in app |
| `/docs` | `docs.html` → `docs.tsx` | Public API reference; loads none of the app |
| `/table` | `table.html` → `table.tsx` | Generic record browser; its state lives in the URL query |

### 5.2 Shell and navigation
- `components/app/Chrome.tsx` is the window frame. On `lg` and up it is a fixed desktop-style
  layout (sidebar, title bar, status bar, and a single scrolling `<main>`). Below that, a top bar
  and a bottom tab bar replace it.
- `components/app/navigation.tsx` is **the one table** of screens (`VIEWS`), create actions
  (`CREATES`, each with the permission it needs) and `SHORTCUTS`. The sidebar, the mobile tabs, the
  command launcher (Ctrl/⌘ K) and the keyboard shortcuts all read it, so a new screen is added
  there once.
- A single `keydown` listener in `App.tsx` drives key sequences through a pure `SequenceMatcher`
  (`lib/commands.ts`). It stands down inside inputs, open menus and modals.

### 5.3 UI conventions
- **Forms open in a `Sheet`**, a right-hand full-height panel. **Read-only previews open in a
  `Dialog`.** The sheet body is a CSS `@container`, so forms use container queries
  (`@md:grid-cols-2`), never viewport breakpoints.
- **Overlays are portalled to `<body>`** (`components/ui/portal.tsx`), because a transformed
  ancestor breaks `position: fixed`.
- **A field that references another record is a `Combobox`**: searchable and portalled, and it
  still accepts free text.
- **Permissions in the UI** come from `useAccess()` (`components/app/access.tsx`). It only hides
  controls, and the server and PocketBase still enforce.
- **Preferences persist to the user's account** (`lib/preferences.ts`). The UI never writes to
  `localStorage`.

### 5.4 Styling system (`styles/globals.css`)
- Tokens are CSS custom properties in oklch, with light and dark themes, mapped into Tailwind
  through `@theme inline`.
- Surface utilities: `slab` (page background), `panel` (cards, sheets, menus), `rail` and `seam`
  (dividers). Use these rather than raw `bg-card` / `bg-background`.
- The **accent colour** and the **reading font** are user preferences, applied as `data-accent` /
  `data-font` on `<html>`. Every tinted role (`--primary`, `--ring`…) derives from `--tint-hue`, so
  never hard-code a colour for those roles. Status colours (`signal`, `hazard`, `alert`, `flare`)
  do **not** follow the accent, and their lightness is tuned for a 4.5:1 contrast ratio.
- Background texture uses repeating gradients, never under text.
- Motion uses the theme's named animations (`animate-rise`, `animate-extend`, …). It is always
  `motion-safe:`, always under 0.5s, and honours `prefers-reduced-motion` globally.

---

## 6. Configuration

All configuration comes from one `.env` at the repo root (copy `.env.example`). Bun loads it for
`bun dev`, and Compose reads it for interpolation.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PB_VERSION`, `BUN_VERSION` | Compose build args | Pinned image versions; bumping one rebuilds |
| `API_PORT`, `PB_PORT` | override file | Host ports for local development |
| `PB_ADMIN_EMAIL`, `PB_ADMIN_PASSWORD` | PocketBase only | Dashboard superuser; deliberately blanked in the app container |
| `CPQ_SIGNUP` | PocketBase hooks | `open` or `invite` sign-up policy |
| `POCKETBASE_URL` | Bun server | Defaults to `http://127.0.0.1:$PB_PORT`; Compose sets `http://pocketbase:8080` |
| `PB_TEST_URL` | tests | Use an existing PocketBase instead of a throwaway container |

Frontend-visible variables must be prefixed `BUN_PUBLIC_*` (set in `bunfig.toml`).

---

## 7. Developer workflow

### 7.1 First run
```bash
bun install
cp .env.example .env          # change the admin password
bun run docker:up             # builds both images, app on :3000, PocketBase on :8091
```
- App: `http://localhost:3000`. Sign up to create a user and a personal organization.
- PocketBase dashboard: `http://localhost:8091/_/` (superuser from `.env`).
- Locked out of the dashboard? Run `bun run docker:init` to upsert or reset the superuser.

### 7.2 Day-to-day loops

| You are changing… | Do this | Reload behaviour |
| --- | --- | --- |
| Frontend or server TS | `bun run dev` (`bun --hot src/index.ts`) against the Dockerised PocketBase | HMR in the browser, hot reload on the server |
| `pb_hooks/*` | Edit in place. The override file bind-mounts them into the container | PocketBase watches hooks and reloads itself; if it doesn't, run `docker compose restart pocketbase` |
| A new migration | Add `docker/pb_migrations/<ts>_<name>.js` | Restart PocketBase to apply it |
| Docker / dependencies | `bun run docker:up` (rebuilds) | — |

Other scripts: `docker:logs` (follow logs), `docker:down` (stop, keeping data; `docker compose down
-v` wipes the volume), `build` (static, minified bundle of every HTML entry into `dist/`; not needed
in production because Bun bundles on demand), `start` (production mode, with no HMR or console
echo).

### 7.3 Testing
```bash
bun test                      # everything
bun test src/lib              # pure units only, no Docker needed
bun test src/server/api.test.ts
```

| Kind | Where | What it does |
| --- | --- | --- |
| **Unit** | `src/lib/*.test.ts` | Pure functions, fast and with no I/O. Most logic is tested here. |
| **Component / structural** | `src/components/*.test.tsx` | `renderToStaticMarkup` plus assertions about conventions: forms render in sheets, reference fields are comboboxes, no shortcut prefixes another |
| **End-to-end API** | `src/server/api.test.ts` | Starts a real `Bun.serve` on a random port against a **throwaway PocketBase container** built from `docker/pb.dockerfile` on a random port with an empty volume. Exercises routes, rules, hooks and migrations together, focused on authority (who can see and change what) and concurrency. |
| **Migration SQL** | `src/server/migration.test.ts` | Runs exported backfill SQL against SQLite fixtures, including idempotency |
| **Contract** | `src/server/openapi.test.ts` | Every documented path is a real route |

- The test PocketBase image is **rebuilt on every run** (cached layers take about a second), so
  tests never check stale rules or hooks.
- **Without Docker, storage-backed tests skip** rather than fail, and everything else still runs.
  To use an existing instance instead, set `PB_TEST_URL`.
- Tests mint unique users per run, so re-runs against a shared instance do not collide.

```ts
// src/lib/widgets.test.ts
import { test, expect } from "bun:test";
import { widgetTotal } from "./widgets";

test("rounds each line before summing", () => {
  expect(widgetTotal([{ qty: 3, unit: 0.335 }])).toBe(1.01);
});
```

### 7.4 Adding a feature: checklist

Example: a new `widgets` resource.

1. **Schema:** add `docker/pb_migrations/<ts>_widgets.js` with the collection, its fields, indexes,
   and rules built from the shared `IN_ORG` / `role()` fragments.
2. **Ownership:** add the collection to `OWNED` in `docker/pb_hooks/rules/ownership.js`, so `owner`
   and `org` are stamped. Without that, every rule misses its records.
3. **Pure logic:** add `src/lib/widgets.ts`, a validator in `lib/validate.ts`, and unit tests.
4. **Storage:** add `list/get/create/update/deleteWidget(token, …)` in `src/server/db.ts`
   (token-first, async).
5. **Routes:** add entries in `src/index.ts`, wrapped in `guarded`.
6. **Docs:** add the operations to `src/server/openapi.ts`. `openapi.test.ts` fails otherwise.
7. **Permissions:** update `PERMISSIONS` in `lib/organization.ts` to match the migration rules.
8. **UI:** add a screen in `components/app/`, register it in `navigation.tsx`, and use a `Sheet` for
   its editor and `Combobox` for its references.
9. **Privileged step?** Add a hook route under `docker/pb_hooks/` and call it with `callHook`.
10. **Tests:** cover authority in `api.test.ts` (another org cannot read it, and a read-only role
    cannot write it).

---

## 8. Build and deployment

- **App image** (`docker/bun.dockerfile`): a two-stage alpine build. It installs with
  `--frozen-lockfile`, including dev dependencies because Tailwind is needed at serve time, copies
  `src/` and `styles/`, runs as user `bun`, and has a healthcheck on `GET /api/health`. There is no
  separate build step, because `Bun.serve` bundles HTML entries on demand.
- **PocketBase image** (`docker/pb.dockerfile`): downloads the pinned PocketBase release for the
  target architecture (amd64/arm64) and **bakes in** `pb_migrations` and `pb_hooks`. It has a
  healthcheck on `/api/health`.
- **Compose:** `app` waits on `pocketbase` being healthy, so it never races the migrations. The base
  file publishes **no host ports**. Only `docker-compose.override.yml`, which is auto-loaded locally
  and ignored when a deploy names `-f docker-compose.yml`, publishes ports and live-mounts the
  hooks, so the PocketBase admin UI is never exposed on a deploy target.
- **Data:** everything persistent is in the `pb_data` volume. `down` keeps it and `down -v` deletes
  it.

---

## 9. Security model summary

- The server is credential-less: it forwards the caller's token, and PocketBase rules decide.
- Sessions are an httpOnly cookie. Sign-out records the token's hash in a revocation table, which
  middleware checks and a cron sweeps. "Sign out everywhere" rotates the user's `tokenKey`.
- API keys are `prefix_` plus 40 random characters, and only their SHA-256 is stored. Middleware
  resolves a key to its owner, so every existing rule applies unchanged. A key cannot manage keys.
- Files are served only through an authenticated route that mints a short-lived file token as the
  caller. Anything not on an inline allowlist is served as a sandboxed download.
- The `/docs` cURL generator writes the credential as a shell variable, never inline.
