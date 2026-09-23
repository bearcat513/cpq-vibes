# Document templates — a reimplementation spec

How a stored template turns into the HTML, Markdown, plain text or PDF a customer receives, and
exactly what has to move, be rewritten, or be left behind to run the same machinery in another
application.

---

## 1. Scope

The subsystem answers one question: **given a business record and a template the user wrote, produce
the file a customer reads.** Four output formats, two record kinds, a block-based PDF designer, and
**zero runtime dependencies** — no headless browser, no PDF library, no template engine.

**In scope**

- A `{{token}}` substitution renderer with per-format escaping and one repeating block.
- Two token *vocabularies* (quote, invoice) over one renderer.
- A JSON block language for PDFs, plus a hand-written PDF 1.7 writer.
- Embedding PNG/JPEG byte-for-byte (letterheads, logos, signatures).
- Validation that normalises a template on the way to storage.
- A live-preview editor that runs the production renderer.

**Out of scope**

- Expression evaluation in templates. Substitution only — a template is a document, never a program.
- Embedded fonts, links, forms, encryption. Standard 14 fonts only.
- Image decoding. Anything a PDF reader cannot take as-is is refused, not converted (server side).
- Email delivery, e-signature, versioning of rendered output.

> **The one design rule that shapes everything: one renderer, two vocabularies.** Adding invoice
> documents to an app that already rendered quotes added a `kind` column and one file — not a second
> renderer, editor or escaping path. Preserve that split when you port it, or the second document
> type becomes a copy of the first with the nouns changed.

---

## 2. Architecture

Four layers. Everything below the record layer is a pure function of its inputs, which is what lets
the browser render a live preview with the same code the server uses for the delivered file.

| Layer | Files | Portable? |
| --- | --- | --- |
| Records & context | `Quote`, `Invoice`, seller, locale, `asOf` | domain — yours to replace |
| Vocabularies | `proposal.ts`, `invoiceDocument.ts` | one file per record kind — rewrite |
| Renderers | `document.ts`, `pdfTemplate.ts` | pure, kind-agnostic — as-is |
| Output primitives | `pdf.ts`, `pdfFonts.ts`, `image.ts`, `money.ts` | pure, domain-free — as-is |

Render pipeline, in order:

```
text formats  record ─▸ vocabulary.resolve() ─▸ DocumentSource ─▸ renderTemplate()
                └ expand {{#lines}} per row ─▸ substitute scalars ─▸ escape per format ─▸ string

pdf format    record ─▸ quotePdfSource() / invoicePdfSource() ─▸ PdfSource
                └ readPdfTemplate(body) ─▸ PdfTemplate ─▸ renderPdfDocument()
                    └ blocks ─▸ PdfDocument cursor ─▸ onEachPage(header/stamp/footer) ─▸ Uint8Array
```

The `DocumentSource` / `PdfSource` boundary is the seam. Nothing below it imports `Quote` or
`Invoice`; nothing above it knows about escaping, pagination or PDF operators.

---

## 3. The text template format

Three of the four formats — `html`, `markdown`, `text` — store the document as authored text with
holes in it. HTML, Markdown and plain text each decide their own layout, so nothing needs to position
anything.

```ts
TOKEN_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g

LINES_OPEN  = "{{#lines}}"        // everything between is rendered once per line
LINES_CLOSE = "{{/lines}}"
LINE_TABLE_TOKEN = "lines.table"  // a ready-made table in the target format
```

### Rules the renderer enforces

1. **The repeating block expands first.** A `{{line.*}}` token therefore resolves only where it means
   something; outside the block it reports as unknown rather than quietly rendering blank.
2. **An unknown token renders as a blank, and is collected.** `RenderResult.unknownTokens` drives the
   editor's warning. An unresolved `{{foo}}` reaching a customer is worse than a gap the author sees
   in preview.
