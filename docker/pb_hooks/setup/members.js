/// <reference path="../../pb_data/types.d.ts" />

/**
 * Accounts and the organizations they work in.
 *
 * `users.org` and `users.role` are what every collection rule reads, so no
 * request may write them — not on create, where a registration could name
 * itself an admin of somebody else's company, and not on update, where the
 * account's own update rule would otherwise let it. They are cleared or
 * restored here and set only by lib/orgs.js.
 *
 * Registration is open by default. `CPQ_SIGNUP=invite` closes it to anyone an
 * organization has not invited — except the very first account, which has
 * nobody to invite it.
 *
 * Replaces setup/adopt.js: adopting the pre-accounts records is now one step
 * of onboarding the first account, because those records need an
 * organization as well as an owner.
 *
 * As everywhere here, a handler body cannot see this file's scope, so each
 * one requires what it needs inside itself.
 */
module.exports.register = () => {
  onRecordCreateRequest(e => {
    if (e.hasSuperuserAuth()) return e.next();

    e.record.set("org", "");
    e.record.set("role", "");

    const mode = String($os.getenv("CPQ_SIGNUP") || "open")
      .trim()
      .toLowerCase();
    if (mode === "invite" && e.app.countRecords("users") > 0) {
      const email = String(e.record.email() || "")
        .trim()
        .toLowerCase();
      let invited = false;
      try {
        e.app.findFirstRecordByFilter("invitations", "email = {:email}", { email: email });
        invited = true;
      } catch (err) {
        invited = false;
      }
      if (!invited) {
        throw new ForbiddenError("Sign-up on this instance is by invitation. Ask an admin to invite this address.");
      }
    }

    e.next();
  }, "users");

  onRecordUpdateRequest(e => {
    if (e.hasSuperuserAuth()) return e.next();

    const original = e.record.original();
    e.record.set("org", original.get("org"));
    e.record.set("role", original.get("role"));
    e.next();
  }, "users");

  onRecordAfterCreateSuccess(e => {
    e.next();
    try {
      require(`${__hooks}/lib/orgs.js`).onboard(e.app, e.record);
    } catch (err) {
      // An account with no organization can still sign in and create one;
      // failing the registration would strand the address instead.
      console.log("[members] could not onboard " + e.record.email() + ":", String(err));
    }
  }, "users");
};
