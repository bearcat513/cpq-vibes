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

/* --------------------- organizations and roles (1750000010) ---------------- */

/**
 * Every account becoming the admin of a one-person organization, and every
 * record following its owner there.
 *
 * The property that matters most is the one the tests below keep checking:
 * **nothing anyone could see before becomes visible to anyone else.** Two
 * accounts become two organizations, never one.
 */
const ORG_MIGRATION = "docker/pb_migrations/1750000010_organizations.js";
const orgStatement = (name: string) => statement(name, ORG_MIGRATION);
const forTable = (sql: string, table: string) => sql.split("{table}").join(table);

function orgTables(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, org TEXT DEFAULT '', role TEXT DEFAULT '')");
  db.run("CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, settings TEXT, created TEXT, updated TEXT)");
  db.run("CREATE TABLE memberships (id TEXT PRIMARY KEY, org TEXT, user TEXT, role TEXT, created TEXT, updated TEXT)");
  db.run("CREATE TABLE counters (id TEXT PRIMARY KEY, org TEXT, kind TEXT, year INTEGER, value INTEGER, created TEXT, updated TEXT)");
  db.run("CREATE TABLE products (id TEXT PRIMARY KEY, owner TEXT, org TEXT DEFAULT '')");
  db.run(
    "CREATE TABLE quotes (id TEXT PRIMARY KEY, owner TEXT, org TEXT DEFAULT '', number TEXT, status TEXT, version INTEGER, supersedes TEXT DEFAULT '', supersededBy TEXT DEFAULT '', created TEXT)",
  );
  db.run("CREATE TABLE invoices (id TEXT PRIMARY KEY, owner TEXT, org TEXT DEFAULT '', number TEXT, state TEXT)");
  db.run("CREATE TABLE payments (id TEXT PRIMARY KEY, invoice TEXT, owner TEXT, org TEXT DEFAULT '')");
  db.run("CREATE TABLE api_keys (id TEXT PRIMARY KEY, user TEXT, org TEXT DEFAULT '')");
  return db;
}

async function migrateOrgs(db: Database) {
  for (const name of ["CREATE_PERSONAL_ORGS", "CREATE_ADMIN_MEMBERSHIPS", "ASSIGN_PERSONAL_ORGS"]) {
    db.run(await orgStatement(name));
  }
  for (const table of ["products", "quotes", "invoices"]) db.run(forTable(await orgStatement("STAMP_OWNER_ORG"), table));
  db.run(forTable(await orgStatement("STAMP_LEDGER_ORG"), "payments"));
  db.run(await orgStatement("STAMP_KEY_ORG"));
  for (const name of ["RELEASE_DRAFT_NUMBERS", "SEED_QUOTE_COUNTERS", "SEED_INVOICE_COUNTERS", "LINK_SUPERSEDED"]) {
    db.run(await orgStatement(name));
  }
}

const one = <T>(db: Database, sql: string, ...params: string[]) => db.query(sql).get(...params) as T;