3. **Values are escaped per format on the way in.** HTML escapes `& < > " '`; Markdown escapes only
   `|` and newlines (a pipe breaks a table, everything else is a product name that should read as
   written); plain text escapes nothing.
4. **`RAW_TOKENS` bypass escaping.** Exactly three: `lines.table`, `customer.address`,
   `customer.shippingAddress`. Each is produced by the app from already-escaped data — an address is
   four lines, and four lines are `<br />` in HTML and newlines elsewhere. *Never add a user-authored
   value to this set.*
5. **Substitution uses a replacer function, never a string.** A customer value containing `$&` would
   otherwise be read as a replacement pattern and corrupt the document. Customer data is exactly
   where a stray `$` turns up.
6. **An unclosed `{{#lines}}` is an authoring mistake, not a failure.** The marker is dropped and the
   rest renders.

### The shape a vocabulary hands over

```ts
type DocumentSource = {
  values: (format: ProposalFormat) => Record<string, string>;  // scalar tokens
  lines: Record<string, string>[];                             // one map per row
  table: (format: ProposalFormat) => string;                   // {{lines.table}}
};

type RenderResult = { text: string; unknownTokens: string[] };
```

`values` takes the format because a few tokens are written *in* it. Shared helpers — `formatTable()`,
`formatAddress()`, `escapeHtml()`, `escapeMarkdown()`, `documentFileName()`, `CONTENT_TYPES` — live
beside the renderer so a table lays out identically whichever record produced it.

---

## 4. Vocabularies: what a token means

