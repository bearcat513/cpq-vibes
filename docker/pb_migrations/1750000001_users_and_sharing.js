/// <reference path="../pb_data/types.d.ts" />

/**
 * Accounts, ownership and sharing.
 *
 * Before this, the app was single-tenant: one superuser held everything. Now
 * every record belongs to the user who created it, and configurations and
 * script templates can additionally be shared, read-only, with other accounts.
 *
 * The rules below are the whole access-control story. They are evaluated by
 * PocketBase against the caller's own token, so a bug in the Bun server cannot
 * hand one account another's data — the server carries no authority of its
 * own any more.
 *
 * `owner` is deliberately not `required`: records created before this
 * migration have none, and a required field would make them unsavable. They
 * are invisible to every rule below until the first account claims them
 * (pb_hooks/setup/adopt.js). Everything created from here on gets an owner
 * from pb_hooks/rules/ownership.js, which ignores whatever the request body
 * claims.
 */
migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");

    // Anyone may register; nobody may browse the user list or read another
    // account. Sharing resolves an address through a hook instead, so an email
    // never has to be enumerable to be shareable.
    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    users.createRule = "";
    users.updateRule = "id = @request.auth.id";
    users.deleteRule = "id = @request.auth.id";
    app.save(users);

    const ownerField = () =>
      new Field({
        type: "relation",
        name: "owner",
        required: false,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: true, // closing an account takes its data with it
      });

    /** Read-only recipients. Maintained only by pb_hooks/lib/sharing.js. */
    const sharedWithField = () =>
      new Field({
        type: "relation",
        name: "sharedWith",
        required: false,
        maxSelect: 50,
        collectionId: users.id,
        cascadeDelete: false, // a deleted account drops off the list
      });

    const MINE = "owner = @request.auth.id";
    // `?=` is "any of": sharedWith holds many ids and one of them must match.
    const MINE_OR_SHARED = `${MINE} || sharedWith.id ?= @request.auth.id`;
    const SIGNED_IN = '@request.auth.id != ""';

    // Shared records are readable, never writable: update and delete stay with
    // the owner. A recipient who wants to change one saves their own copy.
    for (const name of ["configs", "script_templates"]) {
      const collection = app.findCollectionByNameOrId(name);
      collection.fields.add(ownerField(), sharedWithField());
      collection.listRule = MINE_OR_SHARED;
      collection.viewRule = MINE_OR_SHARED;
      collection.createRule = SIGNED_IN;
      collection.updateRule = MINE;
      collection.deleteRule = MINE;
      collection.indexes = [
        ...collection.indexes,
        `CREATE INDEX \`idx_${name}_owner\` ON \`${name}\` (\`owner\`)`,
      ];
      app.save(collection);
    }

    // Generated data is private, including data generated from a configuration
    // someone shared with you: the rows are yours, not theirs.
    const datasets = app.findCollectionByNameOrId("datasets");
    datasets.fields.add(ownerField());
    datasets.listRule = MINE;
    datasets.viewRule = MINE;
    datasets.createRule = SIGNED_IN;
    datasets.updateRule = MINE;
    datasets.deleteRule = MINE;
    datasets.indexes = [
      ...datasets.indexes,
      "CREATE INDEX `idx_datasets_owner_created` ON `datasets` (`owner`, `created`)",
    ];
    app.save(datasets);
  },
  app => {
    // Back to superuser-only, with the ownership fields dropped.
    for (const name of ["configs", "script_templates", "datasets"]) {
      const collection = app.findCollectionByNameOrId(name);
      for (const field of ["owner", "sharedWith"]) {
        if (collection.fields.getByName(field)) collection.fields.removeByName(field);
      }
      collection.indexes = collection.indexes.filter(index => !index.includes("_owner"));
      collection.listRule = null;
      collection.viewRule = null;
      collection.createRule = null;
      collection.updateRule = null;
      collection.deleteRule = null;
      app.save(collection);
    }
  },
);
