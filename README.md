# CPQ

Configure, price and quote. Build a catalogue of what you sell — with options, rules, volume tiers
and bundles — put price books and commercial policy around it, and turn that into quotes that price
themselves, route for approval when they should, and render into a document you can send.

Everyone has their own catalogue, customers and quotes. A product, a price book, a quote or a
proposal template can be shared, read-only, with anyone else who has an account, and a quote
awaiting someone's approval becomes visible to that person and to nobody else — see
[Accounts, sharing and approvals](#accounts-sharing-and-approvals).

The app and its database run together under Docker Compose:

```bash
cp .env.example .env     # ports, PocketBase version, dashboard credentials
bun run docker:up        # http://localhost:3000, PocketBase on :8091
```

Open it, create an account, and press **Install the sample** in Settings — it fills the workspace
with a worked example you can take apart.

Usable as a UI or as a local REST API — see [API](#api).

## What it does

### Configure

A **product** is a SKU, a price, a cost, and a shape:

| Part | What it is |
| --- | --- |
| Option groups | Choices the buyer makes. `one` is a radio group, `any` a checkbox list with optional bounds |
| Options | Each adds a fixed amount (`+ $12/user`) and/or multiplies (`× 1.4` for a Premium edition) |
| Configuration rules | `requires`, `excludes`, `recommend`, and `validate` — an arbitrary formula over the line |
| Volume tiers | Price breaks on quantity: `100–499: 18% off`, `500+: set to $75` |
| Bundle components | Other SKUs pulled onto the quote as their own lines, each at its own bundle discount |
| Attributes | Free-form catalogue metadata, rendered on a proposal as a spec table |

Options are priced factor-first, then delta — so `100 × 1.4 + 15` is 155, not `(100 + 15) × 1.4`. A
percentage uplift never silently scales a flat add-on.

Rules reference options by **key**, not by id, so a catalogue survives being exported and imported
somewhere else. `requires` and `excludes` block; `recommend` only warns. A `validate` rule is a
formula:

```
quantity >= 25                          Enterprise starts at 25 users
option.hsm == 0 || option.enterprise    keys are Enterprise-only
```

The configurator runs in the browser as options are clicked *and* on the server when the quote is
saved — the same function, so the editor can never say a configuration is fine that the server will
then refuse.

### Price

The server prices every quote it stores. Totals in a request body are ignored. A line's price is
built in a fixed order, and every step is kept on the line, because the question a CPQ is always
asked is "why is it that price":

| # | Step |
| --- | --- |
| 1 | The price book's entry for the SKU, or the product's catalogue list price |
| 2 | The configured options — the factor, then the delta |
| 3 | The volume tier the quantity falls into |
| 4 | A negotiated unit price override, which replaces 1–3 outright |
| 5 | Pricing rules, by formula, in priority order |
| 6 | The discount — the rep's, or one a rule set |
| 7 | The price book's floor, which nothing may go below |
| 8 | The term: `periods = months ÷ billing period` |

Expanding a line in the editor shows exactly that walk, with each rule that moved it named.

**Money is rounded at every step, to the currency's own precision**, and every total is the sum of
numbers that were already rounded. A quote is checked with a calculator by people about to spend
money, and a total a cent away from its own visible lines costs more to explain than it could ever
save. ¥ carries no decimals, because it does not have any.

**"% off list" is measured against the configured product** — options included, tiers and discounts
not. Any other baseline makes the number meaningless the moment an option adds value: a line whose
options cost more than the base product would read as a markup, and a quote's list total would land
below its own subtotal.

**A price floor is a warning, not an error.** The floor has already done its job — the line is
priced at it — so the quote is correct and sendable; the rep is told their discount did not land in
full rather than being stopped by something the engine already fixed.

**Recurring lines are priced across the whole term**, at `term ÷ billing period` periods —
deliberately fractional, so an 18-month deal on annual billing is 1.5 periods rather than a lie in
either direction. Totals report one-time, MRR, ARR and total contract value separately.

### Pricing rules

Commercial policy changes far more often than software does, so policy is data: a condition and an
expression, both written in the formula language below.

```
name        Three-year commitment
scope       each line
condition   termMonths >= 36 && isRecurring == 1
sets        discountPercent = max(discountPercent, 8)
```

A rule targets `unitPrice`, `discountPercent` or `adjustment` (an amount on the net), is scoped to a
line or the whole quote, and can be narrowed to a product family or a single SKU. Rules run lowest
priority first and each one sees what the last produced, so `unitPrice * 0.9` then `unitPrice - 10`
is 80 rather than 81. A rule whose formula does not parse is reported on the quote rather than
silently doing nothing.

### The formula language

One parser serves pricing rules, approval policy and product validation. Expressions are tokenized,
parsed into an AST and walked by hand — there is no `eval`, no `Function`, and nothing reachable
but the variables passed in.

| | |
| --- | --- |
| Arithmetic | `+ - * / % ^`, parentheses. `^` is right-associative |
| Comparison | `< <= > >= == !=` — they produce `1` and `0`, so a condition *is* an expression |
| Logic | `&& \|\| !`, short-circuiting, so `quantity > 0 && total / quantity > 10` guards properly |
| Functions | `round clamp floor ceil abs sqrt pow min max if` |
| Variables | `quantity`, `unitPrice`, `termMonths`, `marginPercent`… the editor lists every one as a clickable chip |

`if(condition, a, b)` evaluates only the branch it takes, so the other one may divide by zero.
Anything that cannot produce a finite number is `null`, and callers decide what that means: a
pricing rule that cannot be computed does not fire, and an approval condition that cannot be
computed does not approve anything. Neither substitutes a number.

Every expression is checked against the variables its scope actually offers, as it is typed — a
typo is caught by the person writing the rule rather than by the quote it mispriced a month later.

### Quote

A quote has a customer, a price book, a currency, a term, lines, and a life:

```
draft ──submit──▶ in_review ──approve──▶ approved ──▶ sent ──▶ accepted
  ▲                    │                     │                    declined
  └────── reject ───────┘                    └── (no approvals needed: submit lands here)
```

- **Only `draft` and `rejected` are editable.** A quote in review is being looked at by somebody; a
  sent quote exists in someone else's inbox with a number on it. Changing either underneath its
  readers is how a CPQ stops being trustworthy — `New revision` is the way forward.
- **A revision is a new record**, numbered `Q-2026-0007-r2`, pointing at what it supersedes. The
  document that was sent stays exactly as it was sent, which is what makes "which version did they
  sign" a question with an answer.
- **A sent quote past its `validUntil` reads as expired** without being rewritten — expiry is a fact
  about the calendar, not a status that only becomes true when a job sweeps it.
- **A quote snapshots what it was priced from.** Each line carries the product's name, SKU and list
  price as they were; the quote carries the customer's address and terms. A quote sent last quarter
  still renders correctly after the catalogue moves on, and one shared with a colleague who cannot
  read your customers still renders at all.

### Approve

An approval rule watches one number — the discount, the margin, the value, the term — or, for
policies no single number describes, a formula.

| Metric | Fires on |
| --- | --- |
| `discountPercent` | Effective discount off list |
| `marginPercent` | Margin as a percentage of what is charged |
| `netTotal` | Value after every discount, before tax |
| `termMonths` | Subscription length |
| `floorBreach` | A line discounted past the ceiling **its own product** allows |
| `custom` | A formula over the same variables the pricing rules use |

Three things make an approval mean something here:

**A rule asks the people you name, with a quorum.** The approver picker offers everyone with an
account here, and flags anyone named who has not registered — a rule addressed to somebody who
cannot sign in would leave the quote in review forever. One of three is a rota, where whoever is at
their desk answers. Three of three is a board, where everyone signs. Two of three is the
arrangement neither of those describes, and it is the reason the number is yours to set.

Approving and rejecting have **separate quorums**, because they are usually not the same number: a
deal that needs two yeses very often needs only one no. A request is one thing addressed to
everybody rather than one request each, so the quote shows who has answered and who has not, and an
objection outweighs a quorum met in the same breath — an approval body that can be out-voted by
filling the room is not one. A quorum larger than the room is capped on the way in, so a rule can
never be written that nobody could satisfy.

**Levels are cumulative.** A quote deep enough for the VP is not a quote that skips the manager —
it needs every level at or below the highest it trips, and only the lowest outstanding level is
asked at a time.

**Editing a quote voids its approvals.** They are recomputed from scratch on every submit, and a
decision made against the old numbers is never carried forward. Anything else lets a quote be
approved at 20% and sent at 40%.

**The rep sees it coming.** The totals panel shows what submitting *would* ask for, live, as the
discount is typed. A rep who learns at submit time that 32% needs the VP has already told the
customer 32%.

Submitting reprices the quote against the catalogue as it stands now — the thing being approved has
to be the thing that will be sent. A quote that trips nothing is approved outright rather than
sitting in a queue nobody needs to look at.

### Quote documents

A quote renders into a document through a **proposal template**, and a workspace can hold as many
as it likes — a full proposal, a one-page summary, a partner version. Four formats:

| Format | The body is | Good for |
| --- | --- | --- |
| `pdf` | A document description (blocks) | The file a customer receives |
| `html` | Text with tokens | A styled page, an email, a letterhead |
| `markdown` | Text with tokens | Something to paste into a doc or a wiki |
| `text` | Text with tokens | A plain-text quote in the body of an email |

**The three text formats** are text with `{{token}}` placeholders:

```markdown
# {{quote.name}}

**Quote {{quote.number}}** · valid until {{quote.validUntil}}
Prepared for {{customer.name}} ({{customer.contactName}})

{{#lines}}- {{line.quantity}} × {{line.name}} {{line.options}} — {{line.total}}
{{/lines}}

**Total {{totals.grandTotal}}** ({{totals.discountPercent}} off list)
```

`{{#lines}}…{{/lines}}` repeats per line; `{{lines.table}}` drops in a ready-made table in the
template's own format. The editor lists every token as a clickable chip and warns about any it does
not recognise, because an unresolved token renders as a blank in a document going to a customer.
Nothing is executed: rendering is string substitution, and values are escaped for the target format
— a product called `AC/DC <5kW>` renders as those characters rather than as broken markup.

### PDF

**A PDF template is a document described as data** rather than prose, because a PDF has no layout
of its own: something has to say where on the page each thing goes, how wide the columns are, and
what happens when the items run past the bottom. The alternative — writing HTML and rendering it —
means shipping a browser to do it.

So a template is page setup plus an ordered list of blocks, edited as a list rather than as JSON:

| Block | What it draws |
| --- | --- |
| Heading / Text | A title or a wrapped paragraph, with size, alignment and colour |
| Image | A picture in the flow — a logo, a cover band, a diagram — at a width you give, with an optional caption |
| Columns | Side-by-side panels — prepared for / prepared by / valid until |
| Field list | Label and value pairs |
| Line items | The quote's lines as a table: pick the columns, their widths and their alignment |
| Totals | A right-aligned totals panel, each row naming the number it shows |
| Signatures | Ruled areas for names and dates |
| Divider / Spacer / Page break | The usual layout furniture |

Plus a **letterhead**: a logo and a block of text drawn into the top margin, on every page or only
the first. It sits beside the page setup rather than in the block list because it is not part of
the flow — it is drawn after the layout is finished, like the footer, and a proposal whose second
page is unbranded looks like a fax.

Every piece of text in a block runs through the **same token vocabulary as the other formats**, so
`{{customer.name}}` means the same thing in a PDF as in an HTML template.

**The preview is the output.** The renderer is pure and runs in both places, so the template editor
draws the real PDF in an iframe on every change — by the same code the server runs for the file a
customer receives. A preview that could disagree with the download would be worse than none, so it
cannot: there is one implementation. Design a template before you have written a single quote and
it renders against a built-in specimen, itself priced by the real pricing engine so its totals add
up.

**What a PDF template deliberately cannot do.** It cannot print **cost or margin** — the totals it
may name is a closed, customer-facing list, and internal numbers are simply not on it, so the one
artefact designed to leave the company has no way to carry them.

The writer is about a thousand lines with no dependencies, using only the PDF standard 14 fonts, so
a quote is a few kilobytes and opens anywhere without an embedded font. That is the same trade this
codebase makes for the formula language and for CSV: at the size we use the format, owning it costs
less than depending on it. Text is encoded as WinAnsi — the em dashes, curly quotes, `·`, `×` and
the €/£/¥ symbols the rest of the app emits all survive, and anything that cannot be encoded
degrades to something readable (`≥` becomes `>=`) rather than vanishing.

Download a PDF from the **PDF** button on any saved quote, from **Preview** beside any template, or
over the API:

```bash
curl -sb jar "localhost:3000/api/quotes/qte_1a2b3c4d/document?templateId=tpl_1a2b3c4d" -o quote.pdf
```

### Branding

A logo lives **in the template**, as a base64 `data:` URL beside the blocks that use it, so it
travels with an export, a share and an import rather than turning into a broken reference. Drop a
file on the image picker and it is ready to print; the browser flattens transparency onto the paper
colour, scales anything oversized down and re-encodes losslessly, so what gets stored is bytes a
PDF reader can take as they are.

That strictness is the point: the writer embeds an image **without decoding it**. A JPEG's own data
is PDF's `DCTDecode` stream, and a PNG's `IDAT` is `FlateDecode` with the predictor PDF already
knows — so a logo goes into the file byte for byte, at full quality, and the same picture on eight
pages is one object. What that rules out is transparency inside the stream (PDF has no such thing),
interlaced PNGs, CMYK and progressive JPEGs; the editor converts all of those on the way in, and
the API answers a sentence saying which one it hit. An image that cannot be drawn is left out and
reported rather than failing the render — a proposal missing its logo can still be read.

### Move it around

| What | Where |
| --- | --- |
| `*.cpq.json` | Products, price books and both kinds of rule. Meant to live in a repo next to the code that depends on it |
| Quote CSV / JSON | One row per line, money as bare numbers — a CSV with `$1,234.56` in a cell sums to zero |
| Catalogue CSV | The catalogue as a spreadsheet, nested parts flattened to something readable |
| Workspace JSON | Everything: catalogue, policy, customers, templates **and quotes** |

Catalogue files identify records by SKU and name, never by internal id — ids are stripped on export
and minted fresh on import, so the same catalogue exported from two instances produces the same
bytes and stays diffable. Nothing is stored until the whole document validates; an import that
would half-apply leaves a catalogue nobody can reason about. Anything already present by SKU or
name is skipped rather than overwritten, so an import is never the thing that silently changed a
live price.

### The worked example

An empty CPQ is not explorable: you cannot see what a volume tier does without a product that has
one, or what an approval ladder does without a discount deep enough to climb it. **Install the
sample** in Settings adds eight products (a configurable platform with editions and add-ons, usage
and services lines, and a bundle whose components carry the price), two price books with floors,
three pricing rules, a five-rung approval ladder, two customers, seven proposal templates, and a
quote built to trip the ladder. The templates are the documentation for the document format:
between them they use every block, the letterhead, the whole customer-facing totals list and both
kinds of image, and **Start from an example** on the Templates screen opens any of them as a draft
to take apart.

It is additive and idempotent by SKU and name — running it twice does not produce two catalogues,
and it never overwrites something you have edited. Everything goes in through the same validators
and the same pricing engine as anything else: if it would not import as a file, it does not install
either.

### Your own defaults

The gear beside your name opens *Settings*, where preferences decide what the app starts you with —
currency, price book, term, tax, how long a quote is valid, locale, how many quotes the list holds,
and whether deleting asks first. They belong to the account rather than the browser, so they follow
you to another machine, and they save themselves as you change them.

**Show cost and margin** is off by default and worth the switch: margin is the number nobody wants
over their shoulder in front of a customer, and a rep sharing their screen on a call should be able
to put it away in one click.

### Getting around

The left-hand navigation **collapses to its icons**, which is worth a click on a laptop when the
quote editor wants the width. It collapses from the button at the foot of the nav, and — like
every other preference here — the choice belongs to the account rather than the browser, so it
follows you to another machine. Nothing in this app writes to browser storage.

**Every form is a panel that slides in from the right**, full height, about a third of the window.
A centred modal fights the work it is used for: it covers the list you were reading, it cannot be
as tall as the screen, and a long form inside one scrolls in a box floating over another
scrollable box. A panel leaves the record you came from visible beside it and gets the whole
column height for free. Editors size themselves against the panel rather than against the window
behind it, so a dense form reflows to the space it actually has.

The exception is anything meant to be **read** rather than filled in — a rendered proposal, a PDF
preview. Those stay wide modals, because a document squeezed into a third of the screen is a
document nobody can check.

**A field that names another record is a searchable dropdown**, never a text box — a bundle's
component, a price book entry's product, the SKU or family a pricing rule targets, the family on a
product. Each one searches by SKU and by name, shows what it is offering (`bundle`, `inactive`), and
those that mean "any" carry an explicit *Any product* row rather than relying on you to clear the
field.

The reason is that a typo in one of these does not fail loudly. A bundle component whose SKU matches
no product is skipped when the bundle is expanded — the quote simply comes out missing a line, with
nothing to say why. Where a reference can legitimately dangle (a price book may price a SKU this
workspace has not created yet, which is exactly what the importer warns about rather than refusing)
the dropdown still accepts a typed value, and the form says the SKU is not in the catalogue instead
of silently accepting it.

An approver's address is the one reference that stays typable, offering only the addresses your own
rules already use. This app resolves an address but never lists one — there is no directory to
offer, and adding one to save a few keystrokes would be a poor trade.

## Running it

Two containers, defined in `docker-compose.yml`: `app` (this Bun server, UI and API) and
`pocketbase` (the database). `docker-compose.override.yml` publishes their host ports, and Compose
loads it automatically for a local `docker compose up` — a deploy target that names a compose file
with `-f` gets the base file, which publishes nothing.

```bash
cp .env.example .env     # required: PB_VERSION and the superuser credentials
bun run docker:up        # build + start both, in the background
bun run docker:logs      # follow both
bun run docker:down      # stop; the pb_data volume (your data) survives
```

| URL | What |
| --- | --- |
| `http://localhost:3000` | The app |
| `http://localhost:8091/_/` | PocketBase dashboard, as `PB_ADMIN_EMAIL` |

PocketBase creates its superuser on first boot from `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD`
(`docker/pb_hooks/setup/superuser.js`), and never touches it again — rotating the password in the
dashboard survives a redeploy. `bun run docker:init` resets it back to the `.env` values.

**Working on the app itself** is faster outside the container, with only the database in Docker:

```bash
docker compose up -d pocketbase
bun install
bun dev                 # hot reload, http://localhost:3000
PORT=4000 bun dev       # or anywhere else
```

Bun loads `.env` too, so `bun dev` finds the same PocketBase through `PB_PORT`. `POCKETBASE_URL`
overrides the location outright — Compose sets it to `http://pocketbase:8080` for the containerised
app.

### Tests

```bash
bun test
```

The library tests — pricing, the formula language, configuration, approvals, proposals, the file
formats — are pure and run in milliseconds. `src/server/api.test.ts` is end-to-end against a real
Bun server talking to a real PocketBase in a throwaway container built from `docker/`, so the route
table, the storage layer, the collection rules and the hooks are all exercised for real. Without
Docker those tests skip and everything else still runs.

## Accounts, sharing and approvals

Sign-up is open: an email address and a password of at least eight characters make an account.
Everything you then create is yours, and nobody else's list, count or export can reach it.

**Sharing** is read-only and covers the four things worth passing around:

| A recipient can | A recipient cannot |
| --- | --- |
| Open it, and see it under their own list | Rename, edit or delete it |
| Export it | Share it on to anyone else |
| Quote from a shared product or price book — the quotes are theirs, not yours | See who else it is shared with |

Saving a change to something shared with you does not fail — it keeps your own copy, owned by you.
A recipient can drop a share from their own list, and the owner can revoke it at any time.

**Approvals** are the other way someone sees a record of yours, and the narrowest. Submitting a
quote makes it readable by the people its rules name — and only that quote. An approver gets no
access to your catalogue, your customers, your rules or your other quotes. They can record a
decision, and a hook holds them to the approval fields on the way through: an approver who posts a
whole quote with new prices approves the old ones.

**The account directory.** Picking an approver or someone to share with means choosing a person,
so `GET /api/directory` lists the accounts on the instance — **id, email and display name, and
nothing else**. No verified flag, no dates, no preferences, and nothing any of them owns.

Be aware of what that means: with sign-up open, anyone who registers can see every account's
address. The collection rules are untouched — a user token still cannot read the `users` collection
— so this endpoint is the only way through, and it is one file
(`docker/pb_hooks/lib/directory.js`). Drop it from `pb_hooks/main.pb.js`, or close sign-up, if that
is the wrong trade for your instance: every picker treats an empty directory as "type the address
yourself", which is how they behaved before.

Beyond the directory, addresses are still only resolved, never enumerated: sharing and approver
stamping look up the address you give them and say whether an account exists for it.

**Upgrading from the dummy-data generator this grew out of?** Its three collections are dropped by
`docker/pb_migrations/1750000003_cpq.js` — a generated dataset has no CPQ meaning to migrate into.
Take a `GET /api/export` from the old app first if the contents still matter. Records made before
accounts existed have no owner and are invisible until the first account registers, which inherits
them.

## Storage

Everything lives in PocketBase, in seven collections created by `docker/pb_migrations/`:

| Collection | Holds |
| --- | --- |
| `products` | The catalogue: price, cost, and the option groups, rules, tiers and components as JSON |
| `price_books` | Per-customer prices and floors, entries stored whole |
| `pricing_rules` | Formula-driven price adjustments |
| `approval_rules` | Who has to look at what, and when |
| `accounts` | Customers, with their currency, terms and tax position |
| `quotes` | Lines, totals and approvals, stored as priced |
| `proposal_templates` | Document bodies — text with `{{token}}` placeholders, or a PDF document description with its branding inside it |

Each collection has real columns for what the *database* has to do something with — find by SKU,
sort by name, filter by status, match an approver — and one JSON field for the nested domain object
the app reads whole. Spreading option groups across thirty PocketBase fields would buy no query
anything performs and cost a migration every time the domain grew a feature.

Ids stay the readable `prd_…` / `pb_…` / `qte_…` strings the API and the UI use; the migration
widens PocketBase's fixed-length id field to allow them. Preferences get no collection: they are one
`preferences` JSON field on the account's own `users` record, read with the session on every page
load, and they die with the account. Every read and write goes through one normalizer
(`src/lib/preferences.ts`), so a stored blob missing a key still reads back as a complete set.

**Who may do what is decided by PocketBase, not by this server.** Every collection carries API rules
— `owner = @request.auth.id || sharedWith.id ?= @request.auth.id` to read a product, and for quotes
`|| approvers.id ?= @request.auth.id` on top — and the Bun server holds no credentials of its own:
it passes your token through and PocketBase evaluates those rules against *you*. A mistake in a
route here cannot hand one account another's records, because the route has no authority to hand
them over with. The browser never holds a PocketBase token either; it lives in an httpOnly cookie.

Three hooks back that up (`docker/pb_hooks/`): `owner` is stamped from the authenticated account on
create and restored on update, so it cannot be set from a request body; the sharing endpoints run
inside PocketBase, where resolving an address does not require the ability to read the user list;
and `rules/approvals.js` rebuilds a quote from what is *stored* when an approver writes it, putting
back only the decision, the status and the timestamp.

The data is in the `pb_data` Docker volume. `docker compose down` keeps it; `docker compose down -v`
deletes it. A stored quote is capped at 4 MB of line items.

## API

Everything the UI can do is a REST call on the same `Bun.serve` router — no separate API server, no
extra process. `GET /api` returns the endpoint index, so the app documents itself:

```bash
curl -s localhost:3000/api | jq
```

Everything except `/api`, `/api/health` and `/api/auth/*` needs a session. Sign in once with a
cookie jar and every later call is authenticated:

```bash
curl -sc jar -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
curl -sb jar localhost:3000/api/quotes | jq
```

An `Authorization: <token>` header works too, for a script holding a PocketBase user token.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api` | Endpoint index |
| `GET` | `/api/health` | Liveness check — what the container healthcheck polls |
| `GET` | `/api/meta` | PocketBase URL, reachability and your record counts |
| `GET` | `/api/reference` | Every enum, pricing variable and proposal token this app knows |
| `POST` | `/api/auth/register` `login` `logout` | `{ email, password }` → a session |
| `GET` | `/api/auth/me` | The signed-in account, with its preferences |
| `POST` | `/api/auth/password` | `{ currentPassword, newPassword }` |
| `GET` `PUT` | `/api/preferences` | Read / replace this account's preferences |
| `POST` | `/api/formula/validate` | `{ expression, scope }` → check a rule before saving it |
| `GET` `POST` | `/api/accounts` | List / create customers |
| `GET` `PUT` `DELETE` | `/api/accounts/:id` | One customer |
| `GET` `POST` | `/api/products` | List / create products |
| `GET` `PUT` `DELETE` | `/api/products/:id` | One product |
| `POST` | `/api/products/:id/configure` | `{ selectedOptions, quantity }` → validate a configuration |
| `GET` | `/api/products/export` | The catalogue as `*.cpq.json`, or `?format=csv` |
| `GET` `POST` | `/api/price-books` | List / create price books |
| `GET` `PUT` `DELETE` | `/api/price-books/:id` | One price book |
| `GET` `POST` | `/api/pricing-rules` | List / create pricing rules |
| `GET` `PUT` `DELETE` | `/api/pricing-rules/:id` | One pricing rule |
| `GET` `POST` | `/api/approval-rules` | List / create approval rules |
| `GET` `PUT` `DELETE` | `/api/approval-rules/:id` | One approval rule |
| `GET` | `/api/catalog/export` | Products, price books and rules as one `*.cpq.json` |
| `POST` | `/api/catalog/import` | Create everything in a `*.cpq.json` body |
| `GET` `POST` | `/api/quotes` | List (`?limit=`) / create — the server prices it |
| `GET` | `/api/quotes/awaiting` | Quotes waiting on your approval |
| `POST` | `/api/quotes/preview` | Price a quote without storing it |
| `GET` `PUT` `DELETE` | `/api/quotes/:id` | Read / replace a draft / delete |
| `POST` | `/api/quotes/:id/submit` | Reprice, run the approval rules, and submit |
| `POST` | `/api/quotes/:id/decision` | `{ decision, comment? }` → answer as an approver |
| `POST` | `/api/quotes/:id/status` | `{ status }` → sent, accepted, declined, back to draft |
| `POST` | `/api/quotes/:id/revise` | The next revision, leaving this one as it was |
| `GET` | `/api/quotes/:id/export` | Download a quote (`?format=csv\|json`) |
| `GET` | `/api/quotes/:id/document` | Render through a template (`?templateId=`). A PDF template answers with the PDF; `&inline` dispositions it for an iframe |
| `GET` `POST` | `/api/proposal-templates` | List / create templates |
| `GET` `PUT` `DELETE` | `/api/proposal-templates/:id` | One template |
| `GET` `POST` `DELETE` | `/api/{products\|price-books\|quotes\|proposal-templates}/:id/shares` | List / add (`{ email }`) / remove (`?email=`) a recipient |
| `GET` | `/api/export` | The whole workspace as one JSON file |
| `POST` | `/api/sample` | Install the worked example |

Posting a quote sends the header plus `lines`, and gets back the priced quote with every
intermediate number on each line:

```bash
curl -sb jar -X POST localhost:3000/api/quotes -H 'content-type: application/json' -d '{
  "name": "Acme expansion", "accountId": "acc_1a2b3c4d", "currency": "USD", "termMonths": 36,
  "lines": [{ "productId": "prd_1a2b3c4d", "quantity": 40, "discountPercent": 22,
              "selectedOptions": ["enterprise", "sso"] }]
}' | jq '.quote.totals'
```