describe("giving every account an organization", () => {
  test("each account becomes the admin of its own, named after it", async () => {
    const db = orgTables();
    db.run("INSERT INTO users (id, email, name) VALUES ('AliceID', 'alice@example.com', 'Alice'), ('bob', 'bob@example.com', '')");
    await migrateOrgs(db);

    const alice = one<{ org: string; role: string }>(db, "SELECT org, role FROM users WHERE id = 'AliceID'");
    const bob = one<{ org: string; role: string }>(db, "SELECT org, role FROM users WHERE id = 'bob'");
    expect(alice).toEqual({ org: "org_aliceid", role: "admin" });
    expect(bob).toEqual({ org: "org_bob", role: "admin" });

    expect(one<{ name: string }>(db, "SELECT name FROM organizations WHERE id = 'org_aliceid'").name).toBe("Alice's workspace");
    // No display name: the address stands in for it.
    expect(one<{ name: string }>(db, "SELECT name FROM organizations WHERE id = 'org_bob'").name).toBe("bob@example.com");

    const memberships = db.query("SELECT org, user, role FROM memberships ORDER BY user").all();
    expect(memberships).toEqual([
      { org: "org_aliceid", user: "AliceID", role: "admin" },
      { org: "org_bob", user: "bob", role: "admin" },
    ]);
  });

  test("records follow their owner, so two accounts' records stay apart", async () => {
    const db = orgTables();
    db.run("INSERT INTO users (id, email, name) VALUES ('alice', 'a@example.com', 'A'), ('bob', 'b@example.com', 'B')");
    db.run("INSERT INTO products (id, owner) VALUES ('p1', 'alice'), ('p2', 'bob'), ('orphan', '')");
    db.run("INSERT INTO invoices (id, owner, number, state) VALUES ('i1', 'alice', 'INV-2026-0001', 'issued')");
    db.run("INSERT INTO payments (id, invoice, owner) VALUES ('pay1', 'i1', 'bob')");
    db.run("INSERT INTO api_keys (id, user) VALUES ('k1', 'bob')");
    await migrateOrgs(db);

    expect(one<{ org: string }>(db, "SELECT org FROM products WHERE id = 'p1'").org).toBe("org_alice");
    expect(one<{ org: string }>(db, "SELECT org FROM products WHERE id = 'p2'").org).toBe("org_bob");
    // An ownerless leftover stays unreachable, exactly as it was.
    expect(one<{ org: string }>(db, "SELECT org FROM products WHERE id = 'orphan'").org).toBe("");
    // A payment belongs to its invoice's organization, whoever keyed it in.
    expect(one<{ org: string }>(db, "SELECT org FROM payments WHERE id = 'pay1'").org).toBe("org_alice");
    expect(one<{ org: string }>(db, "SELECT org FROM api_keys WHERE id = 'k1'").org).toBe("org_bob");
  });

  test("running it twice changes nothing", async () => {
    const db = orgTables();
    db.run("INSERT INTO users (id, email, name) VALUES ('alice', 'a@example.com', 'A')");
    db.run("INSERT INTO quotes (id, owner, number, status, version, created) VALUES ('q1', 'alice', 'Q-2026-0003', 'draft', 1, '1')");
    await migrateOrgs(db);
    await migrateOrgs(db);

    expect(one<{ n: number }>(db, "SELECT count(*) AS n FROM organizations").n).toBe(1);
    expect(one<{ n: number }>(db, "SELECT count(*) AS n FROM memberships").n).toBe(1);
    expect(one<{ n: number }>(db, "SELECT count(*) AS n FROM counters").n).toBe(1);
  });
});

describe("seeding the number counters", () => {
  test("each organization's counter starts at the highest number it has used that year", async () => {
    const db = orgTables();
    db.run("INSERT INTO users (id, email, name) VALUES ('alice', 'a@example.com', 'A'), ('bob', 'b@example.com', 'B')");
    db.run(`INSERT INTO quotes (id, owner, number, status, version, created) VALUES
      ('q1', 'alice', 'Q-2026-0003', 'sent', 1, '1'),
      ('q2', 'alice', 'Q-2026-0011-r2', 'draft', 2, '2'),
      ('q3', 'alice', 'Q-2025-0040', 'sent', 1, '3'),
      ('q4', 'bob', 'Q-2026-0002', 'sent', 1, '4'),
      ('q5', 'bob', 'imported by hand', 'sent', 1, '5')`);
    await migrateOrgs(db);

    const counter = (org: string, year: number) =>
      (db.query("SELECT value FROM counters WHERE org = ? AND kind = 'quote' AND year = ?").get(org, year) as { value: number } | null)
        ?.value;
    // A revision's "0011-r2" counts as 11: revisions share their original's number.
    expect(counter("org_alice", 2026)).toBe(11);
    expect(counter("org_alice", 2025)).toBe(40);
    expect(counter("org_bob", 2026)).toBe(2);
  });

  test("drafts give their invoice numbers back, and only issued ones seed the counter", async () => {
    const db = orgTables();
    db.run("INSERT INTO users (id, email, name) VALUES ('alice', 'a@example.com', 'A')");
    db.run(`INSERT INTO invoices (id, owner, number, state) VALUES
      ('i1', 'alice', 'INV-2026-0001', 'issued'),
      ('i2', 'alice', 'INV-2026-0002', 'void'),
      ('i3', 'alice', 'INV-2026-0003', 'draft')`);
    await migrateOrgs(db);

    expect(one<{ number: string }>(db, "SELECT number FROM invoices WHERE id = 'i3'").number).toBe("DRAFT-i3");
    expect(one<{ number: string }>(db, "SELECT number FROM invoices WHERE id = 'i1'").number).toBe("INV-2026-0001");
    // Void counts: its number was issued and is never reused.
    expect(one<{ value: number }>(db, "SELECT value FROM counters WHERE kind = 'invoice'").value).toBe(2);
  });
});

