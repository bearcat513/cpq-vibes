/// <reference path="../pb_data/types.d.ts" />

/**
 * Accounts, normalized: `details` comes apart.
 *
 * An account used to be four columns and one JSON blob holding everything
 * else — its people, its two addresses, its terms. That blob goes:
 *
 * - **The scalars become columns** on `accounts`: industry, website, status,
 *   tags, paymentTerms, paymentTermDays, creditLimit, defaultDiscountPercent,
 *   taxExempt, taxPercent, notes. Each is now filterable, sortable and
 *   editable in the record form like any other field.
 * - **The people become `contacts`**, one record each with a required
 *   `account` relation (cascade: a contact belongs to exactly one account).
 *   It is an *auth* collection with every way of signing in switched off —
 *   `authRule` is null, which PocketBase reads as "nobody". That is
 *   deliberate: a contact carries `org`, and every rule here reads
 *   `@request.auth.org`, so a contact holding a token would read its
 *   vendor's whole organization. A customer portal is possible later, and
 *   needs every rule to check `@request.auth.collectionName = "users"` first.
 *   For the same reason the address a contact is written to lives in its
 *   own `contactEmail` field: the built-in `email` is unique across every
 *   organization and hidden from other users, so it stays blank until
 *   somebody is invited to sign in.
 * - **The addresses become `sys_physical_location`** records, which
 *   `accounts.billingAddress` and `accounts.shippingAddress` point at.
 *   "Ship to the billing address" is no longer a flag: both relations name
 *   the same record. A location's `name` is every non-blank part joined into
 *   one line, set by pb_hooks/rules/locations.js on every save — never by a
 *   request.
 *
 * `contactEmail` on accounts goes too: it was a copy of the primary
 * contact's address, and the primary contact is now a record of its own.
 *
 * The data moves in SQL, for the reason in 1750000004: a JSON field reaches
 * the JSVM as a byte array. Each statement is exported as a constant and run
 * against a throwaway database by src/server/migration.test.ts, and each is
 * idempotent. Record ids are derived from the account's, so a re-run finds
 * the rows it already wrote and the statements can link what they insert.
 *
 * Contact ids are minted (`con_<account id>_<position>`), not copied: the
 * embedded ids were only unique within one account — every org that
 * installed the sample has a `con_harbour_dana`.
 *
 * Also switches on PocketBase's batch API: the server saves an account, its
 * locations and its contacts in one transaction.
 */

/**
 * A billing location for every account whose details carry one. Its `name`
 * is every non-blank part joined with ", " — `locationName` in
 * src/lib/locations.ts and pb_hooks/rules/locations.js do the same.
 */
const INSERT_BILLING = "INSERT INTO sys_physical_location (id, owner, org, name, line1, line2, city, state, postalCode, country, created, updated) SELECT 'loc_b_' || a.id, coalesce(a.owner, ''), coalesce(a.org, ''), substr((CASE WHEN trim(coalesce(json_extract(a.details, '$.billingAddress.line1'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.billingAddress.line1')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.billingAddress.line2'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.billingAddress.line2')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.billingAddress.city'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.billingAddress.city')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.billingAddress.state'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.billingAddress.state')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.billingAddress.postalCode'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.billingAddress.postalCode')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.billingAddress.country'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.billingAddress.country')) ELSE '' END), 3), trim(coalesce(json_extract(a.details, '$.billingAddress.line1'), '')), trim(coalesce(json_extract(a.details, '$.billingAddress.line2'), '')), trim(coalesce(json_extract(a.details, '$.billingAddress.city'), '')), trim(coalesce(json_extract(a.details, '$.billingAddress.state'), '')), trim(coalesce(json_extract(a.details, '$.billingAddress.postalCode'), '')), trim(coalesce(json_extract(a.details, '$.billingAddress.country'), '')), a.created, a.updated FROM accounts a WHERE json_valid(a.details) AND json_type(a.details, '$.billingAddress') = 'object' AND (trim(coalesce(json_extract(a.details, '$.billingAddress.line1'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.billingAddress.line2'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.billingAddress.city'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.billingAddress.state'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.billingAddress.postalCode'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.billingAddress.country'), '')) <> '') AND NOT EXISTS (SELECT 1 FROM sys_physical_location l WHERE l.id = 'loc_b_' || a.id)";

