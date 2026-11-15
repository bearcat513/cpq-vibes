/// <reference path="../../pb_data/types.d.ts" />

/**
 * A quote has two writers, and they may do very different things to it.
 *
 * **An editor** — an admin of its organization, or the sales member who owns
 * it — edits it freely: lines, prices, discounts, status. They may not change
 * who owns it, which organization it is in, its number, who it is shared with
 * or who it is waiting on; those are set by endpoints that check something
 * first.
 *
 * **An approver** can write the quote they were actually asked about, because
 * the update rule lets them, because otherwise recording a decision would need
 * this server to hold a credential that could write anybody's quote. What they
 * may change is held to the approval fields *here*: the decision, the
 * resulting status, and when it was made. Everything else on the record is
 * restored from what was stored before their request, so an approver who posts
 * a whole quote with new prices approves the old ones.
 *
 * The status an approver may set is limited too. Deciding an approval can
 * leave a quote `approved`, `rejected` or still `in_review`; it cannot make it
 * `sent`, and it cannot put it back to `draft`.
 *
 * Note the shape of the handler. A hook body runs in its own scope and cannot
 * see anything declared in this file outside it, so every list and helper the
 * handler needs is declared *inside* the callback. Hoisting one out is the
 * kind of change that registers cleanly and then fails at runtime.
 */
module.exports.register = () => {
  onRecordUpdateRequest(e => {
    if (e.hasSuperuserAuth()) return e.next();
    if (!e.auth) throw new UnauthorizedError("Sign in to continue.");

    const original = e.record.original();

    // An editor is an admin of the quote's organization, or a sales member
    // who owns it — the same test as the update rule's first half.
    const org = String(e.auth.get("org") || "");
    const role = e.auth.getString("role");
    const inOrg = org !== "" && original.get("org") === org;
    const isEditor = inOrg && (role === "admin" || (role === "sales" && original.get("owner") === e.auth.id));

    if (isEditor) {
      // Set by /api/cpq/approvers and the share routes, never by a body.
      e.record.set("owner", original.get("owner"));
      e.record.set("org", original.get("org"));
      e.record.set("sharedWith", original.get("sharedWith"));
      e.record.set("approvers", original.get("approvers"));
      e.record.set("number", original.get("number"));

      // `supersededBy` may only name a revision *of this quote*, in the same
      // organization — which is what revising writes. Anything else would
      // let an editor retire a quote by pointing it at an unrelated one.
      const next = String(e.record.get("supersededBy") || "");
      if (next && next !== String(original.get("supersededBy") || "")) {
        let revision = null;
        try {
          revision = e.app.findRecordById("quotes", next);
        } catch (err) {
          revision = null;
        }
        if (!revision || revision.get("supersedes") !== original.id || revision.get("org") !== original.get("org")) {
          throw new BadRequestError("A quote can only be superseded by one of its own revisions.");
        }
      }
      return e.next();
    }

    const approvers = original.get("approvers") || [];
    if (approvers.indexOf(e.auth.id) === -1) {
      // The update rule should already have refused this; saying the same
      // thing twice costs nothing and the rule is the kind of line that gets
      // edited.
      throw new ForbiddenError("This quote is not yours to change.");
    }

    // An approver may move these three, and nothing else.
    const APPROVER_MAY_SET = ["approvals", "status", "decidedAt"];
    const DECIDABLE = ["in_review", "approved", "rejected"];

    // Start from what is *stored*, not from what was sent, and put back only
    // the three fields above. Reconstructing the record this way rather than
    // walking a list of fields to restore means a field added to this
    // collection later is protected by default — the failure mode of the
    // other direction is a new field silently becoming approver-writable.
    const incoming = e.record.fieldsData();
    const restored = original.fieldsData();
    for (const name of APPROVER_MAY_SET) restored[name] = incoming[name];

    if (DECIDABLE.indexOf(String(restored.status)) === -1) {
      throw new ForbiddenError("An approver can approve or reject a quote, and nothing else.");
    }

    e.record.load(restored);
    e.next();
  }, "quotes");
};
