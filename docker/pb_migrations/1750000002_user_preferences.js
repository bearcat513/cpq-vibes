/// <reference path="../pb_data/types.d.ts" />

/**
 * Per-account preferences.
 *
 * One JSON field on the account's own record, rather than a collection of its
 * own: a preference set belongs to exactly one account, is read on every page
 * load alongside the session, and dies with the account. The `users` rules
 * from the previous migration already say an account may only read and update
 * itself, so this field inherits exactly the access it should have and adds no
 * rule of its own.
 *
 * `required: false`: every account that existed before this migration has no
 * preferences, and the app answers for them with the defaults
 * (`normalizePreferences` in src/lib/preferences.ts). The size cap is far more
 * than the handful of scalars the app stores, and is what stops the field
 * being used as free storage — anyone can register, and an account may write
 * its own record.
 */
migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");

    users.fields.add(
      new Field({
        type: "json",
        name: "preferences",
        required: false,
        maxSize: 8192,
      }),
    );

    app.save(users);
  },
  app => {
    const users = app.findCollectionByNameOrId("users");
    if (users.fields.getByName("preferences")) users.fields.removeByName("preferences");
    app.save(users);
  },
);