/** A shipping location, only where the account ships somewhere other than where it is billed. */
const INSERT_SHIPPING = "INSERT INTO sys_physical_location (id, owner, org, name, line1, line2, city, state, postalCode, country, created, updated) SELECT 'loc_s_' || a.id, coalesce(a.owner, ''), coalesce(a.org, ''), substr((CASE WHEN trim(coalesce(json_extract(a.details, '$.shippingAddress.line1'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.shippingAddress.line1')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.shippingAddress.line2'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.shippingAddress.line2')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.shippingAddress.city'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.shippingAddress.city')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.shippingAddress.state'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.shippingAddress.state')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.shippingAddress.postalCode'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.shippingAddress.postalCode')) ELSE '' END) || (CASE WHEN trim(coalesce(json_extract(a.details, '$.shippingAddress.country'), '')) <> '' THEN ', ' || trim(json_extract(a.details, '$.shippingAddress.country')) ELSE '' END), 3), trim(coalesce(json_extract(a.details, '$.shippingAddress.line1'), '')), trim(coalesce(json_extract(a.details, '$.shippingAddress.line2'), '')), trim(coalesce(json_extract(a.details, '$.shippingAddress.city'), '')), trim(coalesce(json_extract(a.details, '$.shippingAddress.state'), '')), trim(coalesce(json_extract(a.details, '$.shippingAddress.postalCode'), '')), trim(coalesce(json_extract(a.details, '$.shippingAddress.country'), '')), a.created, a.updated FROM accounts a WHERE json_valid(a.details) AND json_type(a.details, '$.shippingAddress') = 'object' AND json_extract(a.details, '$.shippingSameAsBilling') = 0 AND (trim(coalesce(json_extract(a.details, '$.shippingAddress.line1'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.shippingAddress.line2'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.shippingAddress.city'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.shippingAddress.state'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.shippingAddress.postalCode'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.shippingAddress.country'), '')) <> '') AND NOT EXISTS (SELECT 1 FROM sys_physical_location l WHERE l.id = 'loc_s_' || a.id)";

/** Every scalar out of details into its column, and the two relations pointed at what the inserts above wrote. */
const COPY_COLUMNS = "UPDATE accounts SET industry = coalesce(json_extract(details, '$.industry'), ''), website = coalesce(json_extract(details, '$.website'), ''), status = CASE WHEN json_extract(details, '$.status') IN ('prospect', 'customer', 'inactive') THEN json_extract(details, '$.status') ELSE 'prospect' END, tags = CASE WHEN json_type(details, '$.tags') = 'array' THEN json_extract(details, '$.tags') ELSE '[]' END, paymentTerms = coalesce(json_extract(details, '$.paymentTerms'), ''), paymentTermDays = CASE WHEN json_type(details, '$.paymentTermDays') IN ('integer', 'real') THEN json_extract(details, '$.paymentTermDays') WHEN ltrim(lower(coalesce(json_extract(details, '$.paymentTerms'), '')), 'abcdefghijklmnopqrstuvwxyz -') GLOB '[0-9]*' THEN CAST(ltrim(lower(json_extract(details, '$.paymentTerms')), 'abcdefghijklmnopqrstuvwxyz -') AS INTEGER) ELSE 30 END, creditLimit = coalesce(json_extract(details, '$.creditLimit'), 0), defaultDiscountPercent = coalesce(json_extract(details, '$.defaultDiscountPercent'), 0), taxExempt = CASE WHEN json_extract(details, '$.taxExempt') = 1 THEN 1 ELSE 0 END, taxPercent = coalesce(json_extract(details, '$.taxPercent'), 0), notes = coalesce(json_extract(details, '$.notes'), ''), billingAddress = CASE WHEN EXISTS (SELECT 1 FROM sys_physical_location l WHERE l.id = 'loc_b_' || accounts.id) THEN 'loc_b_' || accounts.id ELSE '' END, shippingAddress = CASE WHEN EXISTS (SELECT 1 FROM sys_physical_location l WHERE l.id = 'loc_s_' || accounts.id) THEN 'loc_s_' || accounts.id WHEN EXISTS (SELECT 1 FROM sys_physical_location l WHERE l.id = 'loc_b_' || accounts.id) AND coalesce(json_extract(details, '$.shippingSameAsBilling'), 1) <> 0 THEN 'loc_b_' || accounts.id ELSE '' END WHERE json_valid(details)";

