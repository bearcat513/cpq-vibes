/// <reference path="../../pb_data/types.d.ts" />

/**
 * What rules/locations.js does, as functions its handlers `require` — a
 * handler cannot see its file's scope, closures included.
 */

/** Every non-blank part, in order, joined with ", ". Same as `locationName` in src/lib/locations.ts. */
function locationName(record) {
  return ["line1", "line2", "city", "state", "postalCode", "country"]
    .map(part => String(record.getString(part) || "").trim())
    .filter(part => part !== "")
    .join(", ");
}

/**
 * Removes each location id in `before` that is not in `after`, unless some
 * account still names it.
 */
function sweepLocations(app, before, after) {
  const ids = [];
  before.forEach(id => {
    id = String(id || "");
    if (id && ids.indexOf(id) === -1 && after.indexOf(id) === -1) ids.push(id);
  });

  ids.forEach(id => {
    const still = app.countRecords("accounts", $dbx.or($dbx.hashExp({ billingAddress: id }), $dbx.hashExp({ shippingAddress: id })));
    if (still > 0) return;
    try {
      app.delete(app.findRecordById("sys_physical_location", id));
    } catch (err) {
      // Already gone. A failed sweep only leaves an orphan behind.
    }
  });
}

module.exports = { locationName, sweepLocations };
