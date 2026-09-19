/**
 * The approver backfill, run against a real database.
 *
 * A migration touches real data exactly once and cannot be re-run, so the one
 * in `docker/pb_migrations/1750000004_multi_approver.js` is worth testing
 * rather than reading. It is also the one that has already been wrong once: a
 * JSON field reaches PocketBase's JSVM as a *byte array*, so the obvious
 * version — read `definition`, set `.approvers`, save — ran without error and
 * copied nothing.
 *
 * The SQL is lifted out of the migration file itself rather than repeated
 * here, so the statement under test is the statement that will run.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const MIGRATION = "docker/pb_migrations/1750000004_multi_approver.js";

/** The backfill statement, taken from the migration. */
async function backfillSql(): Promise<string> {
  const source = await Bun.file(MIGRATION).text();
  const match = /const BACKFILL_APPROVERS = "((?:[^"\\]|\\.)*)"/.exec(source);
  if (!match) throw new Error(`No BACKFILL_APPROVERS statement found in ${MIGRATION}`);
  return match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** A stand-in for the collection as it was before this migration. */
function legacyTable(rows: { id: string; approverEmail: string; definition: string | null }[]): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE approval_rules (id TEXT PRIMARY KEY, approverEmail TEXT, definition TEXT)");
  for (const row of rows) {
    db.run("INSERT INTO approval_rules (id, approverEmail, definition) VALUES (?, ?, ?)", [
      row.id,
      row.approverEmail,
      row.definition,
    ]);
  }
  return db;
}

const read = (db: Database, id: string) =>
  JSON.parse((db.query("SELECT definition FROM approval_rules WHERE id = ?").get(id) as { definition: string }).definition);

describe("backfilling the approver list", () => {
  test("a single approver becomes a one-person list with a quorum of one", async () => {
    // Which is exactly what the rule meant before it could name several people.
    const db = legacyTable([
      { id: "a", approverEmail: "manager@example.com", definition: '{"scope":"quote","metric":"discountPercent"}' },
    ]);

    db.run(await backfillSql());

    const definition = read(db, "a");
    expect(definition.approvers).toEqual(["manager@example.com"]);
    expect(definition.approvalsRequired).toBe(1);
    expect(definition.rejectionsRequired).toBe(1);
    // The rest of the rule is untouched.
    expect(definition.scope).toBe("quote");
    expect(definition.metric).toBe("discountPercent");
  });

  test("the address is normalised the way the app stores it", async () => {
    const db = legacyTable([{ id: "a", approverEmail: "  Manager@Example.COM  ", definition: "{}" }]);
    db.run(await backfillSql());
    expect(read(db, "a").approvers).toEqual(["manager@example.com"]);
  });

  test("a rule already written the new way is left exactly as it is", async () => {
    // Re-running a migration must not overwrite a quorum somebody has since set.
    const db = legacyTable([
      {
        id: "a",
        approverEmail: "old@example.com",
        definition: '{"approvers":["a@example.com","b@example.com"],"approvalsRequired":2,"rejectionsRequired":1}',
      },
    ]);

    db.run(await backfillSql());

    const definition = read(db, "a");
    expect(definition.approvers).toEqual(["a@example.com", "b@example.com"]);
    expect(definition.approvalsRequired).toBe(2);
  });

  test("a rule with no approver is left alone rather than given an empty list", async () => {
    const db = legacyTable([
      { id: "a", approverEmail: "", definition: '{"scope":"quote"}' },
      { id: "b", approverEmail: "   ", definition: '{"scope":"quote"}' },
    ]);

    db.run(await backfillSql());

    expect(read(db, "a").approvers).toBeUndefined();
    expect(read(db, "b").approvers).toBeUndefined();
  });

  test("a null or unparseable definition does not lose the approver", async () => {
    const db = legacyTable([
      { id: "a", approverEmail: "who@example.com", definition: null },
      { id: "b", approverEmail: "what@example.com", definition: "not json" },
    ]);

    db.run(await backfillSql());

    expect(read(db, "a").approvers).toEqual(["who@example.com"]);
    expect(read(db, "b").approvers).toEqual(["what@example.com"]);
  });

  test("it carries every rule, not just the first", async () => {
    const db = legacyTable(
      ["one", "two", "three"].map((id, index) => ({
        id,
        approverEmail: `approver${index}@example.com`,
        definition: "{}",
      })),
    );

    db.run(await backfillSql());

    for (const [index, id] of ["one", "two", "three"].entries()) {
      expect(read(db, id).approvers).toEqual([`approver${index}@example.com`]);
    }
  });
});

