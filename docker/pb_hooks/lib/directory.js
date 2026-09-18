/**
 * The people you can pick from.
 *
 * Until now this app deliberately had no directory: an address could be
 * *resolved* — sharing and approver stamping look up what you typed and say
 * whether an account exists — but never *listed*. That works when you already
 * know the address. It does not work for an approval rule, where the question
 * is "who on this instance can sign this off", and the honest answer was an
 * empty dropdown next to ten accounts.
 *
 * So there is a directory now, and it is worth being clear about what that
 * changes: **any signed-in account can see the address and name of every other
 * account.** Sign-up is open by default, so that is everyone who registers.
 * Nothing else about an account is exposed — no verified flag, no created
 * date, no preferences, and no record any of them owns — and the collection
 * rules are untouched, so this endpoint is the only way through. If that is
 * the wrong trade for an instance, close sign-up or drop this module from
 * pb_hooks/main.pb.js; every caller treats an empty directory as "type the
 * address yourself", which is exactly how it behaved before.
 *
 * It lives here rather than in the Bun server for the same reason sharing
 * does: reading `users` needs authority no user token has, and the Bun server
 * holds no credentials of its own.
 */

/** Enough for a company; past this, typing the address is faster anyway. */
const MAX_RESULTS = 200;

function list(e) {
  const query = e.request.url.query();
  const search = String(query.get("search") || "").trim().toLowerCase();

  let records;
  try {
    records = search
      ? e.app.findRecordsByFilter("users", "email ~ {:q} || name ~ {:q}", "email", MAX_RESULTS, 0, { q: search })
      : e.app.findRecordsByFilter("users", "id != ''", "email", MAX_RESULTS, 0);
  } catch (err) {
    // An instance with no accounts yet is not an error.
    records = [];
  }

  const users = [];
  for (const record of records) {
    if (!record) continue;
    users.push({
      id: record.id,
      email: record.email(),
      // The display name, when the account set one. Never anything else.
      name: String(record.get("name") || ""),
    });
  }

  return e.json(200, { users: users, truncated: users.length >= MAX_RESULTS });
}

module.exports = { list, MAX_RESULTS };
