/**
 * Registration, sign-in, sign-out, and "who am I".
 *
 * All four are thin passes over PocketBase's own `users` collection. The token
 * it issues goes into an httpOnly cookie and is never returned in a response
 * body, so no script on the page can read it or forward it anywhere.
 */
import { ApiError, asRecord, fail, handler, readJson } from "./http";
import { loadContext } from "./context";
import { callHook, clientFor, toApiError } from "./pocketbase";
import {
  clearedSessionCookie,
  isApiKey,
  readToken,
  requireToken,
  sessionCookie,
  toSessionUser,
  type SessionUser,
} from "./session";

/** PocketBase's own minimum for the `users` collection. */
const MIN_PASSWORD = 8;

/** Long enough for any real name, short enough to fit a document's signature line. */
export const MAX_DISPLAY_NAME = 120;

type Credentials = { email: string; password: string; name: string };

function readCredentials(body: Record<string, unknown>, requirePassword = true): Credentials {
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  if (!email.includes("@")) throw new ApiError("A valid email address is required.");

  const password = String(body.password ?? "");
  if (requirePassword && password.length < MIN_PASSWORD) {
    throw new ApiError(`A password of at least ${MIN_PASSWORD} characters is required.`);
  }

  return { email, password, name: String(body.name ?? "").trim() };
}

/** Signs in and answers with the user plus the cookie that carries the token. */
async function authenticate(req: Request, email: string, password: string): Promise<Response> {
  const client = clientFor();
  const auth = await client.collection("users").authWithPassword(email, password);

  // The organization and role come from the same place every later request
  // reads them, so the first paint already knows what to hide.
  const user = await loadContext(auth.token)
    .then(context => context.user)
    .catch(() => toSessionUser(auth.record as unknown as Record<string, unknown>));

  return Response.json(
    { user },
    { headers: { "Set-Cookie": sessionCookie(req, auth.token) } },
  );
}

/**
 * The signed-in user, with their organization and role, or null.
 *
 * Asks PocketBase, which is what proves the credential: an expired, signed-out
 * or forged token and a revoked or expired key all come back as null.
 */
export async function sessionUser(req: Request): Promise<SessionUser | null> {
  const credential = readToken(req);
  if (!credential) return null;
  try {
    return (await loadContext(credential)).user;
  } catch {
    return null;
  }
}

/**
 * Ends the session this request carries — for real.
 *
 * Clearing the cookie only stops *this browser* sending the token; a copy of
 * it would keep working for the rest of the week. So the token is recorded as
 * signed out in PocketBase first (pb_hooks/lib/sessions.js), and refused from
 * then on. `?everywhere=1` rotates the account's token key instead, which ends
 * every session it has.
 *
 * Signing out is never refused: a token PocketBase no longer honours is
 * already as signed out as it gets, and the cookie is cleared either way.
 */
async function signOut(req: Request): Promise<Response> {
  const credential = readToken(req);
  const everywhere = ["1", "true", "yes"].includes(new URL(req.url).searchParams.get("everywhere") ?? "");
  let revoked = false;

  if (credential && !isApiKey(credential)) {
    try {
      await callHook(credential, everywhere ? "/api/cpq/sessions/revoke-all" : "/api/cpq/sessions/revoke", {
        method: "POST",
      });
      revoked = true;
    } catch {
      revoked = false;
    }
  }

  return Response.json(
    { ok: true, revoked, everywhere: everywhere && revoked },
    { headers: { "Set-Cookie": clearedSessionCookie(req) } },
  );
}

export const authRoutes = {
  "/api/auth/register": {
    POST: handler(async req => {
      const { email, password, name } = readCredentials(asRecord(await readJson(req)));

      try {
        await clientFor()
          .collection("users")
          .create({ email, password, passwordConfirm: password, name, emailVisibility: false });
      } catch (error) {
        throw toApiError(error, "Could not create the account");
      }

      // Straight into a session: nobody wants to type it twice.
      const response = await authenticate(req, email, password);
      return new Response(response.body, { status: 201, headers: response.headers });
    }),
  },

  "/api/auth/login": {
    POST: handler(async req => {
      const { email, password } = readCredentials(asRecord(await readJson(req)), false);

      try {
        return await authenticate(req, email, password);
      } catch (error) {
        // PocketBase says "Failed to authenticate"; say which part to fix, and
        // never reveal whether the address exists.
        throw new ApiError("That email and password do not match an account.", 401);
      }
    }),
  },

  "/api/auth/logout": {
    POST: handler(signOut),
  },

  "/api/auth/me": {
    GET: handler(async req => {
      const user = await sessionUser(req);
      if (user) return Response.json({ user });

      // The cookie is stale or forged — clear it so the page stops retrying.
      const hadCookie = Boolean(readToken(req));
      return new Response(JSON.stringify({ error: "Sign in to continue." }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          ...(hadCookie ? { "Set-Cookie": clearedSessionCookie(req) } : {}),
        },
      });
    }),
  },

  /** Your display name — what approvers, members and documents see. */
  "/api/auth/profile": {
    PATCH: handler(async req => {
      const token = requireToken(req);
      const body = asRecord(await readJson(req));
      const name = String(body.name ?? "").trim();
      if (name.length > MAX_DISPLAY_NAME) {
        throw new ApiError(`A name is ${MAX_DISPLAY_NAME} characters at most.`);
      }

      const { user } = await loadContext(token);
      try {
        // The users collection's own rule lets an account update itself and
        // nobody else; this server adds nothing to that.
        await clientFor(token).collection("users").update(user.id, { name });
      } catch (error) {
        throw toApiError(error, "Could not change your name");
      }
      return Response.json({ user: (await loadContext(token)).user });
    }),
  },

  /** Changing your own password. The email is fixed: it is how invitations find you. */
  "/api/auth/password": {
    POST: handler(async req => {
      const token = requireToken(req);
      const body = asRecord(await readJson(req));

      const current = String(body.currentPassword ?? "");
      const next = String(body.newPassword ?? "");
      if (next.length < MIN_PASSWORD) {
        throw new ApiError(`A password of at least ${MIN_PASSWORD} characters is required.`);
      }

      const client = clientFor(token);
      const me = await client
        .collection("users")
        .authRefresh()
        .catch(() => null);
      if (!me) return fail("Sign in to continue.", 401);

      try {
        await client.collection("users").update(me.record.id, {
          oldPassword: current,
          password: next,
          passwordConfirm: next,
        });
      } catch (error) {
        throw toApiError(error, "Could not change the password");
      }

      // PocketBase invalidates every existing token on a password change, so
      // the old cookie is dead — replace it with a fresh session.
      return await authenticate(req, String(me.record.email), next);
    }),
  },
};
