/**
 * Registration, sign-in, sign-out, and "who am I".
 *
 * All four are thin passes over PocketBase's own `users` collection. The token
 * it issues goes into an httpOnly cookie and is never returned in a response
 * body, so no script on the page can read it or forward it anywhere.
 */
import { ApiError, asRecord, fail, handler, readJson } from "./http";
import { clientFor, toApiError } from "./pocketbase";
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

  return Response.json(
    { user: toSessionUser(auth.record as unknown as Record<string, unknown>) },
    { headers: { "Set-Cookie": sessionCookie(req, auth.token) } },
  );
}

/** The signed-in user, or null — asks PocketBase, which is what proves it. */
export async function sessionUser(req: Request): Promise<SessionUser | null> {
  const credential = readToken(req);
  if (!credential) return null;

  try {
    if (isApiKey(credential)) {
      // A key has no token to refresh. The `users` list rule is
      // `id = @request.auth.id`, so a listing of that collection holds exactly
      // one record — the account the key belongs to — which is both the answer
      // and the proof that the key is still good.
      const list = await clientFor(credential).collection("users").getList(1, 1);
      const record = list.items[0] as unknown as Record<string, unknown> | undefined;
      return record ? toSessionUser(record) : null;
    }

    // A refresh is the only way to know the token has not been revoked.
    const auth = await clientFor(credential).collection("users").authRefresh();
    return toSessionUser(auth.record as unknown as Record<string, unknown>);
  } catch {
    return null;
  }
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
    POST: handler(req => Response.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie(req) } })),
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

  /** Changing your own password. Everything else about an account is fixed. */
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
