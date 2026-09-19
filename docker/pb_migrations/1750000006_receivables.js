/// <reference path="../pb_data/types.d.ts" />

/**
 * Invoices: the receivables ledger.
 *
 * A quote is an offer and an invoice is a demand, so this is a collection of
 * its own rather than more fields on `quotes`. A quote gets revised,
 * superseded and re-priced; an invoice is a number that has gone to an
 * accounts payable department, and the only honest way to change one is to
 * credit it. Two records, two lifecycles.
 *
 * ## Shape
 *
 * The same split as everywhere else here: real columns for what the database
 * has to do something with, and JSON for the nested objects the app reads
 * whole.
 *
 * The columns worth explaining are `state`, `dueDate` and `balance`. Those
 * three are what an aging query filters and sorts on — "everything issued,
 * past due, still owing, oldest first" — and they are the reason this is not
 * one big JSON blob. Note what is *not* a column: `status`. Open, part paid,
 * paid and overdue are derived from the balance and the date by
 * `invoiceStatus` in src/lib/receivable.ts, because a stored "overdue" is
 * wrong the morning after it is written and a stored "paid" that disagrees
 * with the arithmetic is unforgivable in a finance system. `state` records
 * only the part a person actually sets.
 *
 * `balance` is denormalised out of `totals` for the same reason, and it is
 * written by the server on every save from the same pure function the browser
 * uses — never by a client, and never by hand.
 *
 * ## Access
 *
 * Owner, or someone it was shared with, read-only — the `sharedRules` pattern
 * that products and price books already use. An invoice is not an approval
 * workflow: nobody else needs to write one, so there is no approver clause
 * and no hook holding anyone to a subset of fields.
 *
 * Accounts gained `paymentTermDays` and `creditLimit` at the same time as
 * this, and they need no migration: both live in the existing `details` JSON,
 * and `toAccount` seeds the day count out of the "Net 30" text for rows
 * written before receivables existed.
 */
migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");
    const quotes = app.findCollectionByNameOrId("quotes");

    /** App-supplied id: `inv_<hex>`, matching every other collection here. */
    const idField = {
      type: "text",
      name: "id",
      system: true,
      primaryKey: true,
      required: true,
      min: 3,
      max: 40,
      pattern: "^[a-z0-9_]+$",
      autogeneratePattern: "[a-z0-9]{15}",
    };

    const MINE = "owner = @request.auth.id";
    const MINE_OR_SHARED = `${MINE} || sharedWith.id ?= @request.auth.id`;
    const SIGNED_IN = '@request.auth.id != ""';

    const invoices = new Collection({
      name: "invoices",
      type: "base",
      listRule: MINE_OR_SHARED,
      viewRule: MINE_OR_SHARED,
      createRule: SIGNED_IN,
      updateRule: MINE,
      deleteRule: MINE,
      fields: [
        idField,
        { type: "text", name: "number", required: true, min: 1, max: 40 },
        // draft | issued | void. The rest of what a person reads is derived.
        { type: "text", name: "state", required: true, max: 20 },
        { type: "text", name: "currency", required: true, min: 3, max: 3 },
        // Plain text dates, not `date`: these are calendar days, and a
        // timestamp would drag a timezone into a due date that has none.
        { type: "text", name: "issueDate", required: false, max: 10 },
        { type: "text", name: "dueDate", required: false, max: 10 },
        // Denormalised from `totals` so aging can be a query rather than a
        // full read. Written by the server from src/lib/receivable.ts.
        { type: "number", name: "total", required: false },
        { type: "number", name: "balance", required: false },
        { type: "number", name: "lineCount", required: false, min: 0 },
        {
          type: "relation",
          name: "quote",
          required: false,
          maxSelect: 1,
          collectionId: quotes.id,
          // Deleting a quote must not delete the invoice raised from it: the
          // money is owed whatever happened to the offer behind it. The
          // invoice keeps the quote's *number* in its header for that case.
          cascadeDelete: false,
        },
        // Customer snapshot, payment terms, PO reference, notes.
        { type: "json", name: "header", required: false, maxSize: 65536 },
        { type: "json", name: "lines", required: false, maxSize: 1048576 },
        // { payments: [], credits: [] } — the subledger, read and written whole.
        { type: "json", name: "ledger", required: false, maxSize: 262144 },
        { type: "json", name: "totals", required: false, maxSize: 65536 },
        {
          type: "relation",
          name: "owner",
          required: false,
          maxSelect: 1,
          collectionId: users.id,
          cascadeDelete: true,
        },
        {
          type: "relation",
          name: "sharedWith",
          required: false,
          maxSelect: 50,
          collectionId: users.id,
          cascadeDelete: false,
        },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_invoices_owner_number` ON `invoices` (`owner`, `number`)",
        "CREATE INDEX `idx_invoices_owner_state` ON `invoices` (`owner`, `state`)",
        // The aging query: issued, unpaid, oldest due date first.
        "CREATE INDEX `idx_invoices_owner_due` ON `invoices` (`owner`, `dueDate`)",
      ],
    });

    app.save(invoices);
  },
  app => {
    try {
      app.delete(app.findCollectionByNameOrId("invoices"));
    } catch (err) {
      // Never created, or already dropped.
    }
  },
);
