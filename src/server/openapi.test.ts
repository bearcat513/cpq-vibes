/**
 * The document is what tools read, so these check its shape rather than its
 * prose: that every reference resolves, that the credentials are described,
 * that the index `GET /api` prints is the same list of endpoints — and, the
 * part most worth catching, that every operation named here is a route
 * `src/index.ts` actually answers on.
 *
 * That last one is what makes the document safe to treat as the only list.
 */
import { describe, expect, test } from "bun:test";
import { buildOpenApiDocument, endpointIndex, OPENAPI_PATH, OPERATIONS } from "./openapi";
import { API_KEY_HEADER, API_KEY_PREFIX, SESSION_COOKIE } from "./session";
import { CURRENCIES, QUOTE_STATUSES } from "../lib/types";
import { DEFAULT_PREFERENCES } from "../lib/preferences";

const document = buildOpenApiDocument({ serverUrl: "http://localhost:3000" });

const components = document.components as {
  schemas: Record<string, unknown>;
  responses: Record<string, unknown>;
  securitySchemes: Record<string, { type?: string; in?: string; name?: string }>;
};

/** Every operation object in the document, with the route it sits on. */
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods as Record<string, Record<string, unknown>>).map(([method, operation]) => ({
    path,
    method,
    operation,
  })),
);

/** Every `$ref` anywhere in the document. */
function refsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(entry => refsIn(entry, found));
  else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === "$ref" && typeof nested === "string") found.push(nested);
      else refsIn(nested, found);
    }
  }
  return found;
}

describe("the document", () => {
  test("is OpenAPI 3.0, which is the version every tool reads", () => {
    expect(document.openapi).toBe("3.0.3");
    expect(document.info).toMatchObject({ title: "CPQ API" });
  });

  test("points at the server it was fetched from", () => {
    expect(document.servers[0]).toMatchObject({ url: "http://localhost:3000" });
    // Without one it still has to name something a tool can call.
    expect(String((buildOpenApiDocument().servers[0] as { url?: string }).url)).toMatch(/^https?:\/\//);
  });

  test("describes all three ways in, as alternatives rather than a set", () => {
    const schemes = components.securitySchemes;
    expect(schemes.apiKey).toMatchObject({ type: "apiKey", in: "header", name: API_KEY_HEADER });
    expect(schemes.userToken).toMatchObject({ in: "header", name: "Authorization" });
    expect(schemes.sessionCookie).toMatchObject({ in: "cookie", name: SESSION_COOKIE });
    expect(document.security).toHaveLength(3);
  });

  test("resolves every reference it makes", () => {
    const defined = new Set([
      ...Object.keys(components.schemas).map(name => `#/components/schemas/${name}`),
      ...Object.keys(components.responses).map(name => `#/components/responses/${name}`),
    ]);
    const missing = [...new Set(refsIn(document))].filter(reference => !defined.has(reference));
    expect(missing).toEqual([]);
  });

  test("gives every operation an id, a summary and a tag, and never repeats an id", () => {
    const ids: string[] = [];
    for (const { path, method, operation } of operations) {
      expect(operation.operationId, `${method} ${path}`).toBeTruthy();
      expect(operation.summary, `${method} ${path}`).toBeTruthy();
      expect(operation.tags, `${method} ${path}`).toHaveLength(1);
      ids.push(String(operation.operationId));
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every tag it declares is used, and every tag used is declared", () => {
    const declared = new Set((document.tags as { name: string }[]).map(tag => tag.name));
    const used = new Set(operations.map(({ operation }) => (operation.tags as string[])[0]!));
    expect([...used].filter(tag => !declared.has(tag))).toEqual([]);
    expect([...declared].filter(tag => !used.has(tag))).toEqual([]);
  });

  test("says which endpoints need no credential, and they are the four you would expect", () => {
    const open = operations
      .filter(({ operation }) => Array.isArray(operation.security) && (operation.security as unknown[]).length === 0)
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();

    expect(open).toEqual([
      "GET /api",
      `GET ${OPENAPI_PATH}`,
      "GET /api/health",
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "POST /api/auth/register",
    ].sort());
  });

  test("gives every guarded operation a 401, and every operation a 400", () => {
    for (const { path, method, operation } of operations) {
      const responses = operation.responses as Record<string, unknown>;
      expect(responses["400"], `${method} ${path}`).toBeDefined();
      const anonymous = Array.isArray(operation.security) && (operation.security as unknown[]).length === 0;
      if (!anonymous) expect(responses["401"], `${method} ${path}`).toBeDefined();
    }
  });

  test("lists a success before the failures, so a tool shows the useful one first", () => {
    for (const { path, method, operation } of operations) {
      const [first] = Object.keys(operation.responses as Record<string, unknown>);
      expect(Number(first), `${method} ${path}`).toBeLessThan(300);
    }
  });
});

describe("the vocabularies it promises", () => {
  test("are imported rather than retyped, so it cannot offer a value the server refuses", () => {
    const schemas = components.schemas as Record<string, { properties?: Record<string, { enum?: unknown[] }> }>;
    expect(schemas.Quote?.properties?.status?.enum).toEqual([...QUOTE_STATUSES]);
    expect(schemas.QuoteTotals?.properties?.currency?.enum).toEqual([...CURRENCIES]);
  });

  test("describe every preference the account actually has", () => {
    const preferences = components.schemas.Preferences as { properties: Record<string, unknown> };
    expect(Object.keys(preferences.properties).sort()).toEqual(Object.keys(DEFAULT_PREFERENCES).sort());
  });
});

describe("the index GET /api prints", () => {
  test("is the same list of endpoints, written the way the route table writes them", () => {
    const index = endpointIndex();
    expect(Object.keys(index)).toHaveLength(OPERATIONS.length);
    expect(index["GET    /api/quotes/:id/document"]).toBeTruthy();
    // `{id}` is OpenAPI's spelling; the index uses the route table's.
    expect(Object.keys(index).some(line => line.includes("{"))).toBe(false);
  });
});

describe("every documented endpoint", () => {
  /**
   * The route table, read as text.
   *
   * Importing `src/index.ts` would start a server on the port, so this reads
   * the file instead — crude, and it catches the failure that matters: an
   * endpoint documented under a path nothing answers on.
   */
  const routes = new Set<string>();
  const source = require("node:fs").readFileSync(new URL("../index.ts", import.meta.url), "utf8") as string;
  for (const match of source.matchAll(/^\s*(?:\[OPENAPI_PATH\]|"(\/[^"]*)"):\s*\{?/gm)) {
    routes.add(match[1] ?? OPENAPI_PATH);
  }
  // The auth routes live in their own module and are spread in.
  const authSource = require("node:fs").readFileSync(new URL("./auth.ts", import.meta.url), "utf8") as string;
  for (const match of authSource.matchAll(/"(\/api\/auth\/[^"]*)":/g)) routes.add(match[1]!);

  test("sits on a path the route table answers on", () => {
    const missing = OPERATIONS.map(operation => operation.path.replace(/\{(\w+)\}/g, ":$1")).filter(
      path => !routes.has(path),
    );
    expect(missing).toEqual([]);
  });
});
