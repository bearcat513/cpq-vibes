/// <reference path="../pb_data/types.d.ts" />

/**
 * Organizations and roles.
 *
 * Until now every account was an island: its own catalogue, its own price
 * books, its own approval ladder, and a share list for passing single records
 * across. A sales team cannot work like that. The catalogue and the commercial
 * policy have to be one set, owned by the company, edited by a few people and
 * quoted from by everyone — so records now belong to an **organization**, and
 * what a member may do with them is decided by their **role** in it.
 *
 * ## The model
 *
 *   organizations   name, and `settings` (the time zone "today" is read in)
 *   memberships     (org, user, role) — one row per person per organization
 *   invitations     (org, email, role) — a membership waiting for its account
 *   users.org       the organization this account is working in right now
 *   users.role      its role there, denormalised from the membership
 *
 * `users.org` and `users.role` are what the rules below read, as
 * `@request.auth.org` and `@request.auth.role`. A rule that had to find "a
 * membership of this record's org whose user is me *and* whose role is admin"
 * would need two conditions to match the *same* membership row, which
 * PocketBase's `?=` does not promise. A single denormalised pair on the caller
 * makes every rule a plain comparison. The price is that the pair must never be
 * writable from a request — pb_hooks/setup/members.js restores both on every
 * update and clears both on create — and must follow the membership, which
 * pb_hooks/lib/orgs.js does whenever a role changes or a member leaves.
 *
 * ## Roles
 *
 *   admin     everything, including members, the catalogue, policy and templates
 *   sales     customers, and their own quotes; reads everything else
 *   finance   customers, invoices, payments and credits; reads everything else
 *   viewer    reads everything, writes nothing
 *
 * Approving is not a role. Being named by an approval rule is what lets
 * somebody decide a quote — the `approvers` relation, unchanged — so a viewer
 * can sign off a discount without being able to edit anything, and an approver
 * outside the organization still sees that one quote and nothing else.
 * `src/lib/organization.ts` holds the same table as `PERMISSIONS`, and the
 * API tests walk it against these rules.
 *
 * ## What moves
 *
 * Every existing account gets a one-person organization of its own, as its
 * admin, and every record it owns is stamped with that organization — so
 * nothing anyone could see before becomes visible to anyone else. All of it is
 * SQL rather than a loop over records, for the reason spelled out in
 * 1750000004, and every statement is a constant that
 * src/server/migration.test.ts runs against a throwaway database.
 *
 * Three fixes ride along because they need the same columns:
 *
 * - **Numbers come from a counter**, per organization, kind and year, instead
 *   of counting the records the caller can see — which counted quotes shared
 *   with them and quotes they were approving, and fell back on top of numbers
 *   already used when a share was revoked. Counters are seeded from the
 *   highest number each organization has used, so nothing collides.
 * - **An invoice is numbered when it is issued**, not when its draft is
 *   created, so discarding a draft can no longer leave a hole in the issued
 *   run. Existing drafts give their number back and read `DRAFT-<id>`.
 * - **A revised quote points at its revision** (`supersededBy`), which is what
 *   stops the old version being accepted or invoiced beside the new one. It is
 *   a relation rather than a status so that deleting the revision — a draft
 *   nobody wanted — unsets it and brings the original back by itself.
 *
 * `owner` stops cascading. It used to delete a closing account's records with
 * it, which in a team deletes a departing rep's pipeline; now the records stay
 * with the organization and the owner reference is simply cleared.
 */

/** Every collection whose records belong to an organization. */
const OWNED = [
  "accounts",
  "products",
  "price_books",
  "pricing_rules",
  "approval_rules",
  "proposal_templates",
  "quotes",
  "invoices",
  "payments",
  "credits",
];

/* ------------------------------- backfills -------------------------------- */

/*
 * Each existing account becomes the admin of an organization of its own. The
 * ids are derived from the account's — `org_<user id>` — so the three
 * statements agree without a lookup table, and re-running them is a no-op.
 */
const CREATE_PERSONAL_ORGS = "INSERT INTO organizations (id, name, settings, created, updated) SELECT 'org_' || lower(u.id), CASE WHEN trim(coalesce(u.name, '')) <> '' THEN trim(u.name) || '''s workspace' ELSE coalesce(nullif(trim(u.email), ''), 'Workspace') END, '{}', strftime('%Y-%m-%d %H:%M:%fZ', 'now'), strftime('%Y-%m-%d %H:%M:%fZ', 'now') FROM users u WHERE coalesce(u.org, '') = '' AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = 'org_' || lower(u.id))";

