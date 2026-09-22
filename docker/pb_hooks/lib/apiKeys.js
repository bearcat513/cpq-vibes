/**
 * Issuing API keys, and turning one back into the account that owns it.
 *
 * This lives in PocketBase rather than in the Bun server because both halves
 * need authority no user token carries: issuing writes to a collection whose
 * create rule is closed, and authenticating reads a key belonging to whoever
 * presented it, before anyone is known to be signed in.
 *
 * The middleware sets `e.auth` to the key's owner, which is the whole point —
 * every collection rule in the migrations is written against `@request.auth`,
 * so a key reaches exactly what its owner reaches, with no second access model
 * to keep in step.
 *
 * A hook body cannot see its own file's scope, so every handler registered in
 * keys/routes.js `require`s this module inside itself.
 */

/** Marks a key at a glance, and tells it apart from a session token. */
const PREFIX = "cpq_";

/** Random characters after the prefix. 40 from a CSPRNG is ~206 bits. */
const SECRET_LENGTH = 40;

/** Per account. A cap keeps a runaway script from filling the table. */
const MAX_KEYS = 25;

/** How stale `lastUsed` may get before it is worth another write. */
const LAST_USED_INTERVAL_MS = 5 * 60 * 1000;

/** Ten years is not "never", but it is past the life of any script. */
const MAX_EXPIRY_DAYS = 3650;

/** PocketBase stores dates as "2026-01-31 12:00:00.000Z". */
function toPocketBaseDate(date) {
  return date.toISOString().replace("T", " ");
}

function fromPocketBaseDate(value) {
  const text = String(value || "");
  if (!text) return null;
  const parsed = new Date(text.replace(" ", "T"));
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** What a caller may learn about a key once it exists. The secret is not here. */
function describe(record) {
  return {
    id: record.id,
    name: record.get("name") || "",
    created: String(record.get("created") || ""),
    expires: String(record.get("expires") || ""),
    lastUsed: String(record.get("lastUsed") || ""),
  };
}

/**
 * Issues a key and returns it once.
 *
 * The raw value is never stored and cannot be recovered — if it is lost the
 * only remedy is to revoke it and issue another, which is the property that
 * makes storing hashes worth anything.
 */
function issue(e) {
  /**
   * A key cannot issue a key.
   *
   * Everything else a key can do, its owner could already do — but minting is
   * different: a leaked key that can mint another survives having the leaked
   * one revoked. Requiring a real sign-in here means revocation actually ends
   * the access. The header alone is enough to refuse: a session token would
   * have authenticated first and left the middleware untouched, so a request
   * carrying both is a client that should pick one.
   */
  if (e.request.header.get("X-Api-Key")) {
    throw new ForbiddenError("An API key cannot issue API keys — sign in to create one.");
  }

  const body = new DynamicModel({ name: "", expiresInDays: 0 });
  try {
    e.bindBody(body);
  } catch (err) {
    // No body is fine: an unnamed key that never expires is a valid ask.
  }

  const name = String(body.name || "")
    .trim()
    .slice(0, 100);

  const existing = e.app.findRecordsByFilter("api_keys", "user = {:user}", "", MAX_KEYS + 1, 0, { user: e.auth.id });
  if (existing.length >= MAX_KEYS) {
    throw new BadRequestError(`You already have ${MAX_KEYS} API keys. Revoke one before issuing another.`);
  }

  const raw = PREFIX + $security.randomString(SECRET_LENGTH);
  const record = new Record(e.app.findCollectionByNameOrId("api_keys"));

  record.set("id", "key_" + $security.randomStringWithAlphabet(16, "0123456789abcdefghijklmnopqrstuvwxyz"));
  record.set("user", e.auth.id);
  record.set("name", name);
  record.set("key_hash", $security.sha256(raw));

  const days = Number(body.expiresInDays || 0);
  if (days > 0) {
    record.set(
      "expires",
      toPocketBaseDate(new Date(Date.now() + Math.min(days, MAX_EXPIRY_DAYS) * 24 * 60 * 60 * 1000)),
    );
  }

  e.app.save(record);

  // `key` appears in this response and in no other, ever.
  return e.json(200, Object.assign(describe(record), { key: raw }));
}

/**
 * Records that a key was used, at most once every few minutes.
 *
 * Writing on every request would turn a read-only call into a write and put a
 * row update in front of every quote listing; the point of the field is to
 * tell a forgotten key from a live one, which does not need the minute.
 */
function touch(app, record) {
  const previous = fromPocketBaseDate(record.get("lastUsed"));
  const now = new Date();
  if (previous && now.getTime() - previous.getTime() < LAST_USED_INTERVAL_MS) return;

  record.set("lastUsed", toPocketBaseDate(now));
  try {
    app.save(record);
  } catch (err) {
    // Bookkeeping must never be the reason a request fails.
    console.log("[api-keys] could not record last use:", String(err));
  }
}

/**
 * Middleware: an `X-API-Key` header stands in for a session token.
 *
 * A request that is already authenticated is left alone, so a token always
 * wins and a stray header cannot downgrade a signed-in session.
 */
function authenticate(e) {
  const raw = e.request.header.get("X-Api-Key");
  if (!raw || e.auth) return e.next();

  let record;
  try {
    record = e.app.findFirstRecordByData("api_keys", "key_hash", $security.sha256(raw));
  } catch (err) {
    throw new UnauthorizedError("Invalid API key.");
  }

  const expires = fromPocketBaseDate(record.get("expires"));
  if (expires && expires.getTime() <= Date.now()) {
    throw new UnauthorizedError("This API key has expired.");
  }

  let owner;
  try {
    owner = e.app.findRecordById("users", record.get("user"));
  } catch (err) {
    // The account is gone but the key outlived it; say the same thing as for
    // a key that never existed.
    throw new UnauthorizedError("Invalid API key.");
  }

  e.auth = owner;
  touch(e.app, record);

  return e.next();
}

module.exports = { issue, authenticate, describe, PREFIX, MAX_KEYS, SECRET_LENGTH, MAX_EXPIRY_DAYS };
