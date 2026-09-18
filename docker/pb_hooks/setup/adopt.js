/// <reference path="../../pb_data/types.d.ts" />

/**
 * Hands the single-tenant leftovers to the first account that registers.
 *
 * Everything created before the accounts migration has no owner, which means
 * no rule matches it and nobody can see it. Rather than stranding that data,
 * the first user to sign up inherits it — the tool was theirs alone until the
 * moment accounts existed.
 *
 * Only ever the *first* account: for every later registration this is a no-op,
 * so a second user cannot walk in and claim anything.
 *
 * Note the shape of the handler below. A hook body runs in its own scope and
 * cannot see anything declared in this file outside it, so the collection list
 * and every helper live *inside* the callback. Hoisting either one out is the
 * kind of change that still registers cleanly and then fails at runtime.
 */
module.exports.register = () => {
  onRecordAfterCreateSuccess(e => {
    e.next();

    const owned = ["accounts", "products", "price_books", "pricing_rules", "approval_rules", "proposal_templates", "quotes"];

    try {
      // Anyone but the very first account leaves this alone.
      if (e.app.countRecords("users") !== 1) return;

      let adopted = 0;
      for (const collection of owned) {
        const orphans = e.app.findAllRecords(collection, $dbx.exp("owner = '' OR owner IS NULL"));
        for (const record of orphans) {
          record.set("owner", e.record.id);
          e.app.save(record);
          adopted++;
        }
      }

      if (adopted > 0) {
        console.log(`[setup] ${e.record.email()} is the first account — adopted ${adopted} pre-accounts record(s)`);
      }
    } catch (err) {
      // Never fail a registration over this.
      console.log("[setup] could not adopt pre-accounts records:", String(err));
    }
  }, "users");
};