describe("linking superseded quotes", () => {
  test("a revised quote points at its newest revision", async () => {
    const db = orgTables();
    db.run("INSERT INTO users (id, email, name) VALUES ('alice', 'a@example.com', 'A')");
    db.run(`INSERT INTO quotes (id, owner, number, status, version, supersedes, created) VALUES
      ('q1', 'alice', 'Q-2026-0001', 'sent', 1, '', '1'),
      ('q2', 'alice', 'Q-2026-0001-r2', 'sent', 2, 'q1', '2'),
      ('q3', 'alice', 'Q-2026-0001-r3', 'draft', 3, 'q2', '3'),
      ('q4', 'alice', 'Q-2026-0002', 'accepted', 1, '', '4'),
      ('q5', 'alice', 'Q-2026-0002-r2', 'draft', 2, 'q4', '5')`);
    await migrateOrgs(db);

    const supersededBy = (id: string) => one<{ s: string }>(db, "SELECT supersededBy AS s FROM quotes WHERE id = ?", id).s;
    expect(supersededBy("q1")).toBe("q2");
    expect(supersededBy("q2")).toBe("q3");
    expect(supersededBy("q3")).toBe("");
    // An accepted quote is a contract; a later revision does not retire it.
    expect(supersededBy("q4")).toBe("");
  });
});

/* -------------------- breaking up account details (1750000014) ------------------- */

/**
 * The account `details` blob moving into columns, `contacts` and
 * `sys_physical_location`. Like the ledger fan-out, it moves data rather than
 * adding to it — a dropped contact or address would be gone with the column.
 */
const NORMALIZE_MIGRATION = "docker/pb_migrations/1750000014_account_normalize.js";
const NORMALIZE = ["INSERT_BILLING", "INSERT_SHIPPING", "COPY_COLUMNS", "INSERT_CONTACTS", "INSERT_LEGACY_CONTACTS", "ONE_PRIMARY"];

/** The three tables as PocketBase leaves them once 1750000014 has added its fields, before `details` is dropped. */
function accountTables(accounts: { id: string; details: unknown; contactEmail?: string }[]): Database {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE accounts (id TEXT PRIMARY KEY, owner TEXT, org TEXT, name TEXT, contactEmail TEXT, details TEXT, industry TEXT, website TEXT, status TEXT, tags TEXT, paymentTerms TEXT, paymentTermDays REAL, creditLimit REAL, defaultDiscountPercent REAL, taxExempt BOOLEAN, taxPercent REAL, notes TEXT, billingAddress TEXT, shippingAddress TEXT, created TEXT, updated TEXT)",
  );
  db.run(
    "CREATE TABLE sys_physical_location (id TEXT PRIMARY KEY, owner TEXT, org TEXT, name TEXT, line1 TEXT, line2 TEXT, city TEXT, state TEXT, postalCode TEXT, country TEXT, created TEXT, updated TEXT)",
  );
  db.run(
    'CREATE TABLE contacts (id TEXT PRIMARY KEY, account TEXT, owner TEXT, org TEXT, name TEXT, title TEXT, contactEmail TEXT, phone TEXT, role TEXT, "primary" BOOLEAN, position REAL, email TEXT, emailVisibility BOOLEAN, verified BOOLEAN, password TEXT, tokenKey TEXT UNIQUE, created TEXT, updated TEXT)',
  );
  for (const account of accounts) {
    db.run("INSERT INTO accounts (id, owner, org, name, contactEmail, details, created, updated) VALUES (?, 'u1', 'org1', ?, ?, ?, ?, ?)", [
      account.id,
      account.id,
      account.contactEmail ?? "",
      typeof account.details === "string" ? account.details : JSON.stringify(account.details),
      "2026-03-01 09:00:00.000Z",
      "2026-03-01 09:00:00.000Z",
    ]);
  }
  return db;
}

const normalize = async (db: Database) => {
  for (const name of NORMALIZE) db.run(await statement(name, NORMALIZE_MIGRATION));
};

