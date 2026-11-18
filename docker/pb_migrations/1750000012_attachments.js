/// <reference path="../pb_data/types.d.ts" />

/**
 * Attachments: one collection of files for every kind of record.
 *
 * A file names what it belongs to with `target` (accounts, quotes, invoices,
 * approvals) and `recordId`, rather than each collection growing a file field
 * of its own. `approvals` is not a collection — an approval request lives in
 * its quote's JSON and is re-minted on every reprice — so an approval
 * attachment's `recordId` is the quote's id. See src/lib/attachments.ts.
 *
 * **You see an attachment if you can see the record it is on.** The read rule
 * repeats each target's own audience: the organization, anyone the record is
 * shared with, and — for a quote — the people asked to approve it. A rule
 * cannot follow a polymorphic id the way it follows a relation, so it joins
 * through `@collection.<name>:alias`, one alias per question; conditions on
 * one alias are about the same row.
 *
 * **You add one where you could change the record**, with one exception:
 *
 * | target    | who may attach                                         |
 * | --------- | ------------------------------------------------------ |
 * | accounts  | admin, sales, finance                                  |
 * | quotes    | admin, or the sales member who owns it                 |
 * | invoices  | admin, finance                                         |
 * | approvals | as quotes — and anyone asked to approve it, from any org |
 *
 * The status of the record does not matter: a signed order form belongs on an
 * accepted quote, and a remittance advice on an issued invoice.
 *
 * Removing one is for an admin, or whoever uploaded it. Nothing updates one —
 * a wrong file is removed and the right one uploaded.
 *
 * `owner` and `org` are stamped by pb_hooks/rules/attachments.js — `org` from
 * the *record*, not the uploader, since an approver may be in another
 * organization entirely. It is not in OWNED for that reason.
 */
migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");
    const organizations = app.findCollectionByNameOrId("organizations");

    const IN_ORG = '@request.auth.org != "" && org = @request.auth.org';
    const role = (...roles) => "(" + roles.map(name => `@request.auth.role = "${name}"`).join(" || ") + ")";

    /* -------------------------------- read --------------------------------- */

    // `IN_ORG` covers every target: `org` is the record's own organization.
    const QUOTE_AUDIENCE =
      '(target = "quotes" || target = "approvals") && @collection.quotes:rq.id ?= recordId && ' +
      "(@collection.quotes:rq.sharedWith.id ?= @request.auth.id || @collection.quotes:rq.approvers.id ?= @request.auth.id)";
    const INVOICE_AUDIENCE =
      'target = "invoices" && @collection.invoices:ri.id ?= recordId && @collection.invoices:ri.sharedWith.id ?= @request.auth.id';
    const READ = `(${IN_ORG}) || (${QUOTE_AUDIENCE}) || (${INVOICE_AUDIENCE})`;

    /* ------------------------------- create -------------------------------- */

    const BODY_ID = "@request.body.recordId";
    const IN_MY_ORG = alias => `@request.auth.org != "" && @collection.${alias}.org ?= @request.auth.org`;
    const OWNS_QUOTE = alias =>
      `(${IN_MY_ORG(alias)} && (${role("admin")} || (${role("sales")} && @collection.${alias}.owner ?= @request.auth.id)))`;

    const CREATE = [
      `(@request.body.target = "accounts" && ${role("admin", "sales", "finance")} && ` +
        `@collection.accounts:ca.id ?= ${BODY_ID} && ${IN_MY_ORG("accounts:ca")})`,
      `(@request.body.target = "invoices" && ${role("admin", "finance")} && ` +
        `@collection.invoices:ci.id ?= ${BODY_ID} && ${IN_MY_ORG("invoices:ci")})`,
      `(@request.body.target = "quotes" && @collection.quotes:cq.id ?= ${BODY_ID} && ${OWNS_QUOTE("quotes:cq")})`,
      `(@request.body.target = "approvals" && @collection.quotes:cp.id ?= ${BODY_ID} && ` +
        `(${OWNS_QUOTE("quotes:cp")} || @collection.quotes:cp.approvers.id ?= @request.auth.id))`,
    ].join(" || ");

    /* ------------------------------- delete -------------------------------- */

    // An approver outside the organization may take back what they uploaded.
    const DELETE = `(${IN_ORG} && ${role("admin")}) || owner = @request.auth.id`;

    const attachments = new Collection({
      name: "sys_attachment",
      type: "base",
      listRule: READ,
      viewRule: READ,
      createRule: `@request.auth.id != "" && (${CREATE})`,
      updateRule: null,
      deleteRule: `@request.auth.id != "" && (${DELETE})`,
      fields: [
        {
          type: "text",
          name: "id",
          system: true,
          primaryKey: true,
          required: true,
          min: 3,
          max: 40,
          pattern: "^[a-z0-9_]+$",
          autogeneratePattern: "[a-z0-9]{15}",
        },
        {
          type: "relation",
          name: "owner",
          required: false,
          maxSelect: 1,
          collectionId: users.id,
          cascadeDelete: false,
        },
        {
          type: "relation",
          name: "org",
          required: false,
          maxSelect: 1,
          collectionId: organizations.id,
          cascadeDelete: true,
        },
        { type: "select", name: "target", required: true, maxSelect: 1, values: ["accounts", "quotes", "invoices", "approvals"] },
        // Not a relation: it names a record in whichever collection `target` says.
        { type: "text", name: "recordId", required: true, min: 1, max: 40, pattern: "^[a-z0-9_]+$" },
        {
          type: "file",
          name: "file",
          required: true,
          maxSelect: 1,
          // MAX_ATTACHMENT_BYTES in src/lib/attachments.ts.
          maxSize: 25 * 1024 * 1024,
          // A file token is needed to fetch it, and the view rule decides who gets one.
          protected: true,
          mimeTypes: [],
          thumbs: [],
        },
        // The name it was uploaded with; the stored filename has a random suffix.
        { type: "text", name: "name", required: false, max: 200 },
        { type: "number", name: "size", required: false, min: 0, onlyInt: true },
        { type: "text", name: "mimeType", required: false, max: 200 },
        { type: "text", name: "note", required: false, max: 500 },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX `idx_sys_attachment_record` ON `sys_attachment` (`recordId`, `target`)",
        "CREATE INDEX `idx_sys_attachment_org` ON `sys_attachment` (`org`)",
      ],
    });

    app.save(attachments);
  },
  app => {
    app.delete(app.findCollectionByNameOrId("sys_attachment"));
  },
);
