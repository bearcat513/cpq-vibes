/**
 * The PocketBase connection every storage call goes through.
 *
 * One client per request, carrying that caller's own token — this server holds
 * no credentials of its own and can therefore grant no access of its own.
 * Ownership and sharing are enforced by the collection rules in
 * docker/pb_migrations/, evaluated by PocketBase against the real user.
 */
import PocketBase, { ClientResponseError } from "pocketbase";
import { ApiError } from "./http";
import { API_KEY_HEADER, isApiKey } from "./session";

/**
 * Inside Compose this is `http://pocketbase:8080` (the service name on the
 * compose network). Outside it, the fallback is the host port the override
 * file publishes, so `bun dev` works against `bun run docker:up`.
 *
 * 127.0.0.1 rather than "localhost": Bun's fetch tries ::1 first, and the
 * Docker port forward only listens on IPv4.
 */
export const POCKETBASE_URL = (
  process.env.POCKETBASE_URL ?? `http://127.0.0.1:${process.env.PB_PORT || "8091"}`
).replace(/\/+$/, "");

/**
 * A client speaking as `credential`, or anonymously when there is none (which
 * is only ever registration and sign-in).
 *
 * A session token and an API key are the same thing to everything downstream;
 * the difference is only which header carries it. A token goes in
 * `Authorization`, a key in `X-API-Key`, where a hook in PocketBase resolves
 * it to the same account. Every call in db.ts passes one string through
 * without caring which it holds.
 */
export function clientFor(credential?: string): PocketBase {
  const client = new PocketBase(POCKETBASE_URL);

  // Server-side there is no "user navigated away" — the SDK's automatic
  // cancellation of same-key requests would just make concurrent calls fail.
  client.autoCancellation(false);

  if (!credential) return client;

  if (isApiKey(credential)) {
    client.beforeSend = (url, options) => {
      options.headers = { ...options.headers, [API_KEY_HEADER]: credential };
      return { url, options };
    };
    return client;
  }

  // The record is unknown and unneeded: the token is what PocketBase checks,
  // and the SDK sends it on every request once it is in the store.
  client.authStore.save(credential, null);

  return client;
}

export const isNotFound = (error: unknown) => error instanceof ClientResponseError && error.status === 404;

export const isAuthFailure = (error: unknown) =>
  error instanceof ClientResponseError && (error.status === 401 || error.status === 403);

/**
 * Turns an SDK failure into something an API caller can act on.
 *
 * A `ClientResponseError` with status 0 is a connection failure, not a
 * rejected request — that is a 502, because this server is fine and its
 * database is not. PocketBase nests field errors under `data`; the first one
 * says far more than the generic "Failed to create record".
 */
export function toApiError(error: unknown, context: string): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof ClientResponseError) {
    if (error.status === 0) {
      return new ApiError(`${context}: PocketBase is unreachable at ${POCKETBASE_URL}.`, 502);
    }

    // An expired or revoked token reads as "sign in again", not as a failure
    // of whatever was being attempted.
    if (error.status === 401) return new ApiError("Your session has expired — sign in again.", 401);

    const fieldError = Object.entries(error.response?.data ?? {})[0];
    const detail =
      (fieldError && `${fieldError[0]}: ${(fieldError[1] as { message?: string })?.message ?? "invalid value"}`) ||
      error.response?.message ||
      error.message;

    return new ApiError(`${context}: ${detail}`, error.status >= 500 ? 502 : error.status || 400);
  }

  return new ApiError(`${context}: ${error instanceof Error ? error.message : String(error)}`, 502);
}

/**
 * `getList(1, 1)` reports `totalItems` without transferring any records — and
 * the count is already scoped to the caller by the collection's list rule.
 */
export async function countRecords(token: string, collection: string): Promise<number> {
  const list = await clientFor(token).collection(collection).getList(1, 1, { fields: "id" });
  return list.totalItems;
}

/** Whether PocketBase is up, for `/api/meta` — never throws. */
export async function pocketbaseStatus(): Promise<{ url: string; reachable: boolean }> {
  try {
    const response = await fetch(`${POCKETBASE_URL}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return { url: POCKETBASE_URL, reachable: response.ok };
  } catch {
    return { url: POCKETBASE_URL, reachable: false };
  }
}

/**
 * PocketBase stores timestamps as `2026-01-31 12:00:00.000Z`; the API has
 * always handed out ISO-8601, and the UI sorts and formats on that.
 */
export function toIso(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "";
  const parsed = new Date(text.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}
