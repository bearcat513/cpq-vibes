/**
 * Organizations: who is in one, what they may do there, and the numbers it
 * hands out.
 *
 * Everything here writes something no request may write for itself — a
 * membership, the caller's own `org`/`role` pair, a counter — so it lives in
 * PocketBase and saves through the app directly, past the request hooks that
 * would otherwise restore those fields. That privilege is why every function
 * checks the caller's role itself before touching anything.
 *
 * The invariant this file keeps: **`users.role` is always the role of the
 * membership named by `users.org`.** The collection rules read the pair from
 * `@request.auth`, so a membership whose role changed while the account's copy
 * did not would leave somebody with access they had lost. Every write below
 * that touches a membership updates the pair in the same transaction.
 *
 * A hook body cannot see its file's scope, so the route handlers in
 * org/routes.js `require` this module inside themselves.
 */

/** Matches ROLES in src/lib/organization.ts. */
const ROLES = ["admin", "sales", "finance", "viewer"];

/** Roles that may take a number of each kind, matching the create rules. */
const NUMBERING = {
  quote: { prefix: "Q", collection: "quotes", roles: ["admin", "sales"] },
};

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const MAX_NAME = 200;
const MAX_MEMBERS = 500;

function newId(prefix) {
  return prefix + "_" + $security.randomStringWithAlphabet(12, ID_ALPHABET);
}

/** "7" → "0007". Hand-rolled: padStart is not something to bet a number on. */
function pad(value) {
  let text = String(value);
  while (text.length < 4) text = "0" + text;
  return text;
}

/** A JSON field reaches the JSVM as bytes; its string form is the stored text. */
function parseJson(record, field, fallback) {
  try {
    const text = record.getString(field);
    return text ? JSON.parse(text) : fallback;
  } catch (err) {
    return fallback;
  }
}

function readBody(e, shape) {
  const body = new DynamicModel(shape);
  try {
    e.bindBody(body);
  } catch (err) {
    // An empty body is answered by the checks below, with a sentence.
  }
  return body;
}

function readRole(value, fallback) {
  const role = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (ROLES.indexOf(role) === -1) throw new BadRequestError("A role is one of " + ROLES.join(", ") + ".");
  return role;
}

function readEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (email.indexOf("@") < 1) throw new BadRequestError("A valid email address is required.");
  return email;
}

/**
 * Membership changes take a real session, the way issuing a key does. A
 * leaked admin key that could add its holder's own account as an admin would
 * outlive the key being revoked — which is the one thing revocation is for.
 */
function requireSession(e, what) {
  if (e.request.header.get("X-Api-Key")) {
    throw new ForbiddenError("An API key cannot " + what + " — sign in to do it.");
  }
}

function requireOrg(e) {
  const org = String(e.auth.get("org") || "");
  if (!org) throw new BadRequestError("You are not in an organization. Create one, or ask an admin to invite you.");
  return org;
}

function requireAdmin(e) {
  const org = requireOrg(e);
  if (e.auth.getString("role") !== "admin") throw new ForbiddenError("Only an admin of this organization can do that.");
  return org;
}

function findMembership(app, orgId, userId) {
  try {
    return app.findFirstRecordByFilter("memberships", "org = {:org} && user = {:user}", { org: orgId, user: userId });
  } catch (err) {
    return null;
  }
}

function adminCount(app, orgId) {
  return app.findRecordsByFilter("memberships", "org = {:org} && role = 'admin'", "", MAX_MEMBERS, 0, { org: orgId })
    .length;
}

/** Points an account at one of its organizations, with its role there. */
function activate(app, userId, orgId, role) {
  const user = app.findRecordById("users", userId);
  user.set("org", orgId);
  user.set("role", orgId ? role : "");
  app.save(user);
}

function ensureMembership(app, orgId, userId, role) {
  const existing = findMembership(app, orgId, userId);
  if (existing) return existing;
  const membership = new Record(app.findCollectionByNameOrId("memberships"));
  membership.set("id", newId("mem"));
  membership.set("org", orgId);
  membership.set("user", userId);
  membership.set("role", role);
  app.save(membership);
  return membership;
}

