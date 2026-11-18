/// <reference path="../pb_data/types.d.ts" />

/**
 * The record workspace: `record_forms` gains a `workspace` JSON field beside
 * `layout`, holding the related-list tabs and the record summary that `/table`
 * opens a record into. Its shape is `WorkspaceLayout` in src/lib/workspace.ts,
 * which is also where it is checked before it is saved.
 *
 * On the same row rather than a collection of its own because it is the same
 * thing — how one collection's records are laid out, per organization — with
 * the same audience (everybody reads) and the same writers (admins). Empty
 * means the built-in default for that collection.
 */
migrate(
  app => {
    const forms = app.findCollectionByNameOrId("record_forms");
    forms.fields.add(new Field({ type: "json", name: "workspace", required: false, maxSize: 131072 }));
    app.save(forms);
  },
  app => {
    const forms = app.findCollectionByNameOrId("record_forms");
    forms.fields.removeByName("workspace");
    app.save(forms);
  },
);
