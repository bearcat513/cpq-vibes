/// <reference path="../pb_data/types.d.ts" />

/**
 * The only .pb.js file in this directory — PocketBase loads it once at boot.
 *
 * Everything else is a plain module listed below, exporting `register()`.
 * A handler body cannot see anything outside itself, so a module `require`s
 * its dependencies *inside* the handler, not at the top of the file.
 */
const MODULES = [
  "setup/superuser.js",
  "setup/adopt.js",
  "rules/ownership.js",
  "rules/approvals.js",
  "share/routes.js",
  "keys/routes.js",
];

MODULES.forEach(path => {
  try {
    require(`${__hooks}/${path}`).register();
  } catch (err) {
    // One broken module should not take down the rest.
    console.log(`[hooks] FAILED to register ${path}:`, String(err));
  }
});

console.log(`[hooks] registered ${MODULES.length} module(s)`);
