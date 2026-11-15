/**
 * The people you can pick from: the members of the organization you are
 * working in.
 *
 * Approver and share pickers offer this list. It is scoped to your
 * organization because that is who an approval rule is written about, and
 * because an instance shared by several companies must not hand any one of
 * them the others' staff list. Somebody outside it can still be named — the
 * pickers accept a typed address, and sharing and approver stamping resolve
 * one — but they cannot be *browsed*.
 *
 * Only the address and display name are exposed. It lives here rather than in
 * the Bun server because reading `users` needs authority no user token has.
 */
/** Enough for a company; past this, typing the address is faster anyway. */
const MAX_RESULTS = 200;

function list(e) {
  const query = e.request.url.query();
  const search = String(query.get("search") || "")
    .trim()
    .toLowerCase();
  const org = String(e.auth.get("org") || "");
  if (!org) return e.json(200, { users: [], truncated: false });

  const filter = search
    ? "org = {:org} && (user.email ~ {:q} || user.name ~ {:q})"
    : "org = {:org}";
  let memberships;
  try {
    memberships = e.app.findRecordsByFilter("memberships", filter, "", MAX_RESULTS, 0, { org: org, q: search });
  } catch (err) {
    memberships = [];
  }

  const users = [];
  for (const membership of memberships) {
    if (!membership) continue;
    try {
      const record = e.app.findRecordById("users", membership.getString("user"));
      users.push({ id: record.id, email: record.email(), name: String(record.get("name") || "") });
    } catch (err) {
      // A deleted account; its membership cascades.
    }
  }
  users.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));

  return e.json(200, { users: users, truncated: users.length >= MAX_RESULTS });
}

module.exports = { list, MAX_RESULTS };
