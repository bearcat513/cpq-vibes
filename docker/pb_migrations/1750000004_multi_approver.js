/// <reference path="../pb_data/types.d.ts" />

/**
 * An approval rule asks several people, with a quorum.
 *
 * It used to ask exactly one: `approval_rules` carried an `approverEmail`
 * column and a triggered rule produced one request with one answer. A rule can
 * now name a list and say how many of them must approve — and, separately, how
 * many must reject — before it is settled.
 *
 * ## Where the list lives
 *
 * In `definition`, with the rest of the rule, not in a column. The collection
 * keeps real columns for what the database has to *do* something with, and
 * nothing queries, sorts or filters on an approver: the quote's `approvers`
 * relation is what the access rules match on. `approverEmail` was in the wrong
 * place by that measure even when there was only one, so it is copied into the
 * definition and the column is dropped.
 *
 * Every existing rule keeps its approver as a one-element list, and a quorum
 * of one — which is exactly what it meant before.
 *
 * ## The relation
 *
 * `quotes.approvers` is widened from 20 to 50. One level can now gather
 * several rules' worth of people, and an approver who cannot be stamped onto
 * the quote cannot see it — so the cap here, `MAX_APPROVERS` in
 * pb_hooks/lib/approvers.js and the one in src/lib/validate.ts have to agree.
 */
migrate(
  app => {
    const rules = app.findCollectionByNameOrId("approval_rules");

    /* --- carry every existing approver into the definition --- */

    /*
     * Done in SQL rather than by reading each record.
     *
     * A JSON field reaches the JSVM as `types.JSONRaw`, which is a *byte
     * array* — so `definition.approvers` on it is undefined whatever the
     * stored object holds, and assigning to it sets a stray property on the
     * bytes that `record.set` then throws away. The loop looks right, runs
     * without error, and copies nothing. SQLite's own JSON functions operate
     * on the stored text and have no such trap.
     *
     * Exported as a constant because src/server/migration.test.ts runs this
     * exact statement against a throwaway database — a migration touches real
     * data once and cannot be re-run, so it is worth a test.
     */
    const BACKFILL_APPROVERS = "UPDATE approval_rules SET definition = json_set(CASE WHEN json_valid(definition) THEN definition ELSE '{}' END, '$.approvers', json_array(lower(trim(approverEmail))), '$.approvalsRequired', 1, '$.rejectionsRequired', 1) WHERE trim(coalesce(approverEmail, '')) <> '' AND json_extract(CASE WHEN json_valid(definition) THEN definition ELSE '{}' END, '$.approvers') IS NULL";

    app.db().newQuery(BACKFILL_APPROVERS).execute();

    if (rules.fields.getByName("approverEmail")) rules.fields.removeByName("approverEmail");
    app.save(rules);

    /* --- room for a level's worth of approvers on a quote --- */

    const quotes = app.findCollectionByNameOrId("quotes");
    const approvers = quotes.fields.getByName("approvers");
    if (approvers) {
      approvers.maxSelect = 50;
      app.save(quotes);
    }
  },
  app => {
    // Down: put the column back, holding the first approver — which is all a
    // single-approver rule could ever have expressed.
    const users = app.findCollectionByNameOrId("users");
    const rules = app.findCollectionByNameOrId("approval_rules");

    if (!rules.fields.getByName("approverEmail")) {
      rules.fields.add(new Field({ type: "text", name: "approverEmail", required: false, max: 200 }));
      app.save(rules);
    }

    for (const record of app.findAllRecords("approval_rules")) {
      const definition = record.get("definition") || {};
      const first = (definition.approvers || [])[0] || "";
      record.set("approverEmail", first);
      app.save(record);
    }

    const quotes = app.findCollectionByNameOrId("quotes");
    const approvers = quotes.fields.getByName("approvers");
    if (approvers) {
      approvers.maxSelect = 20;
      app.save(quotes);
    }

    void users;
  },
);
