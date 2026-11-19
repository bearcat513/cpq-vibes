/// <reference path="../pb_data/types.d.ts" />

/**
 * Line items become records: `quote_lines` and `invoice_lines`.
 *
 * Both used to be one JSON array on their parent — `quotes.lines`,
 * `invoices.lines`. That array goes, for the reasons `payments` and
 * `credits` came out of the invoice before it:
 *
 * - **A line is something people ask questions about.** "Every quote with
 *   SKU X on it", "what did we sell of family Y last quarter", "lines priced
 *   under list" — each meant opening every quote and unpacking its JSON. Now
 *   they are filters on a collection, and the record browser and the
 *   workspace's related lists can show them.
 * - **A line gets an identity.** A record id, an owner, a created date.
 *
 * ## Shape
 *
 * Real columns for every scalar on a line, and one `detail` JSON field for
 * what is nested — on a quote line the selected options, their names, the
 * volume tier, the rules that moved the price and its issues and warnings,
 * and `unitPriceOverride`, which is a column-shaped number that may be
 * `null` (a negotiated price of 0 is not the same as none). An invoice line is
 * flat, so it has no `detail` at all.
 *
 * The line's own id — what `parentId` (a bundle component's parent) and an
 * invoice line's `sourceLineId` name — is kept as `lineId`. It is unique only
 * within its parent: a revision copies its quote's lines and keeps their ids,
 * which is what lets it say what changed. The *record* id is minted, so two
 * revisions never collide (`qln_<quote id>_<position>` here, `qln_…` from the
 * server afterwards). `position` is the order the lines are in.
 *
 * `lineCount` stays on the parent: the list endpoints read it without
 * touching a line.
 *
 * ## Access
 *
 * A line has its parent's audience, joined through the relation the way the
 * ledger joins through `invoice`:
 *
 * - a quote line is read by whoever can read the quote — the organization,
 *   anyone it is shared with, anyone it is waiting on — and written by
 *   whoever may edit it: an admin, or the sales member who owns it. Not an
 *   approver: deciding never changes a line.
 * - an invoice line is read like a payment, and written by admin or finance
 *   **only while the invoice is a draft**. That rule used to live only in
 *   src/server/invoices.ts; with the lines a collection of their own, the
 *   collection says it too.
 *
 * Neither may be moved to another parent by an update.
 *
 * ## Data
 *
 * In SQL, for the reason in 1750000004 — a JSON field reaches the JSVM as a
 * byte array. Each statement is exported as a constant, run against a
 * throwaway database by src/server/migration.test.ts, and idempotent.
 */

/**
 * Every embedded quote line as a row. `detail` is the line with every column
 * removed, so anything a future line carries that is not a column survives.
 */
