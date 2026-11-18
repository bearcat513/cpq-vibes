/// <reference path="../../pb_data/types.d.ts" />

/**
 * What an attachment says about itself, set here and never by the request.
 *
 * The create rule in 1750000012_attachments.js decides *whether* a caller may
 * attach a file to a record. This decides what the stored row records:
 *
 * - `owner` is whoever uploaded it.
 * - `org` is the **record's** organization, not the uploader's. An approver
 *   may be in another organization altogether, and the row still has to read
 *   as belonging to the quote's, or nobody there would see it.
 * - `name` and `size` come from the uploaded file itself when PocketBase will
 *   say, so a caller cannot describe a 20 MB file as a 2 KB one.
 *
 * It also caps how many files one record can carry, and — on the other side
 * — removes a record's attachments when the record itself is deleted, since
 * `recordId` is not a relation and nothing would cascade on its own.
 *
 * `sys_attachment` is deliberately not in rules/ownership.js's OWNED: that
 * stamps `org` from the caller, which is exactly wrong here.
 */

module.exports.register = () => {
  onRecordCreateRequest(e => {
    if (e.hasSuperuserAuth()) return e.next();
    if (!e.auth) throw new UnauthorizedError("Sign in to continue.");

    // Mirrors src/lib/attachments.ts. A handler cannot see its file's scope.
    const COLLECTION = { accounts: "accounts", quotes: "quotes", invoices: "invoices", approvals: "quotes" };
    const MAX_PER_RECORD = 50;

    const target = String(e.record.get("target") || "");
    const recordId = String(e.record.get("recordId") || "");
    const collection = COLLECTION[target];
    if (!collection) throw new BadRequestError("Attach a file to a customer, a quote, an invoice or an approval.");

    let record;
    try {
      record = $app.findRecordById(collection, recordId);
    } catch (_) {
      throw new NotFoundError("There is no such record to attach a file to.");
    }

    const already = $app.countRecords(
      "sys_attachment",
      $dbx.hashExp({ target: target, recordId: recordId }),
    );
    if (already >= MAX_PER_RECORD) {
      throw new BadRequestError("That record already carries " + MAX_PER_RECORD + " files. Remove one to add another.");
    }

    e.record.set("owner", e.auth.id);
    e.record.set("org", String(record.get("org") || ""));

    // What was actually uploaded, where PocketBase will tell us.
    try {
      const files = e.record.getUnsavedFiles("file");
      if (files && files.length) {
        const file = files[0];
        if (!String(e.record.get("name") || "").trim()) e.record.set("name", String(file.originalName || file.name));
        e.record.set("size", Number(file.size) || 0);
      }
    } catch (_) {
      // Older runtimes: keep what the request said.
    }

    e.next();
  }, "sys_attachment");

  // `recordId` is not a relation, so deleting a record cascades nothing on its
  // own. Approval attachments hang off the quote and go with it.
  ["accounts", "quotes", "invoices"].forEach(collection => {
    onRecordAfterDeleteSuccess(e => {
      const TARGETS = { accounts: ["accounts"], quotes: ["quotes", "approvals"], invoices: ["invoices"] };
      const targets = TARGETS[e.record.collection().name] || [];
      try {
        const rows = $app.findAllRecords(
          "sys_attachment",
          $dbx.hashExp({ recordId: e.record.id }),
          $dbx.in("target", ...targets),
        );
        rows.forEach(row => $app.delete(row));
      } catch (err) {
        console.log("[attachments] could not remove the files of", e.record.id, String(err));
      }
      e.next();
    }, collection);
  });
};
