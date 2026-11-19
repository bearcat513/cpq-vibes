# CPQ

Configure, price and quote. Track the pipeline that comes before a quote — leads, converted into
customers and opportunities. Build a catalogue of what you sell — with options, rules, volume tiers
and bundles — put price books and commercial policy around it, and turn that into quotes that price
themselves, route for approval when they should, and render into a document you can send. When one
is won, bill it: invoices, payments, credits and an aging report, with every balance worked out
from the ledger rather than stored.

Everything belongs to an **organization**, and a member's **role** — admin, sales, finance or
viewer — decides what they may change. A product, a price book, a quote or a template can be
shared, read-only, with somebody outside it, and a quote awaiting someone's approval becomes
visible to that person and to nobody else — see
[Organizations, roles, sharing and approvals](#organizations-roles-sharing-and-approvals).

The app and its database run together under Docker Compose:

```bash
cp .env.example .env     # ports, PocketBase version, dashboard credentials
bun run docker:up        # http://localhost:3000, PocketBase on :8091
```

Open it, create an account, and press **Install the sample** in Settings — it fills the workspace
with a worked example you can take apart.

Usable as a UI or as a local REST API — see [API](#api).

It is dressed as the plant floor its numbers end up on: cool concrete with a drafting grid,
graphite ink, machined corners, and the signal colours of a shop floor for anything live, late or
wrong — with a dark mode that is the same shop on the night shift. The accent (one of seven signal
colours) and the reading face are yours to pick in Settings; the status colours are not, so paid
always reads as paid. Motion is machine motion, under half a second and always `motion-safe`, and
nothing moves for anyone who has asked it not to.

## What it does

### Pipeline

Before there is a quote there is somebody who might want one. The pipeline has two records:

- A **lead** is a person and/or a company you have not qualified yet — contact details, where they
  came from (web, referral, event, outbound, partner…), a status (`new`, `working`, `qualified`,
  `unqualified`) and an estimated value. Leads are a pool the whole sales team works, not one rep's.
- An **opportunity** is a deal with a customer: a stage (`prospecting` → `qualification` →
  `proposal` → `negotiation` → `closed_won` / `closed_lost`), an amount, a probability, an expected
  close date, a next step and a contact. It is owned like a quote — a rep edits their own, an admin
  any.

**Converting a lead** does four things at once, or none of them: it creates the customer (or uses
one you pick — the screen suggests a customer whose name matches the lead's company), adds the
person as its contact (skipped if someone at that customer already has their email), opens an
opportunity, and marks the lead `converted` with links to what it became. A converted lead is
read-only, and the database refuses an edit to one as well as the server.

**An opportunity generates quotes.** *New quote* on an opportunity starts a draft for its customer,
in its currency, linked to it; the opportunity lists every quote written against it. A linked quote
keeps the link through edits and revisions, its customer must be the opportunity's, and the quote
editor shows the link with an *Unlink* button. Deleting an opportunity keeps its quotes.

**Probability follows the stage** until the deal closes: each open stage has a default you can
change, and a closed stage fixes it — won is 100%, lost is 0% — and records when it closed.
Reopening clears that. The opportunities screen leads with the open pipeline, its weighted value,
what has been won and the win rate, **one row per currency** — never added together. A lead's
estimate is never carried into another currency either: converted onto a customer that bills in
something else, the opportunity starts at 0 rather than at a number in the wrong money.

### Configure

A **product** is a SKU, a price, a cost, and a shape:

| Part | What it is |
| --- | --- |
| Option groups | Choices the buyer makes. `one` is a radio group, `any` a checkbox list with optional bounds |
| Options | Each adds a fixed amount (`+ $12/user`) and/or multiplies (`× 1.4` for a Premium edition), and carries what it costs to deliver |
| Conditions | A group or an option can be shown only `when` a formula holds, so a question that does not apply is never asked |
| Configuration rules | `requires`, `excludes`, `recommend`, and `validate` — an arbitrary formula over the line |
| Volume tiers | Price breaks on quantity: `100–499: 18% off`, `500+: set to $75` |
| Quantity | A minimum, a maximum, and a pack size a quantity has to be a multiple of |
| Availability | The window it may be quoted in. Outside it, a quote warns rather than refuses |
| Bundle components | Other SKUs pulled onto the quote as their own lines, each at its own bundle discount |
| Attributes | Free-form catalogue metadata, rendered on a proposal as a spec table |

Options are priced factor-first, then delta — so `100 × 1.4 + 15` is 155, not `(100 + 15) × 1.4`. A
percentage uplift never silently scales a flat add-on. An option's `costDelta` goes the same way
into the line's cost, so the margin on a configured line is the margin on what is actually being
sold — and no document ever renders it.

**Hiding is not forbidding.** A rule tells a rep that what they picked is not allowed; a
`visibleWhen` means the question was never put to them. A hidden group is not required, its
selections are dropped rather than priced, and a group with nothing left to choose from is not
asked at all. Conditions are resolved to a fixed point, because hiding one group can hide the
next:

```
option.enterprise                       only Enterprise is asked where its data lives
quantity >= 50                          24×7 cover is only sold at scale
```

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

**Usage lines are an estimate, and say so.** A metered product is quoted at the quantity the
customer expects to use, and its value is reported as its own **usage (estimated)** total. It is in
the net total, so the customer sees what the forecast costs, but it is *not* in total contract value
or in recurring revenue — a forecast is not a commitment, and counting it as one inflates exactly
the number an approver reads.

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
- **Numbers come from a counter**, per organization and per year: `Q-2026-0007`. Two reps saving
  at the same moment get two numbers, not the same one.
- **A revision is a new record**, numbered from the original — `Q-2026-0007-r2`, then `-r3`, never
  `-r2-r3` — pointing at what it supersedes. The document that was sent stays exactly as it was
  sent, which is what makes "which version did they sign" a question with an answer.
- **A revised quote is superseded.** The older version reads as `superseded` and can no longer be
  sent, accepted or invoiced; only the latest revision can be revised again, and an accepted quote
  cannot be revised at all — it is a contract. Discard the revision and the original comes back.
- **A sent quote past its `validUntil` reads as expired** without being rewritten — expiry is a fact
  about the calendar, not a status that only becomes true when a job sweeps it. The calendar is the
  organization's: "today" is the date in its time zone (Settings → Organization), so a quote in
  Sydney does not expire at eleven in the morning.
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

**A rule asks the people you name, with a quorum.** The approver picker offers the members of your
organization, and flags anyone named who has not registered — a rule addressed to somebody who
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

### Customers

A **customer** is an account with people in it: a list of contacts, one of them *primary* — who a
quote is addressed to, and whose name and address the quote snapshots — plus a lifecycle status
(`prospect`, `customer`, `inactive`), free-text tags, payment terms, a tax position, and a billing
address. The shipping address follows the billing one until you say it differs. Contacts and
addresses are records of their own rather than a blob on the account, so they can be listed,
linked and searched; a customer, its contacts and its addresses are still saved together, in one
write that lands whole or not at all.

The customers screen is a list you can search, filter by status or tag, and sort, until you pick
one. Then it is that customer's page: their contacts, every quote ever written for them (not just
the latest page), their invoices, their files, and a roll-up — open pipeline, won, win rate. **It never adds two
currencies.** A quote written in something other than the account's currency is counted and
labelled, never summed into a figure that would then be confidently wrong.

An account also carries a **credit limit**, and it is advisory: the customer page shows where they
stand against it, and nothing refuses to quote them for being over it. A limit somebody typed last
year would block the wrong deal more often than the right one.

### Bill

A quote is an offer that gets revised and superseded; an invoice is a number sitting in somebody's
accounts payable. So receivables are **their own collections** — `invoices`, `payments` and
`credits` — not one more quote status.

```
draft ──issue──▶ issued ──▶ open ─▶ part paid ─▶ paid
  │                 │         └──── overdue (past its due date with a balance)
discard            void (only while nothing has been paid)
```

- **Only `state` is stored** — draft, issued or void. *Open*, *part paid*, *paid* and *overdue* are
  worked out from the ledger and the organization's date every time they are asked for. A stored
  "overdue" is wrong the morning after it is written.
- **The balance is never stored either.** Paid and credited are added up from their own records on
  every read, so recording a payment is an insert — two people banking cash at the same moment
  cannot lose one. A balance **may go negative**: an overpaid invoice owes the customer money back,
  and clamping it at zero would lose it.
- **An invoice is numbered when it is issued**, not when it is drafted (`DRAFT-…` until then), so a
  discarded draft leaves no gap. Issuing sets the due date from the account's payment terms.
- **An issued invoice's lines are fixed.** To change what is owed, credit it — an adjustment, a
  return, goodwill or a write-off. A credit larger than the balance is refused, because unlike an
  overpayment it is always a typo.
- **Nothing ever issued is deleted.** A draft may be discarded; anything past that is voided, and
  voiding is refused once a payment exists.
- **The server totals every invoice**, from its own lines, rounding at every step. Totals and
  balances in a request body are ignored — a client that could set its own balance could mark its
  own debts paid.

**Invoice a quote** from any sent or accepted quote: it bills the whole contract value, with the
quote's discount, adjustment and shipping as their own lines, addressed exactly where the quote
was. It warns rather than refuses when something looks wrong — the quote (or an earlier revision of
it) has already been invoiced, a usage line went in at its estimated quantity, or the total lands a
penny off the quote's. Billing a subscription period by period is a billing schedule, and
deliberately not here.

**Receivables** lists invoices by status, and the **aging report** buckets what is owed into
current, 1–30, 31–60, 61–90 and 90+ days overdue — by the balance, not the total, and never across
two currencies.

### Files

A customer, a quote, an invoice or an approval can carry **attachments** — the signed PO, the
customer's own spec, the remittance advice, the screenshot an approver wants to see. Files go in one
`sys_attachment` collection for every kind of record rather than a file field on each, up to 25 MB a
file and 50 files a record.

**You see a file if you can see its record**, and you attach where you could edit the record — plus,
on an approval, anyone asked to approve it, from whichever organization. A file is never served
straight from the database: the download route reads it as you, and anything a browser could run
(HTML, SVG, scripts) is only ever handed out as a download, never shown in place. Deleting a record
deletes its files.

### Documents

A quote or an invoice renders into a document through a **template**, and a workspace can hold as
many as it likes — a full proposal, a one-page summary, a partner version, a remittance-friendly
invoice. Every template has a `kind`, *quote* or *invoice*: the editor, the formats and the block
language are the same, and only what the tokens mean differs. A quote template will not render an
invoice — every token would come out blank — so it is refused rather than sent full of holes. Four
formats:

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

An invoice template has `{{invoice.number}}`, `{{invoice.dueDate}}`, `{{totals.paid}}`,
`{{totals.balance}}` and the rest, and `{{invoice.status}}` and `{{invoice.daysOverdue}}` are
derived **as it renders** — an invoice printed the morning after it falls due says so.

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

And a **watermark**: a word stamped across every page — DRAFT, COPY, SPECIMEN — at the size, angle,
colour and opacity you give it. It is drawn *beneath* the content, so a stamped document is no
harder to read than a clean one, and its text is token-resolved like everything else: the sample
order form stamps `{{quote.status}}` in capitals, so the stamp reads the record rather than the
template.

**The house style is a setting, not a constant.** A template's style holds the leading, the gap
under a paragraph, the heading scale, face and capitals, the colour of rules, and the line-item
table's header fill and colour, zebra striping, grid colour, cell padding and row lines. Every
default reproduces what the renderer used to hard-code, so a template written before the style
existed renders exactly as it did — and a block still wins where it says something of its own, so
one document can hold two tables that do not look alike.

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
artefact designed to leave the company has no way to carry them. Nor can a template of one kind
name the other kind's numbers: there is no balance on a quote and no list price on an invoice.

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
curl -sb jar "localhost:3000/api/invoices/inv_1a2b3c4d/document?templateId=tpl_5e6f7a8b" -o invoice.pdf
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
| Invoice CSV / JSON | One invoice, or every invoice with its aging; the aging report on its own as CSV |
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
three pricing rules, a five-rung approval ladder, two customers, ten templates (seven for quotes,
three for invoices), and a quote built to trip the ladder. The templates are the documentation for the document format:
between them they use every block, the letterhead, the whole customer-facing totals list and both
kinds of image, and **Start from an example** on the Templates screen opens any of them as a draft
to take apart.

**Install the healthcare sample** beside it adds a second example built from the workbook in
`tools/`: 42 data-archiving products, a list price book and four customer contract books, seven
fictional customers, and eight quotes left at every stage from draft to accepted — each written for
an opportunity, in a pipeline with a deal at every stage (one of them lost) and six leads, one
already converted. Five invoices, one billed from an accepted quote, spread its receivables across
the aging, with a payment, a part payment and a credit among them. Its prices are the
workbook's illustrative ones; its costs, and the subsystem prices the workbook leaves out, are
invented and marked in `src/lib/samplesHealthcare.ts`. Install it in an empty account: pricing and
approval rules apply to the whole workspace, so the first sample's would apply to its quotes too.

It is additive and idempotent by SKU and name — running it twice does not produce two catalogues,
and it never overwrites something you have edited. Everything goes in through the same validators
and the same pricing engine as anything else: if it would not import as a file, it does not install
either.

### Your own defaults

The gear beside your name opens *Settings*, one tab at a time:

| Tab | What is there |
| --- | --- |
| Account | Your display name, your password, and *Sign out everywhere* |
| Organization | Its name and time zone, its members and their roles, and your other organizations |
| Appearance | Theme, font, accent, and motion — "reduce" turns animation off on this account whatever the machine says |
| Workspace | The screen the app opens on (Home unless you pick another), quotes per page, locale (with a sample of how it prints), and the switches: cost and margin, ask before deleting, collapsed navigation, single-key shortcuts |
| Defaults | What a new quote starts as — currency, price book, term, tax, validity and its standing notes — a new customer's payment term, and the default quote and invoice templates |
| Data | Exporting the workspace, and (for an admin) installing a worked example |
| API keys | Keys for scripts |

Preferences belong to the account rather than the browser, so they follow you to another machine,
and they save themselves as you change them. Clicking the organization's name in the nav opens its
tab directly.

**Show cost and margin** is off by default and worth the switch: margin is the number nobody wants
over their shoulder in front of a customer, and a rep sharing their screen on a call should be able
to put it away in one click.

### Getting around

**Home** is where the app opens: four figures across the top — open quotes, what is out with
customers, what is waiting on your approval, what the organization is owed — each one a door to the
screen that answers it in full. Below them, *Needs attention* (approvals, quotes expiring this week,
overdue invoices, rejected quotes, unissued drafts), the newest quotes, the pipeline by status, the
records your role may start, and a *Getting started* checklist until the workspace has a product,
a customer, a quote and a template. Money is added up in your default currency only; a quote in
another currency is counted, not summed.

**On a computer the app is a window, not a page.** It fills the browser and holds still: the sidebar
down the left, a title bar with where you are and the launcher, a status bar along the foot (the
database connection, preference saves, your organization and role, and today in the
organization's time zone), and the screen between them as the one thing that scrolls. **On a
phone** the sidebar and both bars go, replaced by a slim top bar (where you are, search, your
account) and a tab bar within reach of a thumb — Home, Quotes, Approvals, Customers, and *More* for
the rest.

**The launcher** (Ctrl K, or ⌘ K on a Mac, from any screen — or `/`) is one box that goes anywhere
and starts anything. Typing filters every command — each screen, each *New …*, each settings tab,
the theme, the margin switch, switching organization — and searches quotes, customers, products and
templates alongside them. Arrow keys move, Enter opens, Escape clears and then closes.

| Keys | Does |
| --- | --- |
| Ctrl/⌘ K, `/` | Open the launcher |
| `?` | List every shortcut |
| `g` then a letter | Go to a screen: `g h` Home, `g l` Leads, `g o` Opportunities, `g q` Quotes, `g a` Approvals, `g i` Receivables, `g p` Catalogue, `g r` Rules, `g c` Customers, `g t` Templates, `g s` Settings |
| `n` then a letter | Start one: `n q` quote, `n c` customer, `n l` lead, `n o` opportunity, `n i` invoice, `n p` product — if your role may |
| `[` | Collapse or expand the navigation |

Shortcuts wait while you are typing in a field and while a panel or dialog is open, so a half-filled
form is never thrown away by a letter. The single-key ones can be switched off under *Settings →
Workspace*; Ctrl/⌘ K stays on, since a modifier cannot fire by accident.

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

An approver's address is the one reference that stays typable: the picker offers the members of your
organization, but an address may be named before it registers.

### The record browser

**Data table** (in the sidebar, the *More* sheet and the launcher; it opens in a new tab so a
half-edited quote is not left behind) is a view of the database itself:

```
/table?table_name=quotes&query=status = "sent" && name ~ "renewal"
```

Pick any collection and it lists the **stored records** — not the domain objects the rest of the
app shows, so there is no derived quote status or invoice balance here, and the page says so. It
reads through your own credential, so the collection's rules decide which rows come back exactly as
they do everywhere else: a viewer sees what a viewer may, a hidden field (an API key's hash) never
arrives, and `counters` is refused for everyone. Columns are inferred from the records, sorting and
paging are done by PocketBase, and the filter is built as a tree of conditions — or typed as text,
which is still applied when the builder cannot draw it. The URL is the page's whole state, so a
filtered view is a link you can send.

**Clicking a row opens the record form**, in a panel like every other editor, and `&record=<id>`
puts it in the URL. Its layout is data: a `record_forms` record per collection holds sections of
fields, each with a widget (text, number, select, tags, JSON…), a label and its bounds. With
nothing stored, the form is built from the record. An admin changes a layout by editing that
record — in the data table, since `record_forms` is a collection like any other.

The server resolves the same layout the form was drawn from, refuses any field it does not offer as
editable, re-runs each field's check, and refuses a save whose record changed underneath it (409).
That narrows what the form writes and grants nothing; the collection's rules still decide.
**Quotes, invoices, their lines, payments, credits, leads and opportunities are read-only here**,
because a raw write would skip what the server works out for them — pricing, totals, a lead's
conversion, a deal's probability and close date — and so are `owner`, `org` and the other fields
PocketBase or a hook sets.

**A row opens the record workspace**, a full page in three panes: the record form, **related
lists** (tabs of the records that point at this one — a customer's contacts, quotes, invoices,
opportunities and files; an opportunity's quotes) and a **summary** column of numbers about it. A
summary line is a field, a **roll-up** (count, sum, average, minimum or maximum over a related list,
optionally filtered) or a **formula** over the lines above it — and a formula with a blank input is
blank, never a zero. The server works the summary out, reading every related row as you, so it adds
up only what you could see, and says so when it stops at 5,000 rows. Customers, quotes, invoices and
opportunities come with a layout built in; an admin changes any of them with *Customize*, which
edits the form and the workspace together and previews the draft against the record on screen. *New*
in a tab creates a related record with the link already filled in, except in a collection only the
server writes.

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

The library tests — pricing, the formula language, configuration, approvals, the pipeline,
proposals, the file formats — are pure and run in milliseconds. `src/server/api.test.ts` is end-to-end against a real
Bun server talking to a real PocketBase in a throwaway container built from `docker/`, so the route
table, the storage layer, the collection rules and the hooks are all exercised for real. Without
Docker those tests skip and everything else still runs.

## Organizations, roles, sharing and approvals

Every record belongs to an **organization**, and every member of it reads all of it — the
catalogue, the customers, the quotes and the receivables are the team's, not one rep's. What each
member may *change* is decided by their **role**:

| Role | May change |
| --- | --- |
| `admin` | Everything: the catalogue, price books, pricing and approval rules, templates, the organization and its members, and any quote or opportunity |
| `sales` | Customers, leads (any of them — they are a pool), and their own opportunities and quotes — create, edit, submit, send, revise, share, delete |
| `finance` | Customers (not deleting them), and receivables: invoices, payments, credits |
| `viewer` | Nothing. Reads everything, which is what a manager, an auditor or a new hire needs |

There is no "approver" role. Approving is something a rule asks of a named person, whatever their
role — a sales director who is a `sales` member approves the quotes their rules send them.

The roles are enforced by PocketBase's collection rules, so a script with an API key is held to them
exactly as the UI is. The UI reads the same table (`src/lib/organization.ts`) only to hide the
buttons it would otherwise offer and have refused.

**Getting in.** A new account joins every organization that invited its address. With no invitation
it gets an organization of its own, as its admin. Set `CPQ_SIGNUP=invite` (in `.env`, read by the
`pocketbase` service) and only invited addresses may register at all — the first account on an empty
instance always may, or nobody could start. Upgrading an instance from before organizations put
each existing account in a personal organization of its own, as admin, holding what it already
owned.

**Settings → Organization** is where an admin renames it, sets its time zone, adds a member (an
address with an account joins at once; any other is invited), changes a role or removes someone.
Removing a member keeps their records with the organization. Nobody can remove or demote the last
admin. Anyone can leave, start another organization, or switch to another they belong to — an
account works in one at a time.

**Sharing** is how a record reaches somebody *outside* your organization. It is read-only and covers
the four things worth passing around:

| A recipient can | A recipient cannot |
| --- | --- |
| Open it, and see it under their own list | Rename, edit or delete it |
| Export it | Share it on to anyone else |
| Quote from a shared product or price book — the quotes are theirs, not yours | See who else it is shared with |

Saving a change to something shared with you does not fail — it keeps your own copy, owned by your
organization.
A recipient can drop a share from their own list, and the owner can revoke it at any time.

**Approvals** are the other way someone sees a record of yours, and the narrowest. Submitting a
quote makes it readable by the people its rules name — and only that quote. An approver from outside
the organization gets no access to its catalogue, customers, rules or other quotes. They can record a
decision, and a hook holds them to the approval fields on the way through: an approver who posts a
whole quote with new prices approves the old ones.

**The directory.** Picking an approver or someone to share with means choosing a person, so
`GET /api/directory` lists **the members of your organization — id, email and display name, and
nothing else**. Nobody can list the accounts of another organization, or of the instance; a user
token still cannot read the `users` collection, and this endpoint is one file
(`docker/pb_hooks/lib/directory.js`). Outside it, addresses are only resolved, never enumerated:
sharing and approver stamping look up the address you give them and say whether an account exists
for it.

**Signing out ends the session.** The token is revoked on the server, not just dropped from the
browser, so a copy of it stops working at once. **Settings → Sessions → Sign out everywhere** ends
every session the account has; API keys are revoked one by one.

**Upgrading from the dummy-data generator this grew out of?** Its three collections are dropped by
`docker/pb_migrations/1750000003_cpq.js` — a generated dataset has no CPQ meaning to migrate into.
Take a `GET /api/export` from the old app first if the contents still matter. Records made before
accounts existed have no owner and are invisible until the first account registers, which inherits
them into its organization.

## Storage

Everything lives in PocketBase, in collections created by `docker/pb_migrations/` — those that
hold the work, those that hold the organization around it, and one that lays out the record
browser:

| Collection | Holds |
| --- | --- |
| `products` | The catalogue: price, cost, and the option groups, rules, tiers and components as JSON |
| `price_books` | Per-customer prices and floors, entries stored whole |
| `pricing_rules` | Formula-driven price adjustments |
| `approval_rules` | Who has to look at what, and when |
| `leads` | People and companies not yet qualified. A converted one names the customer, contact and opportunity it became |
| `opportunities` | Deals: a customer, a stage, an amount, a probability and a close date. Quotes name theirs in an `opportunity` relation |
| `accounts` | Customers: status, tags, currency, terms, credit limit and tax position, each a column |
| `contacts` | A customer's people, ordered, one of them primary. Deleted with the customer. An auth collection nobody can sign in to |
| `sys_physical_location` | Addresses. A customer's billing and shipping relations may name one record, which is what "ship to billing" is |
| `quotes` | The header, totals and approvals, stored as priced |
| `quote_lines` | One row per line of a quote, every scalar a column, the nested parts (options, tier, applied rules) in a `detail` JSON |
| `proposal_templates` | Document bodies for quotes and invoices (a `kind` says which) — text with `{{token}}` placeholders, or a PDF document description with its style and branding inside it |
| `invoices` | What a customer owes: line totals, `state`, `dueDate`. No `status` and no `balance` — both are derived on every read. Numbered when issued, not when drafted, so a discarded draft leaves no gap |
| `invoice_lines` | One row per line of an invoice. Writable only while the invoice is a draft |
| `payments` | Cash received. One row per payment, belonging to one invoice, so banking two at once cannot lose either |
| `credits` | Amounts credited or written off, the same way |
| `sys_attachment` | Files on a customer, quote, invoice or approval, keyed by `target` and `recordId`. Read by whoever can read the record |
| `api_keys` | A SHA-256 per key, hidden, with its name, expiry, last use and the organization it was issued in. Never the key |
| `organizations` | Where records belong: a name and its settings (the time zone) |
| `memberships` | Who is in which organization, as what role |
| `invitations` | Addresses invited to an organization and not yet registered |
| `counters` | The next quote and invoice number, per organization, kind and year. No user can read or write one |
| `revoked_tokens` | The hash of each signed-out session token, until it would have expired anyway |
| `record_forms` | The record browser's form and workspace layout, one per collection per organization. Everyone reads, admins write |

Each collection has real columns for what the *database* has to do something with — find by SKU,
sort by name, filter by status, match an approver — and one JSON field for the nested domain object
the app reads whole. Spreading option groups across thirty PocketBase fields would buy no query
anything performs and cost a migration every time the domain grew a feature. Where a nested thing
*is* something people look for on its own — a line, a contact, an address — it is a collection of
its own, and the parent and its children are written in one PocketBase batch, so a quote is never
stored with half its lines.

Ids stay the readable `prd_…` / `pb_…` / `qte_…` strings the API and the UI use; the migration
widens PocketBase's fixed-length id field to allow them. Preferences get no collection: they are one
`preferences` JSON field on the account's own `users` record, read with the session on every page
load, and they die with the account. Every read and write goes through one normalizer
(`src/lib/preferences.ts`), so a stored blob missing a key still reads back as a complete set.

**Who may do what is decided by PocketBase, not by this server.** Every collection carries API rules
— `org = @request.auth.org || sharedWith.id ?= @request.auth.id` to read a product, the role on
top of that to write one, and for quotes `|| approvers.id ?= @request.auth.id` — and the Bun server
holds no credentials of its own:
it passes your token through and PocketBase evaluates those rules against *you*. A mistake in a
route here cannot hand one account another's records, because the route has no authority to hand
them over with. The browser never holds a PocketBase token either; it lives in an httpOnly cookie.

The hooks back that up (`docker/pb_hooks/`): `owner` and `org` are stamped from the authenticated
account on create and restored on update, so neither can be set from a request body; the
organization routes (`orgs/routes.js`) are the only writers of a membership, a role or a number
counter; the sharing endpoints run
inside PocketBase, where resolving an address does not require the ability to read the user list;
`rules/approvals.js` rebuilds a quote from what is *stored* when an approver writes it, putting back
only the decision, the status and the timestamp; and `keys/routes.js` issues an API key — hashing it
and handing the raw value back once — and resolves an incoming one to its owner, which is what lets
every rule above apply to a key unchanged.

The data is in the `pb_data` Docker volume. `docker compose down` keeps it; `docker compose down -v`
deletes it. A quote may have at most 1,000 lines and an invoice 500.

## API

Everything the UI can do is a REST call on the same `Bun.serve` router — no separate API server, no
extra process.

### Three places the API describes itself

| Where | What it is |
| --- | --- |
| `GET /api` | The endpoint index, plus the pricing pipeline, the approval ladder, the receivables conventions and the document vocabularies |
| `GET /api/openapi.json` | The same API as an OpenAPI 3.0 document — import the URL into Postman, Bruno or Insomnia, or generate a client from it |
| [`/docs`](http://localhost:3000/docs) | That document rendered, and **callable**: pick a credential, fill the parameters, press Execute, read the response |

There is one list of endpoints, in `src/server/openapi.ts`, and all three of those print it. A route
renamed there cannot go on being advertised under its old name anywhere else — which is why this
README no longer keeps a table of its own. `src/server/openapi.test.ts` asserts the other half: that
every path the document names is one the route table actually answers on.

```bash
curl -s localhost:3000/api | jq '.endpoints'
curl -s localhost:3000/api/openapi.json -o cpq.openapi.json
open http://localhost:3000/docs
```

`/docs` is its own page rather than a screen inside the app: it is read by people who have not
signed in, the document it renders needs no credential, and none of the quote editor has to load to
show it. It wears your account's theme, accent and reading face if you are signed in.

### Three ways in

| Credential | Header | For |
| --- | --- | --- |
| API key | `X-API-Key: cpq_…` | A script, a cron job, a CI step |
| User token | `Authorization: <token>` | Something already holding a PocketBase token — sent raw, no `Bearer` |
| Session cookie | set by `POST /api/auth/login` | The app, and `curl -c jar -b jar` |

All three reach the same account, and every endpoint takes any of them. `GET /api`, `GET
/api/health`, `GET /api/openapi.json` and the three sign-in routes need no credential; everything
else does.

```bash
curl -sc jar -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
curl -sb jar 'localhost:3000/api/quotes?q=acme&status=sent&page=1&perPage=50' | jq
```

A list that pages says how much there is in its headers — `X-Total-Count`, `X-Page`,
`X-Per-Page`, `X-Total-Pages` — so the body stays a plain array.

Every failure answers `{ "error": string }` with a sentence in it, and an honest status: 400 for a
bad request, 401 for a missing or spent credential, 403 where a key reaches for something only a
session may do or a role reaches for something it may not change, 404 for a record that does not exist — or that exists and is not yours, which this
API declines to tell apart — and 422 where the request was understood and the record's own state
refuses it (editing an issued invoice, voiding one that has been paid).

### API keys

A session expires in a week and lives in a cookie, which is right for a browser and useless for the
nightly job that raises invoices. Issue a key under **Settings → API keys**, or:

```bash
curl -sb jar -X POST localhost:3000/api/keys -H 'content-type: application/json' \
  -d '{"name":"Nightly invoice run","expiresInDays":365}' | jq -r .key
```

```bash
export CPQ_API_KEY=cpq_…
curl -s localhost:3000/api/receivables/aging -H "X-API-Key: $CPQ_API_KEY" | jq
```

| Decision | The rule |
| --- | --- |
| Format | `cpq_` plus 40 random characters. The prefix is the whole test for "is this a key", and it is unambiguous: a session token is a JWT, which always begins `eyJ` |
| Storage | **Only a SHA-256 is stored**, in a hidden field. The raw value is in the issuing response and nowhere else, ever — lose it and the remedy is to revoke it and issue another |
| Reach | Exactly what its owner reaches, with its owner's role. A hook resolves a key to the same `@request.auth` a token produces, so the collection rules are the only access model whichever credential arrived |
| Organization | A key belongs to the organization it was issued in. While its owner is working in another, it is **refused with a 403** — switch back, or issue a key in the new organization. (The rules read the owner's organization from the database, so a key cannot carry one of its own) |
| **A key cannot manage keys** | Issuing and revoking need a real session. Revocation is how you recover from a leak, so it is the one thing a leaked key must not be able to do — refused by the app with a sentence, and by PocketBase on its own |
| Expiry | Optional, capped at ten years. Revoking takes effect on the key's next request |
| Last used | Written at most every few minutes, so a busy key does not cause a write per request |

At most 25 keys per account. `GET /api/keys` lists them — with `name`, `createdAt`, `expiresAt` and
`lastUsedAt`, and never the key — and `DELETE /api/keys/:id` revokes one.

### Writing a quote

Posting a quote sends the header plus `lines`, and gets back the priced quote with every
intermediate number on each line. **The server prices it**: totals in the request body are ignored
and overwritten, and the same is true of an invoice's totals and balance.

```bash
curl -sb jar -X POST localhost:3000/api/quotes -H 'content-type: application/json' -d '{
  "name": "Acme expansion", "accountId": "acc_1a2b3c4d", "currency": "USD", "termMonths": 36,
  "lines": [{ "productId": "prd_1a2b3c4d", "quantity": 40, "discountPercent": 22,
              "selectedOptions": ["enterprise", "sso"] }]
}' | jq '.quote.totals'
```
