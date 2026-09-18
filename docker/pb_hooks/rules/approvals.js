/// <reference path="../../pb_data/types.d.ts" />

/**
 * A quote has two writers, and they may do very different things to it.
 *
 * **Its owner** edits it freely — lines, prices, discounts, status — but may
 * not change who owns it, who it is shared with, or who it is waiting on.
 * Those three are set through endpoints that check something first.
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
    const isOwner = original.get("owner") === e.auth.id;

    // Set by /api/cpq/approvers, never by a request body.
    const restoreRelations = () => {
      e.record.set("owner", original.get("owner"));
      e.record.set("sharedWith", original.get("sharedWith"));
      e.record.set("approvers", original.get("approvers"));
    };

    if (isOwner) {
      restoreRelations();
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