function createOrganization(app, userId, name) {
  const org = new Record(app.findCollectionByNameOrId("organizations"));
  org.set("id", newId("org"));
  org.set("name", name);
  org.set("settings", {});
  app.save(org);
  ensureMembership(app, org.id, userId, "admin");
  activate(app, userId, org.id, "admin");
  return org;
}

function defaultOrgName(user) {
  const name = String(user.getString("name") || "").trim();
  return (name ? name + "'s workspace" : user.email() || "Workspace").slice(0, MAX_NAME);
}

/**
 * Hands the single-tenant leftovers to the first account that registers.
 *
 * Records created before accounts existed have no owner and no organization,
 * so no rule matches them. The first account on the instance inherits them —
 * the tool was theirs alone until accounts existed — and nobody after that
 * can claim anything.
 */
function adoptOrphans(app, userId, orgId) {
  const owned = [
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
  let adopted = 0;
  for (const collection of owned) {
    const orphans = app.findAllRecords(collection, $dbx.exp("(owner = '' OR owner IS NULL) AND (org = '' OR org IS NULL)"));
    for (const record of orphans) {
      record.set("owner", userId);
      record.set("org", orgId);
      app.save(record);
      adopted++;
    }
  }
  if (adopted > 0) console.log("[orgs] the first account adopted " + adopted + " pre-accounts record(s)");
}

/**
 * Gives a newly registered account somewhere to work.
 *
 * An address somebody was invited at joins every organization that invited
 * it, and starts in the first. Anybody else gets an organization of their own,
 * as its admin — which is also how the first account on a fresh instance
 * starts.
 */
function onboard(app, user) {
  if (String(user.get("org") || "")) return;
  const email = String(user.email() || "")
    .trim()
    .toLowerCase();

  app.runInTransaction(tx => {
    const invites = email
      ? tx.findRecordsByFilter("invitations", "email = {:email}", "created", 50, 0, { email: email })
      : [];

    let first = null;
    for (const invite of invites) {
      if (!invite) continue;
      const orgId = invite.getString("org");
      const role = invite.getString("role") || "viewer";
      ensureMembership(tx, orgId, user.id, role);
      if (!first) first = { orgId: orgId, role: role };
      tx.delete(invite);
    }

    if (first) {
      activate(tx, user.id, first.orgId, first.role);
      return;
    }

    const org = createOrganization(tx, user.id, defaultOrgName(user));
    if (tx.countRecords("users") === 1) adoptOrphans(tx, user.id, org.id);
  });
}

/* ------------------------------- reading ---------------------------------- */

function describeOrg(record) {
  return { id: record.id, name: record.getString("name"), settings: parseJson(record, "settings", {}) };
}

function membershipsOf(app, userId) {
  const rows = app.findRecordsByFilter("memberships", "user = {:user}", "created", MAX_MEMBERS, 0, { user: userId });
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    try {
      const org = app.findRecordById("organizations", row.getString("org"));
      out.push({ id: row.id, org: { id: org.id, name: org.getString("name") }, role: row.getString("role") });
    } catch (err) {
      // An organization deleted from the dashboard; its membership cascades.
    }
  }
  return out;
}

/**
 * Who the caller is, where they are working, and as what.
 *
 * Read from `e.auth` — the stored account, which is exactly what the
 * collection rules read `@request.auth` from — so the Bun server learns the
 * context the rules will apply. An API key only gets this far while its owner
 * is working in the organization it was issued in (lib/apiKeys.js).
 */
function context(e) {
  const auth = e.auth;
  const orgId = String(auth.get("org") || "");
  let org = null;
  if (orgId) {
    try {
      org = describeOrg(e.app.findRecordById("organizations", orgId));
    } catch (err) {
      org = null;
    }
  }

  return e.json(200, {
    user: {
      id: auth.id,
      email: auth.email(),
      name: auth.getString("name"),
      verified: auth.verified(),
      created: String(auth.get("created") || ""),
      preferences: parseJson(auth, "preferences", null),
    },
    org: org,
    role: org ? auth.getString("role") : "",
    memberships: membershipsOf(e.app, auth.id),
    credential: e.request.header.get("X-Api-Key") ? "key" : "session",
  });
}