const CREATE_ADMIN_MEMBERSHIPS = "INSERT INTO memberships (id, org, user, role, created, updated) SELECT 'mem_' || lower(u.id), 'org_' || lower(u.id), u.id, 'admin', strftime('%Y-%m-%d %H:%M:%fZ', 'now'), strftime('%Y-%m-%d %H:%M:%fZ', 'now') FROM users u WHERE coalesce(u.org, '') = '' AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org = 'org_' || lower(u.id) AND m.user = u.id)";

const ASSIGN_PERSONAL_ORGS = "UPDATE users SET org = 'org_' || lower(id), role = 'admin' WHERE coalesce(org, '') = ''";

/**
 * A record joins its owner's organization. `{table}` is substituted per
 * collection. A record with no owner — the pre-accounts leftovers — keeps an
 * empty org, which no rule matches, exactly as an empty owner never did.
 */
const STAMP_OWNER_ORG = "UPDATE {table} SET org = (SELECT u.org FROM users u WHERE u.id = {table}.owner) WHERE coalesce(org, '') = '' AND coalesce(owner, '') <> ''";

/** A payment or credit belongs wherever its invoice does — which is what its rules read anyway. */
const STAMP_LEDGER_ORG = "UPDATE {table} SET org = (SELECT i.org FROM invoices i WHERE i.id = {table}.invoice) WHERE coalesce(org, '') = ''";

/** An API key acts in the organization its owner was in when it was issued. */
const STAMP_KEY_ORG = "UPDATE api_keys SET org = (SELECT u.org FROM users u WHERE u.id = api_keys.user) WHERE coalesce(org, '') = ''";

/** Drafts give their number back: an invoice is numbered when it is issued. */
const RELEASE_DRAFT_NUMBERS = "UPDATE invoices SET number = 'DRAFT-' || id WHERE state = 'draft' AND number NOT LIKE 'DRAFT-%'";

/**
 * Each organization's counters start at the highest number it has already
 * used that year. `CAST` reads the longest leading integer, so a revision's
 * `0007-r2` counts as 7 — the revision reuses its original's number.
 */
const SEED_QUOTE_COUNTERS = "INSERT INTO counters (id, org, kind, year, value, created, updated) SELECT 'cnt_' || lower(hex(randomblob(8))), q.org, 'quote', CAST(substr(q.number, 3, 4) AS INTEGER), max(CAST(substr(q.number, 8) AS INTEGER)), strftime('%Y-%m-%d %H:%M:%fZ', 'now'), strftime('%Y-%m-%d %H:%M:%fZ', 'now') FROM quotes q WHERE coalesce(q.org, '') <> '' AND q.number GLOB 'Q-[0-9][0-9][0-9][0-9]-[0-9]*' AND NOT EXISTS (SELECT 1 FROM counters c WHERE c.org = q.org AND c.kind = 'quote' AND c.year = CAST(substr(q.number, 3, 4) AS INTEGER)) GROUP BY q.org, substr(q.number, 3, 4)";

const SEED_INVOICE_COUNTERS = "INSERT INTO counters (id, org, kind, year, value, created, updated) SELECT 'cnt_' || lower(hex(randomblob(8))), i.org, 'invoice', CAST(substr(i.number, 5, 4) AS INTEGER), max(CAST(substr(i.number, 10) AS INTEGER)), strftime('%Y-%m-%d %H:%M:%fZ', 'now'), strftime('%Y-%m-%d %H:%M:%fZ', 'now') FROM invoices i WHERE coalesce(i.org, '') <> '' AND i.state <> 'draft' AND i.number GLOB 'INV-[0-9][0-9][0-9][0-9]-[0-9]*' AND NOT EXISTS (SELECT 1 FROM counters c WHERE c.org = i.org AND c.kind = 'invoice' AND c.year = CAST(substr(i.number, 5, 4) AS INTEGER)) GROUP BY i.org, substr(i.number, 5, 4)";

/**
 * A quote that has been revised points at its newest revision. An accepted
 * quote is left alone: it is a contract, and revising one used to be allowed,
 * so an accepted original with a revision is history to keep rather than a
 * quote to retire.
 */
const LINK_SUPERSEDED = "UPDATE quotes SET supersededBy = (SELECT r.id FROM quotes r WHERE r.supersedes = quotes.id ORDER BY r.version DESC, r.created DESC LIMIT 1) WHERE coalesce(supersededBy, '') = '' AND status <> 'accepted' AND EXISTS (SELECT 1 FROM quotes r WHERE r.supersedes = quotes.id)";

