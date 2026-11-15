/// <reference path="../../pb_data/types.d.ts" />

/**
 * Organizations, members, numbering and sessions, under PocketBase's own
 * router.
 *
 * Every one of these writes something no request may write for itself, which
 * is why they are routes here rather than record calls from the Bun server.
 * Each checks the caller's role itself — see lib/orgs.js — because saving
 * through the app bypasses the collection rules.
 */
module.exports.register = () => {
  // Called here, at registration, not inside a handler — so the closure is
  // fine. The handlers themselves still require their module inside.
  const auth = () => $apis.requireAuth("users");

  routerAdd("GET", "/api/cpq/context", e => require(`${__hooks}/lib/orgs.js`).context(e), auth());

  routerAdd("GET", "/api/cpq/org/members", e => require(`${__hooks}/lib/orgs.js`).members(e), auth());
  routerAdd("POST", "/api/cpq/org/members", e => require(`${__hooks}/lib/orgs.js`).addMember(e), auth());
  routerAdd("PATCH", "/api/cpq/org/members/{id}", e => require(`${__hooks}/lib/orgs.js`).updateMember(e), auth());
  routerAdd("DELETE", "/api/cpq/org/members/{id}", e => require(`${__hooks}/lib/orgs.js`).removeMember(e), auth());
  routerAdd("DELETE", "/api/cpq/org/invitations/{id}", e => require(`${__hooks}/lib/orgs.js`).revokeInvitation(e), auth());
  routerAdd("POST", "/api/cpq/org/switch", e => require(`${__hooks}/lib/orgs.js`).switchOrg(e), auth());
  routerAdd("POST", "/api/cpq/orgs", e => require(`${__hooks}/lib/orgs.js`).createOrg(e), auth());

  routerAdd("POST", "/api/cpq/numbers/{kind}", e => require(`${__hooks}/lib/orgs.js`).takeNumber(e), auth());
  routerAdd("POST", "/api/cpq/invoices/{id}/issue", e => require(`${__hooks}/lib/orgs.js`).issueInvoice(e), auth());

  routerAdd("POST", "/api/cpq/sessions/revoke", e => require(`${__hooks}/lib/sessions.js`).revoke(e), auth());
  routerAdd("POST", "/api/cpq/sessions/revoke-all", e => require(`${__hooks}/lib/sessions.js`).revokeAll(e), auth());

  // Global, like the API-key middleware: a signed-out token is refused on
  // PocketBase's own REST API too, not just on these routes.
  routerUse(e => require(`${__hooks}/lib/sessions.js`).refuseRevoked(e));

  cronAdd("cpq_revoked_tokens", "17 3 * * *", () => require(`${__hooks}/lib/sessions.js`).sweep($app));
};