/** The members of the caller's organization, and — for an admin — its open invitations. */
function listing(app, orgId, isAdmin) {
  const rows = app.findRecordsByFilter("memberships", "org = {:org}", "created", MAX_MEMBERS, 0, { org: orgId });
  const members = [];
  for (const row of rows) {
    if (!row) continue;
    try {
      const user = app.findRecordById("users", row.getString("user"));
      members.push({
        id: row.id,
        userId: user.id,
        email: user.email(),
        name: user.getString("name"),
        role: row.getString("role"),
        joined: String(row.get("created") || ""),
      });
    } catch (err) {
      // A deleted account; its membership cascades with it.
    }
  }
  members.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));

  const invitations = [];
  if (isAdmin) {
    const invites = app.findRecordsByFilter("invitations", "org = {:org}", "-created", MAX_MEMBERS, 0, { org: orgId });
    for (const invite of invites) {
      if (!invite) continue;
      invitations.push({
        id: invite.id,
        email: invite.getString("email"),
        role: invite.getString("role"),
        created: String(invite.get("created") || ""),
      });
    }
  }

  return { members: members, invitations: invitations, canManage: isAdmin };
}

function members(e) {
  const orgId = requireOrg(e);
  return e.json(200, listing(e.app, orgId, e.auth.getString("role") === "admin"));
}

/* ------------------------------- members ---------------------------------- */

/**
 * Adds somebody to the organization.
 *
 * An address with an account becomes a member straight away; one without is
 * an invitation, honoured when that address registers. Either way the answer
 * says which happened, because "added" and "will be added when they sign up"
 * are different things to tell the person who asked.
 */
function addMember(e) {
  requireSession(e, "manage members");
  const orgId = requireAdmin(e);
  const body = readBody(e, { email: "", role: "" });
  const email = readEmail(body.email);
  const role = readRole(body.role, "sales");

  let user = null;
  try {
    user = e.app.findAuthRecordByEmail("users", email);
  } catch (err) {
    user = null;
  }

  let outcome = "";
  e.app.runInTransaction(tx => {
    if (user) {
      if (findMembership(tx, orgId, user.id)) {
        throw new BadRequestError(email + " is already a member. Change their role instead.");
      }
      ensureMembership(tx, orgId, user.id, role);
      // Somebody with nowhere to work starts working here.
      if (!String(tx.findRecordById("users", user.id).get("org") || "")) activate(tx, user.id, orgId, role);
      outcome = "added";
      return;
    }

    let invite = null;
    try {
      invite = tx.findFirstRecordByFilter("invitations", "org = {:org} && email = {:email}", { org: orgId, email: email });
    } catch (err) {
      invite = new Record(tx.findCollectionByNameOrId("invitations"));
      invite.set("id", newId("inv"));
      invite.set("org", orgId);
      invite.set("email", email);
    }
    invite.set("role", role);
    invite.set("invitedBy", e.auth.id);
    tx.save(invite);
    outcome = "invited";
  });

  return e.json(200, Object.assign(listing(e.app, orgId, true), { outcome: outcome }));
}

function loadMembership(e, orgId) {
  let membership;
  try {
    membership = e.app.findRecordById("memberships", e.request.pathValue("id"));
  } catch (err) {
    throw new NotFoundError("No such member.");
  }
  if (membership.getString("org") !== orgId) throw new NotFoundError("No such member.");
  return membership;
}

/** Changes a member's role — and, when it is the org they are working in, the copy rules read. */
function updateMember(e) {
  requireSession(e, "manage members");
  const orgId = requireAdmin(e);
  const membership = loadMembership(e, orgId);
  const role = readRole(readBody(e, { role: "" }).role);

  if (membership.getString("role") === "admin" && role !== "admin" && adminCount(e.app, orgId) <= 1) {
    throw new BadRequestError("This is the organization's only admin. Make somebody else an admin first.");
  }

  e.app.runInTransaction(tx => {
    const fresh = tx.findRecordById("memberships", membership.id);
    fresh.set("role", role);
    tx.save(fresh);

    const user = tx.findRecordById("users", fresh.getString("user"));
    if (user.getString("org") === orgId) {
      user.set("role", role);
      tx.save(user);
    }
  });

  return e.json(200, listing(e.app, orgId, true));
}

