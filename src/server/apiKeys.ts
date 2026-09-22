/**
 * API keys.
 *
 * Listing and revoking are ordinary record calls: the collection's own rules
 * let an owner read and delete their keys, and nothing else. Issuing is not —
 * it has to hash a secret, store only the hash, and return the raw value once,
 * so it happens in PocketBase (docker/pb_hooks/lib/apiKeys.js) and this proxies
 * to it with the caller's own token, exactly as sharing does.
 */
import { ApiError } from "./http";
import { clientFor, POCKETBASE_URL, toApiError, toIso } from "./pocketbase";

/** What a caller may know about a key after it exists. Never the key itself. */
export type ApiKey = {
  id: string;
  name: string;
  createdAt: string;
  /** Empty when the key never expires. */
  expiresAt: string;
  /** Empty until it is first used. Written at most every few minutes. */
  lastUsedAt: string;
};

/** The one response that carries the secret, and the only time it exists. */
export type IssuedApiKey = ApiKey & { key: string };

export const MAX_KEY_NAME_LENGTH = 100;

/** Ten years is not "never", but it is past the life of any script. */
export const MAX_EXPIRY_DAYS = 3650;

/** Per account, matching the cap in docker/pb_hooks/lib/apiKeys.js. */
export const MAX_KEYS = 25;

type Row = Record<string, unknown>;

function toApiKey(row: Row): ApiKey {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    createdAt: toIso(row.created),
    expiresAt: toIso(row.expires),
    lastUsedAt: toIso(row.lastUsed),
  };
}

export async function listApiKeys(token: string): Promise<ApiKey[]> {
  try {
    const rows = await clientFor(token).collection("api_keys").getFullList({ sort: "-created" });
    return (rows as unknown as Row[]).map(toApiKey);
  } catch (error) {
    throw toApiError(error, "Could not read your API keys");
  }
}

export async function deleteApiKey(token: string, id: string): Promise<boolean> {
  try {
    await clientFor(token).collection("api_keys").delete(id);
    return true;
  } catch (error) {
    // A key that is not there, and one that is not yours, read the same from
    // outside — this API declines to tell them apart.
    const status = (error as { status?: number })?.status;
    if (status === 404 || status === 403) return false;
    throw toApiError(error, "Could not revoke that API key");
  }
}

export function readKeyInput(body: Record<string, unknown>): { name: string; expiresInDays: number } {
  const name = String(body.name ?? "").trim();
  if (name.length > MAX_KEY_NAME_LENGTH) {
    throw new ApiError(`A key name must be ${MAX_KEY_NAME_LENGTH} characters or fewer.`);
  }

  const raw = body.expiresInDays;
  if (raw === undefined || raw === null || raw === "") return { name, expiresInDays: 0 };

  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    throw new ApiError('"expiresInDays" must be a positive number of days, or left out for a key that never expires.');
  }

  return { name, expiresInDays: Math.min(Math.floor(days), MAX_EXPIRY_DAYS) };
}

/**
 * Issues a key through the hook that can hash it.
 *
 * The caller's token goes along, so PocketBase decides who the key belongs to;
 * this server never names the account.
 */
export async function createApiKey(
  token: string,
  input: { name: string; expiresInDays: number },
): Promise<IssuedApiKey> {
  let response: Response;
  try {
    response = await fetch(`${POCKETBASE_URL}/api/cpq/keys`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw toApiError(error, "Could not reach the key service");
  }

  const payload = (await response.json().catch(() => null)) as (Row & { message?: string }) | null;

  if (!response.ok) {
    // PocketBase's error shape is { message, status }; this API's is { error }.
    throw new ApiError(payload?.message || "Could not issue an API key.", response.status);
  }

  return { ...toApiKey(payload ?? {}), key: String(payload?.key ?? "") };
}
