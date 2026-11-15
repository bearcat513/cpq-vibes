/**
 * Signing out, for real.
 *
 * A PocketBase session token is a signed JWT: once issued it is good until it
 * expires, and nothing the server forgets about it changes that. Clearing the
 * browser's cookie ends the session for that browser and for nobody who copied
 * the token first. So signing out records the token's hash here, and a
 * middleware refuses a recorded token until the moment it would have expired
 * anyway — after which a nightly job forgets it.
 *
 * "Sign out everywhere" is cheaper and blunter: it rotates the account's
 * token key, which invalidates every token ever issued to it at once.
 *
 * A hook body cannot see its file's scope; sessions/routes.js `require`s this
 * inside each handler.
 */

/** "Bearer abc" and "abc" are both accepted by PocketBase, so both are refused. */
function tokenOf(e) {
  const header = String(e.request.header.get("Authorization") || "").trim();
  return header.toLowerCase().indexOf("bearer ") === 0 ? header.slice(7).trim() : header;
}

function toPocketBaseDate(date) {
  return date.toISOString().replace("T", " ");
}

/** Middleware: a signed-out token is no token at all. */
function refuseRevoked(e) {
  const token = tokenOf(e);
  if (!token) return e.next();

  let revoked = false;
  try {
    e.app.findFirstRecordByData("revoked_tokens", "hash", $security.sha256(token));
    revoked = true;
  } catch (err) {
    revoked = false;
  }
  if (revoked) throw new UnauthorizedError("This session has been signed out.");
  return e.next();
}

/** Records the caller's own token as signed out. */
function revoke(e) {
  const token = tokenOf(e);
  if (!token) throw new BadRequestError("Only a session token can be signed out — an API key is revoked instead.");

  const hash = $security.sha256(token);
  let expires = "";
  try {
    const claims = $security.parseUnverifiedJWT(token);
    const exp = Number(claims.exp || 0);
    if (exp > 0) expires = toPocketBaseDate(new Date(exp * 1000));
  } catch (err) {
    // Unreadable claims: keep it until the cleanup's fallback age.
  }

  try {
    e.app.findFirstRecordByData("revoked_tokens", "hash", hash);
  } catch (err) {
    const record = new Record(e.app.findCollectionByNameOrId("revoked_tokens"));
    record.set("id", "rvk_" + $security.randomStringWithAlphabet(16, "0123456789abcdefghijklmnopqrstuvwxyz"));
    record.set("hash", hash);
    if (expires) record.set("expires", expires);
    e.app.save(record);
  }
  return e.json(200, { signedOut: true });
}

/**
 * Rotates the account's token key, which ends every session it has — this
 * one included. API keys are untouched: they are not tokens, and each is
 * revoked on its own.
 */
function revokeAll(e) {
  if (e.request.header.get("X-Api-Key")) {
    throw new ForbiddenError("An API key cannot sign an account out — sign in to do it.");
  }
  const user = e.app.findRecordById("users", e.auth.id);
  user.refreshTokenKey();
  e.app.save(user);
  return e.json(200, { signedOut: true, everywhere: true });
}

/**
 * Forgets revocations whose tokens have expired by themselves. A row with no
 * readable expiry is kept for thirty days, past any token's life.
 */
function sweep(app) {
  const now = new Date();
  const fallback = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  app
    .db()
    .newQuery(
      "DELETE FROM revoked_tokens WHERE (expires <> '' AND expires < {:now}) OR (coalesce(expires, '') = '' AND created < {:fallback})",
    )
    .bind({ now: toPocketBaseDate(now), fallback: toPocketBaseDate(fallback) })
    .execute();
}

module.exports = { refuseRevoked, revoke, revokeAll, sweep };