A vocabulary is one file per record kind. It publishes the token list (the editor's picker and the
API's documentation read from it), resolves those tokens against a record, and builds the two source
objects. It is the *only* place a record type is named.

| Export | Quote (`proposal.ts`) | Invoice (`invoiceDocument.ts`) |
| --- | --- | --- |
| `TOKENS` | `PROPOSAL_TOKENS` — 31 scalars | `INVOICE_TOKENS` — 28 scalars |
| `LINE_TOKENS` | 13 (`line.options`, `line.term`, `line.billing`…) | 9 (`line.taxPercent`, `line.taxAmount`…) |
| `…Source` | `quoteSource()` | `invoiceSource()` |
| `…PdfSource` | `quotePdfSource()` | `invoicePdfSource()` |
| `render…` | `renderProposal()` | `renderInvoiceDocument()` |
| Context | `{ quote, sellerName, sellerEmail, locale? }` | `{ invoice, …, asOf? }` |

Each `TokenDescription` is `{ token, description }` — the description is the sentence the editor
shows beside the token, and the list is the contract: a template can reach exactly these values and
nothing else.

### Two conventions worth copying

- **Spell the shared halves identically.** `customer.*` and `seller.*` are character-for-character
  the same in both vocabularies, so one letterhead, address panel or signature block works in either
  kind of template.
- **Derive at render time what is derived everywhere else.** `{{invoice.status}}` is computed as the
  document renders, never read off the record — an invoice printed the morning after it falls due
  says "Overdue" because the date says so. `{{totals.balance}}` is printed as held, including
  negative: an overpaid invoice owes money back, and clamping it at zero loses a customer's money.
- **Export the resolution, don't duplicate it.** The PDF renderer draws strings rather than markup,
  so it calls `proposalTokenValues()` / `invoiceTokenValues()` — the same `resolve()`, run for the
  `text` format. That is what keeps `{{customer.name}}` meaning the same thing in a PDF as in an
  email.

### Adding a third kind — the full checklist

1. Add the name to `TemplateKind`, `TEMPLATE_KINDS`, `TEMPLATE_KIND_LABELS`.
2. Write the vocabulary file: token lists, `resolve()`, `resolveLine()`, the two exported value
   functions, the line table, the `DocumentSource` and the `PdfSource`.
3. Add its line-field and totals-field unions, and its entries in `lineItemFields(kind)` /
   `totalsFields(kind)`.
4. Add default columns, default totals rows, a starter template, and the `blankBlock(type, kind)`
   branches.
5. Add the route (or a branch in the existing one) and a specimen record for the editor preview.
6. Map the kind to its vocabulary in the templates screen.

Nothing in `document.ts`, `pdfTemplate.ts`'s renderer, `pdf.ts` or the validator's block reader
changes.

---

## 5. The PDF template format

A PDF has no layout of its own, so a `pdf` template is not text — it is a **document described as
data**: page setup, a house style, optional page furniture, and an ordered list of blocks. Every
string in it still runs through the same token vocabulary.

```ts
type PdfTemplate = {
  page: PdfPageSetup;        // paper, margins, face, body size, 3 colours
  style?: PdfStyle;          // the house style; absent = defaultStyle(page.fontSize)
  header?: PdfHeader;        // letterhead, drawn in the top margin of every page
  watermark?: PdfWatermark;  // a stamp drawn beneath the content
  blocks: PdfBlock[];        // the flow, max 200
  footer: { text: string; showPageNumbers: boolean };
};
```

### Blocks

| Type | Draws | Notable fields |
| --- | --- | --- |
| `heading` | A title line | `size` (default `fontSize × headingScale`), `align`, `color` |
| `text` | A wrapped paragraph | `bold`, `italic`, `size`, `color`, `spaceAfter` |
| `image` | A picture in the flow | `source` (data URL), `width`, `caption` |
| `columns` | Up to 4 side-by-side panels | each `{ heading?, text, align? }`; the block ends below the *tallest* |
| `fields` | Label/value pairs, ≤ 40 | values go through `text()` so a multi-line address stays multi-line |
| `lineItems` | The line table | `columns[]`, `showOptions`, `showDescription`, `headerFill`, `zebra`, `fontSize` |
| `totals` | A right-aligned totals panel | `rows[]` (`emphasis`, `omitIfZero`), `width` |
| `signatures` | Up to 4 ruled areas | moves whole across a page break — a split signature block is useless |
| `divider` | A horizontal rule | `color` (default `style.ruleColor`), `thickness` |
| `spacer` | Vertical space | `height` |
| `pageBreak` | Starts the next page | — |

### The house style

`PdfStyle` is where a renderer constant goes to become a setting: leading, paragraph gap, heading
scale, an optional heading face, heading capitals, rule colour, and the line-item table's fill,
header colour, capitals, zebra, grid, row lines and cell padding. Two rules govern it.

- **Every default reproduces the constant it replaced**, so a template written before the style
  existed renders exactly as it did. `headingScale` is therefore *computed*: a heading used to be
  body + 9pt — a step, not a ratio — so the default is `round((size + 9) / size, 3)`, keeping a 12pt
  template's headings at 21pt rather than growing them to 22.8.
- **A block still wins over the document** wherever it says anything, so one template can hold two
  tables that do not look alike.

Two deliberate exceptions: the totals rule stays the *accent* colour (it underlines the number the
document is about), and the table grid has its own colour rather than `ruleColor` — a grid is read
*through*, a divider is read.

### Page furniture

- **Letterhead** — logo plus text in the top margin, bottom-aligned to a common baseline, optional
  rule, optional `firstPageOnly`. Drawn after layout via `onEachPage`, because a block would put it
  on page one only and a proposal whose second page is unbranded looks like a fax. The band is the
  top margin less a 20pt gap; a taller logo is scaled down rather than allowed to print over the
  first paragraph.
- **Watermark** — token-resolved like everything else (`{{quote.status}}` stamps what the record
  actually is), optional capitals, and drawn *beneath* the content so a stamped document is no harder
  to read than a clean one.
- **Branding lives inside the template** as a base64 `data:` URL, so it survives an export, a share
  and an import. A logo referenced anywhere else breaks on the first of those journeys.

> **A closed list is a security control.** The line-item and totals field lists are **closed and
> customer-facing**. Cost, margin and margin percent appear on neither, and the validator silently
> drops any field not on the list. A template is the one artefact designed to be sent outside the
> company; the cheapest way to guarantee it never carries internal numbers is to give it no way to
> name them. Neither kind can name the other kind's numbers either.

---

## 6. The PDF writer

`pdf.ts` emits PDF 1.7 directly — roughly 980 lines, no dependencies, output measured in kilobytes.
`PdfDocument` is a **cursor, not a canvas**: blocks are added top to bottom, it tracks where it is,
starts a new page when it runs out of room, and repeats table headers across the break. Coordinates
are points (72/inch) with the origin top-left; the flip to PDF's own convention happens in one
function.

| Group | API |
| --- | --- |
| Cursor | `y` (get/set), `left`, `contentWidth`, `contentBottom`, `remaining`, `pageCount` |
| Flow | `text()`, `image()`, `rule()`, `table()`, `moveDown()`, `ensureRoom()`, `addPage()` |
| Absolute | `drawTextAt()`, `drawRule()`, `drawRect()`, `drawImageAt()`, `drawWatermark()` |
| Deferred | `onEachPage(draw, { beneath })` |
| Output | `toBytes()` → `Uint8Array`; `pdfResponse(bytes, fileName, inline)` |

### Three implementation details that will bite a porter

1. **Text literals are byte runs marked with NULs.** `drawTextAt` writes `` `\0${bytes}\0 Tj` `` and
   `serializeOperators` splices the real bytes in. Write that marker as a space and the operator is
   emitted as the literal digits. Keep the marker; keep the splice.
2. **`onEachPage(draw, { beneath: true })` draws *under* the page's own content** by rendering into an
   empty operator list and splicing it in front. That is what a watermark is, and it is why header,
   stamp and footer are all deferred until the page count is known.
3. **Fonts are the standard 14, encoded WinAnsi.** `pdfFonts.ts` carries the metrics for Helvetica,
   Times and Courier in four styles and provides `measureText / wrapText / truncateToWidth`. No
   embedding means no font files and no licensing, at the cost of no non-Latin-1 text.

### Images

`image.ts` **decodes nothing**. A JPEG is PDF's `DCTDecode` stream and a PNG's `IDAT` is
`FlateDecode` with predictor 15, so an embeddable picture is copied in byte for byte; alpha,
interlace, CMYK and progressive JPEG are refused with a sentence. Limits are 750 KB and 6000 px per
side, PNG and JPEG only. The same picture used on every page is one PDF object, and decoding is
memoised per render — a failure is cached as its own message so a second block using the same broken
picture is reported against that block and the first is not reported twice.

`imageFile.ts` is the browser-only counterpart that makes those refusals invisible in the UI: it
flattens and re-encodes through a canvas before the bytes ever reach the template.

---

## 7. Validation and normalisation

`readProposalTemplate()` / `readPdfTemplate()` are shared by the REST API, the file importer and the
editor. A PDF body is parsed, clamped and **stored back as canonical JSON**, so the renderer never
guesses at a half-formed block and a body written by hand against the API gets exactly the defaults
the editor uses.

### The posture: drop, don't refuse

- An **unrecognised block type** is dropped — a template from a future version should lose the block
  it cannot draw, not the page.
- An **unknown column or totals field** is dropped (this is what keeps `cost` out of a customer
  document). A table left with no usable column falls back to the kind's defaults rather than
  rendering empty.
- An **unreadable image** becomes an empty source; the block keeps its place and the editor reports
  what was wrong, rather than failing a save on a file somebody just chose.
- An **empty body** is a brand-new template, not an error — it becomes the starter template for its
  kind.
- Hard failures are only: invalid JSON, a non-object body, and *no blocks at all*.
- A template is read **against its own kind**, so one switched from quote to invoice comes back with
  a table it can actually fill.

### Bounds

| Field | Min | Max | Default |
| --- | ---: | ---: | --- |
| Template name | 1 | 120 | — |
| Body, text formats | 0 | 200,000 | — |
| Body, PDF format | 0 | 3,000,000 | separate limit: a letterhead is hundreds of KB of base64 |
| Blocks per template | 1 | 200 | — |
| `page.fontSize` | 6 | 18 | 10 pt |
| `page.margins.*` | 12 | 200 | 56 / 48 / 56 / 48 |
| `style.lineHeight` | 1 | 3 | 1.35 |
| `style.paragraphSpacing` | 0 | 48 | 4 pt |
| `style.headingScale` | 1 | 4 | (size + 9) / size |
| `style.table.cellPadding` | 1 | 24 | 5 pt |
| heading `size` | 6 | 72 | 18 pt |
| text `size` | 5 | 48 | 10 pt |
| image `width` | 8 | 900 | 140 pt |
| header `logoWidth` | 8 | 400 | 110 pt |
| totals `width` | 120 | 600 | 260 pt |
| watermark `size` / `opacity` / `angle` | 8 / 0.01 / −90 | 400 / 1 / 90 | 84 pt / 0.08 / 45° |
| Columns, signature parties | 1 | 4 | — |
| Field rows | 0 | 40 | — |

Every bound is a legibility bound rather than a taste one: leading below 1 overlaps its own
descenders, a heading smaller than the body is not a heading, and a cell with no padding puts a
number against a grid line.

**Absent stays absent.** An empty letterhead, an empty watermark and an unset heading face are
omitted keys, not empty objects — "no heading face" means "follow the body", which is not the same as
naming the body's face and would stop following it the moment somebody changed the body. The *style*,
by contrast, is always written: a stored template carries its whole style so the defaults cannot
shift under it later.

---

## 8. Storage

One collection, `proposal_templates`, for both kinds — because a template is a template: same editor,
same letterhead, same block language, and only the meaning of a token differs.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text | — |
| `name` | text, required | max 120, mirrors `MAX_TEMPLATE_NAME_LENGTH` |
| `kind` | text | `quote` \| `invoice`; blank reads as `quote` |
| `format` | text | `html` \| `markdown` \| `text` \| `pdf` |
| `body` | text | max 3,000,000 — prose or canonical JSON |
| `owner` | relation | indexed; set server-side |
| `sharedWith` | relation[] | a shared template renders like your own |
| `created` / `updated` | autodate | list is sorted `-updated` |

The body is one text column rather than a JSON column, which matters in this stack: in PocketBase's
JSVM a JSON field arrives as a byte array, so reading one, mutating it and saving runs without error
and writes nothing. Backfills are done in SQL and tested as statements.

### Schema history, as three migrations

1. **Create** — name, format, body (200,000), owner, sharedWith, owner index.
2. **Widen for branding** — `body.max` → 3,000,000 so a template can carry its own pictures. The down
   migration *refuses* rather than truncating, and says how many templates are in the way.
3. **Add `kind`** — plus `UPDATE proposal_templates SET kind = 'quote' WHERE kind IS NULL OR
   trim(kind) = ''`. Backfilled rather than left empty: a column that means something only by
   omission is one somebody will eventually read the wrong way round.

Access control lives in the database's own rules, not in the app server — templates are owned,
shareable records like any other. Saving a template someone shared with you creates *your* copy,
named "… (my copy)".

---

## 9. HTTP surface

| Method & path | Does |
| --- | --- |
| `GET /api/proposal-templates` | Yours and those shared with you, both kinds |
| `POST /api/proposal-templates` | Create; body is validated and normalised |
| `GET\|PUT\|DELETE …/{id}` | Read / replace / delete (owner only for the last two) |
| `…/{id}/shares` | Share and unshare |
| `GET /api/quotes/{id}/document` | `?templateId=` `&inline` |
| `GET /api/invoices/{id}/document` | Same shape, invoice vocabulary |

### Template selection

`pickTemplate(templates, kind, templateId)` filters by kind first, then:

- no `templateId` → the first template of that kind, else **404** "There are no invoice templates yet
  — create one first."
- id exists but is the other kind → **422** naming both the template and the mismatch. The id *does*
  exist, and being told it does not is the kind of message people spend an afternoon on.
- id is unknown → **404**.

Kind is not a filter for tidiness: a quote template rendered against an invoice resolves every token
to a blank and hands the customer a document full of holes.

### Response shapes

- **Text formats, download** — the rendered string with the format's content type and a slugged
  filename (`q-2026-0007-acme.md`).
- **Text formats, `?inline`** — JSON: `{ text, format, templateId, templateName, unknownTokens }`,
  for the preview pane.
- **PDF** — always the bytes; `?inline` only changes the content disposition, because a PDF preview
  *is* the PDF.
- **Unrenderable PDF template** — 422, quoting the template name and the parse error.

What a document renders is the record *as it stands*: an invoice's balance is recomputed from the
ledger on that read, so a document downloaded after a payment shows the payment.

---

## 10. Editor contract

Two components: a templates screen (list, name, kind, format, token picker, unknown-token warning)
and a PDF block editor (blocks on the left, the document on the right).

1. **The preview runs the production renderer.** `renderPdfDocument()` is called on every change and
   the bytes go into a blob URL in an `<iframe>` — every target browser has a PDF viewer, so there is
   nothing to ship. This is the whole reason the renderer is pure: a template editor whose preview
   can disagree with the file is worse than no preview.
2. **The preview is drawn against a specimen record** priced and totalled by the real engines — a
   specimen quote or a specimen invoice, chosen by the template's kind. No network round-trip, and no
   dependence on the user having a quote yet.
3. **The editor parses through the server's own validator.** A body written by hand against the API
   opens with exactly the defaults it will be stored with; an unparseable one opens as the starter
   template rather than a blank screen.
4. **Revoke the previous blob URL on every render.** A blob URL is a document-lifetime resource;
   leaking one per keystroke holds every intermediate render in memory for the session. Revoke on
   unmount too.
5. **A render failure is caught and shown, never thrown.** The last good preview stays on screen with
   the message beside it.
6. **Unknown tokens are reported as you type** (`unknownTokensIn(body, vocabulary)`), and the token
   list is clickable — nobody should transcribe `{{totals.grandTotal}}` by hand.
7. **Ship worked examples, and make "new" mean a complete document.** Ten sample templates between
   them use every block, the letterhead and the whole totals list; a new template starts as a
   sendable starter rather than a blank page, so the first template is an edit instead of an
   afternoon.

---

## 11. Porting

### File manifest

| File | LOC | Move as-is? | Depends on |
| --- | ---: | --- | --- |
| `lib/pdf.ts` | 980 | yes, verbatim | `pdfFonts`, `image` |
| `lib/pdfFonts.ts` | 392 | yes, verbatim | — |
| `lib/image.ts` | 430 | yes, verbatim | — |
| `lib/imageFile.ts` | 202 | yes, verbatim (browser) | `image` |
| `lib/money.ts` | 144 | yes, or swap for yours | currency list |
| `lib/document.ts` | 278 | yes, minus the `Address` import | `types` |
| `lib/pdfTemplate.ts` | 1,368 | partly — renderer verbatim; field unions & sources are yours | vocabularies |
| `lib/proposal.ts` | 213 | no — rewrite per record | `Quote` |
| `lib/invoiceDocument.ts` | 233 | no — rewrite per record | `Invoice`, `receivable` |
| `lib/validate.ts` | ~350 of 1,311 | partly — extract the template half | `pdfTemplate` |
| `components/PdfTemplateEditor.tsx` | 1,162 | partly — port with your UI kit | `pdfTemplate` |
| `components/TemplatesView.tsx` | 455 | partly — port with your UI kit | all of the above |
| `components/ImagePicker.tsx` | 129 | partly — port with your UI kit | `imageFile` |

Roughly **2,300 lines port untouched** (writer, fonts, images, text renderer). About **450 lines are
domain** — the two vocabularies. The rest is validation and UI that follows your stack.

### Order of work

1. **Drop in the primitives** — `pdf.ts`, `pdfFonts.ts`, `image.ts`, a money formatter. Run their
   tests; they need no domain at all.
2. **Drop in `document.ts`** and define your `Format` and `Address` types.
3. **Write one vocabulary** for your primary record: token list, `resolve()`, `resolveLine()`,
   `DocumentSource`. You now have HTML, Markdown and text end to end.
4. **Add the PDF layer** — copy `pdfTemplate.ts`, then replace the field unions, the default columns
   and totals rows, the starter templates and the two `PdfSource` builders. The renderer and
   `blankBlock` come across unchanged.
5. **Port the validator** before exposing any API — it is the only thing standing between a
   hand-written body and the renderer.
6. **Add storage**: one table with `kind` and `format` columns from day one, even with a single kind.
   Retrofitting `kind` costs a migration and a backfill.
7. **Add the two routes** (CRUD, and render-with-`?inline`).
8. **Build the editor last**, against the finished pure core.

### Swap points

- **Storage** — nothing in the core knows about PocketBase. Any store with a text column ≥ 3 MB
  works; the collection rules are the only place ownership and sharing live.
- **Server runtime** — the routes use Bun's `serve()` route table and `Response`. Both are standard
  Web APIs; the only PDF-specific helper is `pdfResponse()`.
- **Money and dates** — `formatMoney` / `formatPercent` take a locale and round to the currency's
  precision. Substitute your own; the renderer only ever sees strings.
- **UI kit** — the editors use a sheet/panel/combobox set. The contract is only §10's seven rules.

### Test surface to port with it

About 2,000 lines of tests, none of which need a database: `pdfTemplate.test.ts` (931 — starter,
blocks, what a template may *not* do, validation, robustness, images and letterhead, invoice
templates, styling, table style, watermark, samples), `pdf.test.ts` (381), `image.test.ts` (269),
`invoiceDocument.test.ts` (240), `proposal.test.ts` (219), plus a component test asserting the editor
contract. The suites worth copying first are "what a template may not do" (no cost, no margin, no
cross-kind fields) and "robustness" (garbage bodies still produce a document).

---

## 12. Invariants

Break any of these and the subsystem stops being the thing this spec describes.

1. **The renderer is pure.** No I/O, no clock beyond an injected `asOf`, no randomness. The browser
   preview and the server's file must be byte-comparable.
2. **A template is a document, never a program.** Substitution only — no expression evaluation, no
   `eval`, no template language to escape out of. Nothing in a template can reach the record beyond
   the tokens its vocabulary lists.
3. **Escape per format, at substitution time.** `RAW_TOKENS` stays a closed set of app-produced
   values.
4. **Field lists stay closed and customer-facing.** No cost, no margin, no cross-kind fields —
   enforced by the validator dropping them, not by the UI hiding them.
5. **One renderer per output family, N vocabularies.** A new record kind never forks `document.ts` or
   `renderPdfDocument()`.
6. **A kind mismatch is refused, not rendered.** A document full of blanks is worse than an error.
7. **Every new style default reproduces the constant it replaced**, and the stored body carries its
   whole style, so an existing template's appearance never shifts under it.
8. **Validation drops what it cannot use and refuses only the unusable.** Unknown block, unknown
   field, broken image → dropped. Invalid JSON, no blocks → refused.
9. **Branding travels inside the template** as a data URL, so export, share and import keep the logo.
10. **Derived values are derived at render time** — status, ageing, balance. A stored "overdue" is
    wrong the morning after it is written.
