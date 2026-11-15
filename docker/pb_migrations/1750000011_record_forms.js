/// <reference path="../pb_data/types.d.ts" />

/**
 * Record forms: how the data table's record form is laid out, per collection.
 *
 * One record per collection per organization. `layout` is JSON — sections of
 * fields, each with a widget, a label and its bounds — read and checked by
 * `readFormLayout` in src/lib/recordForm.ts, which is also where the shape is
 * documented. A collection with no record here gets a layout built from the
 * record's own fields, so nothing has to be configured before the form works.
 *
 * Everybody in the organization reads the layouts, because everybody opens
 * records; only an admin changes them. A layout narrows what the table's
 * record route writes and grants nothing: the target collection's own rules
 * still decide who may change a record.
 *
 * `owner` and `org` are stamped by rules/ownership.js, like every OWNED
 * collection.
 */
migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");
    const organizations = app.findCollectionByNameOrId("organizations");

    const IN_ORG = '@request.auth.org != "" && org = @request.auth.org';
    const MEMBER = '@request.auth.org != ""';
    const ADMIN = '@request.auth.role = "admin"';

    const forms = new Collection({
      name: "record_forms",
      type: "base",
      listRule: IN_ORG,
      viewRule: IN_ORG,
      createRule: `${MEMBER} && ${ADMIN}`,
      updateRule: `${IN_ORG} && ${ADMIN}`,
      deleteRule: `${IN_ORG} && ${ADMIN}`,
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
        // The collection this lays out — any name, since the table opens any.
        { type: "text", name: "collection", required: true, min: 1, max: 100, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        { type: "text", name: "title", required: false, max: 200 },
        { type: "text", name: "description", required: false, max: 1000 },
        { type: "json", name: "layout", required: false, maxSize: 65536 },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        // One layout per collection per organization: which one to draw is never a choice.
        "CREATE UNIQUE INDEX `idx_record_forms_org_collection` ON `record_forms` (`org`, `collection`)",
      ],
    });

    app.save(forms);
  },
  app => {
    app.delete(app.findCollectionByNameOrId("record_forms"));
  },
);
