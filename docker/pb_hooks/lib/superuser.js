/**
 * First-boot superuser provisioning.
 *
 * The Bun API authenticates as this account, so a fresh volume has to come up
 * with it already in place — otherwise the app boots with no way to reach its
 * own database. It is create-once, never upsert: if the password is rotated in
 * the dashboard, a redeploy must not silently reset it to the env value.
 * `bun run docker:init` does that deliberately.
 */

// PocketBase seeds this placeholder for its own web installer flow; it is not
// a real account, so it must not count as "already provisioned".
const INSTALLER_EMAIL = "__pbinstaller@example.com";

const MIN_PASSWORD = 8;

function hasRealSuperuser(app) {
  try {
    app.findFirstRecordByFilter("_superusers", "email != {:installer}", { installer: INSTALLER_EMAIL });
    return true;
  } catch (err) {
    // Throws when no row matches, which is the case we want to act on.
    return false;
  }
}

function ensure(app) {
  const email = String($os.getenv("PB_ADMIN_EMAIL") || "").trim();
  const password = String($os.getenv("PB_ADMIN_PASSWORD") || "");

  if (!email || !password) {
    console.log("[setup] PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD not set — skipping superuser bootstrap");
    return;
  }

  if (password.length < MIN_PASSWORD) {
    console.log(`[setup] PB_ADMIN_PASSWORD is shorter than ${MIN_PASSWORD} characters — refusing to create a superuser`);
    return;
  }

  if (hasRealSuperuser(app)) return;

  try {
    const collection = app.findCollectionByNameOrId("_superusers");
    const record = new Record(collection);
    record.set("email", email);
    record.setPassword(password);
    app.save(record);
    // The address is useful in a deploy log; the password never is.
    console.log(`[setup] created initial superuser ${email}`);
  } catch (err) {
    console.log("[setup] could not create superuser:", String(err));
  }
}

module.exports = { ensure, INSTALLER_EMAIL, MIN_PASSWORD };
