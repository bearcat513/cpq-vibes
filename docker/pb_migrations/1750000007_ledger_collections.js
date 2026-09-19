/// <reference path="../pb_data/types.d.ts" />

/**
 * Payments and credits become records of their own.
 *
 * They were arrays inside `invoices.ledger`. Three things were wrong with
 * that, and all three are why they are now two collections:
 *
 * **Recording a payment was a read-modify-write of the whole invoice.** Two
 * people banking cheques in the same second could lose one of them — the
 * second save wrote back the ledger the first had read. An insert cannot do
 * that.
 *
 * **Cash was unanswerable on its own.** "What came in last month" is a
 * question about payments, and asking it meant opening every invoice in the
 * workspace and unpacking its JSON.
 *
 * **Neither had an identity.** No owner, no created date, no durable id that
 * anything could reference — just an object inside another record's field.
 *
 * ## What goes, and what does not
 *
 * `invoices.ledger` is dropped once its contents have been fanned out into
 * rows. So is `invoices.balance`: it was a cached number, and now that the
 * payments behind it live elsewhere it is a cached number that can disagree
 * with them. Nothing queried on it — the aging report reads the whole book
 * and adds it up in `src/lib/receivable.ts` — so it bought nothing and risked
 * the one kind of wrongness a finance system cannot have.
 *
 * `invoices.total` stays. It is a pure function of the invoice's own lines,
 * which are still on the invoice, so it cannot drift.
 *
 * ## Access
 *
 * The ledger follows its invoice rather than carrying its own copy of the
 * sharing rules: you can read the payments of an invoice you can read, and
 * only the invoice's owner can add to or remove from its ledger. That last
 * clause is doing real work — without it, anyone signed in could file a
 * payment against somebody else's invoice.
 */

/**
 * Fans the embedded payments out into rows.
 *
 * SQL rather than a loop over records, for the reason spelled out in
 * 1750000004: a JSON field reaches the JSVM as a *byte array*, so the obvious
 * JavaScript version reads nothing and writes nothing while appearing to
 * work. SQLite's own JSON functions operate on the stored text.
 *
 * `recordedAt` was an ISO timestamp on the embedded object; it becomes the
 * row's `created`, which is what it always meant. The `T` has to go because
 * PocketBase stores datetimes with a space.
 *
 * Exported as a constant because src/server/migration.test.ts runs this exact
 * statement against a throwaway database.
 */
const FANOUT_PAYMENTS = "INSERT INTO payments (id, invoice, receivedOn, amount, method, reference, note, owner, created, updated) SELECT json_extract(entry.value, '$.id'), i.id, coalesce(json_extract(entry.value, '$.receivedOn'), ''), coalesce(json_extract(entry.value, '$.amount'), 0), coalesce(json_extract(entry.value, '$.method'), 'bank_transfer'), coalesce(json_extract(entry.value, '$.reference'), ''), coalesce(json_extract(entry.value, '$.note'), ''), coalesce(i.owner, ''), coalesce(nullif(replace(coalesce(json_extract(entry.value, '$.recordedAt'), ''), 'T', ' '), ''), i.created), coalesce(nullif(replace(coalesce(json_extract(entry.value, '$.recordedAt'), ''), 'T', ' '), ''), i.created) FROM invoices i, json_each(CASE WHEN json_valid(i.ledger) AND json_type(i.ledger, '$.payments') = 'array' THEN json_extract(i.ledger, '$.payments') ELSE '[]' END) entry WHERE json_extract(entry.value, '$.id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments existing WHERE existing.id = json_extract(entry.value, '$.id'))";

/** The same, for credits. */
const FANOUT_CREDITS = "INSERT INTO credits (id, invoice, issuedOn, amount, reason, note, owner, created, updated) SELECT json_extract(entry.value, '$.id'), i.id, coalesce(json_extract(entry.value, '$.issuedOn'), ''), coalesce(json_extract(entry.value, '$.amount'), 0), coalesce(json_extract(entry.value, '$.reason'), 'adjustment'), coalesce(json_extract(entry.value, '$.note'), ''), coalesce(i.owner, ''), coalesce(nullif(replace(coalesce(json_extract(entry.value, '$.recordedAt'), ''), 'T', ' '), ''), i.created), coalesce(nullif(replace(coalesce(json_extract(entry.value, '$.recordedAt'), ''), 'T', ' '), ''), i.created) FROM invoices i, json_each(CASE WHEN json_valid(i.ledger) AND json_type(i.ledger, '$.credits') = 'array' THEN json_extract(i.ledger, '$.credits') ELSE '[]' END) entry WHERE json_extract(entry.value, '$.id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM credits existing WHERE existing.id = json_extract(entry.value, '$.id'))";

/** Down: gathers the rows back into the JSON field they came out of. */
const REBUILD_LEDGER = "UPDATE invoices SET ledger = json_object('payments', coalesce((SELECT json_group_array(json_object('id', p.id, 'receivedOn', p.receivedOn, 'amount', p.amount, 'method', p.method, 'reference', p.reference, 'note', p.note, 'recordedAt', p.created)) FROM payments p WHERE p.invoice = invoices.id), json('[]')), 'credits', coalesce((SELECT json_group_array(json_object('id', c.id, 'issuedOn', c.issuedOn, 'amount', c.amount, 'reason', c.reason, 'note', c.note, 'recordedAt', c.created)) FROM credits c WHERE c.invoice = invoices.id), json('[]')))";

migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");
    const invoices = app.findCollectionByNameOrId("invoices");

    /** App-supplied id: `pmt_…`, `crd_…`, matching every other collection. */
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

    const invoiceField = () => ({
      type: "relation",
      name: "invoice",
      required: true,
      maxSelect: 1,
      collectionId: invoices.id,
      // Safe because of an invariant the server holds: only a *draft* invoice
      // can be deleted, and a draft has no ledger. Nothing that was ever
      // issued is deletable, so this can never take a real payment with it —
      // it only stops orphans.
      cascadeDelete: true,
    });

    const ownerField = () => ({
      type: "relation",
      name: "owner",
      required: false,
      maxSelect: 1,
      collectionId: users.id,
      cascadeDelete: true,
    });

    const created = { type: "autodate", name: "created", onCreate: true, onUpdate: false };
    const updated = { type: "autodate", name: "updated", onCreate: true, onUpdate: true };

    /*
     * The ledger inherits its invoice's audience: readable by whoever can
     * read the invoice, writable only by whoever owns it. Keying the write
     * rules off `invoice.owner` rather than off the row's own `owner` is what
     * stops a signed-in stranger filing a payment against your invoice —
     * their row would be owned by them, but it would be attached to you.
     */
    const READ = "invoice.owner = @request.auth.id || invoice.sharedWith.id ?= @request.auth.id";
    const WRITE = "invoice.owner = @request.auth.id";

    const payments = new Collection({
      name: "payments",
      type: "base",
      listRule: READ,
      viewRule: READ,
      createRule: WRITE,
      updateRule: WRITE,
      deleteRule: WRITE,
      fields: [
        idField,
        invoiceField(),
        // A calendar day, not a timestamp: the day the money arrived, which
        // is what aging is measured against. `created` is when it was keyed in.
        { type: "text", name: "receivedOn", required: false, max: 10 },
        { type: "number", name: "amount", required: true },
        { type: "text", name: "method", required: false, max: 20 },
        { type: "text", name: "reference", required: false, max: 120 },
        { type: "text", name: "note", required: false, max: 1000 },
        ownerField(),
        created,
        updated,
      ],
      indexes: [
        "CREATE INDEX `idx_payments_invoice` ON `payments` (`invoice`)",
        // The cash receipts question: what came in, and when.
        "CREATE INDEX `idx_payments_owner_received` ON `payments` (`owner`, `receivedOn`)",
      ],
    });
    app.save(payments);

    const credits = new Collection({
      name: "credits",
      type: "base",
      listRule: READ,
      viewRule: READ,
      createRule: WRITE,
      updateRule: WRITE,
      deleteRule: WRITE,
      fields: [
        idField,
        invoiceField(),
        { type: "text", name: "issuedOn", required: false, max: 10 },
        { type: "number", name: "amount", required: true },
        { type: "text", name: "reason", required: false, max: 20 },
        { type: "text", name: "note", required: false, max: 1000 },
        ownerField(),
        created,
        updated,
      ],
      indexes: [
        "CREATE INDEX `idx_credits_invoice` ON `credits` (`invoice`)",
        "CREATE INDEX `idx_credits_owner_issued` ON `credits` (`owner`, `issuedOn`)",
      ],
    });
    app.save(credits);

    /* --------------------- carry the embedded ledgers over ------------------ */

    app.db().newQuery(FANOUT_PAYMENTS).execute();
    app.db().newQuery(FANOUT_CREDITS).execute();

    /* ------------------------- drop what they replaced ---------------------- */

    if (invoices.fields.getByName("ledger")) invoices.fields.removeByName("ledger");
    // A cached balance cannot be kept honest now that its inputs live
    // elsewhere, and nothing ever queried on it.
    if (invoices.fields.getByName("balance")) invoices.fields.removeByName("balance");
    app.save(invoices);
  },
  app => {
    const invoices = app.findCollectionByNameOrId("invoices");

    if (!invoices.fields.getByName("ledger")) {
      invoices.fields.add(new Field({ type: "json", name: "ledger", required: false, maxSize: 262144 }));
    }
    if (!invoices.fields.getByName("balance")) {
      invoices.fields.add(new Field({ type: "number", name: "balance", required: false }));
    }
    app.save(invoices);

    // Gather the rows back into the field, then recompute the cached balance
    // from what was gathered.
    app.db().newQuery(REBUILD_LEDGER).execute();
    app
      .db()
      .newQuery(
        "UPDATE invoices SET balance = coalesce(total, 0) - coalesce((SELECT sum(p.amount) FROM payments p WHERE p.invoice = invoices.id), 0) - coalesce((SELECT sum(c.amount) FROM credits c WHERE c.invoice = invoices.id), 0)",
      )
      .execute();

    for (const name of ["payments", "credits"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (err) {
        // Never created, or already dropped.
      }
    }
  },
);
