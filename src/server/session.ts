/**
 * Sessions.
 *
 * The PocketBase token lives in an httpOnly cookie, so page scripts cannot
 * read it, and it is handed straight back to PocketBase on every request that
 * needs data. This server never validates it itself and never acts on anyone's
 * behalf: PocketBase evaluates its own collection rules against the real
 * caller, which is what keeps one account out of another's records even if a
 * route here gets something wrong.
 *
 * An `Authorization: <token>` header is accepted too, for scripts holding a
 * token from PocketBase directly.
 */
import { normalizePreferences, type Preferences } from "../lib/preferences";
import { ApiError } from "./http";

export const SESSION_COOKIE = "cpq_session";

/** PocketBase's user tokens last a week by default; the cookie matches. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  verified: boolean;
  createdAt: string;
  /**
   * Carried on the session so the app has them on its first paint, rather
   * than rendering a default theme and then correcting itself.
   */
  preferences: Preferences;
};

export function toSessionUser(record: Record<string, unknown> | undefined | null): SessionUser {
  return {
    id: String(record?.id ?? ""),
    email: String(record?.email ?? ""),
    name: String(record?.name ?? ""),
    verified: record?.verified === true,
    createdAt: String(record?.created ?? ""),
    // An account made before the preferences field existed has none; the
    // normalizer answers with the defaults rather than with undefined.
    preferences: normalizePreferences(record?.preferences),
  };
}

/**
 * Whether this request arrived over TLS — directly, or through a proxy that
 * terminated it and said so.
 */
function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
  return new URL(req.url).protocol === "https:";
}

/**
 * `Secure` follows the request rather than NODE_ENV.
 *
 * Tying it to the environment looks safer and behaves worse: a production
 * container reached over plain http://localhost — which is how this is run
 * locally — would set a cookie that Safari refuses to store, and sign-in would
 * fail with nothing to show for it. Behind a TLS-terminating proxy the
 * forwarded header is https and the flag comes back.
 */
export function sessionCookie(req: Request, token: string, maxAge = SESSION_MAX_AGE): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Lax keeps the cookie off cross-site POSTs, which is what stops another
    // page from driving this API with your session.
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

export const clearedSessionCookie = (req: Request) => sessionCookie(req, "", 0);

/** Parsed from the header rather than `req.cookies` so plain `Request`s work. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;

  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) {
      return decodeURIComponent(pair.slice(index + 1).trim()) || undefined;
    }
  }
  return undefined;
}

export function readToken(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE) ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? undefined;
}

/**
 * Whether a token is worth sending on: a JWT in shape, and not past its own
 * expiry.
 *
 * This proves nothing about authenticity — the signature is PocketBase's to
 * check, and it does, on every request. It exists because PocketBase answers
 * an unusable token by treating the caller as anonymous, and an anonymous
 * caller matches no ownership rule, so the reply is a perfectly empty list
 * with a 200 on it. A stale cookie should say "sign in again" instead of
 * quietly showing an empty account.
 */
export function isUsableToken(token: string): boolean {
  const payload = token.split(".")[1];
  if (!payload) return false;

  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    // Seconds since the epoch, per the JWT spec.
    return typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export class NoSession extends ApiError {
  constructor() {
    super("Sign in to continue.", 401);
  }
}

export function requireToken(req: Request): string {
  const token = readToken(req);
  if (!token || !isUsableToken(token)) throw new NoSession();
  return token;
}
