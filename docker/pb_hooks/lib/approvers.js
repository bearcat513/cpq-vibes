/**
 * Stamping the accounts a quote is waiting on.
 *
 * The Bun server works out *which* addresses matter: it prices the quote, runs
 * the approval rules and finds the lowest outstanding level. What it cannot do
 * is turn those addresses into account ids, because that means reading the
 * `users` collection and no user token may. So it sends the addresses here and
 * this resolves them.
 *
 * Writing `approvers` from inside PocketBase is the second reason this lives
 * here: rules/approvals.js restores that relation on every ordinary update, so
 * neither the owner nor an approver can put themselves — or anyone else — on
 * the list by posting it. Saving through the app directly, as this does,
 * bypasses the request hooks, which is exactly the privilege the endpoint
 * exists to hold and the reason it checks ownership itself.
 *
 * An address with no account is reported rather than refused. An approval rule
 * naming a colleague who has not signed up yet is a configuration problem the
 * quote should say out loud, not a reason to refuse to submit it.
 */
/**
 * Matches the `approvers` relation's `maxSelect` and `MAX_APPROVERS` in
 * src/lib/validate.ts. An approver who cannot be stamped here cannot see the
 * quote, so the three have to agree.
 */
const MAX_APPROVERS = 50;

function stamp(e) {
  const quote = (() => {
    try {
      return e.app.findRecordById("quotes", e.request.pathValue("id"));
    } catch (err) {
      throw new NotFoundError("Not found.");
    }
  })();

  // Only the owner. An approver deciding a quote does not get to choose who
  // else is asked, and a recipient it was shared with gets nothing at all.
  if (quote.get("owner") !== e.auth.id) {
    throw new ForbiddenError("Only the owner of a quote can say who it is waiting on.");
  }

  const body = new DynamicModel({ emails: [] });
  try {
    e.bindBody(body);
  } catch (err) {
    throw new BadRequestError('Send { "emails": [...] }.');
  }

  const requested = (body.emails || []).slice(0, MAX_APPROVERS);
  const resolved = [];
  const unresolved = [];

  for (const raw of requested) {
    const email = String(raw || "").trim().toLowerCase();
    if (!email) continue;
    try {
      const user = e.app.findAuthRecordByEmail("users", email);
      if (resolved.indexOf(user.id) === -1) resolved.push(user.id);
    } catch (err) {
      unresolved.push(email);
    }
  }

  quote.set("approvers", resolved);
  e.app.save(quote);

  return e.json(200, { resolved: resolved, unresolved: unresolved });
}

module.exports = { stamp, MAX_APPROVERS };