/**
 * Every embedded contact as a record. `tokenKey` is random and `password`
 * blank: neither can sign anybody in while the collection's authRule is null,
 * and the migration sets a random password hash afterwards so a later edit
 * passes validation.
 */
const INSERT_CONTACTS = "INSERT INTO contacts (id, account, owner, org, name, title, contactEmail, phone, role, \"primary\", position, email, emailVisibility, verified, password, tokenKey, created, updated) SELECT 'con_' || a.id || '_' || entry.key, a.id, coalesce(a.owner, ''), coalesce(a.org, ''), trim(coalesce(json_extract(entry.value, '$.name'), '')), trim(coalesce(json_extract(entry.value, '$.title'), '')), lower(trim(coalesce(json_extract(entry.value, '$.email'), ''))), trim(coalesce(json_extract(entry.value, '$.phone'), '')), CASE WHEN json_extract(entry.value, '$.role') IN ('commercial', 'billing', 'technical', 'signatory', 'other') THEN json_extract(entry.value, '$.role') ELSE 'commercial' END, CASE WHEN json_extract(entry.value, '$.primary') = 1 THEN 1 ELSE 0 END, entry.key, '', 0, 0, '', lower(hex(randomblob(25))), a.created, a.updated FROM accounts a, json_each(CASE WHEN json_valid(a.details) AND json_type(a.details, '$.contacts') = 'array' THEN json_extract(a.details, '$.contacts') ELSE '[]' END) entry WHERE json_type(entry.value) = 'object' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = 'con_' || a.id || '_' || entry.key)";

/**
 * A record from before the contact list: one contact out of `contactName`,
 * the `contactEmail` column and `contactPhone`. The `coalesce` matters — such
 * a record has no `$.contacts`, `json_type` is NULL, and `NOT (… AND NULL)`
 * is NULL rather than true, which would skip exactly the rows this is for.
 */
const INSERT_LEGACY_CONTACTS = "INSERT INTO contacts (id, account, owner, org, name, title, contactEmail, phone, role, \"primary\", position, email, emailVisibility, verified, password, tokenKey, created, updated) SELECT 'con_' || a.id || '_0', a.id, coalesce(a.owner, ''), coalesce(a.org, ''), trim(coalesce(json_extract(a.details, '$.contactName'), '')), '', lower(trim(coalesce(a.contactEmail, ''))), trim(coalesce(json_extract(a.details, '$.contactPhone'), '')), 'commercial', 1, 0, '', 0, 0, '', lower(hex(randomblob(25))), a.created, a.updated FROM accounts a WHERE NOT (json_valid(a.details) AND coalesce(json_type(a.details, '$.contacts'), '') = 'array') AND (trim(coalesce(a.contactEmail, '')) <> '' OR (json_valid(a.details) AND (trim(coalesce(json_extract(a.details, '$.contactName'), '')) <> '' OR trim(coalesce(json_extract(a.details, '$.contactPhone'), '')) <> ''))) AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = 'con_' || a.id || '_0')";

/** Exactly one primary per account with any contacts: the first flagged, else the first. */
const ONE_PRIMARY = "UPDATE contacts SET \"primary\" = CASE WHEN id = (SELECT c.id FROM contacts c WHERE c.account = contacts.account ORDER BY c.\"primary\" DESC, c.position, c.id LIMIT 1) THEN 1 ELSE 0 END";