const HARBOUR = {
  status: "customer",
  tags: ["enterprise", "renewal-q3"],
  paymentTerms: "Net 30",
  paymentTermDays: 30,
  creditLimit: 250000,
  taxExempt: true,
  taxPercent: 8.5,
  billingAddress: { line1: "1200 Embarcadero", line2: "Suite 400", city: "San Francisco", state: "CA", postalCode: "94107", country: "United States" },
  shippingSameAsBilling: false,
  shippingAddress: { line1: "3400 Pier 80", line2: "", city: "San Francisco", state: "CA", postalCode: "94124", country: "" },
  contacts: [
    { id: "con_harbour_dana", name: "Dana Okafor", email: "Dana@Harbour.example.com", role: "commercial", primary: false },
    { id: "con_harbour_ap", name: "Accounts Payable", email: "ap@harbour.example.com", role: "billing", primary: true },
  ],
};

describe("breaking an account's details into columns and records", () => {
  test("each address becomes a location named on one line, and the account points at it", async () => {
    const db = accountTables([
      { id: "acc_h", details: HARBOUR },
      { id: "acc_same", details: { billingAddress: HARBOUR.billingAddress, shippingSameAsBilling: true, shippingAddress: HARBOUR.shippingAddress } },
      { id: "acc_none", details: { billingAddress: { line1: " ", city: "" } } },
    ]);
    await normalize(db);

    const names = Object.fromEntries((db.query("SELECT id, name FROM sys_physical_location").all() as any[]).map(row => [row.id, row.name]));
    expect(names).toEqual({
      loc_b_acc_h: "1200 Embarcadero, Suite 400, San Francisco, CA, 94107, United States",
      // Blank parts are skipped, not left as ", ,".
      loc_s_acc_h: "3400 Pier 80, San Francisco, CA, 94124",
      loc_b_acc_same: "1200 Embarcadero, Suite 400, San Francisco, CA, 94107, United States",
    });

    const links = db.query("SELECT id, billingAddress, shippingAddress FROM accounts ORDER BY id").all();
    expect(links).toEqual([
      { id: "acc_h", billingAddress: "loc_b_acc_h", shippingAddress: "loc_s_acc_h" },
      // A blank address is no location; shipping to the billing address is the same one.
      { id: "acc_none", billingAddress: "", shippingAddress: "" },
      { id: "acc_same", billingAddress: "loc_b_acc_same", shippingAddress: "loc_b_acc_same" },
    ]);
  });

  test("the scalars land in their columns, and payment days are read out of the terms when missing", async () => {
    const db = accountTables([
      { id: "acc_h", details: HARBOUR },
      { id: "acc_text", details: { paymentTerms: "Net 45 EOM", status: "nonsense" } },
      { id: "acc_bare", details: {} },
    ]);
    await normalize(db);

    const rows = db.query("SELECT id, status, tags, paymentTermDays, creditLimit, taxExempt, taxPercent FROM accounts ORDER BY id").all() as any[];
    expect(rows).toEqual([
      { id: "acc_bare", status: "prospect", tags: "[]", paymentTermDays: 30, creditLimit: 0, taxExempt: 0, taxPercent: 0 },
      { id: "acc_h", status: "customer", tags: '["enterprise","renewal-q3"]', paymentTermDays: 30, creditLimit: 250000, taxExempt: 1, taxPercent: 8.5 },
      { id: "acc_text", status: "prospect", tags: "[]", paymentTermDays: 45, creditLimit: 0, taxExempt: 0, taxPercent: 0 },
    ]);
  });

  test("every contact becomes a record on its account, in order, with exactly one primary", async () => {
    const db = accountTables([
      { id: "acc_h", details: HARBOUR },
      // The same sample installed in another org: same embedded ids, no collision.
      { id: "acc_h2", details: HARBOUR },
      { id: "acc_two", details: { contacts: [{ name: "A", primary: true }, { name: "B", primary: true }] } },
      { id: "acc_zero", details: { contacts: [{ name: "C" }, { name: "D" }] } },
    ]);
    await normalize(db);

    const rows = db.query('SELECT id, account, name, contactEmail, role, "primary" AS isPrimary, position, email FROM contacts ORDER BY account, position').all() as any[];
    expect(rows.filter(row => row.account === "acc_h")).toEqual([
      { id: "con_acc_h_0", account: "acc_h", name: "Dana Okafor", contactEmail: "dana@harbour.example.com", role: "commercial", isPrimary: 0, position: 0, email: "" },
      { id: "con_acc_h_1", account: "acc_h", name: "Accounts Payable", contactEmail: "ap@harbour.example.com", role: "billing", isPrimary: 1, position: 1, email: "" },
    ]);
    expect(rows.filter(row => row.account === "acc_h2")).toHaveLength(2);
    expect(rows.filter(row => row.account === "acc_two").map(row => row.isPrimary)).toEqual([1, 0]);
    expect(rows.filter(row => row.account === "acc_zero").map(row => row.isPrimary)).toEqual([1, 0]);
    // Nobody signs in as a contact, but each still has a distinct token key.
    expect(new Set((db.query("SELECT tokenKey FROM contacts").all() as any[]).map(row => row.tokenKey)).size).toBe(rows.length);
  });

  test("a record from before the contact list becomes one primary contact", async () => {
    const db = accountTables([
      { id: "acc_old", contactEmail: "Old@Example.com", details: { contactName: "Olde Contact", contactPhone: "555" } },
      { id: "acc_empty", details: {} },
    ]);
    await normalize(db);

    expect(db.query('SELECT account, name, contactEmail, phone, "primary" AS isPrimary FROM contacts').all()).toEqual([
      { account: "acc_old", name: "Olde Contact", contactEmail: "old@example.com", phone: "555", isPrimary: 1 },
    ]);
  });

  test("running it twice changes nothing", async () => {
    const db = accountTables([{ id: "acc_h", details: HARBOUR }]);
    await normalize(db);
    const snapshot = () => [
      db.query("SELECT * FROM sys_physical_location ORDER BY id").all(),
      db.query("SELECT id, name, position FROM contacts ORDER BY id").all(),
      db.query("SELECT billingAddress, shippingAddress, paymentTermDays FROM accounts").all(),
    ];
    const first = snapshot();
    await normalize(db);
    expect(snapshot()).toEqual(first);
  });

  test("down rebuilds the blob the app used to read", async () => {
    const db = accountTables([{ id: "acc_h", details: HARBOUR }]);
    await normalize(db);
    db.run("UPDATE accounts SET details = NULL, contactEmail = ''");
    db.run(await statement("REBUILD_DETAILS", NORMALIZE_MIGRATION));

    const row = db.query("SELECT contactEmail, details FROM accounts").get() as any;
    const details = JSON.parse(row.details);
    expect(row.contactEmail).toBe("ap@harbour.example.com");
    expect(details.contacts.map((contact: any) => [contact.name, contact.primary])).toEqual([
      ["Dana Okafor", false],
      ["Accounts Payable", true],
    ]);
    expect(details.billingAddress).toEqual(HARBOUR.billingAddress);
    expect(details.shippingAddress.line1).toBe("3400 Pier 80");
    expect(details.shippingSameAsBilling).toBe(false);
    expect(details).toMatchObject({ status: "customer", creditLimit: 250000, paymentTermDays: 30, taxExempt: true, tags: HARBOUR.tags });
  });
});