const FANOUT_QUOTE_LINES = "INSERT INTO quote_lines (id, quote, owner, org, lineId, position, productId, parentLineId, sortOrder, quantity, discountPercent, termMonths, description, sku, name, family, chargeType, billingPeriod, unitOfMeasure, listUnitPrice, optionsUnitDelta, baseUnitPrice, unitPrice, listTotal, discountAmount, netTotal, effectiveDiscountPercent, periods, unitCost, costTotal, margin, marginPercent, oneTime, monthlyRecurring, annualRecurring, detail, created, updated) SELECT 'qln_' || q.id || '_' || entry.key, q.id, coalesce(q.owner, ''), coalesce(q.org, ''), coalesce(json_extract(entry.value, '$.id'), 'ln_' || entry.key), entry.key, coalesce(json_extract(entry.value, '$.productId'), ''), coalesce(json_extract(entry.value, '$.parentId'), ''), coalesce(json_extract(entry.value, '$.sortOrder'), entry.key), coalesce(json_extract(entry.value, '$.quantity'), 0), coalesce(json_extract(entry.value, '$.discountPercent'), 0), coalesce(json_extract(entry.value, '$.termMonths'), 0), coalesce(json_extract(entry.value, '$.description'), ''), coalesce(json_extract(entry.value, '$.sku'), ''), coalesce(json_extract(entry.value, '$.name'), ''), coalesce(json_extract(entry.value, '$.family'), ''), coalesce(json_extract(entry.value, '$.chargeType'), ''), coalesce(json_extract(entry.value, '$.billingPeriod'), ''), coalesce(json_extract(entry.value, '$.unitOfMeasure'), ''), coalesce(json_extract(entry.value, '$.listUnitPrice'), 0), coalesce(json_extract(entry.value, '$.optionsUnitDelta'), 0), coalesce(json_extract(entry.value, '$.baseUnitPrice'), 0), coalesce(json_extract(entry.value, '$.unitPrice'), 0), coalesce(json_extract(entry.value, '$.listTotal'), 0), coalesce(json_extract(entry.value, '$.discountAmount'), 0), coalesce(json_extract(entry.value, '$.netTotal'), 0), coalesce(json_extract(entry.value, '$.effectiveDiscountPercent'), 0), coalesce(json_extract(entry.value, '$.periods'), 0), coalesce(json_extract(entry.value, '$.unitCost'), 0), coalesce(json_extract(entry.value, '$.costTotal'), 0), coalesce(json_extract(entry.value, '$.margin'), 0), coalesce(json_extract(entry.value, '$.marginPercent'), 0), coalesce(json_extract(entry.value, '$.oneTime'), 0), coalesce(json_extract(entry.value, '$.monthlyRecurring'), 0), coalesce(json_extract(entry.value, '$.annualRecurring'), 0), json_remove(entry.value, '$.id', '$.productId', '$.parentId', '$.sortOrder', '$.quantity', '$.discountPercent', '$.termMonths', '$.description', '$.sku', '$.name', '$.family', '$.chargeType', '$.billingPeriod', '$.unitOfMeasure', '$.listUnitPrice', '$.optionsUnitDelta', '$.baseUnitPrice', '$.unitPrice', '$.listTotal', '$.discountAmount', '$.netTotal', '$.effectiveDiscountPercent', '$.periods', '$.unitCost', '$.costTotal', '$.margin', '$.marginPercent', '$.oneTime', '$.monthlyRecurring', '$.annualRecurring'), q.created, q.updated FROM quotes q, json_each(CASE WHEN json_valid(q.lines) AND json_type(q.lines) = 'array' THEN q.lines ELSE '[]' END) entry WHERE entry.type = 'object' AND NOT EXISTS (SELECT 1 FROM quote_lines l WHERE l.id = 'qln_' || q.id || '_' || entry.key)";

/** The same for invoices. Every field of an invoice line is a column. */
const FANOUT_INVOICE_LINES = "INSERT INTO invoice_lines (id, invoice, owner, org, lineId, position, sourceLineId, sku, description, quantity, unitPrice, amount, taxPercent, taxAmount, created, updated) SELECT 'iln_' || i.id || '_' || entry.key, i.id, coalesce(i.owner, ''), coalesce(i.org, ''), coalesce(json_extract(entry.value, '$.id'), 'il_' || entry.key), entry.key, coalesce(json_extract(entry.value, '$.sourceLineId'), ''), coalesce(json_extract(entry.value, '$.sku'), ''), coalesce(json_extract(entry.value, '$.description'), ''), coalesce(json_extract(entry.value, '$.quantity'), 0), coalesce(json_extract(entry.value, '$.unitPrice'), 0), coalesce(json_extract(entry.value, '$.amount'), 0), coalesce(json_extract(entry.value, '$.taxPercent'), 0), coalesce(json_extract(entry.value, '$.taxAmount'), 0), i.created, i.updated FROM invoices i, json_each(CASE WHEN json_valid(i.lines) AND json_type(i.lines) = 'array' THEN i.lines ELSE '[]' END) entry WHERE entry.type = 'object' AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.id = 'iln_' || i.id || '_' || entry.key)";

/**
 * Down: the array, rebuilt in `position` order. `parentId` is set after the
 * merge rather than inside it, because a JSON merge patch *removes* a key
 * whose value is null — and a top-level line's parent is null, not missing.
 */
const REBUILD_QUOTE_LINES = "UPDATE quotes SET lines = coalesce((SELECT json_group_array(json(json_set(json_patch(CASE WHEN json_valid(l.detail) AND json_type(l.detail) = 'object' THEN l.detail ELSE '{}' END, json_object('id', l.lineId, 'productId', l.productId, 'sortOrder', l.sortOrder, 'quantity', l.quantity, 'discountPercent', l.discountPercent, 'termMonths', l.termMonths, 'description', l.description, 'sku', l.sku, 'name', l.name, 'family', l.family, 'chargeType', l.chargeType, 'billingPeriod', l.billingPeriod, 'unitOfMeasure', l.unitOfMeasure, 'listUnitPrice', l.listUnitPrice, 'optionsUnitDelta', l.optionsUnitDelta, 'baseUnitPrice', l.baseUnitPrice, 'unitPrice', l.unitPrice, 'listTotal', l.listTotal, 'discountAmount', l.discountAmount, 'netTotal', l.netTotal, 'effectiveDiscountPercent', l.effectiveDiscountPercent, 'periods', l.periods, 'unitCost', l.unitCost, 'costTotal', l.costTotal, 'margin', l.margin, 'marginPercent', l.marginPercent, 'oneTime', l.oneTime, 'monthlyRecurring', l.monthlyRecurring, 'annualRecurring', l.annualRecurring)), '$.parentId', CASE WHEN coalesce(l.parentLineId, '') = '' THEN NULL ELSE l.parentLineId END))) FROM (SELECT * FROM quote_lines WHERE quote = quotes.id ORDER BY position, id) l), '[]')";

