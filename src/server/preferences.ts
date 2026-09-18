/**
 * Reading and writing the signed-in account's preferences.
 *
 * They live in a `preferences` JSON field on the account's own `users` record
 * (docker/pb_migrations/1750000002_user_preferences.js), so the same rule that
 * already says an account may only read and update itself is what keeps one
 * account's preferences out of another's reach — this file grants nothing.
 *
 * Nothing is written until `normalizePreferences` has been over it, so the
 * stored blob is always a complete, in-range preference set whatever the
 * request body claimed.
 */
import { normalizePreferences, type Preferences } from "../lib/preferences";
import { clientFor, toApiError } from "./pocketbase";

/**
 * The caller's own record, as PocketBase understands it — the refresh is what
 * proves the token, and it hands back the record the token belongs to, so
 * there is no id to take from the request.
 */
async function ownRecord(token: string): Promise<Record<string, unknown>> {
  try {
    const auth = await clientFor(token).collection("users").authRefresh();
    return auth.record as unknown as Record<string, unknown>;
  } catch (error) {
    throw toApiError(error, "Could not read your account");
  }
}

export async function readPreferences(token: string): Promise<Preferences> {
  return normalizePreferences((await ownRecord(token)).preferences);
}

export async function writePreferences(token: string, raw: unknown): Promise<Preferences> {
  const preferences = normalizePreferences(raw);
  const me = await ownRecord(token);

  try {
    await clientFor(token).collection("users").update(String(me.id), { preferences });
  } catch (error) {
    throw toApiError(error, "Could not save your preferences");
  }

  return preferences;
}