/** Down: the blob, rebuilt from the columns, the locations and the contacts. */
const REBUILD_DETAILS = "UPDATE accounts SET contactEmail = coalesce((SELECT c.contactEmail FROM contacts c WHERE c.account = accounts.id ORDER BY c.\"primary\" DESC, c.created LIMIT 1), ''), details = json_object('industry', industry, 'website', website, 'status', status, 'tags', json(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END), 'contacts', json(coalesce((SELECT json_group_array(json_object('id', c.id, 'name', c.name, 'title', c.title, 'email', c.contactEmail, 'phone', c.phone, 'role', c.role, 'primary', json(CASE WHEN c.\"primary\" THEN 'true' ELSE 'false' END))) FROM (SELECT * FROM contacts WHERE account = accounts.id ORDER BY position, id) c), '[]')), 'billingAddress', json(coalesce((SELECT json_object('line1', l.line1, 'line2', l.line2, 'city', l.city, 'state', l.state, 'postalCode', l.postalCode, 'country', l.country) FROM sys_physical_location l WHERE l.id = accounts.billingAddress), '{\"line1\":\"\",\"line2\":\"\",\"city\":\"\",\"state\":\"\",\"postalCode\":\"\",\"country\":\"\"}')), 'shippingAddress', json(coalesce((SELECT json_object('line1', l.line1, 'line2', l.line2, 'city', l.city, 'state', l.state, 'postalCode', l.postalCode, 'country', l.country) FROM sys_physical_location l WHERE l.id = coalesce(nullif(accounts.shippingAddress, ''), accounts.billingAddress)), '{\"line1\":\"\",\"line2\":\"\",\"city\":\"\",\"state\":\"\",\"postalCode\":\"\",\"country\":\"\"}')), 'shippingSameAsBilling', json(CASE WHEN coalesce(shippingAddress, '') = '' OR shippingAddress = billingAddress THEN 'true' ELSE 'false' END), 'paymentTerms', paymentTerms, 'paymentTermDays', paymentTermDays, 'creditLimit', creditLimit, 'defaultDiscountPercent', defaultDiscountPercent, 'taxExempt', json(CASE WHEN taxExempt THEN 'true' ELSE 'false' END), 'taxPercent', taxPercent, 'notes', notes)";

migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");
    const organizations = app.findCollectionByNameOrId("organizations");
    const accounts = app.findCollectionByNameOrId("accounts");

    const IN_ORG = '@request.auth.org != "" && org = @request.auth.org';
    const MEMBER = '@request.auth.org != ""';
    const role = (...roles) => "(" + roles.map(name => `@request.auth.role = "${name}"`).join(" || ") + ")";
    // Who may change an account may change its people and its addresses —
    // the same table as `accounts` in 1750000010.
    const WRITERS = role("admin", "sales", "finance");
    const DELETERS = role("admin", "sales", "finance");

    const idField = {
      type: "text",
      name: "id",
      system: true,
      primaryKey: true,
      required: true,
      min: 3,
      max: 60,
      pattern: "^[a-z0-9_]+$",
      autogeneratePattern: "[a-z0-9]{15}",
    };
    const owner = () => ({ type: "relation", name: "owner", required: false, maxSelect: 1, collectionId: users.id, cascadeDelete: false });
    const org = () => ({ type: "relation", name: "org", required: false, maxSelect: 1, collectionId: organizations.id, cascadeDelete: true });
    const created = { type: "autodate", name: "created", onCreate: true, onUpdate: false };
    const updated = { type: "autodate", name: "updated", onCreate: true, onUpdate: true };

    /* ------------------------- sys_physical_location ------------------------- */

    const locations = new Collection({
      name: "sys_physical_location",
      type: "base",
      listRule: IN_ORG,
      viewRule: IN_ORG,
      createRule: `${MEMBER} && ${WRITERS}`,
      updateRule: `${IN_ORG} && ${WRITERS}`,
      deleteRule: `${IN_ORG} && ${DELETERS}`,
      fields: [
        idField,
        owner(),
        org(),
        // The parts below in one line. Set by pb_hooks/rules/locations.js.
        { type: "text", name: "name", required: false, max: 1000 },
        { type: "text", name: "line1", required: false, max: 200 },
        { type: "text", name: "line2", required: false, max: 200 },
        { type: "text", name: "city", required: false, max: 120 },
        { type: "text", name: "state", required: false, max: 120 },
        { type: "text", name: "postalCode", required: false, max: 40 },
        { type: "text", name: "country", required: false, max: 120 },
        created,
        updated,
      ],
      indexes: ["CREATE INDEX `idx_sys_physical_location_org` ON `sys_physical_location` (`org`)"],
    });
    app.save(locations);

    /* --------------------------------- contacts ------------------------------ */

    const contacts = new Collection({
      name: "contacts",
      type: "auth",
      listRule: IN_ORG,
      viewRule: IN_ORG,
      // The account has to be one of yours, on the way in and after any edit.
      createRule: `${MEMBER} && ${WRITERS} && account.org = @request.auth.org`,
      updateRule: `${IN_ORG} && ${WRITERS} && account.org = @request.auth.org`,
      deleteRule: `${IN_ORG} && ${DELETERS}`,
      // Null: nobody authenticates as a contact, by any method. See above.
      authRule: null,
      manageRule: null,
      passwordAuth: { enabled: false, identityFields: ["email"] },
      oauth2: { enabled: false },
      otp: { enabled: false },
      mfa: { enabled: false },
      fields: [
        idField,
        // Blank until somebody is invited to sign in; unique across every org when set.
        { type: "email", name: "email", system: true, required: false },
        { type: "relation", name: "account", required: true, maxSelect: 1, collectionId: accounts.id, cascadeDelete: true },
        owner(),
        org(),
        { type: "text", name: "name", required: false, max: 200 },
        { type: "text", name: "title", required: false, max: 200 },
        // Where to write to them. Not the auth `email`, which is unique across every org.
        { type: "email", name: "contactEmail", required: false },
        { type: "text", name: "phone", required: false, max: 60 },
        { type: "select", name: "role", required: false, maxSelect: 1, values: ["commercial", "billing", "technical", "signatory", "other"] },
        // Who a quote is addressed to: one per account, kept so by the server.
        { type: "bool", name: "primary", required: false },
        // Where they sit in the account's list, which is the order people put them in.
        { type: "number", name: "position", required: false, min: 0, onlyInt: true },
        created,
        updated,
      ],
      indexes: ["CREATE INDEX `idx_contacts_account` ON `contacts` (`account`)", "CREATE INDEX `idx_contacts_org` ON `contacts` (`org`)"],
    });
    app.save(contacts);

    /* --------------------------------- accounts ------------------------------ */

    const fields = [
      new TextField({ name: "industry", max: 200 }),
      new TextField({ name: "website", max: 500 }),
      new SelectField({ name: "status", maxSelect: 1, values: ["prospect", "customer", "inactive"] }),
      new JSONField({ name: "tags", maxSize: 10000 }),
      new TextField({ name: "paymentTerms", max: 200 }),
      new NumberField({ name: "paymentTermDays", min: 0, max: 365, onlyInt: true }),
      new NumberField({ name: "creditLimit", min: 0 }),
      new NumberField({ name: "defaultDiscountPercent", min: 0, max: 100 }),
      new BoolField({ name: "taxExempt" }),
      new NumberField({ name: "taxPercent", min: 0, max: 100 }),
      new TextField({ name: "notes", max: 5000 }),
      new RelationField({ name: "billingAddress", maxSelect: 1, collectionId: locations.id, cascadeDelete: false }),
      new RelationField({ name: "shippingAddress", maxSelect: 1, collectionId: locations.id, cascadeDelete: false }),
    ];
    fields.forEach(field => accounts.fields.add(field));
    app.save(accounts);

    for (const sql of [INSERT_BILLING, INSERT_SHIPPING, COPY_COLUMNS, INSERT_CONTACTS, INSERT_LEGACY_CONTACTS, ONE_PRIMARY]) {
      app.db().newQuery(sql).execute();
    }

    // A real hash, so a later edit of a migrated contact passes validation.
    // Nobody knows it, and nobody may sign in as a contact anyway.
    app.findAllRecords("contacts").forEach(contact => {
      if (contact.getString("password")) return;
      contact.setPassword($security.randomString(40));
      app.saveNoValidate(contact);
    });

    const after = app.findCollectionByNameOrId("accounts");
    after.fields.removeByName("details");
    after.fields.removeByName("contactEmail");
    app.save(after);

    const settings = app.settings();
    settings.batch.enabled = true;
    settings.batch.maxRequests = Math.max(settings.batch.maxRequests || 0, 100);
    app.save(settings);
  },
  app => {
    const accounts = app.findCollectionByNameOrId("accounts");
    accounts.fields.add(new JSONField({ name: "details", maxSize: 65536 }));
    accounts.fields.add(new TextField({ name: "contactEmail", max: 200 }));
    app.save(accounts);

    app.db().newQuery(REBUILD_DETAILS).execute();

    const after = app.findCollectionByNameOrId("accounts");
    for (const name of ["industry", "website", "status", "tags", "paymentTerms", "paymentTermDays", "creditLimit", "defaultDiscountPercent", "taxExempt", "taxPercent", "notes", "billingAddress", "shippingAddress"]) {
      after.fields.removeByName(name);
    }
    app.save(after);

    app.delete(app.findCollectionByNameOrId("contacts"));
    app.delete(app.findCollectionByNameOrId("sys_physical_location"));
  },
);