/* ---------------------- line items as records (1750000016) ---------------------- */

/**
 * `quotes.lines` and `invoices.lines` fanning out into `quote_lines` and
 * `invoice_lines`. The arrays are dropped afterwards, so a line left behind
 * here is a line gone from a customer's quote or invoice.
 */
const LINES_MIGRATION = "docker/pb_migrations/1750000016_line_items.js";

const QUOTE_LINE_COLUMNS =
  "lineId TEXT, position REAL, productId TEXT, parentLineId TEXT, sortOrder REAL, quantity REAL, discountPercent REAL, termMonths REAL, description TEXT, sku TEXT, name TEXT, family TEXT, chargeType TEXT, billingPeriod TEXT, unitOfMeasure TEXT, listUnitPrice REAL, optionsUnitDelta REAL, baseUnitPrice REAL, unitPrice REAL, listTotal REAL, discountAmount REAL, netTotal REAL, effectiveDiscountPercent REAL, periods REAL, unitCost REAL, costTotal REAL, margin REAL, marginPercent REAL, oneTime REAL, monthlyRecurring REAL, annualRecurring REAL, detail TEXT";

/** Both parents with their `lines` still on them, and both line tables as 1750000016 creates them. */
function lineTables(quotes: { id: string; lines: unknown }[], invoices: { id: string; lines: unknown }[] = []): Database {
  const db = new Database(":memory:");
  const raw = (value: unknown) => (typeof value === "string" || value === null ? value : JSON.stringify(value));
  db.run("CREATE TABLE quotes (id TEXT PRIMARY KEY, owner TEXT, org TEXT, lines TEXT, created TEXT, updated TEXT)");
  db.run("CREATE TABLE invoices (id TEXT PRIMARY KEY, owner TEXT, org TEXT, lines TEXT, created TEXT, updated TEXT)");
  db.run(`CREATE TABLE quote_lines (id TEXT PRIMARY KEY, quote TEXT, owner TEXT, org TEXT, ${QUOTE_LINE_COLUMNS}, created TEXT, updated TEXT)`);
  db.run(
    "CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice TEXT, owner TEXT, org TEXT, lineId TEXT, position REAL, sourceLineId TEXT, sku TEXT, description TEXT, quantity REAL, unitPrice REAL, amount REAL, taxPercent REAL, taxAmount REAL, created TEXT, updated TEXT)",
  );
  const stamp = "2026-05-01 09:00:00.000Z";
  for (const quote of quotes) {
    db.run("INSERT INTO quotes VALUES (?, 'u1', 'org1', ?, ?, ?)", [quote.id, raw(quote.lines) as string, stamp, stamp]);
  }
  for (const invoice of invoices) {
    db.run("INSERT INTO invoices VALUES (?, 'u1', 'org1', ?, ?, ?)", [invoice.id, raw(invoice.lines) as string, stamp, stamp]);
  }
  return db;
}

