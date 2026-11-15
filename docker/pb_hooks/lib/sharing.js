/**
 * Sharing a product, price book, quote, invoice or proposal template with
 * another account.
 *
 * This lives in PocketBase rather than in the Bun server for two reasons.
 * Resolving an email address to an account needs to read the `users`
 * collection, which no user token may do — keeping it here means the address
 * book stays closed while addresses remain shareable. And writing `sharedWith`
 * from here goes through the app directly, so it is not blocked by the same
 * rules that stop a client from editing its own share list.
 *
 * Read-only sharing: a recipient may list and view the record, and nothing
 * else. That is enforced by the collection rules, not here.
 *
 * Inside an organization everyone can already read everything, so a share is
 * how a record reaches somebody *outside* it — a partner, an auditor, the
 * customer's own procurement team. Whoever owns the record may share it, and
 * so may an admin of its organization: records outlive the person who made
 * them, and a share list nobody can edit once its owner has left would be a
 * leak nobody can close.
 */
const SHAREABLE = ["products", "price_books", "quotes", "invoices", "proposal_templates"];
const MAX_SHARES = 50;

/** Everything a caller may learn about one record's sharing. */
function describeShares(app, record, viewer) {
  const insider = record.get("owner") === viewer.id || inOrg(record, viewer);

  return {
    owner: emailOf(app, record.get("owner")),
    // The organization sees the guest list; a recipient sees who shared it.
    sharedWith: insider ? emailsOf(app, record.get("sharedWith")) : [],
    canShare: canManage(record, viewer),
  };
}

/** The record belongs to the organization the caller is working in. */
function inOrg(record, viewer) {
  const org = String(viewer.get("org") || "");
  return org !== "" && String(record.get("org") || "") === org;
}

/** Its owner, or an admin of its organization. */
function canManage(record, viewer) {
  if (record.get("owner") === viewer.id) return true;
  return inOrg(record, viewer) && viewer.getString("role") === "admin";
}

function emailOf(app, id) {
  if (!id) return "";
  try {
    return app.findRecordById("users", id).email();
  } catch (err) {
    return "";
  }
}

function emailsOf(app, ids) {
  return (ids || []).map(id => emailOf(app, id)).filter(email => email !== "");
}

/**
 * The record named by the path, if this caller may see it at all.
 *
 * A record the caller cannot see is reported as missing rather than
 * forbidden — "no such id" and "not yours" should look the same from outside.
 */
function load(e) {
  const collection = e.request.pathValue("collection");
  if (SHAREABLE.indexOf(collection) === -1) {
    throw new BadRequestError(
      "Only products, price books, quotes, invoices and proposal templates can be shared.",
    );
  }

  let record;
  try {
    record = e.app.findRecordById(collection, e.request.pathValue("id"));
  } catch (err) {
    throw new NotFoundError("Not found.");
  }

  const viewer = e.auth.id;
  const shared = (record.get("sharedWith") || []).indexOf(viewer) !== -1;
  // An approver can read the quote, but the share list is not theirs to see:
  // being asked to approve something is not the same as being given it.
  if (record.get("owner") !== viewer && !shared && !inOrg(record, e.auth)) throw new NotFoundError("Not found.");

  return record;
}

function requireOwner(record, viewer) {
  if (!canManage(record, viewer)) {
    throw new ForbiddenError("Only the owner of this record, or an admin, can change who it is shared with.");
  }
}

/** The address from the request body (POST) or the query string (DELETE). */
function readEmail(e) {
  const body = new DynamicModel({ email: "" });
  try {
    e.bindBody(body);
  } catch (err) {
    // No body at all — a DELETE carrying ?email= is the other calling style.
  }

  const email = String(body.email || e.request.url.query().get("email") || "")
    .trim()
    .toLowerCase();

  if (!email) throw new BadRequestError("An email address is required.");
  return email;
}

function list(e) {
  const record = load(e);
  return e.json(200, describeShares(e.app, record, e.auth));
}

function add(e) {
  const record = load(e);
  requireOwner(record, e.auth);

  const email = readEmail(e);
  if (email === e.auth.email().toLowerCase()) {
    throw new BadRequestError("This is already yours — share it with someone else's address.");
  }

  let target;
  try {
    target = e.app.findAuthRecordByEmail("users", email);
  } catch (err) {
    // Deliberately explicit: the owner typed this address and needs to know
    // whether the person has an account, not to guess at silence.
    throw new NotFoundError(`No account is registered for ${email}.`);
  }

  const current = record.get("sharedWith") || [];
  if (current.indexOf(target.id) === -1) {
    if (current.length >= MAX_SHARES) {
      throw new BadRequestError(`A record can be shared with at most ${MAX_SHARES} people.`);
    }
    record.set("sharedWith", current.concat(target.id));
    e.app.save(record);
  }

  return e.json(200, describeShares(e.app, record, e.auth));
}

function remove(e) {
  const record = load(e);
  const email = readEmail(e);

  // The owner can revoke anyone; a recipient can only show themselves out.
  const leaving = email === e.auth.email().toLowerCase();
  if (!leaving) requireOwner(record, e.auth);

  let targetId = leaving ? e.auth.id : "";
  if (!targetId) {
    try {
      targetId = e.app.findAuthRecordByEmail("users", email).id;
    } catch (err) {
      throw new NotFoundError(`No account is registered for ${email}.`);
    }
  }

  const current = record.get("sharedWith") || [];
  if (current.indexOf(targetId) !== -1) {
    record.set(
      "sharedWith",
      current.filter(id => id !== targetId),
    );
    e.app.save(record);
  }

  // A recipient who just left can no longer read the record, so answer with
  // the empty view rather than re-reading something now forbidden.
  if (leaving && !inOrg(record, e.auth) && record.get("owner") !== e.auth.id) return e.json(200, { owner: "", sharedWith: [], canShare: false });

  return e.json(200, describeShares(e.app, record, e.auth));
}

module.exports = { list, add, remove, SHAREABLE, MAX_SHARES };
