/**
 * Small helpers shared by the route table in `src/index.ts`.
 * Everything here is plain Bun.serve / Web-standard Request + Response.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function fail(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** Parses a JSON body, turning the raw syntax error into something readable. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) throw new ApiError("Request body is empty; expected JSON.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("Request body must be valid JSON.");
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/* ------------------------------ query params ----------------------------- */

export type Query = URLSearchParams;

export function query(req: Request): Query {
  return new URL(req.url).searchParams;
}

/** `?save=false` / `?save=0` are false; anything else (incl. bare `?save`) is true. */
export function boolParam(params: Query, key: string, fallback: boolean): boolean {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return !["false", "0", "no"].includes(raw.toLowerCase());
}

export function intParam(params: Query, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new ApiError(`"${key}" must be a number (got "${raw}").`);
  return Math.trunc(parsed);
}

export function formatParam(params: Query): "csv" | "json" | null {
  const raw = params.get("format");
  if (raw === null) return null;
  const format = raw.toLowerCase();
  if (format !== "csv" && format !== "json") {
    throw new ApiError(`"format" must be "csv" or "json" (got "${raw}").`);
  }
  return format;
}

/* -------------------------------- wrapper -------------------------------- */

type Handler<T> = (req: Request & T) => Promise<Response> | Response;

/**
 * Wraps a route so thrown errors become the standard `{ error }` JSON shape,
 * and every API call is logged — this runs on a developer's own machine, so
 * seeing the request land is more useful than a silent server.
 */
export function handler<T extends { params?: Record<string, string> }>(fn: Handler<T>): Handler<T> {
  return async (req: Request & T) => {
    const started = performance.now();
    let response: Response;
    try {
      response = await fn(req);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 400;
      response = fail(error instanceof Error ? error.message : "Unexpected error", status);
    }
    const { pathname, search } = new URL(req.url);
    console.log(
      `${req.method} ${pathname}${search} → ${response.status} (${(performance.now() - started).toFixed(1)}ms)`,
    );
    return response;
  };
}
