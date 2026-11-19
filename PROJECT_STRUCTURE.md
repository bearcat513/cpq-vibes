# Project structure

A reusable blueprint for a Bun + React + PocketBase app that is **usable as a UI and as an API**,
documents itself with OpenAPI, issues API keys for scripts, and keeps its records in
**organizations** whose members' roles decide who may change what.

Copy this file into a new repo and work down it. Everything is a convention, not a framework:
there is no hidden magic, only files in agreed places. Throughout, `<app>` stands for the project's
short name (`<APP>` for its upper-case form) — replace it as you copy.

- [1. Stack](#1-stack)
- [2. Directory layout](#2-directory-layout)
- [3. The three layers](#3-the-three-layers)
- [4. The server](#4-the-server)
- [5. Auth and sessions](#5-auth-and-sessions)
- [6. API keys](#6-api-keys)
- [7. Storage and access control](#7-storage-and-access-control)
- [8. API docs (OpenAPI + /docs)](#8-api-docs-openapi--docs)
- [9. The UI](#9-the-ui)
- [10. Configuration and secrets](#10-configuration-and-secrets)
- [11. Docker Compose](#11-docker-compose)
- [12. Tests](#12-tests)
- [13. Adding a feature, end to end](#13-adding-a-feature-end-to-end)
- [14. Conventions at a glance](#14-conventions-at-a-glance)

---

## 1. Stack

| Concern | Choice | Why not the usual thing |
| --- | --- | --- |
| Runtime, bundler, test runner, package manager | **Bun** | One tool. No webpack/vite/jest/ts-node to keep in sync. |
| HTTP server | `Bun.serve()` with a `routes` table | No Express. Routes are a plain object, params and methods included. |
| Frontend | React 19 via **HTML imports** | `src/*.html` are build entry points; Bun transpiles and bundles the `.tsx` they reference. |
| Styling | Tailwind + a small `components/ui` set | Copy-in components (shadcn style), not a component dependency. |
| Storage & auth | **PocketBase** in its own container | Collections, rules, user accounts and a dashboard without writing an auth system. |
| Privileged server logic | PocketBase **hooks** (`pb_hooks/`) | The only place allowed to hold privilege — see §7. |
| Orchestration | Docker Compose | App and database come up together with one command. |

Everything else — pricing, documents, export — is plain TypeScript in
`src/`, with no framework between it and the runtime.

## 2. Directory layout

```
.
├── CLAUDE.md                    # instructions for agents working in the repo
├── PROJECT_STRUCTURE.md         # this file
├── README.md                    # what it does, how to run it, the API
├── package.json                 # scripts: dev, start, build, test, docker:*
├── build.ts                     # production bundle: every src/**/*.html is an entry point
├── docker-compose.yml           # app + database; publishes nothing
├── docker-compose.override.yml  # local only: host ports, source mounts
├── .env.example                 # every variable, documented; copied to .env
│
├── src/
│   ├── index.ts                 # THE route table. The only file that knows the URL space.
│   ├── index.html  index.css    # the app shell
│   ├── frontend.tsx  App.tsx    # the app entry point and its root component
│   ├── docs.html  docs.tsx      # the API reference, a page of its own
│   ├── table.html  table.tsx    # the record browser, a page of its own
│   │
│   ├── server/                  # runs only in Bun. May read env, may hold secrets.
│   │   ├── http.ts              # ApiError, fail(), readJson(), param parsing, handler()
│   │   ├── session.ts           # the cookie, token/API-key reading, requireToken()
│   │   ├── context.ts           # who is asking, in which org, as what — per request
│   │   ├── pocketbase.ts        # clientFor(credential), callHook(), toApiError()
│   │   ├── auth.ts              # register / login / logout / me routes
│   │   ├── <db>.ts              # every storage call. Each one takes a token and is async.
│   │   ├── orgs.ts              # organization routes: proxies to the membership hooks
│   │   ├── apiKeys.ts           # list, revoke, and a proxy to the hook that issues
│   │   ├── share.ts             # proxies to the privileged sharing routes
│   │   ├── table.ts             # any collection, listed through the caller's credential
│   │   ├── recordForms.ts       # the record form: one layout, the server's check of a write
│   │   ├── workspace.ts         # related lists and summaries, read as the caller
│   │   ├── attachments.ts       # files on records: upload, and a download route per file
│   │   ├── <feature>.ts         # orchestration a route needs beyond one storage call
│   │   ├── openapi.ts           # the OpenAPI document and the endpoint index
│   │   └── *.test.ts            # server tests, incl. the end-to-end API test
│   │
│   ├── lib/                     # shared by both sides. No env, no secrets, no I/O.
│   │   ├── types.ts             # the domain types both sides agree on
│   │   ├── api.ts               # the browser's typed client for the API
│   │   ├── organization.ts      # roles and PERMISSIONS — the UI's copy of the rules
│   │   ├── clock.ts             # today(), in the organization's time zone
│   │   ├── commands.ts          # the keyboard-shortcut matcher
│   │   ├── openapiDoc.ts        # parsing the OpenAPI document for the docs page
│   │   ├── preferences.ts       # normalizers: one shape, whoever wrote it
│   │   ├── validate.ts          # every untrusted input, read into a typed value or a sentence
│   │   ├── recordForm.ts  workspace.ts  # layouts as data, checked; summaries computed purely
│   │   └── *.test.ts
│   │
│   └── components/
│       ├── ui/                  # button, input, sheet, dialog, combobox… copied in, owned by us
│       ├── app/                 # the application's own screens, panels and frame
│       ├── docs/                # the API reference page's components
│       ├── table/               # the record browser: table, filter, form, workspace, editor
│       └── *.test.tsx           # component tests, rendered to static markup
│
└── docker/
    ├── bun.dockerfile  pb.dockerfile
    ├── pb_migrations/           # collections, fields, API rules — one file per change
    └── pb_hooks/                # server-side JS run by PocketBase's JSVM
        ├── main.pb.js           # the only .pb.js: requires each module's register()
        ├── lib/                 # the privileged implementations
        ├── rules/               # ownership and org stamping, the approver's write
        ├── keys/ share/ orgs/   # routes that need privilege
        └── setup/               # first-boot superuser; guarding users.org / users.role
```

**One rule holds the layout together:** a file's directory says what it may touch.
`lib/` may touch nothing but its arguments, `server/` may touch env and the network,
`pb_hooks/` may touch privilege. Nothing reaches up.

## 3. The three layers

### `src/lib/` — shared, pure

Imported by the server *and* the browser, so it must not import `process.env`, `node:*`, or
anything that only exists in one of them. This is where the domain lives: types, validators,
normalizers, formatters, parsers.

The high-value pattern here is the **normalizer pair**:

```ts
export const DEFAULT_PREFERENCES: Preferences = { theme: "system", accentColor: "blue" };
export function normalizePreferences(value: unknown): Preferences { /* … */ }
```

The server normalizes what arrives over the API, the UI normalizes what it renders, and a record
written before a field existed comes back with the default rather than `undefined`. A body typed
by hand into `curl` lands in exactly the shape the UI would have produced.

### `src/server/` — Bun only

Each module owns one concern and exports functions, not a class. Storage functions take the
caller's credential as their first argument and are `async`. Errors leave as `ApiError`.

### `src/components/` — the browser

`ui/` is generic and reusable; `app/` is this product; `docs/` renders the API document. A
component never calls `fetch` directly — it calls `lib/api.ts`, which is the only place the URL
space appears on the client side.

## 4. The server

### The route table is the only map

`src/index.ts` holds every route in one `Bun.serve({ routes })` object, grouped by section with
comment rules. Reading it top to bottom is reading the API.

```ts
const server = serve({
  routes: {
    ...authRoutes,                                  // spread in from server/auth.ts

    "/api":            { GET: handler(() => Response.json({ /* index */ })) },
    "/api/health":     { GET: handler(health) },
    "/api/openapi.json": { GET: handler(openApiDocument) },

    "/api/things":     { GET: guarded(listThings), POST: guarded(createThing) },
    "/api/things/:id": {
      GET:    guarded<{ params: { id: string } }>((token, req) => getThing(token, req.params.id)),
      DELETE: guarded<{ params: { id: string } }>((token, req) => deleteThing(token, req.params.id)),
    },

    // Unknown API paths must not fall through to the SPA's HTML.
    "/api/*": handler(req => fail(`No such endpoint: ${req.method} ${path(req)}. See GET /api.`, 404)),

    "/docs": docs,   // the API reference, its own HTML entry point
    "/*":    index,  // the SPA, for everything else
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});
```

Two ordering rules earn their keep: **`/api/*` before `/*`** (or a typo'd endpoint returns the
SPA's HTML with a 200 on it), and **repeated route shapes get a factory** — `shareRoutes("things")`
returns the `GET`/`POST`/`DELETE` triple so two record types cannot drift apart.

### `server/http.ts` — the shape of every answer

Small and worth copying verbatim:

```ts
export class ApiError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const fail = (message: string, status = 400) =>
  Response.json({ error: message }, { status });

export function handler<T>(fn: Handler<T>): Handler<T> {
  return async req => {
    const started = performance.now();
    let response: Response;
    try {
      response = await fn(req);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 400;
      response = fail(error instanceof Error ? error.message : "Unexpected error", status);
    }
    console.log(`${req.method} ${pathOf(req)} → ${response.status} (${ms(started)}ms)`);
    return response;
  };
}
```

- **Every error is `{ error: string }`**, with a status. One shape for the UI, `curl`, and the
  docs page alike.
- **Every route is wrapped**, so a `throw` anywhere below becomes a correct response. Route
  bodies never `try`/`catch` for the sake of the response shape.
- **Every request is logged** with its status and duration.
- Parameter readers (`intParam`, `boolParam`, `enumParam`) throw `ApiError` with the offending
  value quoted: `"limit" must be a number (got "lots").`

### `guarded` — the auth wrapper

```ts
function guarded<T>(fn: (token: string, req: Request & T) => Response | Promise<Response>) {
  return handler<T>(async req => {
    const token = requireToken(req);
    const context = await loadContext(token);       // GET /api/cpq/context, one round trip
    return withContext(context, () => fn(token, req));
  });
}
```

A route is public if it uses `handler`, authenticated if it uses `guarded`. That is the whole
access-control surface in the route table, and it is visible on every line.

### The request context

`guarded` asks the database once who the credential belongs to — the user, the organization they
are working in, their role there, their memberships, and whether a session or a key arrived — and
runs the handler inside an `AsyncLocalStorage` (`server/context.ts`). Anything below reads it with
`requireContext()` rather than making another round trip.

Asking the database rather than decoding the token is deliberate: for an API key it answers with
the key's organization and role, which is exactly what the rules will apply, and it proves the
credential before anything else runs.

Two things ride on it:

- **"Today" is the organization's date.** `lib/clock.ts` has `today()` read a time-zone provider;
  the server points it at the request's organization and the browser at the signed-in one, so
  pure code in `lib/` gets the right calendar without anything threaded through it. Never write
  `new Date().toISOString().slice(0, 10)` for a business date.
- **A batch is refused before its first write.** `requirePermission("samples.install", "install a
  worked example")` throws a 403 with a sentence when the role cannot, rather than letting the rules refuse
  the fortieth record of forty. It grants nothing — the rules still decide each write.

### Error messages are sentences

Not codes, not `Bad Request`. `An API key cannot manage API keys — sign in to issue or revoke one.`
The message is what the UI shows and what a script's author reads at 3am.

## 5. Auth and sessions

**Three ways in, one identity.** `readToken(req)` returns a credential from, in order:

1. `X-API-Key: <app>_…` — a long-lived key for scripts (checked first: a script that sends one
   means it, and must not silently fall back to a browser cookie).
2. The `<app>_session` httpOnly cookie — what the UI uses.
3. `Authorization: <token>` — a raw user token, for scripts holding one already.

Everything downstream passes that one string through without caring which it is.

```ts
export function sessionCookie(req: Request, token: string, maxAge = WEEK): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly",
                 "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isSecureRequest(req)) parts.push("Secure");   // follows the request, not NODE_ENV
  return parts.join("; ");
}
```

Three details that are easy to get wrong:

- **`HttpOnly`** — page scripts cannot read the token, so an XSS cannot walk off with a session.
- **`SameSite=Lax`** — another site cannot drive this API with your session.
- **`Secure` follows the request, not `NODE_ENV`.** Tying it to the environment looks safer and
  behaves worse: a production container reached over `http://localhost` sets a cookie Safari
  refuses to store, and sign-in fails with nothing to show for it. Read `x-forwarded-proto` first
  so a TLS-terminating proxy still gets the flag.

**Shape-check a token before sending it on.** An expired token makes the database treat the caller
as anonymous, and an anonymous caller matches no ownership rule — so the reply is a perfectly empty
list with a 200 on it. Decoding the JWT's `exp` locally turns that silent empty account into
"sign in again". This proves nothing about authenticity; the signature is the database's to check,
and it does, on every request.

**Signing out revokes the token.** A JWT is good until it expires whatever the browser forgets, so
clearing the cookie ends the session only for that browser. Sign-out records the token's SHA-256 in
a `revoked_tokens` collection, a hook middleware refuses a recorded token with a 401 until its own
expiry, and a daily cron sweeps the table. **Sign out everywhere** rotates the user's `tokenKey`,
which kills every JWT at once. Neither touches API keys — those are revoked one by one.

## 6. API keys

A key is how a cron job or a script reaches the API without a week-long session cookie.

| Decision | The rule |
| --- | --- |
| Format | A fixed prefix + random secret: `<app>_…`. The prefix is the whole test for "is this a key", and it is unambiguous: a session token is a JWT, which always begins `eyJ`, so no token can be mistaken for a key. |
| Storage | **Only a SHA-256 of the key is stored.** The raw value is returned by the issuing response once and never exists again. |
| Issuing | The one operation needing privilege (it hashes a secret and hands it back), so it lives in a **hook route**; the app proxies to it with the caller's own token. |
| Listing / revoking | Ordinary record calls — the collection's own rules let an owner read and delete their keys, and nothing else. |
| Reach | Exactly what its owner reaches. A middleware resolves the key to the same authenticated identity a session produces, so the collection rules are the only access model whichever credential arrived. |
| **A key may not manage keys** | Issuing and revoking require a *session*. Revocation is how you recover from a leak, so it is the one thing a leaked key must not be able to do. Enforce it in both layers — a sentence from the app, a refusal from the database. |
| Organization | A key belongs to the organization it was issued in, and is **refused (403) while its owner works in another**. It cannot carry an organization of its own: a rule resolves `@request.auth.*` from the *stored* user record, not the in-memory one a middleware sets, so overriding it changes nothing a rule sees. Refusing is the only honest option. |
| Expiry | Optional, capped (ten years is not "never", but it is past the life of any script). |
| Last used | Written at most every few minutes, so a busy key does not cause a write per request. |

The public shape never includes the secret:

```ts
type ApiKey       = { id: string; name: string; createdAt: string; expiresAt: string; lastUsedAt: string };
type IssuedApiKey = ApiKey & { key: string };   // the one response that carries it
```

## 7. Storage and access control

**Access control lives in the database, not in the app server.**

Every request carries the caller's own credential, and a client is built *per request* from it:

```ts
export function clientFor(credential?: string): PocketBase {
  const client = new PocketBase(POCKETBASE_URL);
  client.autoCancellation(false);            // server-side there is no "navigated away"
  if (!credential) return client;            // only registration and sign-in
  if (isApiKey(credential)) { /* send it as the key header */ }
  else client.authStore.save(credential, null);
  return client;
}
```

The consequence is the point: **the app server holds no credentials and can therefore grant no
access of its own.** A bug in a route cannot leak another account's records, because the database
evaluates its own rules against the real caller. Never reintroduce a superuser client for ordinary
reads and writes. If something genuinely needs privilege, it becomes a hook route.

**Error mapping** happens in one place (`toApiError(error, context)`), and it distinguishes cases
callers act on differently:

- status `0` → `502`, "the database is unreachable at …" — this server is fine, its database is not.
- status `401` → "Your session has expired — sign in again", not a failure of what was attempted.
- field errors → the first one, named: `email: must be a valid email address` beats
  `Failed to create record`.

### Migrations

`docker/pb_migrations/<timestamp>_<what>.js`, one file per change, baked into the image. Collections,
fields, and — the part that matters — **API rules**, built from two small helpers rather than
written out by hand:

```js
const IN_ORG = '@request.auth.org != "" && org = @request.auth.org';
const role = (...roles) => "(" + roles.map(r => `@request.auth.role = "${r}"`).join(" || ") + ")";

// Everybody in the organization reads; the roles that may write, write.
listRule = viewRule = IN_ORG;
createRule = updateRule = `${IN_ORG} && ${role("admin", "sales")}`;
deleteRule = `${IN_ORG} && ${role("admin")}`;
```

A schema change is a new migration file, never a dashboard edit: a fresh volume comes up without it.

**Backfill data in SQL, and test the statement.** A JSON field reaches the JSVM as a byte array
(`types.JSONRaw`), so reading one, mutating it and saving runs without error and writes nothing.
Use SQLite's `json_set` / `json_each` instead, export each statement as a constant, and run it
against a real database in a test (`server/migration.test.ts`). Make it idempotent, so a re-run
changes nothing.

### Organizations and roles

A rule can only read `@request.auth.<field>`, so the user record carries a **denormalized** `org`
(the one they are working in) and `role` (their role there), beside the real collections:
`organizations`, `memberships` (org, user, role) and `invitations`. Every owned collection has an
`org` relation, and the rules above key off it.

- **Only the organization hooks write `users.org`, `users.role` or a membership.** A setup hook
  clears those fields from any user create or update request, and keeps `role` in step with the
  active membership.
- **`owner` and `org` are stamped from the caller** on create and restored on update by
  `rules/ownership.js`, so neither can be set from a request body. A new collection goes in its
  `OWNED` list, or its records are created belonging to nobody and every rule misses them.
- **A role's reach is written twice**: once in the migration's rules, which grant it, and once as
  `PERMISSIONS` in `lib/organization.ts`, which the UI reads to hide what it would only have
  refused. Change one and you change both, or the UI offers what the database refuses.
- **The last admin cannot be removed or demoted**, and a new account joins every organization that
  invited its address, or gets one of its own as admin.

### A parent and its children, in one batch

Keep a column for what the database queries on and one JSON field for a nested object the app reads
whole — until the nested thing is something people look for on its own (a line, a contact, an
address). Then it becomes a collection with a required, cascading relation to its parent, and the
parent and its children are written in **one PocketBase batch** (`pb.createBatch()`), so a record is
never stored with half its children. Enable batches in a migration (`settings.batch.enabled`, and a
`maxRequests` sized to the largest graph the validator allows), match children on a stable id of
their own so an unchanged one is not rewritten, and cap their number in `lib/` so the batch limit and
the validator cannot disagree. A child's access rules join through the relation
(`quote.org = @request.auth.org`) rather than repeating the parent's.

The same batch makes a multi-record action atomic: a lead's conversion writes a customer, a
contact, an opportunity and the lead's own `converted` stamp together, or nothing.

**A state the rules must hold reads the stored record.** An update rule sees the stored values as
plain fields and the request's as `@request.body.*`, so "a converted lead is fixed" is
`status != "converted"` in the update rule — no request can talk its way past it.

### One collection for a polymorphic link

When several kinds of record grow the same thing — files, comments, tags — give it **one
collection keyed by `target` + `recordId`** rather than a field on each. One upload route, one
download route, one panel, one set of rules. The rules repeat each target's audience by joining
through `@collection.<name>:alias`, so you see an attachment exactly when you can see its record.
A file field is `protected`, and bytes are served only through an app route that mints a file token
as the caller and serves anything a browser could execute as a download — a file shown inline from
your origin runs with your origin's cookies.

### Numbers from counters

A human-facing sequence number (a quote's, an invoice's) comes from a `counters` collection with
**no user rules at all**, incremented inside a transaction by a hook route. Two people saving at
once get two numbers. Take a number at the moment it becomes real — an invoice when it is issued,
not when it is drafted — so a discarded draft leaves no gap.

### Hooks

`docker/pb_hooks/` is server-side JS run by the database's own JS VM, not by Bun. It is the only
place privilege is allowed, and it holds one route per thing that needs it (issuing keys, granting a
share, changing a membership, taking the next number, answering "who am I" for the request
context), plus the global middlewares — one that honours an API key, one that refuses a revoked
token — and the cron that sweeps expired revocations. The server reaches a hook route through one
proxy, `callHook`, with the caller's own token.

> **The one rule people trip over:** a hook body cannot see its own file's scope. Declare what a
> handler needs *inside* the handler, or `require` it there. Code that breaks this registers fine
> and fails only at runtime.

`main.pb.js` is the only `.pb.js` file; everything else is a plain module exporting `register()`,
loaded in a `try`/`catch` so one broken module does not take down the rest.

## 8. API docs (OpenAPI + /docs)

Three surfaces, **one source**:

```
src/server/openapi.ts  ──┬──▶  GET /api/openapi.json   (Postman, Bruno, Insomnia, codegen)
   the document          ├──▶  GET /api                (the index, printed from the same document)
                         └──▶  /docs                   (a React page that fetches and renders it)
```

- The document is **the only list of endpoints.** `GET /api` prints its index rather than keeping a
  second copy, so a renamed route cannot go on being advertised under its old name.
- **Limits are imported, never retyped.** `MAX_TAGS`, `MAX_KEYS`, `PREFERENCE_LIMITS` come
  from `lib/`, so the document cannot promise a bound the server does not keep.
- **OpenAPI 3.0.3**, not 3.1 — every tool reads 3.0 today.
- The file a browser downloads is the same bytes the tools fetch.
- `/docs` is **its own HTML entry point**, not a view inside the app: it is read by people who have
  not signed in, and the document it renders needs no credential. It re-renders whatever is in the
  document, so an endpoint added in `openapi.ts` appears there with nothing else to change — and a
  page that disagreed with the document would be a bug in the document.
- The docs page is **callable**: pick a credential (API key or user token), fill the parameters,
  send it, see the response. That is what makes the reference worth opening twice.

Small helpers keep the document readable:

```ts
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const jsonResponse = (description: string, schema: Json) =>
  ({ description, content: { "application/json": { schema } } });
```

`GET /api` should also answer the questions a reader has before the endpoint list: how to
authenticate, what the error shape is, what the common query options mean.

## 9. The UI

### Entry points

Every `src/**/*.html` is a build entry point, found by a glob — adding a page is adding an HTML
file, with nothing to register. Make something its own page rather than a screen when it is read
by people who have not signed in (`/docs`), or when it should load none of the app (`/table`, a
record browser whose whole state is its URL):

```html
<!-- src/index.html -->
<html><body><div id="root"></div>
  <script type="module" src="./frontend.tsx"></script>
</body></html>
```

```tsx
// src/frontend.tsx — HMR-safe root
const elem = document.getElementById("root")!;
(import.meta.hot.data.root ??= createRoot(elem)).render(<StrictMode><App /></StrictMode>);
```

### Component tiers

| Directory | What belongs there | Test |
| --- | --- | --- |
| `components/ui/` | `button`, `input`, `select`, `sheet`, `dialog`, `combobox`, `tabs`, `kbd`, `portal` — generic, copied in, styled with `cva` + `cn()` | Would it be the same in an unrelated product? |
| `components/app/` | `Chrome`, `Dashboard`, `Launcher`, `SettingsPanel`, `ApiKeys`, `ShareDialog`, the screens — this product | Does it name a domain concept? |
| `components/docs/` | `DocsPage`, `OperationCard`, `SchemaView`, `MethodBadge`, `CodeBlock` | Does it render the API document? |
| `components/table/` | The record browser: the table, the filter builder, the record form, the record workspace (related lists, summary) and its layout editor | Does it render stored records? |

### One table for the frame

`components/app/navigation.tsx` lists every screen (with the letter of its `g` shortcut), everything
that can be started (with the permission it needs) and the shortcuts. The sidebar, the phone's tab
bar, the launcher, the dashboard and the shortcut list all read it, so **a new screen is added
there** and gets its nav entry, launcher command and key together. The key handler is one
`keydown` listener over a pure matcher (`lib/commands.ts`); it stands down in a field, an open menu
and under any `aria-modal`, and a test asserts no binding is the start of another.

### Panels, modals, and where overlays live

- **Forms are panels, previews are modals.** Every editor opens in `ui/sheet.tsx`, a right-hand,
  full-height panel; only things meant to be *read* use `ui/dialog.tsx`. The sheet's body is a
  `@container`, so forms inside it use container queries (`@md:grid-cols-2`), never viewport ones.
- **Overlays are portalled onto `<body>`.** `position: fixed` is only fixed to the window while
  nothing above it has a transform, and an entrance animation is a transform — an overlay left
  where it was written is pinned to the view that opened it.
- **A field that names another record is a searchable `Combobox`**, never a free `Input`, so a typo
  cannot quietly point at nothing.

### The UI hides, the rules refuse

`useAccess()` (`components/app/access.tsx`) reads the session's role through `PERMISSIONS` and hides
what that role cannot do. That is courtesy, not security: the button that is not drawn is a request
the database would have refused anyway.

### `lib/api.ts` is the only client that knows URLs

One typed object (`api.things.list()`, `api.keys.create()`), one place that adds
`credentials: "include"`, one place that turns `{ error }` into a thrown `Error`. A component
that calls `fetch` directly is a bug.

### Theme and preferences on first paint

Carry the account's preferences **on the session object** rather than fetching them after mount —
otherwise the app renders a default theme and then corrects itself in front of the user. Apply the
theme with a `dark` class plus `style.colorScheme`, and honour `system` by listening to
`matchMedia("(prefers-color-scheme: dark)")`. Every page takes the look from one hook
(`components/app/useAccountTheme.ts`), so `/docs` and `/table` do not flash a different theme
against the app.

**Anything that persists lives in the account's preferences.** Nothing in the UI writes to
`localStorage`, so a choice follows the user to another machine.

## 10. Configuration and secrets

`.env.example` is the **documented** list of every variable; `.env` is the copy that runs. Bun
auto-loads it and Compose reads it from the repo root, so `bun dev` and `docker compose up` see the
same values. Group it with comments:

```bash
# --- image versions (compose build args) ---
PB_VERSION=0.40.4
BUN_VERSION=1.4.0

# --- host ports (docker-compose.override.yml) ---
API_PORT=3000
PB_PORT=8091          # not 8090: that default is commonly already taken

# --- database superuser (the dashboard login only) ---
PB_ADMIN_EMAIL=admin@example.com
PB_ADMIN_PASSWORD=change-me-please

# --- sign-up (read by a PocketBase hook) ---
CPQ_SIGNUP=open       # or "invite": only an invited address may register
```

## 11. Docker Compose

```
docker-compose.yml           the app and the database. Publishes NO host ports.
docker-compose.override.yml  local only: publishes 3000 and 8091, mounts hooks/migrations.
```

Compose auto-loads an override only when it discovers the base file on its own — a deploy target
naming a file with `-f` gets the base file alone. That one asymmetry keeps `localhost:3000` working
locally *and* keeps the database's admin UI off the internet wherever this is deployed.

Worth copying:

- **An anchor for shared service settings** (`restart`, log rotation) so a change applies to both.
- **`${VAR:?message}`** for anything required — interpolation happens before any build starts, so a
  missing value fails immediately with a sentence, not halfway through.
- **Tag images by version** (`image: app:${VERSION}`) so bumping the version rebuilds rather than
  silently reusing the old image.
- **`depends_on: condition: service_healthy`** so the app's first request does not race the
  migrations that create its collections.
- **Blank the database's admin credentials in the app container.** It signs in as its own users and
  holds no credentials of its own, so the superuser password has no business being there.
- **Bake hooks and migrations into the image**; mount them only in the override. A bind mount whose
  source the daemon cannot see resolves to an empty directory that *hides* them — which means no
  collections and no superuser, with no error.
- **A profile-gated one-shot service** for resetting the superuser (`docker:init`). Profiles keep it
  from *running*, not from being *parsed* — its variables are interpolated on every compose command.
- **A named volume for the data.** `down` keeps it; `down -v` is what deletes it. Say so in a comment.

Scripts: `docker:up` (`up -d --build`), `docker:down`, `docker:logs`, `docker:init`.

## 12. Tests

`bun test`, with tests beside the code they cover.

| File | Runs | For |
| --- | --- | --- |
| `lib/*.test.ts` | In milliseconds, no I/O | The pure domain: every rule worth keeping has a test beside it |
| `components/*.test.tsx` | `renderToStaticMarkup`, no DOM | Structural rules: every editor is a `Sheet`, every reference field a `Combobox`, no shortcut shadows another |
| `server/openapi.test.ts` | Against the route table | Every documented path is one the server answers on |
| `server/migration.test.ts` | Against SQLite | The backfill statements migrations run, on real rows |
| `server/api.test.ts` | Against a real PocketBase container | The access rules — see below |

**One end-to-end API test is worth more than the rest combined.** `server/api.test.ts` starts a
throwaway database container, registers several accounts, and drives the real HTTP surface:
register → sign in → create → share → read as the other account → export → issue a key → call with
the key → revoke → confirm it now fails; then the same records through each role, a role written
onto one's own account (refused), a removed member (locked out at once), and a key used from the
wrong organization (403). That test is what proves the access rules, not just the routes.

Gate it on the container being available so `bun test` still passes on a machine without Docker,
and print a skip line rather than a green false negative.

## 13. Adding a feature, end to end

The order that avoids rework:

1. **Types and normalizer** → `src/lib/<feature>.ts` (+ its test). Shape first; both sides agree here.
2. **Migration** → `docker/pb_migrations/<ts>_<feature>.js`: the collection, its fields, an `org`
   relation, and rules from `IN_ORG` and `role(...)` on all five. Add it to `OWNED` in
   `rules/ownership.js`.
3. **Permissions** → if it is a new kind of write, a `Permission` in `src/lib/organization.ts` with
   the same roles the rules allow.
4. **Storage** → `src/server/<feature>.ts`: functions taking a token, errors through `toApiError`,
   `requireContext()` for the org or its date.
5. **Privilege, only if unavoidable** → a `pb_hooks/` route the server reaches through `callHook`
   with the caller's token. Declare dependencies *inside* the handler.
6. **Routes** → a block in `src/index.ts` with a comment rule, `guarded` where it needs an account.
7. **The document** → `src/server/openapi.ts`: paths, schemas, limits *imported* from step 1.
   `/api` and `/docs` update themselves.
8. **The client** → `src/lib/api.ts`, then the panel in `src/components/app/` — in a `Sheet`, and
   a screen added to `navigation.tsx` (its `g` key, and a `CREATES` entry with its permission if it
   can be started) if it is one.
9. **The record browser** → if the server owns some of its fields, add the collection to
   `SERVER_OWNED` so `/table` cannot write past the server; if it has records pointing at it, give
   it a built-in workspace layout (related lists, summary).
10. **Tests** → the unit test from step 1, plus a leg in the end-to-end test proving the access rules
   for each role — including a write straight to the database, past the app server.
11. **`.env.example`** if it added a variable, **README** if it added a user-visible capability.

## 14. Conventions at a glance

**Naming**

| Thing | Convention |
| --- | --- |
| Files | `camelCase.ts` for modules, `PascalCase.tsx` for components |
| Tests | Beside the source: `foo.ts` → `foo.test.ts`; DOM tests `*.dom.test.tsx` |
| Routes | Plural nouns, kebab-case: `/api/price-books/:id/shares` |
| API fields | `camelCase` in JSON, whatever the database uses in storage — map at the boundary |
| Timestamps | ISO-8601 everywhere in the API; convert at the boundary, once (`toIso`) |
| Env vars | `SCREAMING_SNAKE`; the app's own carry its prefix (`CPQ_SIGNUP`) |
| API keys | `<app>_` prefix, so identifying one is a string test |
| Constants | Exported `UPPER_SNAKE` from `lib/`, imported by the document — never retyped |

**Rules**

- Every error response is `{ error: string }` with a sentence in it.
- Every route goes through `handler`; every authenticated route through `guarded`.
- Every storage call takes the caller's credential. The server holds none of its own.
- Access control lives in the database's rules. A route is not a security boundary.
- A role's reach is changed in the migration's rules *and* in `PERMISSIONS`, together.
- A business date is `today()`, in the organization's time zone — never the server's UTC date.
- What can be derived is not stored: a status that depends on the date is computed when read.
- Limits are defined once in `lib/` and imported by the validator, the document, and the UI.
- `lib/` imports nothing environment-specific. If it needs `process.env`, it belongs in `server/`.
- A schema change is a migration file, not a dashboard edit.
- A record and its children are written in one batch; nothing is stored half-written.
- Never add two currencies together. A total over records in several currencies is one row per
  currency.
- `/api/*` catches unknown endpoints before `/*` serves the SPA.
- Comments explain **why**, especially where the obvious choice is the wrong one.

**Commands**

```bash
bun install
cp .env.example .env
bun run docker:up      # app on :3000, database on :8091
bun dev                # or run the server on the host against the same database
bun test
bun run build
```
