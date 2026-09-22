/// <reference path="../pb_data/types.d.ts" />

/**
 * API keys: a long-lived credential for scripts, kept as a hash.
 *
 * A session token expires in a week and lives in a cookie, which is right for
 * a browser and useless for the nightly job that raises invoices. A key is a
 * second way to prove who you are, and because the middleware in
 * pb_hooks/keys/ turns one into the same `@request.auth` a token produces,
 * every rule written in the migrations before this applies to it unchanged —
 * a key reaches exactly what its owner reaches, and nothing else. There is no
 * second access model to keep in step.
 *
 * Only the SHA-256 of a key is stored, and the field is hidden, so the raw
 * value exists in one response and nowhere else. A database that leaks hands
 * over nothing usable. SHA-256 rather than bcrypt is deliberate: these are 40
 * random characters from the server's own CSPRNG, not a human-chosen
 * password, so there is no dictionary to slow an attacker down with and no
 * reason to pay a KDF's cost on every request.
 *
 * `create` and `update` are locked to superusers. Issuing a key has to hash it
 * and hand the raw value back exactly once, which no client can be trusted to
 * do — POST /api/cpq/keys does it instead. `list`, `view` and `delete` are the
 * owner's, so revoking is deleting the record.
 */
migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");

    /** App-supplied id: `key_<hex>`, matching every other collection here. */
    const idField = {
      type: "text",
      name: "id",
      system: true,
      primaryKey: true,
      required: true,
      min: 3,
      max: 40,
      pattern: "^[a-z0-9_]+$",
      autogeneratePattern: "[a-z0-9]{15}",
    };

    const keys = new Collection({
      name: "api_keys",
      type: "base",
      listRule: "user = @request.auth.id",
      viewRule: "user = @request.auth.id",
      createRule: null,
      updateRule: null,
      deleteRule: "user = @request.auth.id",
      fields: [
        idField,
        {
          type: "relation",
          name: "user",
          required: true,
          maxSelect: 1,
          collectionId: users.id,
          cascadeDelete: true, // closing an account revokes its keys
        },
        { type: "text", name: "name", required: false, max: 100 },
        // Hidden, so it is never returned by the collection API even to its
        // owner. 64 hex characters is exactly one SHA-256.
        { type: "text", name: "key_hash", required: true, hidden: true, min: 64, max: 64 },
        { type: "date", name: "expires", required: false },
        { type: "date", name: "lastUsed", required: false },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      ],
      indexes: [
        // Unique: two keys can never hash to one record, and the lookup on
        // every API-key request is an index hit rather than a scan.
        "CREATE UNIQUE INDEX `idx_api_keys_hash` ON `api_keys` (`key_hash`)",
        "CREATE INDEX `idx_api_keys_user` ON `api_keys` (`user`)",
      ],
    });

    app.save(keys);
  },
  app => {
    app.delete(app.findCollectionByNameOrId("api_keys"));
  },
);
