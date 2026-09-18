/// <reference path="../../pb_data/types.d.ts" />

/**
 * The endpoints that need to read the user list, under PocketBase's own
 * router.
 *
 * `$apis.requireAuth()` rejects anonymous callers before the handler runs, so
 * `e.auth` is always a real account below. The Bun server proxies these with
 * the caller's token — it never speaks for anyone.
 */
module.exports.register = () => {
  const shares = "/api/cpq/shares/{collection}/{id}";

  routerAdd("GET", shares, e => require(`${__hooks}/lib/sharing.js`).list(e), $apis.requireAuth());
  routerAdd("POST", shares, e => require(`${__hooks}/lib/sharing.js`).add(e), $apis.requireAuth());
  routerAdd("DELETE", shares, e => require(`${__hooks}/lib/sharing.js`).remove(e), $apis.requireAuth());

  routerAdd("POST", "/api/cpq/approvers/{id}", e => require(`${__hooks}/lib/approvers.js`).stamp(e), $apis.requireAuth());

  // Who this instance's accounts are — see lib/directory.js for what that
  // exposes and how to turn it off.
  routerAdd("GET", "/api/cpq/directory", e => require(`${__hooks}/lib/directory.js`).list(e), $apis.requireAuth());
};