/**
 * Removes a member — an admin removing somebody, or anybody leaving.
 *
 * The organization is never left without an admin. Whoever is removed stops
 * working there at once: their account moves to another organization they
 * belong to, or to none, and the records they owned stay with the
 * organization rather than leaving with them.
 */
function removeMember(e) {
  requireSession(e, "manage members");
  const orgId = requireOrg(e);
  const membership = loadMembership(e, orgId);
  const userId = membership.getString("user");
  const leaving = userId === e.auth.id;

  if (!leaving && e.auth.getString("role") !== "admin") {
    throw new ForbiddenError("Only an admin can remove somebody else.");
  }
  if (membership.getString("role") === "admin" && adminCount(e.app, orgId) <= 1) {
    throw new BadRequestError(
      leaving
        ? "You are this organization's only admin. Make somebody else an admin before you leave."
        : "This is the organization's only admin.",
    );
  }

  e.app.runInTransaction(tx => {
    tx.delete(tx.findRecordById("memberships", membership.id));

    const user = tx.findRecordById("users", userId);
    if (user.getString("org") !== orgId) return;

    const others = tx.findRecordsByFilter("memberships", "user = {:user}", "-created", 1, 0, { user: userId });
    const next = others.length ? others[0] : null;
    activate(tx, userId, next ? next.getString("org") : "", next ? next.getString("role") : "");
  });

  return leaving
    ? e.json(200, { members: [], invitations: [], canManage: false, left: true })
    : e.json(200, listing(e.app, orgId, true));
}

function revokeInvitation(e) {
  requireSession(e, "manage members");
  const orgId = requireAdmin(e);
  let invite;
  try {
    invite = e.app.findRecordById("invitations", e.request.pathValue("id"));
  } catch (err) {
    throw new NotFoundError("No such invitation.");
  }
  if (invite.getString("org") !== orgId) throw new NotFoundError("No such invitation.");
  e.app.delete(invite);
  return e.json(200, listing(e.app, orgId, true));
}

/* ---------------------------- organizations ------------------------------- */

/** Moves the caller's session into another organization they belong to. */
function switchOrg(e) {
  requireSession(e, "switch organizations");
  const orgId = String(readBody(e, { orgId: "" }).orgId || "");
  const membership = orgId ? findMembership(e.app, orgId, e.auth.id) : null;
  if (!membership) throw new NotFoundError("You are not a member of that organization.");

  activate(e.app, e.auth.id, orgId, membership.getString("role"));
  return e.json(200, { org: describeOrg(e.app.findRecordById("organizations", orgId)), role: membership.getString("role") });
}

/** Starts a new organization, with the caller as its admin, and moves them into it. */
function createOrg(e) {
  requireSession(e, "create organizations");
  const name = String(readBody(e, { name: "" }).name || "").trim();
  if (!name) throw new BadRequestError("An organization needs a name.");
  if (name.length > MAX_NAME) throw new BadRequestError("An organization's name is " + MAX_NAME + " characters at most.");

  let org = null;
  e.app.runInTransaction(tx => {
    org = createOrganization(tx, e.auth.id, name);
  });
  return e.json(200, { org: describeOrg(org), role: "admin" });
}

/* -------------------------------- numbers --------------------------------- */

/**
 * The next free number of one kind, inside the caller's transaction.
 *
 * A counter per organization, kind and year, rather than a count of whatever
 * the caller can see: a count moved whenever somebody shared a quote with you
 * and moved back when they stopped. The loop steps over any number already in
 * use — one made before the counter existed, or written by hand — so the
 * counter can never hand out a duplicate, only skip forward.
 */