const REBUILD_INVOICE_LINES = "UPDATE invoices SET lines = coalesce((SELECT json_group_array(json_object('id', l.lineId, 'sourceLineId', CASE WHEN coalesce(l.sourceLineId, '') = '' THEN NULL ELSE l.sourceLineId END, 'sku', l.sku, 'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unitPrice, 'amount', l.amount, 'taxPercent', l.taxPercent, 'taxAmount', l.taxAmount)) FROM (SELECT * FROM invoice_lines WHERE invoice = invoices.id ORDER BY position, id) l), '[]')";

migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");
    const organizations = app.findCollectionByNameOrId("organizations");
    const quotes = app.findCollectionByNameOrId("quotes");
    const invoices = app.findCollectionByNameOrId("invoices");

    const MEMBER = '@request.auth.org != ""';
    const role = (...roles) => "(" + roles.map(name => `@request.auth.role = "${name}"`).join(" || ") + ")";

    // A quote line: the quote's audience (1750000010), joined through `quote`.
    const QUOTE_READ = `(${MEMBER} && quote.org = @request.auth.org) || quote.sharedWith.id ?= @request.auth.id || quote.approvers.id ?= @request.auth.id`;
    const QUOTE_EDITOR = `${MEMBER} && quote.org = @request.auth.org && (${role("admin")} || (${role("sales")} && quote.owner = @request.auth.id))`;
    // An invoice line: the ledger's audience, and only while the invoice is a draft.
    const INVOICE_READ = `(${MEMBER} && invoice.org = @request.auth.org) || invoice.sharedWith.id ?= @request.auth.id`;
    const INVOICE_EDITOR = `${MEMBER} && invoice.org = @request.auth.org && ${role("admin", "finance")} && invoice.state = "draft"`;
    // A line stays on the parent it was written to.
    const STAYS = parent => `(@request.body.${parent}:isset = false || @request.body.${parent} = ${parent})`;

    const idField = {
      type: "text",
      name: "id",
      system: true,
      primaryKey: true,
      required: true,
      min: 3,
      max: 80,
      pattern: "^[a-z0-9_]+$",
      autogeneratePattern: "[a-z0-9]{15}",
    };
    const owner = () => ({ type: "relation", name: "owner", required: false, maxSelect: 1, collectionId: users.id, cascadeDelete: false });
    const org = () => ({ type: "relation", name: "org", required: false, maxSelect: 1, collectionId: organizations.id, cascadeDelete: true });
    const created = { type: "autodate", name: "created", onCreate: true, onUpdate: false };
    const updated = { type: "autodate", name: "updated", onCreate: true, onUpdate: true };
    const text = (name, max) => ({ type: "text", name, required: false, max });
    const number = name => ({ type: "number", name, required: false });

    /* -------------------------------- quote_lines ------------------------------ */

    const quoteLines = new Collection({
      name: "quote_lines",
      type: "base",
      listRule: QUOTE_READ,
      viewRule: QUOTE_READ,
      createRule: QUOTE_EDITOR,
      updateRule: `${QUOTE_EDITOR} && ${STAYS("quote")}`,
      deleteRule: QUOTE_EDITOR,
      fields: [
        idField,
        // Cascade: a line is part of its quote, and goes with it.
        { type: "relation", name: "quote", required: true, maxSelect: 1, collectionId: quotes.id, cascadeDelete: true },
        owner(),
        org(),
        // The line's own id, unique within its quote — what `parentLineId` names.
        { type: "text", name: "lineId", required: true, min: 1, max: 80 },
        { type: "number", name: "position", required: false, min: 0, onlyInt: true },
        // Text, not a relation: deleting a product must not blank it out of a quote already written.
        text("productId", 80),
        // A bundle component's parent line (its `lineId`); "" for a top-level line.
        text("parentLineId", 80),
        number("sortOrder"),
        number("quantity"),
        number("discountPercent"),
        number("termMonths"),
        text("description", 2000),
        // The catalogue, as it was when the line was priced.
        text("sku", 200),
        text("name", 500),
        text("family", 200),
        text("chargeType", 20),
        text("billingPeriod", 20),
        text("unitOfMeasure", 60),
        // The price, step by step — see `PricedLine` in src/lib/types.ts.
        number("listUnitPrice"),
        number("optionsUnitDelta"),
        number("baseUnitPrice"),
        number("unitPrice"),
        number("listTotal"),
        number("discountAmount"),
        number("netTotal"),
        number("effectiveDiscountPercent"),
        number("periods"),
        number("unitCost"),
        number("costTotal"),
        number("margin"),
        number("marginPercent"),
        number("oneTime"),
        number("monthlyRecurring"),
        number("annualRecurring"),
        // Options, tier, applied rules, issues, warnings, unitPriceOverride.
        { type: "json", name: "detail", required: false, maxSize: 262144 },
        created,
        updated,
      ],
      indexes: [
        "CREATE INDEX `idx_quote_lines_quote` ON `quote_lines` (`quote`, `position`)",
        "CREATE INDEX `idx_quote_lines_org_sku` ON `quote_lines` (`org`, `sku`)",
        "CREATE INDEX `idx_quote_lines_org_product` ON `quote_lines` (`org`, `productId`)",
      ],
    });
    app.save(quoteLines);

    /* ------------------------------- invoice_lines ----------------------------- */

    const invoiceLines = new Collection({
      name: "invoice_lines",
      type: "base",
      listRule: INVOICE_READ,
      viewRule: INVOICE_READ,
      createRule: INVOICE_EDITOR,
      updateRule: `${INVOICE_EDITOR} && ${STAYS("invoice")}`,
      deleteRule: INVOICE_EDITOR,
      fields: [
        idField,
        // Cascade is safe for the reason the ledger's is: only a draft can be deleted.
        { type: "relation", name: "invoice", required: true, maxSelect: 1, collectionId: invoices.id, cascadeDelete: true },
        owner(),
        org(),
        { type: "text", name: "lineId", required: true, min: 1, max: 80 },
        { type: "number", name: "position", required: false, min: 0, onlyInt: true },
        // The quote line it was raised from (that line's `lineId`); "" for none.
        text("sourceLineId", 80),
        text("sku", 200),
        text("description", 2000),
        number("quantity"),
        number("unitPrice"),
        number("amount"),
        number("taxPercent"),
        number("taxAmount"),
        created,
        updated,
      ],
      indexes: [
        "CREATE INDEX `idx_invoice_lines_invoice` ON `invoice_lines` (`invoice`, `position`)",
        "CREATE INDEX `idx_invoice_lines_org_sku` ON `invoice_lines` (`org`, `sku`)",
      ],
    });
    app.save(invoiceLines);

    /* ------------------------------ move the data ------------------------------ */

    app.db().newQuery(FANOUT_QUOTE_LINES).execute();
    app.db().newQuery(FANOUT_INVOICE_LINES).execute();

    const quotesAfter = app.findCollectionByNameOrId("quotes");
    if (quotesAfter.fields.getByName("lines")) quotesAfter.fields.removeByName("lines");
    app.save(quotesAfter);

    const invoicesAfter = app.findCollectionByNameOrId("invoices");
    if (invoicesAfter.fields.getByName("lines")) invoicesAfter.fields.removeByName("lines");
    app.save(invoicesAfter);

    // A quote and its lines are saved in one batch: one request per line
    // changed, created or removed, plus the quote. See MAX_QUOTE_LINES.
    const settings = app.settings();
    settings.batch.enabled = true;
    settings.batch.maxRequests = Math.max(settings.batch.maxRequests || 0, 2100);
    settings.batch.timeout = Math.max(settings.batch.timeout || 0, 60);
    app.save(settings);
  },
  app => {
    const quotes = app.findCollectionByNameOrId("quotes");
    if (!quotes.fields.getByName("lines")) quotes.fields.add(new JSONField({ name: "lines", maxSize: 4194304 }));
    app.save(quotes);
    const invoices = app.findCollectionByNameOrId("invoices");
    if (!invoices.fields.getByName("lines")) invoices.fields.add(new JSONField({ name: "lines", maxSize: 1048576 }));
    app.save(invoices);

    app.db().newQuery(REBUILD_QUOTE_LINES).execute();
    app.db().newQuery(REBUILD_INVOICE_LINES).execute();

    app.delete(app.findCollectionByNameOrId("quote_lines"));
    app.delete(app.findCollectionByNameOrId("invoice_lines"));
  },
);