const fanOutLines = async (db: Database) => {
  db.run(await statement("FANOUT_QUOTE_LINES", LINES_MIGRATION));
  db.run(await statement("FANOUT_INVOICE_LINES", LINES_MIGRATION));
};

/** A priced bundle line and one of its components, as the pricing engine stores them. */
const BUNDLE = {
  id: "ln_bundle",
  productId: "prd_suite",
  quantity: 10,
  discountPercent: 5,
  unitPriceOverride: null,
  selectedOptions: ["sso", "audit"],
  termMonths: 12,
  description: "",
  parentId: null,
  sortOrder: 0,
  sku: "SUITE",
  name: "Suite",
  family: "Software",
  chargeType: "recurring",
  billingPeriod: "monthly",
  unitOfMeasure: "seat",
  optionNames: ["SSO", "Audit log"],
  listUnitPrice: 40,
  optionsUnitDelta: 5,
  baseUnitPrice: 45,
  tier: { minQuantity: 10, maxQuantity: null, unitPrice: 42 },
  unitPrice: 39.9,
  listTotal: 4800,
  discountAmount: 12,
  netTotal: 4788,
  effectiveDiscountPercent: 0.25,
  periods: 12,
  unitCost: 10,
  costTotal: 1200,
  margin: 3588,
  marginPercent: 74.94,
  oneTime: 0,
  monthlyRecurring: 399,
  annualRecurring: 4788,
  appliedRules: [{ ruleId: "prc_1", name: "Volume break", amount: -12 }],
  issues: [],
  warnings: ["Two more seats reach the next tier."],
};
const COMPONENT = { ...BUNDLE, id: "ln_component", parentId: "ln_bundle", sortOrder: 1, unitPriceOverride: 0, sku: "SUITE-SVC", tier: null, appliedRules: [], warnings: [] };

const INVOICE_LINES = [
  { id: "il_1", sourceLineId: "ln_bundle", sku: "SUITE", description: "Suite, 12 months", quantity: 120, unitPrice: 39.9, amount: 4788, taxPercent: 20, taxAmount: 957.6 },
  { id: "il_2", sourceLineId: null, sku: "", description: "Shipping", quantity: 1, unitPrice: 25, amount: 25, taxPercent: 0, taxAmount: 0 },
];