function nextNumber(tx, orgId, kind, year, prefix, collection) {
  let counter;
  try {
    counter = tx.findFirstRecordByFilter("counters", "org = {:org} && kind = {:kind} && year = {:year}", {
      org: orgId,
      kind: kind,
      year: year,
    });
  } catch (err) {
    counter = new Record(tx.findCollectionByNameOrId("counters"));
    counter.set("id", newId("cnt"));
    counter.set("org", orgId);
    counter.set("kind", kind);
    counter.set("year", year);
    counter.set("value", 0);
  }

  let value = counter.getInt("value");
  for (let attempt = 0; attempt < 1000; attempt++) {
    value++;
    const candidate = prefix + "-" + year + "-" + pad(value);
    let taken = false;
    try {
      tx.findFirstRecordByFilter(collection, "org = {:org} && number = {:number}", { org: orgId, number: candidate });
      taken = true;
    } catch (err) {
      taken = false;
    }
    if (!taken) {
      counter.set("value", value);
      tx.save(counter);
      return candidate;
    }
  }
  throw new BadRequestError("Could not allocate a " + kind + " number.");
}

/**
 * A year the caller may number in: the one their organization's calendar is
 * in, which the Bun server works out from its time zone. Anything more than a
 * year from the server's own clock is a mistake rather than a time zone.
 */
function readYear(value) {
  const year = Number(value);
  const now = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || Math.abs(year - now) > 1) {
    throw new BadRequestError("Send the year to number in, as { year }.");
  }
  return year;
}

function takeNumber(e) {
  const orgId = requireOrg(e);
  const kind = e.request.pathValue("kind");
  const numbering = NUMBERING[kind];
  if (!numbering) throw new NotFoundError("Nothing is numbered as " + kind + ".");
  if (numbering.roles.indexOf(e.auth.getString("role")) === -1) {
    throw new ForbiddenError("Your role cannot create a " + kind + ".");
  }

  const year = readYear(readBody(e, { year: 0 }).year);
  let number = "";
  e.app.runInTransaction(tx => {
    number = nextNumber(tx, orgId, kind, year, numbering.prefix, numbering.collection);
  });
  return e.json(200, { number: number });
}

/**
 * Issues a draft invoice: numbers it, dates it, and makes it a receivable, in
 * one transaction.
 *
 * Numbering at issue rather than at creation is what keeps the issued run
 * gapless — a draft can be thrown away, and a number it never had leaves no
 * hole. Doing the number and the state change together is what keeps it so:
 * a number taken by an issue that then failed would be a gap of its own.
 *
 * The Bun server works out the dates (it knows the organization's calendar and
 * the invoice's terms) and checks that there is something to issue; this
 * checks the caller, the state, and takes the number.
 */
function issueInvoice(e) {
  const orgId = requireOrg(e);
  const role = e.auth.getString("role");
  if (role !== "admin" && role !== "finance") throw new ForbiddenError("Only finance or an admin can issue an invoice.");

  const body = readBody(e, { issueDate: "", dueDate: "" });
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const issueDate = String(body.issueDate || "");
  const dueDate = String(body.dueDate || "");
  if (!day.test(issueDate) || !day.test(dueDate)) {
    throw new BadRequestError("Send { issueDate, dueDate } as YYYY-MM-DD.");
  }

  const id = e.request.pathValue("id");
  let number = "";
  e.app.runInTransaction(tx => {
    let invoice;
    try {
      invoice = tx.findRecordById("invoices", id);
    } catch (err) {
      throw new NotFoundError("Invoice not found.");
    }
    if (invoice.getString("org") !== orgId) throw new NotFoundError("Invoice not found.");
    if (invoice.getString("state") !== "draft") {
      throw new BadRequestError(invoice.getString("number") + " has already been issued.");
    }

    number = nextNumber(tx, orgId, "invoice", Number(issueDate.slice(0, 4)), "INV", "invoices");
    invoice.set("number", number);
    invoice.set("state", "issued");
    invoice.set("issueDate", issueDate);
    invoice.set("dueDate", dueDate);
    tx.save(invoice);
  });

  return e.json(200, { number: number });
}

module.exports = {
  ROLES,
  onboard,
  context,
  members,
  addMember,
  updateMember,
  removeMember,
  revokeInvitation,
  switchOrg,
  createOrg,
  takeNumber,
  issueInvoice,
};
