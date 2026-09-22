/// <reference path="../../pb_data/types.d.ts" />

/**
 * The API-key endpoint and the middleware that honours one.
 *
 * Listing and revoking need no route of their own: the collection's own rules
 * let an owner read and delete their keys, so the Bun server proxies those
 * with the caller's token like any other record. Only issuing needs privilege,
 * because only issuing has to hash a secret and hand it back once.
 */
module.exports.register = () => {
  routerAdd("POST", "/api/cpq/keys", e => require(`${__hooks}/lib/apiKeys.js`).issue(e), $apis.requireAuth("users"));

  // Global, so a key works on every route PocketBase serves — its own REST
  // API included, not just the endpoints this app adds.
  routerUse(e => require(`${__hooks}/lib/apiKeys.js`).authenticate(e));
};
