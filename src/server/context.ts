/**
 * Who is asking, where they are working, and as what — for one request.
 *
 * The collection rules in PocketBase are what grant anything; this server
 * still holds no credentials and decides nothing about access on its own.
 * But it needs to *know* three things the rules know, and it asks PocketBase
 * for them once per request (GET /api/cpq/context, in pb_hooks/lib/orgs.js):
 *
 * - **The organization's time zone**, because "today" is a date in its
 *   calendar (src/lib/clock.ts) and the pricing engine, the invoice lifecycle
 *   and the expiry of a quote all read it.
 * - **The caller's role**, so an operation that writes many records — a
 *   sample install, a catalogue import — is refused before the first write
 *   rather than halfway through, and so the UI can hide what it would refuse.
 * - **Who the caller is**, for the approval inbox and a decision's audit
 *   line, which used to cost a round trip each.
 *
 * Asking PocketBase rather than decoding the token is deliberate: for an API
 * key it answers with the key's organization and role, which is exactly what
 * the rules will apply, and it proves the credential before anything else
 * runs.
 *
 * The answer rides along the request in an AsyncLocalStorage, so pure code in
 * src/lib reads "today" without anything having to be threaded through it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isTimeZone, setTimeZoneProvider } from "../lib/clock";
import {
  can,
  isRole,
  normalizeOrgSettings,
  type Membership,
  type Organization,
  type Permission,
  type Role,
} from "../lib/organization";
import { normalizePreferences } from "../lib/preferences";
import { ApiError } from "./http";
import { callHook } from "./pocketbase";
import type { SessionUser } from "./session";

export type RequestContext = {
  user: SessionUser;
  org: Organization | null;
  role: Role | "";
  memberships: Membership[];
  /** Which kind of credential arrived — a key may not manage members or keys. */
  credential: "session" | "key";
};

type RawContext = {
  user?: Record<string, unknown>;
  org?: { id?: string; name?: string; settings?: unknown } | null;
  role?: string;
  memberships?: Array<{ id?: string; org?: { id?: string; name?: string }; role?: string }>;
  credential?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

// "Today" on this server is the requesting organization's today. Outside a
// request — a test, a script — there is no zone, and it is UTC.
setTimeZoneProvider(() => storage.getStore()?.org?.settings.timeZone || undefined);

export function toContext(raw: RawContext): RequestContext {
  const record = raw.user ?? {};
  const org = raw.org && raw.org.id
    ? { id: String(raw.org.id), name: String(raw.org.name ?? ""), settings: normalizeOrgSettings(raw.org.settings, isTimeZone) }
    : null;
  const role = org && isRole(raw.role) ? raw.role : "";

  const memberships: Membership[] = (raw.memberships ?? [])
    .filter(entry => entry?.org?.id && isRole(entry.role))
    .map(entry => ({
      id: String(entry.id ?? ""),
      org: { id: String(entry.org?.id), name: String(entry.org?.name ?? "") },
      role: entry.role as Role,
    }));

  return {
    user: {
      id: String(record.id ?? ""),
      email: String(record.email ?? ""),
      name: String(record.name ?? ""),
      verified: record.verified === true,
      createdAt: String(record.created ?? ""),
      preferences: normalizePreferences(record.preferences),
      org,
      role,
      memberships,
    },
    org,
    role,
    memberships,
    credential: raw.credential === "key" ? "key" : "session",
  };
}

/** Asks PocketBase who `credential` is. Throws a 401 for one it will not honour. */
export async function loadContext(credential: string): Promise<RequestContext> {
  return toContext(await callHook<RawContext>(credential, "/api/cpq/context"));
}

/** Runs `fn` with `context` as the current request's. */
export function withContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current request's context, if there is one. */
export const currentContext = (): RequestContext | undefined => storage.getStore();

/** The current request's context; a route that needs it and has none is a bug. */
export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (!context) throw new ApiError("Sign in to continue.", 401);
  return context;
}

/**
 * Refuses up front what the collection rules would refuse anyway — for the
 * operations that would otherwise fail halfway through a batch of writes.
 */
export function requirePermission(permission: Permission, what: string): RequestContext {
  const context = requireContext();
  if (!context.org) {
    throw new ApiError("You are not in an organization. Create one, or ask an admin to invite you.", 403);
  }
  if (!can(context.role, permission)) {
    throw new ApiError(`Your role (${context.role || "none"}) cannot ${what}.`, 403);
  }
  return context;
}
