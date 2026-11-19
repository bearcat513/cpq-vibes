/// <reference path="../../pb_data/types.d.ts" />

/**
 * `owner`, `org` and `sharedWith` are set here, never by the request body.
 *
 * The collection rules decide who may touch a record; these hooks decide what
 * the record says about itself. Without them a caller could create a record
 * already belonging to another organization, or widen its share list by hand
 * on an ordinary update.
 *
 * A record is created in the organization its creator is working in — for an
 * API key, the one the key was issued in — and never moves. `owner` records
 * who made it; what anybody may do with it is decided by their role in its
 * organization, in the collection rules.
 *
 * Invoices get two more guards, because their numbers have to be gapless: a
 * new invoice is always a draft with a placeholder number, and the only way
 * from draft to issued is POST /api/cpq/invoices/{id}/issue, which takes the
 * next number in the same transaction. The number itself is never writable.
 *
 * Quotes are deliberately absent from the update list: they have a second
 * writer — an approver — and rules/approvals.js handles both cases for them.
 * Their *create* still comes through here.
 *
 * Only *request* hooks are registered, so the hook routes — which save
 * through the app directly — are unaffected. Superusers are left alone too:
 * the dashboard, migrations and maintenance scripts are the one place
 * ownership is set by hand.
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
  // A ledger row records who keyed it in. What it may do is decided by its
  // invoice's organization, in the collection rules — see 1750000010.
  "payments",
  "credits",
  // The data table's form layouts — see 1750000011_record_forms.js.
  "record_forms",
  // An account's people and addresses — see 1750000014_account_normalize.js.
  "contacts",
  "sys_physical_location",
  // Line items — see 1750000016_line_items.js. What they may do is decided
  // by their quote or invoice, in the collection rules.
  "quote_lines",
  "invoice_lines",
];

/** Quotes are updated under rules/approvals.js instead. */
const UPDATE_GUARDED = OWNED.filter(name => name !== "quotes");

module.exports.register = () => {
  OWNED.forEach(collection => {
    onRecordCreateRequest(e => {
      if (e.hasSuperuserAuth()) return e.next();

      // The create rule already requires a token; this is the belt to its braces.
      if (!e.auth) throw new UnauthorizedError("Sign in to continue.");
      const org = String(e.auth.get("org") || "");
      if (!org) throw new ForbiddenError("You are not in an organization. Create one, or ask an admin to invite you.");

      e.record.set("owner", e.auth.id);
      e.record.set("org", org);

      // Sharing is done afterwards, through /api/cpq/shares, which checks the
      // address resolves to a real account. Approvers likewise.
      const fields = e.record.collection().fields;
      if (fields.getByName("sharedWith")) e.record.set("sharedWith", []);
      if (fields.getByName("approvers")) e.record.set("approvers", []);
      // Set by revising, on the quote being revised — never on a new one.
      if (fields.getByName("supersededBy")) e.record.set("supersededBy", "");

      if (e.record.collection().name === "invoices") {
        if (!e.record.id) {
          e.record.set("id", "inv_" + $security.randomStringWithAlphabet(14, "0123456789abcdefghijklmnopqrstuvwxyz"));
        }
        e.record.set("state", "draft");
        e.record.set("number", "DRAFT-" + e.record.id);
      }

      e.next();
    }, collection);
  });

  UPDATE_GUARDED.forEach(collection => {
    onRecordUpdateRequest(e => {
      if (e.hasSuperuserAuth()) return e.next();

      const original = e.record.original();

      // A record cannot change hands or organizations, and the share list
      // cannot be edited by smuggling it into an update.
      e.record.set("owner", original.get("owner"));
      e.record.set("org", original.get("org"));
      if (e.record.collection().fields.getByName("sharedWith")) {
        e.record.set("sharedWith", original.get("sharedWith"));
      }

      if (e.record.collection().name === "invoices") {
        e.record.set("number", original.get("number"));

        // draft → draft, issued → issued or void, void → void. Issuing has
        // its own route; nothing comes back to draft.
        const from = String(original.get("state"));
        const to = String(e.record.get("state"));
        const allowed = { draft: ["draft"], issued: ["issued", "void"], void: ["void"] };
        if ((allowed[from] || [from]).indexOf(to) === -1) {
          throw new BadRequestError(
            from === "draft" && to === "issued"
              ? "Issue an invoice through POST /api/invoices/:id/issue, which numbers it."
              : "An invoice cannot go from " + from + " to " + to + ".",
          );
        }
      }

      e.next();
    }, collection);
  });
};
