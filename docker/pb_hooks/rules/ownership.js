/// <reference path="../../pb_data/types.d.ts" />

/**
 * `owner` and `sharedWith` are set here, never by the request body.
 *
 * The collection rules decide who may touch a record; these hooks decide what
 * the record says about itself. Without them a caller could create a record
 * already owned by someone else, or widen its share list by hand on an
 * ordinary update.
 *
 * Quotes are deliberately absent from the update list: they have a second
 * writer — an approver — and rules/approvals.js handles both cases for them.
 * Their *create* still comes through here, since a quote is created by its
 * owner like anything else.
 *
 * Only *request* hooks are registered, so the sharing and approver endpoints —
 * which save records directly through the app — are unaffected. Superusers are
 * left alone too: the dashboard, migrations and maintenance scripts are the
 * one place ownership is set by hand.
 */
const OWNED = [
  "accounts",
  "products",
  "price_books",
  "pricing_rules",
  "approval_rules",
  "proposal_templates",
  "quotes",
  "invoices",
];

/** Quotes are updated under rules/approvals.js instead. */
const UPDATE_GUARDED = OWNED.filter(name => name !== "quotes");

module.exports.register = () => {
  OWNED.forEach(collection => {
    onRecordCreateRequest(e => {
      if (e.hasSuperuserAuth()) return e.next();

      // The create rule already requires a token; this is the belt to its braces.
      if (!e.auth) throw new UnauthorizedError("Sign in to continue.");

      e.record.set("owner", e.auth.id);

      // Sharing is done afterwards, through /api/cpq/shares, which checks the
      // address resolves to a real account. Approvers likewise.
      const fields = e.record.collection().fields;
      if (fields.getByName("sharedWith")) e.record.set("sharedWith", []);
      if (fields.getByName("approvers")) e.record.set("approvers", []);

      e.next();
    }, collection);
  });

  UPDATE_GUARDED.forEach(collection => {
    onRecordUpdateRequest(e => {
      if (e.hasSuperuserAuth()) return e.next();

      const original = e.record.original();

      // A record cannot change hands, and the share list cannot be edited by
      // smuggling it into an update — both are restored to what they were.
      e.record.set("owner", original.get("owner"));
      if (e.record.collection().fields.getByName("sharedWith")) {
        e.record.set("sharedWith", original.get("sharedWith"));
      }

      e.next();
    }, collection);
  });
};
