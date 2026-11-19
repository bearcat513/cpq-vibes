/// <reference path="../../pb_data/types.d.ts" />

/**
 * `sys_physical_location` and `contacts` — the two collections an account's
 * `details` was broken into (1750000014_account_normalize.js).
 *
 * **A location's `name` is its address on one line**: every non-blank part,
 * in order, joined with ", ". Set on every save, by any writer — a request,
 * a hook route, the dashboard — so it cannot drift from the parts it names.
 * `locationName` in src/lib/locations.ts is the same function.
 *
 * **A location nobody points at is removed.** An account's addresses are
 * relations, so replacing one (or deleting the account) would otherwise leave
 * the old record behind, invisible from every customer screen. Only a
 * location *no* account references any more goes.
 *
 * **A contact never holds a password anybody knows.** The collection is
 * auth-typed for a portal that does not exist yet and its authRule is null,
 * but PocketBase still wants a hash; a create without one gets a random one.
 */
module.exports.register = () => {
  onRecordCreate(e => {
    e.record.set("name", require(`${__hooks}/lib/locations.js`).locationName(e.record));
    e.next();
  }, "sys_physical_location");
  onRecordUpdate(e => {
    e.record.set("name", require(`${__hooks}/lib/locations.js`).locationName(e.record));
    e.next();
  }, "sys_physical_location");

  // Model hooks, so the sweep runs in the save's own transaction and goes
  // back with it; the old ids are read before the save, the new after.
  onRecordUpdate(e => {
    const before = [e.record.original().getString("billingAddress"), e.record.original().getString("shippingAddress")];
    e.next();
    require(`${__hooks}/lib/locations.js`).sweepLocations(e.app, before, [e.record.getString("billingAddress"), e.record.getString("shippingAddress")]);
  }, "accounts");
  onRecordDelete(e => {
    const before = [e.record.getString("billingAddress"), e.record.getString("shippingAddress")];
    e.next();
    require(`${__hooks}/lib/locations.js`).sweepLocations(e.app, before, []);
  }, "accounts");

  onRecordCreateRequest(e => {
    if (!e.record.getString("password")) e.record.setPassword($security.randomString(40));
    e.next();
  }, "contacts");
};