/* ----------------------- the ledger fan-out (1750000007) ------------------ */

/**
 * Payments and credits moving out of `invoices.ledger` into their own tables.
 *
 * Worth testing for the same reason as the backfill above, twice over: it is
 * the one migration that *moves* data rather than adding to it, so a statement
 * that quietly dropped a row would lose a customer's payment, and there would
 * be nothing left to recover it from.
 */
const LEDGER_MIGRATION = "docker/pb_migrations/1750000007_ledger_collections.js";

/** Lifts a named SQL constant out of the migration, so the test runs the real one. */
async function statement(name: string, file = LEDGER_MIGRATION): Promise<string> {
  const source = await Bun.file(file).text();
  const match = new RegExp(`const ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(source);
  if (!match) throw new Error(`No ${name} statement found in ${file}`);
  return match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** The three tables as PocketBase leaves them after 1750000007 creates them. */
function ledgerTables(invoices: { id: string; owner: string; ledger: string | null; total?: number }[]): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE invoices (id TEXT PRIMARY KEY, owner TEXT, ledger TEXT, total REAL, created TEXT, updated TEXT)");
  db.run(
    "CREATE TABLE payments (id TEXT PRIMARY KEY, invoice TEXT, receivedOn TEXT, amount REAL, method TEXT, reference TEXT, note TEXT, owner TEXT, created TEXT, updated TEXT)",
  );
  db.run(
    "CREATE TABLE credits (id TEXT PRIMARY KEY, invoice TEXT, issuedOn TEXT, amount REAL, reason TEXT, note TEXT, owner TEXT, created TEXT, updated TEXT)",
  );

  for (const invoice of invoices) {
    db.run("INSERT INTO invoices (id, owner, ledger, total, created, updated) VALUES (?, ?, ?, ?, ?, ?)", [
      invoice.id,
      invoice.owner,
      invoice.ledger,
      invoice.total ?? 0,
      "2026-03-01 09:00:00.000Z",
      "2026-03-01 09:00:00.000Z",
    ]);
  }
  return db;
}

const ledgerOf = (payments: unknown[], credits: unknown[] = []) => JSON.stringify({ payments, credits });

const samplePayment = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({
  id,
  receivedOn: "2026-04-02",
  amount,
  method: "cheque",
  reference: "FT-1",
  note: "part payment",
  recordedAt: "2026-04-02T09:30:00.000Z",
  ...extra,
});

describe("fanning the ledger out into its own tables", () => {
  test("every embedded payment becomes a row, pointing back at its invoice", async () => {
    const db = ledgerTables([
      { id: "inv_1", owner: "u1", ledger: ledgerOf([samplePayment("pmt_a", 400), samplePayment("pmt_b", 250)]) },
      { id: "inv_2", owner: "u2", ledger: ledgerOf([samplePayment("pmt_c", 90)]) },
    ]);

    db.run(await statement("FANOUT_PAYMENTS"));

    const rows = db.query("SELECT * FROM payments ORDER BY id").all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.id)).toEqual(["pmt_a", "pmt_b", "pmt_c"]);
    // Each one points at the invoice it came out of, and keeps its owner.
    expect(rows.map(row => row.invoice)).toEqual(["inv_1", "inv_1", "inv_2"]);
    expect(rows.map(row => row.owner)).toEqual(["u1", "u1", "u2"]);
    // Not one amount is lost or rounded on the way across.
    expect(rows.map(row => row.amount)).toEqual([400, 250, 90]);
  });

  test("every field comes across, not just the money", async () => {
    const db = ledgerTables([{ id: "inv_1", owner: "u1", ledger: ledgerOf([samplePayment("pmt_a", 400)]) }]);
    db.run(await statement("FANOUT_PAYMENTS"));

    const row = db.query("SELECT * FROM payments WHERE id = 'pmt_a'").get() as any;
    expect(row.receivedOn).toBe("2026-04-02");
    expect(row.method).toBe("cheque");
    expect(row.reference).toBe("FT-1");
    expect(row.note).toBe("part payment");
    // recordedAt was what `created` always meant, in PocketBase's own format.
    expect(row.created).toBe("2026-04-02 09:30:00.000Z");
    expect(row.updated).toBe("2026-04-02 09:30:00.000Z");
  });

  test("a payment with no recordedAt falls back to the invoice's own date", async () => {
    const { recordedAt, ...withoutTimestamp } = samplePayment("pmt_a", 10);
    void recordedAt;
    const db = ledgerTables([{ id: "inv_1", owner: "u1", ledger: ledgerOf([withoutTimestamp]) }]);

    db.run(await statement("FANOUT_PAYMENTS"));

    const row = db.query("SELECT created FROM payments WHERE id = 'pmt_a'").get() as any;
    expect(row.created).toBe("2026-03-01 09:00:00.000Z");
  });

  test("credits come across the same way, with their reason", async () => {
    const db = ledgerTables([
      {
        id: "inv_1",
        owner: "u1",
        ledger: ledgerOf(
          [],
          [{ id: "crd_a", issuedOn: "2026-04-10", amount: 250, reason: "write_off", note: "not coming" }],
        ),
      },
    ]);

    db.run(await statement("FANOUT_CREDITS"));

    const row = db.query("SELECT * FROM credits WHERE id = 'crd_a'").get() as any;
    expect(row.invoice).toBe("inv_1");
    expect(row.amount).toBe(250);
    expect(row.reason).toBe("write_off");
    expect(row.note).toBe("not coming");
  });

  test("an invoice with an empty, missing, null or broken ledger is skipped, not failed", async () => {
    // Every one of these is a real state: a draft never paid, a record written
    // before the field existed, a field somebody cleared.
    const db = ledgerTables([
      { id: "inv_empty", owner: "u1", ledger: ledgerOf([], []) },
      { id: "inv_missing", owner: "u1", ledger: "{}" },
      { id: "inv_null", owner: "u1", ledger: null },
      { id: "inv_broken", owner: "u1", ledger: "not json at all" },
      // The shape a JSON field can also legitimately hold: not an object.
      { id: "inv_array", owner: "u1", ledger: "[1,2,3]" },
      { id: "inv_real", owner: "u1", ledger: ledgerOf([samplePayment("pmt_a", 5)]) },
    ]);

    db.run(await statement("FANOUT_PAYMENTS"));
    db.run(await statement("FANOUT_CREDITS"));

    // The one real payment came across and nothing else threw.
    expect(db.query("SELECT id FROM payments").all()).toEqual([{ id: "pmt_a" }]);
    expect(db.query("SELECT id FROM credits").all()).toEqual([]);
  });

  test("an entry with no id is left behind rather than given a null primary key", async () => {
    const db = ledgerTables([
      { id: "inv_1", owner: "u1", ledger: ledgerOf([{ amount: 40 }, samplePayment("pmt_a", 60)]) },
    ]);

    db.run(await statement("FANOUT_PAYMENTS"));

    expect(db.query("SELECT id FROM payments").all()).toEqual([{ id: "pmt_a" }]);
  });

  test("running it twice does not double the ledger", async () => {
    // A migration runs once, but a half-applied one gets retried — and a
    // duplicated payment is a customer's invoice showing as paid twice over.
    const db = ledgerTables([{ id: "inv_1", owner: "u1", ledger: ledgerOf([samplePayment("pmt_a", 400)]) }]);
    const sql = await statement("FANOUT_PAYMENTS");

    db.run(sql);
    db.run(sql);

    const rows = db.query("SELECT id, amount FROM payments").all();
    expect(rows).toEqual([{ id: "pmt_a", amount: 400 }]);
  });

  test("the down migration gathers the rows back into the field they came from", async () => {
    const db = ledgerTables([
      {
        id: "inv_1",
        owner: "u1",
        total: 1_000,
        ledger: ledgerOf([samplePayment("pmt_a", 400)], [{ id: "crd_a", issuedOn: "2026-04-10", amount: 100, reason: "goodwill", note: "" }]),
      },
    ]);

    db.run(await statement("FANOUT_PAYMENTS"));
    db.run(await statement("FANOUT_CREDITS"));
    // Clear the field the way the up migration does by dropping it.
    db.run("UPDATE invoices SET ledger = NULL");

    db.run(await statement("REBUILD_LEDGER"));

    const ledger = JSON.parse((db.query("SELECT ledger FROM invoices WHERE id = 'inv_1'").get() as any).ledger);
    expect(ledger.payments).toHaveLength(1);
    expect(ledger.payments[0]).toMatchObject({ id: "pmt_a", amount: 400, reference: "FT-1" });
    expect(ledger.credits).toHaveLength(1);
    expect(ledger.credits[0]).toMatchObject({ id: "crd_a", amount: 100, reason: "goodwill" });
  });

  test("the down migration gives an invoice with no ledger two empty lists", async () => {
    // Not null, and not a missing key: the shape the old code read unguarded.
    const db = ledgerTables([{ id: "inv_1", owner: "u1", ledger: null }]);

    db.run(await statement("REBUILD_LEDGER"));

    const ledger = JSON.parse((db.query("SELECT ledger FROM invoices WHERE id = 'inv_1'").get() as any).ledger);
    expect(ledger).toEqual({ payments: [], credits: [] });
  });
});

/* --------------------------- the template kind --------------------------- */

const TEMPLATE_MIGRATION = "docker/pb_migrations/1750000008_invoice_templates.js";

/**
 * Invoice templates added a `kind` column to a collection that already had
 * rows in it. Every one of those rows is a quote template, and the backfill is
 * what says so — a column that meant "quote" only by being empty is one
 * somebody would eventually read the other way round.
 */
describe("backfilling the template kind", () => {
  const templatesTable = (rows: { id: string; kind: string | null }[]): Database => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE proposal_templates (id TEXT PRIMARY KEY, name TEXT, kind TEXT, format TEXT, body TEXT)");
    for (const row of rows) {
      db.run("INSERT INTO proposal_templates (id, name, kind, format, body) VALUES (?, 'Proposal', ?, 'pdf', '{}')", [
        row.id,
        row.kind,
      ]);
    }
    return db;
  };

  const kinds = (db: Database) =>
    (db.query("SELECT id, kind FROM proposal_templates ORDER BY id").all() as { id: string; kind: string }[]).map(
      row => [row.id, row.kind] as const,
    );

  test("a template that predates the column becomes a quote's", async () => {
    // PocketBase gives an added text field an empty string on existing rows;
    // a row written straight into SQL can have a null. Both are the same
    // template, and both are a quote's.
    const db = templatesTable([
      { id: "tpl_a", kind: null },
      { id: "tpl_b", kind: "" },
      { id: "tpl_c", kind: "   " },
    ]);

    db.run(await statement("BACKFILL_KIND", TEMPLATE_MIGRATION));

    expect(kinds(db)).toEqual([
      ["tpl_a", "quote"],
      ["tpl_b", "quote"],
      ["tpl_c", "quote"],
    ]);
  });

  test("a template that already says what it is keeps saying it", async () => {
    // The statement has to be safe to run twice: a migration that reran and
    // turned every invoice template into a quote one would be silent.
    const db = templatesTable([
      { id: "tpl_a", kind: "invoice" },
      { id: "tpl_b", kind: "quote" },
    ]);

    db.run(await statement("BACKFILL_KIND", TEMPLATE_MIGRATION));
    db.run(await statement("BACKFILL_KIND", TEMPLATE_MIGRATION));

    expect(kinds(db)).toEqual([
      ["tpl_a", "invoice"],
      ["tpl_b", "quote"],
    ]);
  });
});
