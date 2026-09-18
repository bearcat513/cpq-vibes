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
