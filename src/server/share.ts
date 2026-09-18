/**
 * The two things this server cannot do on its own, relayed to PocketBase.
 *
 * Both need to turn an email address into an account, which means reading the
 * `users` collection — something no user token may do, and something this
 * server holds no credentials to do either. So the work happens inside
 * PocketBase (docker/pb_hooks/), and these functions are a proxy that carries
 * the caller's own token along, so PocketBase still decides whether they own
 * the record they are talking about.
 *
 *   sharing    — who else may read a product, price book, quote or template
 *   approvers  — which accounts a submitted quote is waiting on
 *
 * The second one exists for the same reason as the first, and has the same
 * shape: the Bun server works out *which* addresses matter (by pricing the
 * quote and running the approval rules), and PocketBase resolves them and
 * writes the relation the rules are evaluated against.
 */
import { ApiError } from "./http";
import { POCKETBASE_URL, toApiError } from "./pocketbase";

/** Collection names as PocketBase knows them, keyed by API path segment. */
const COLLECTIONS = {
  products: "products",
  "price-books": "price_books",
  quotes: "quotes",
  "proposal-templates": "proposal_templates",
} as const;

export type Shareable = keyof typeof COLLECTIONS;

export const SHAREABLE_KINDS = Object.keys(COLLECTIONS) as Shareable[];

export const isShareable = (value: string): value is Shareable => value in COLLECTIONS;

/** What a share endpoint answers with. */
export type Shares = {
  /** The owner's email address — who shared it, when it is not yours. */
  owner: string;
  /** The people it is shared with. Only ever populated for the owner. */
  sharedWith: string[];
  /** Whether this caller may change the list. */
  canShare: boolean;
};

async function relay<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${POCKETBASE_URL}${path}`, {
      ...init,
      headers: { Authorization: token, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw toApiError(error, "Could not reach PocketBase");
  }

  const payload = (await response.json().catch(() => null)) as (T & { message?: string }) | null;

  if (!response.ok) {
    // PocketBase's error shape is { message, status }; the API's is { error }.
    throw new ApiError(payload?.message || "The request failed.", response.status);
  }

  return payload as T;
}

const sharePath = (kind: Shareable, id: string, search = "") =>
  `/api/cpq/shares/${COLLECTIONS[kind]}/${encodeURIComponent(id)}${search}`;

export const listShares = (token: string, kind: Shareable, id: string) =>
  relay<Shares>(token, sharePath(kind, id));

export const addShare = (token: string, kind: Shareable, id: string, email: string) =>
  relay<Shares>(token, sharePath(kind, id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

export const removeShare = (token: string, kind: Shareable, id: string, email: string) =>
  relay<Shares>(token, sharePath(kind, id, `?email=${encodeURIComponent(email)}`), { method: "DELETE" });

/* ------------------------------- approvers ------------------------------- */

export type StampedApprovers = {
  /** Account ids for the addresses that resolved — what the quote now lists. */
  resolved: string[];
  /** Addresses with no account here. The rule is real; the approver is not. */
  unresolved: string[];
};

/**
 * Sets which accounts a quote is waiting on.
 *
 * Only the owner may call it, which PocketBase checks. An address with no
 * account is reported rather than refused: an approval rule naming someone who
 * has not signed up yet is a configuration problem worth surfacing on the
 * quote, not a reason to refuse to submit it.
 */
export const stampApprovers = (token: string, quoteId: string, emails: string[]) =>
  relay<StampedApprovers>(token, `/api/cpq/approvers/${encodeURIComponent(quoteId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emails }),
  });

/* ------------------------------- directory ------------------------------- */

export type DirectoryUser = { id: string; email: string; name: string };

/**
 * The accounts on this instance, for the pickers that name a person.
 *
 * Every signed-in account can read this — see docker/pb_hooks/lib/directory.js
 * for what that does and does not expose. A caller that cannot reach it treats
 * the answer as empty and falls back to typing an address, so an instance that
 * drops the hook keeps working.
 */
export const listDirectory = (token: string, search = "") =>
  relay<{ users: DirectoryUser[]; truncated: boolean }>(
    token,
    `/api/cpq/directory${search ? `?search=${encodeURIComponent(search)}` : ""}`,
  );

export function readEmail(value: unknown): string {
  const email = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!email.includes("@")) throw new ApiError("A valid email address is required.");
  return email;
}
