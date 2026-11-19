/// <reference path="../pb_data/types.d.ts" />

/**
 * The pipeline: `leads`, `opportunities`, and a quote's `opportunity`.
 *
 * A lead is somebody who might buy, before anybody has decided they are worth
 * a customer record. Converting one (POST /api/leads/:id/convert) creates or
 * picks the account, adds the person to it as a contact, and opens an
 * opportunity — all in one batch — and stamps the lead with what it became.
 * An opportunity is a deal with one customer, and quotes are written for it.
 * See src/lib/pipeline.ts.
 *
 * ## Access
 *
 * Built like 1750000010's: everybody in the organization reads both, and
 * writes go by role.
 *
 * - **Leads** are written by admin and sales — any lead in the organization,
 *   not only their own, because a lead is a pool that gets worked and handed
 *   around. **A converted lead is fixed**: the update rule asks the *stored*
 *   status, so the conversion itself goes through and nothing after it does.
 *   It may still be deleted, which leaves what it became untouched.
 * - **Opportunities** are written like quotes: an admin edits any, a sales
 *   member the ones they own. A deal outlives the rep who opened it, which is
 *   why the admin can.
 * - A quote's `opportunity` is written by whoever may edit the quote; an
 *   approver may not move it (pb_hooks/rules/approvals.js allows an approver
 *   three fields, and this is not one of them).
 *
 * One thing cascades. Deleting a customer takes its opportunities with it —
 * a deal with nobody is not a deal. Everything else unlinks: deleting an
 * opportunity leaves its quotes (a sent quote is a document in somebody's
 * inbox) with no `opportunity`, and a lead keeps its history with the links
 * to whatever was deleted blanked.
 *
 * `owner` and `org` are stamped by pb_hooks/rules/ownership.js; both
 * collections are in its `OWNED` list.
 */
migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");
    const organizations = app.findCollectionByNameOrId("organizations");
    const accounts = app.findCollectionByNameOrId("accounts");
    const quotes = app.findCollectionByNameOrId("quotes");

    const IN_ORG = '@request.auth.org != "" && org = @request.auth.org';
    const MEMBER = '@request.auth.org != ""';
    const role = (...roles) => "(" + roles.map(name => `@request.auth.role = "${name}"`).join(" || ") + ")";
    const OWN_DEAL = `(${role("admin")} || (${role("sales")} && owner = @request.auth.id))`;

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
    const date = name => ({ type: "date", name, required: false });

    /* ---------------------------------- leads ---------------------------------- */

    const leads = new Collection({
      name: "leads",
      type: "base",
      listRule: IN_ORG,
      viewRule: IN_ORG,
      createRule: `${MEMBER} && ${role("admin", "sales")}`,
      updateRule: `${IN_ORG} && ${role("admin", "sales")} && status != "converted"`,
      deleteRule: `${IN_ORG} && ${role("admin", "sales")}`,
      fields: [
        idField,
        owner(),
        org(),
        text("name", 200),
        text("company", 200),
        text("title", 120),
        text("email", 200),
        text("phone", 60),
        text("website", 300),
        text("industry", 120),
        text("source", 40),
        text("status", 20),
        number("estimatedAmount"),
        text("currency", 3),
        text("notes", 5000),
        // What converting made of it. Unlinked, not cascaded, if those go.
        date("convertedAt"),
        { type: "relation", name: "convertedAccount", required: false, maxSelect: 1, collectionId: accounts.id, cascadeDelete: false },
        // A contact is an auth record (1750000014); its id is enough.
        text("convertedContact", 80),
        created,
        updated,
      ],
      indexes: [
        "CREATE INDEX `idx_leads_org_status` ON `leads` (`org`, `status`)",
        "CREATE INDEX `idx_leads_org_email` ON `leads` (`org`, `email`)",
      ],
    });
    app.save(leads);

    /* ------------------------------ opportunities ------------------------------ */

    const opportunities = new Collection({
      name: "opportunities",
      type: "base",
      listRule: IN_ORG,
      viewRule: IN_ORG,
      createRule: `${MEMBER} && ${role("admin", "sales")}`,
      updateRule: `${IN_ORG} && ${OWN_DEAL}`,
      deleteRule: `${IN_ORG} && ${OWN_DEAL}`,
      fields: [
        idField,
        owner(),
        org(),
        text("name", 200),
        // A deal is with one customer, and goes with it.
        { type: "relation", name: "account", required: true, maxSelect: 1, collectionId: accounts.id, cascadeDelete: true },
        text("contact", 80),
        text("stage", 20),
        number("amount"),
        text("currency", 3),
        { type: "number", name: "probability", required: false, min: 0, max: 100 },
        date("closeDate"),
        text("source", 40),
        text("nextStep", 500),
        text("lossReason", 500),
        text("notes", 5000),
        { type: "relation", name: "lead", required: false, maxSelect: 1, collectionId: leads.id, cascadeDelete: false },
        date("closedAt"),
        created,
        updated,
      ],
      indexes: [
        "CREATE INDEX `idx_opportunities_org_stage` ON `opportunities` (`org`, `stage`)",
        "CREATE INDEX `idx_opportunities_account` ON `opportunities` (`account`)",
      ],
    });
    app.save(opportunities);

    // The lead points forward at its opportunity too, now that there is one to point at.
    const leadsAfter = app.findCollectionByNameOrId("leads");
    leadsAfter.fields.add(
      new RelationField({ name: "convertedOpportunity", required: false, maxSelect: 1, collectionId: opportunities.id, cascadeDelete: false }),
    );
    app.save(leadsAfter);

    /* -------------------------- a quote's opportunity -------------------------- */

    quotes.fields.add(
      new RelationField({ name: "opportunity", required: false, maxSelect: 1, collectionId: opportunities.id, cascadeDelete: false }),
    );
    quotes.addIndex("idx_quotes_opportunity", false, "`opportunity`", "");
    app.save(quotes);
  },
  app => {
    const quotes = app.findCollectionByNameOrId("quotes");
    quotes.removeIndex("idx_quotes_opportunity");
    if (quotes.fields.getByName("opportunity")) quotes.fields.removeByName("opportunity");
    app.save(quotes);

    const leads = app.findCollectionByNameOrId("leads");
    leads.fields.removeByName("convertedOpportunity");
    app.save(leads);

    app.delete(app.findCollectionByNameOrId("opportunities"));
    app.delete(app.findCollectionByNameOrId("leads"));
  },
);