migrate(
  app => {
    const users = app.findCollectionByNameOrId("users");

    /** App-supplied id, matching every other collection here. */
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
    const created = { type: "autodate", name: "created", onCreate: true, onUpdate: false };
    const updated = { type: "autodate", name: "updated", onCreate: true, onUpdate: true };

    /* ------------------------------ the rules ------------------------------ */

    // `!= ""` first, everywhere: a record with no org and a caller with no org
    // would otherwise compare equal, and an account between organizations
    // would see every orphaned record on the instance.
    const IN_ORG = '@request.auth.org != "" && org = @request.auth.org';
    const MEMBER = '@request.auth.org != ""';
    const role = (...roles) => "(" + roles.map(name => `@request.auth.role = "${name}"`).join(" || ") + ")";
    const SHARED = "sharedWith.id ?= @request.auth.id";
    const APPROVER = "approvers.id ?= @request.auth.id";
    const OWN_QUOTE = `(${role("admin")} || (${role("sales")} && owner = @request.auth.id))`;

    /* --------------------------- organizations ----------------------------- */

    const organizations = new Collection({
      name: "organizations",
      type: "base",
      // Only the one you are working in. The orgs you could switch to come
      // from GET /api/cpq/org, which reads them through your memberships.
      listRule: "id = @request.auth.org",
      viewRule: "id = @request.auth.org",
      createRule: null,
      updateRule: 'id = @request.auth.org && @request.auth.role = "admin"',
      deleteRule: null,
      fields: [
        idField,
        { type: "text", name: "name", required: true, min: 1, max: 200 },
        // { timeZone } — normalised by src/lib/organization.ts on every read.
        { type: "json", name: "settings", required: false, maxSize: 8192 },
        created,
        updated,
      ],
    });
    app.save(organizations);

    const orgRelation = (name, options) =>
      Object.assign(
        { type: "relation", name, required: false, maxSelect: 1, collectionId: organizations.id, cascadeDelete: true },
        options || {},
      );

    const memberships = new Collection({
      name: "memberships",
      type: "base",
      // Your own memberships anywhere (the org switcher), and everyone in the
      // org you are working in (who your colleagues are, and their roles).
      listRule: 'user = @request.auth.id || (@request.auth.org != "" && org = @request.auth.org)',
      viewRule: 'user = @request.auth.id || (@request.auth.org != "" && org = @request.auth.org)',
      // Written only by pb_hooks/lib/orgs.js, which keeps users.role in step.
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        idField,
        orgRelation("org", { required: true }),
        { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
        { type: "text", name: "role", required: true, max: 20 },
        created,
        updated,
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_memberships_org_user` ON `memberships` (`org`, `user`)",
        "CREATE INDEX `idx_memberships_user` ON `memberships` (`user`)",
      ],
    });
    app.save(memberships);

    const invitations = new Collection({
      name: "invitations",
      type: "base",
      listRule: `${MEMBER} && org = @request.auth.org && ${role("admin")}`,
      viewRule: `${MEMBER} && org = @request.auth.org && ${role("admin")}`,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        idField,
        orgRelation("org", { required: true }),
        // Lower-cased on the way in; matched against the address an account
        // registers with.
        { type: "text", name: "email", required: true, min: 3, max: 200 },
        { type: "text", name: "role", required: true, max: 20 },
        { type: "relation", name: "invitedBy", required: false, maxSelect: 1, collectionId: users.id, cascadeDelete: false },
        created,
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_invitations_org_email` ON `invitations` (`org`, `email`)",
        "CREATE INDEX `idx_invitations_email` ON `invitations` (`email`)",
      ],
    });
    app.save(invitations);

    /** Quote and invoice numbers, per organization, kind and year. Hook-only. */
    const counters = new Collection({
      name: "counters",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        idField,
        orgRelation("org", { required: true }),
        { type: "text", name: "kind", required: true, max: 20 },
        { type: "number", name: "year", required: true, onlyInt: true },
        { type: "number", name: "value", required: false, min: 0, onlyInt: true },
        created,
        updated,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_counters_org_kind_year` ON `counters` (`org`, `kind`, `year`)"],
    });
    app.save(counters);

    /**
     * Session tokens that have been signed out. A PocketBase token is a JWT
     * and cannot be recalled, so signing out records its hash here and a
     * middleware refuses it until it would have expired anyway.
     */
    const revoked = new Collection({
      name: "revoked_tokens",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        idField,
        { type: "text", name: "hash", required: true, min: 64, max: 64 },
        { type: "date", name: "expires", required: false },
        created,
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_revoked_tokens_hash` ON `revoked_tokens` (`hash`)",
        "CREATE INDEX `idx_revoked_tokens_expires` ON `revoked_tokens` (`expires`)",
      ],
    });
    app.save(revoked);

    /* ------------------------ the caller's own pair ------------------------ */

    users.fields.add(
      new Field(orgRelation("org", { cascadeDelete: false })),
      new Field({ type: "text", name: "role", required: false, max: 20 }),
    );
    app.save(users);

    /* ----------------------- an org on every record ------------------------ */

    for (const name of OWNED) {
      const collection = app.findCollectionByNameOrId(name);
      if (!collection.fields.getByName("org")) collection.fields.add(new Field(orgRelation("org")));
      const owner = collection.fields.getByName("owner");
      if (owner) owner.cascadeDelete = false;
      app.save(collection);
    }

    const quotes = app.findCollectionByNameOrId("quotes");
    if (!quotes.fields.getByName("supersededBy")) {
      quotes.fields.add(
        new Field({
          type: "relation",
          name: "supersededBy",
          required: false,
          maxSelect: 1,
          collectionId: quotes.id,
          // Deleting the revision unsets this, which is the point: the
          // original is the live quote again.
          cascadeDelete: false,
        }),
      );
      app.save(quotes);
    }

    const keys = app.findCollectionByNameOrId("api_keys");
    if (!keys.fields.getByName("org")) {
      // Closing an organization revokes the keys that acted in it.
      keys.fields.add(new Field(orgRelation("org")));
      app.save(keys);
    }

    /* ------------------------------ backfill ------------------------------- */

    const run = sql => app.db().newQuery(sql).execute();

    run(CREATE_PERSONAL_ORGS);
    run(CREATE_ADMIN_MEMBERSHIPS);
    run(ASSIGN_PERSONAL_ORGS);

    for (const name of OWNED) {
      if (name === "payments" || name === "credits") continue;
      run(STAMP_OWNER_ORG.split("{table}").join(name));
    }
    run(STAMP_LEDGER_ORG.split("{table}").join("payments"));
    run(STAMP_LEDGER_ORG.split("{table}").join("credits"));
    run(STAMP_KEY_ORG);

    run(RELEASE_DRAFT_NUMBERS);
    run(SEED_QUOTE_COUNTERS);
    run(SEED_INVOICE_COUNTERS);
    run(LINK_SUPERSEDED);

    /* -------------------- indexes and rules, now org-keyed ------------------ */

    // Only now: a unique (org, sku) index built while every org was still
    // empty would have refused two accounts that each sell a "PLAT".
    const toOrg = index => index.split("_owner").join("_org").split("`owner`").join("`org`");

    const rules = {
      accounts: {
        listRule: IN_ORG,
        viewRule: IN_ORG,
        createRule: `${MEMBER} && ${role("admin", "sales", "finance")}`,
        updateRule: `${IN_ORG} && ${role("admin", "sales", "finance")}`,
        deleteRule: `${IN_ORG} && ${role("admin", "sales")}`,
      },
      products: {
        listRule: `(${IN_ORG}) || ${SHARED}`,
        viewRule: `(${IN_ORG}) || ${SHARED}`,
        createRule: `${MEMBER} && ${role("admin")}`,
        updateRule: `${IN_ORG} && ${role("admin")}`,
        deleteRule: `${IN_ORG} && ${role("admin")}`,
      },
      pricing_rules: {
        listRule: IN_ORG,
        viewRule: IN_ORG,
        createRule: `${MEMBER} && ${role("admin")}`,
        updateRule: `${IN_ORG} && ${role("admin")}`,
        deleteRule: `${IN_ORG} && ${role("admin")}`,
      },
      quotes: {
        listRule: `(${IN_ORG}) || ${SHARED} || ${APPROVER}`,
        viewRule: `(${IN_ORG}) || ${SHARED} || ${APPROVER}`,
        createRule: `${MEMBER} && ${role("admin", "sales")}`,
        // An approver may write the quote they were asked about — and only its
        // approval fields, which pb_hooks/rules/approvals.js enforces.
        updateRule: `(${IN_ORG} && ${OWN_QUOTE}) || ${APPROVER}`,
        deleteRule: `${IN_ORG} && ${OWN_QUOTE}`,
      },
      invoices: {
        listRule: `(${IN_ORG}) || ${SHARED}`,
        viewRule: `(${IN_ORG}) || ${SHARED}`,
        createRule: `${MEMBER} && ${role("admin", "finance")}`,
        updateRule: `${IN_ORG} && ${role("admin", "finance")}`,
        deleteRule: `${IN_ORG} && ${role("admin", "finance")}`,
      },
    };
    rules.price_books = rules.products;
    rules.proposal_templates = rules.products;
    rules.approval_rules = rules.pricing_rules;

    // The ledger inherits its invoice's audience and its invoice's writers.
    // Keying off `invoice.org` rather than the row's own org is what stops a
    // member of one organization filing a payment against another's invoice.
    const LEDGER_READ = '(@request.auth.org != "" && invoice.org = @request.auth.org) || invoice.sharedWith.id ?= @request.auth.id';
    const LEDGER_WRITE = `@request.auth.org != "" && invoice.org = @request.auth.org && ${role("admin", "finance")}`;
    rules.payments = {
      listRule: LEDGER_READ,
      viewRule: LEDGER_READ,
      createRule: LEDGER_WRITE,
      updateRule: LEDGER_WRITE,
      deleteRule: LEDGER_WRITE,
    };
    rules.credits = rules.payments;

    for (const name of OWNED) {
      const collection = app.findCollectionByNameOrId(name);
      collection.indexes = collection.indexes.map(toOrg);
      if (name === "quotes") {
        collection.indexes = [...collection.indexes, "CREATE INDEX `idx_quotes_supersedes` ON `quotes` (`supersedes`)"];
      }
      Object.assign(collection, rules[name]);
      app.save(collection);
    }
  },
  app => {
    // Down: back to one account per workspace. Records keep their owner, which
    // was never removed, so the old rules find them again.
    const MINE = "owner = @request.auth.id";
    const MINE_OR_SHARED = `${MINE} || sharedWith.id ?= @request.auth.id`;
    const SIGNED_IN = '@request.auth.id != ""';
    const privateRules = { listRule: MINE, viewRule: MINE, createRule: SIGNED_IN, updateRule: MINE, deleteRule: MINE };
    const sharedRules = { ...privateRules, listRule: MINE_OR_SHARED, viewRule: MINE_OR_SHARED };
    const READ = "invoice.owner = @request.auth.id || invoice.sharedWith.id ?= @request.auth.id";
    const WRITE = "invoice.owner = @request.auth.id";
    const ledgerRules = { listRule: READ, viewRule: READ, createRule: WRITE, updateRule: WRITE, deleteRule: WRITE };

    const previous = {
      accounts: privateRules,
      products: sharedRules,
      price_books: sharedRules,
      pricing_rules: privateRules,
      approval_rules: privateRules,
      proposal_templates: sharedRules,
      invoices: sharedRules,
      quotes: {
        listRule: `${MINE_OR_SHARED} || approvers.id ?= @request.auth.id`,
        viewRule: `${MINE_OR_SHARED} || approvers.id ?= @request.auth.id`,
        createRule: SIGNED_IN,
        updateRule: `${MINE} || approvers.id ?= @request.auth.id`,
        deleteRule: MINE,
      },
      payments: ledgerRules,
      credits: ledgerRules,
    };

    const toOwner = index => index.split("_org").join("_owner").split("`org`").join("`owner`");

    for (const name of OWNED) {
      const collection = app.findCollectionByNameOrId(name);
      collection.indexes = collection.indexes
        .filter(index => index.indexOf("idx_quotes_supersedes") === -1)
        .map(toOwner);
      if (collection.fields.getByName("org")) collection.fields.removeByName("org");
      if (name === "quotes" && collection.fields.getByName("supersededBy")) collection.fields.removeByName("supersededBy");
      const owner = collection.fields.getByName("owner");
      if (owner) owner.cascadeDelete = true;
      Object.assign(collection, previous[name]);
      app.save(collection);
    }

    const keys = app.findCollectionByNameOrId("api_keys");
    if (keys.fields.getByName("org")) {
      keys.fields.removeByName("org");
      app.save(keys);
    }

    const users = app.findCollectionByNameOrId("users");
    for (const field of ["org", "role"]) {
      if (users.fields.getByName(field)) users.fields.removeByName(field);
    }
    app.save(users);

    // Draft invoices keep their DRAFT- placeholder: the old code numbers on
    // creation, so they would need renumbering by hand — and none is lost.
    for (const name of ["revoked_tokens", "counters", "invitations", "memberships", "organizations"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (err) {
        // Already gone.
      }
    }
  },
);