describe("breaking quote and invoice lines out into their own tables", () => {
  test("every quote line becomes a row on its quote: scalars in columns, the rest in detail", async () => {
    const db = lineTables([{ id: "qte_a", lines: [BUNDLE, COMPONENT] }]);
    await fanOutLines(db);

    const rows = db.query("SELECT * FROM quote_lines ORDER BY position").all() as any[];
    expect(rows.map(row => [row.id, row.quote, row.lineId, row.position, row.parentLineId])).toEqual([
      ["qln_qte_a_0", "qte_a", "ln_bundle", 0, ""],
      ["qln_qte_a_1", "qte_a", "ln_component", 1, "ln_bundle"],
    ]);
    expect(rows[0]).toMatchObject({ owner: "u1", org: "org1", sku: "SUITE", quantity: 10, unitPrice: 39.9, netTotal: 4788, margin: 3588, chargeType: "recurring" });

    // Nothing that is a column is repeated in detail, and nothing nested is lost.
    expect(JSON.parse(rows[0].detail)).toEqual({
      unitPriceOverride: null,
      selectedOptions: ["sso", "audit"],
      optionNames: ["SSO", "Audit log"],
      tier: { minQuantity: 10, maxQuantity: null, unitPrice: 42 },
      appliedRules: [{ ruleId: "prc_1", name: "Volume break", amount: -12 }],
      issues: [],
      warnings: ["Two more seats reach the next tier."],
    });
    // A negotiated price of zero is not "no override".
    expect(JSON.parse(rows[1].detail).unitPriceOverride).toBe(0);
  });

  test("every invoice line becomes a row, and a line from no quote names none", async () => {
    const db = lineTables([], [{ id: "inv_a", lines: INVOICE_LINES }]);
    await fanOutLines(db);

    expect(db.query("SELECT id, invoice, lineId, position, sourceLineId, description, amount, taxAmount FROM invoice_lines ORDER BY position").all()).toEqual([
      { id: "iln_inv_a_0", invoice: "inv_a", lineId: "il_1", position: 0, sourceLineId: "ln_bundle", description: "Suite, 12 months", amount: 4788, taxAmount: 957.6 },
      { id: "iln_inv_a_1", invoice: "inv_a", lineId: "il_2", position: 1, sourceLineId: "", description: "Shipping", amount: 25, taxAmount: 0 },
    ]);
  });

  test("the same lines on two quotes — a revision — become two sets of rows", async () => {
    const db = lineTables([
      { id: "qte_a", lines: [BUNDLE] },
      { id: "qte_a_r2", lines: [BUNDLE] },
    ]);
    await fanOutLines(db);
    expect(db.query("SELECT quote, lineId FROM quote_lines ORDER BY quote").all()).toEqual([
      { quote: "qte_a", lineId: "ln_bundle" },
      { quote: "qte_a_r2", lineId: "ln_bundle" },
    ]);
  });

  test("an empty, missing, null or broken array is skipped, not failed", async () => {
    const db = lineTables(
      [
        { id: "q_empty", lines: [] },
        { id: "q_null", lines: null },
        { id: "q_broken", lines: "{not json" },
        { id: "q_object", lines: { id: "ln_x" } },
        { id: "q_junk", lines: [1, "two", null, { id: "ln_ok", sku: "OK" }] },
      ],
      [{ id: "i_null", lines: null }],
    );
    await fanOutLines(db);
    expect(db.query("SELECT quote, lineId, position FROM quote_lines").all()).toEqual([{ quote: "q_junk", lineId: "ln_ok", position: 3 }]);
    expect((db.query("SELECT count(*) AS n FROM invoice_lines").get() as any).n).toBe(0);
  });

  test("running it twice does not double the lines", async () => {
    const db = lineTables([{ id: "qte_a", lines: [BUNDLE, COMPONENT] }], [{ id: "inv_a", lines: INVOICE_LINES }]);
    await fanOutLines(db);
    await fanOutLines(db);
    expect((db.query("SELECT count(*) AS n FROM quote_lines").get() as any).n).toBe(2);
    expect((db.query("SELECT count(*) AS n FROM invoice_lines").get() as any).n).toBe(2);
  });

  test("down rebuilds both arrays exactly as they were, in order", async () => {
    const db = lineTables([{ id: "qte_a", lines: [BUNDLE, COMPONENT] }, { id: "qte_none", lines: [] }], [{ id: "inv_a", lines: INVOICE_LINES }]);
    await fanOutLines(db);
    db.run("UPDATE quotes SET lines = NULL");
    db.run("UPDATE invoices SET lines = NULL");
    db.run(await statement("REBUILD_QUOTE_LINES", LINES_MIGRATION));
    db.run(await statement("REBUILD_INVOICE_LINES", LINES_MIGRATION));

    const lines = (table: string, id: string) => JSON.parse((db.query(`SELECT lines FROM ${table} WHERE id = ?`).get(id) as any).lines);
    expect(lines("quotes", "qte_a")).toEqual([BUNDLE, COMPONENT]);
    expect(lines("quotes", "qte_none")).toEqual([]);
    expect(lines("invoices", "inv_a")).toEqual(INVOICE_LINES);
  });
});
