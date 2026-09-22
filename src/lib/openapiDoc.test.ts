/**
 * Reading a document, rather than writing one.
 *
 * These use small hand-written documents instead of the real one: the point is
 * that the reader survives a document that has drifted — a `$ref` that leads
 * nowhere, a schema that contains itself, a server entry that names a host the
 * reader is not on — because a reference page is exactly what somebody opens
 * when something has gone wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  anchorId,
  buildRequest,
  constraints,
  exampleBody,
  exampleFor,
  fillPath,
  groupByTag,
  matches,
  queryString,
  readOperations,
  requestUrl,
  resolve,
  refName,
  serverChoices,
  tagId,
  trialCurl,
  typeLabel,
  NO_CREDENTIAL,
  type OpenApiDoc,
  type Operation,
} from "./openapiDoc";
import { API_KEY_VARIABLE, TOKEN_VARIABLE } from "./curl";

const doc: OpenApiDoc = {
  servers: [{ url: "https://cpq.example.com" }],
  tags: [
    { name: "Quotes", description: "Writing and pricing a quote." },
    { name: "Unused", description: "Declared, never used." },
  ],
  paths: {
    "/api/quotes": {
      get: {
        tags: ["Quotes"],
        operationId: "listQuotes",
        summary: "List quotes",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 25 } }],
        responses: { "200": { description: "The quotes.", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Quote" } } } } } },
      },
      post: {
        tags: ["Quotes"],
        operationId: "createQuote",
        summary: "Create a quote",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/QuoteInput" } } } },
        responses: { "201": { description: "Created." }, "400": { description: "Refused." } },
      },
    },
    "/api/quotes/{id}": {
      get: {
        tags: ["Receivables"],
        operationId: "getQuote",
        summary: "Read one quote",
        security: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The quote." } },
      },
    },
  },
  components: {
    schemas: {
      Quote: {
        type: "object",
        properties: {
          number: { type: "string" },
          currency: { type: "string", enum: ["USD", "EUR"] },
          total: { type: "number", minimum: 0 },
          // A quote that supersedes a quote: the loop the reader has to survive.
          supersedes: { $ref: "#/components/schemas/Quote" },
        },
      },
      QuoteInput: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, validUntil: { type: "string", format: "date" } },
      },
      Circular: { $ref: "#/components/schemas/Circular" },
    },
  },
};

const operations = readOperations(doc);
const find = (id: string): Operation => operations.find(operation => operation.operationId === id)!;

describe("reading a document", () => {
  test("finds every operation, in the order it was written", () => {
    expect(operations.map(operation => operation.operationId)).toEqual(["listQuotes", "createQuote", "getQuote"]);
  });

  test("reads `security: []` as the one thing that needs no credential", () => {
    expect(find("getQuote").anonymous).toBe(true);
    expect(find("listQuotes").anonymous).toBe(false);
  });

  test("orders responses with the success first", () => {
    expect(find("createQuote").responses.map(response => response.status)).toEqual(["201", "400"]);
  });

  test("reads the request body's first media type", () => {
    expect(find("createQuote").body).toMatchObject({ required: true, mediaType: "application/json" });
    expect(find("listQuotes").body).toBeNull();
  });
});

describe("grouping", () => {
  const groups = groupByTag(doc, operations);

  test("drops a tag the document declares but never uses", () => {
    expect(groups.map(group => group.name)).toEqual(["Quotes", "Receivables"]);
  });

  test("keeps a tag used without being declared, rather than losing its operations", () => {
    expect(groups.find(group => group.name === "Receivables")?.operations).toHaveLength(1);
  });

  test("spells an anchor the same way the sidebar links to it", () => {
    expect(tagId("API keys")).toBe("tag-api-keys");
  });
});

describe("references", () => {
  test("names what a $ref points at", () => {
    expect(refName({ $ref: "#/components/schemas/Quote" })).toBe("Quote");
    expect(refName({ type: "string" })).toBeNull();
  });

  test("resolves one that leads nowhere to an empty object rather than throwing", () => {
    expect(resolve(doc, { $ref: "#/components/schemas/Nothing" })).toEqual({});
  });

  test("resolves one that points at itself the same way", () => {
    expect(resolve(doc, { $ref: "#/components/schemas/Circular" })).toEqual({});
  });
});

describe("describing a schema", () => {
  test("names a type in as few words as it takes", () => {
    expect(typeLabel(doc, { $ref: "#/components/schemas/Quote" })).toBe("Quote");
    expect(typeLabel(doc, { type: "array", items: { $ref: "#/components/schemas/Quote" } })).toBe("Quote[]");
    expect(typeLabel(doc, { type: "string", format: "date" })).toBe("string · date");
    expect(typeLabel(doc, { type: "string", enum: ["a"] })).toBe("string · enum");
  });

  test("prints the bounds worth reading beside a field", () => {
    expect(constraints({ default: 25, minimum: 0 })).toEqual(["default 25", "min 0"]);
    expect(constraints({ type: "string" })).toEqual([]);
  });

  test("stops an example at a schema that contains itself", () => {
    const example = exampleFor(doc, { $ref: "#/components/schemas/Quote" }) as Record<string, unknown>;
    expect(example.supersedes).toBeNull();
    // An enum's first value is a better stand-in than the word "string".
    expect(example.currency).toBe("USD");
    expect(example.total).toBe(0);
  });

  test("prints a body box someone can edit and send", () => {
    const body = exampleBody(doc, find("createQuote").body);
    expect(JSON.parse(body)).toEqual({ name: "string", validUntil: new Date().toISOString().slice(0, 10) });
  });
});

describe("composing a trial request", () => {
  test("fills a path parameter, and leaves an empty one in place to be seen", () => {
    expect(fillPath("/api/quotes/{id}", { id: "q_1" })).toBe("/api/quotes/q_1");
    expect(fillPath("/api/quotes/{id}", {})).toBe("/api/quotes/{id}");
  });

  test("sends only the query parameters that were given a value", () => {
    const parameters = find("listQuotes").parameters;
    expect(queryString(parameters, { limit: "10" })).toBe("?limit=10");
    expect(queryString(parameters, { limit: "  " })).toBe("");
  });

  test("aims at the page's own origin first, since that is the one a call can reach", () => {
    expect(serverChoices(doc, "http://localhost:3000")).toEqual([
      "http://localhost:3000",
      "https://cpq.example.com",
    ]);
    // Where the two agree there is nothing to choose between.
    expect(serverChoices(doc, "https://cpq.example.com/")).toEqual(["https://cpq.example.com"]);
  });

  test("puts the body and its content type on a POST, and neither on a GET", () => {
    const post = buildRequest(find("createQuote"), {
      base: "http://localhost:3000",
      values: {},
      body: '{"name":"Acme"}',
      credential: { kind: "apiKey", value: "cpq_secret" },
    });
    expect(post.body).toBe('{"name":"Acme"}');
    expect(post.headers).toContainEqual({ name: "Content-Type", value: "application/json" });
    expect(post.headers).toContainEqual({ name: "X-API-Key", value: "cpq_secret" });

    const get = buildRequest(find("listQuotes"), {
      base: "http://localhost:3000",
      values: { limit: "5" },
      body: "ignored",
      credential: NO_CREDENTIAL,
    });
    expect(get.body).toBeUndefined();
    expect(get.headers).toEqual([]);
    expect(get.url).toBe("http://localhost:3000/api/quotes?limit=5");
  });

  test("builds the URL from the base, the filled path and the query", () => {
    expect(requestUrl("http://localhost:3000/", find("getQuote"), { id: "q 1" })).toBe(
      "http://localhost:3000/api/quotes/q%201",
    );
  });
});

describe("the cURL command beside it", () => {
  const request = buildRequest(find("createQuote"), {
    base: "http://localhost:3000",
    values: {},
    body: '{"name":"Acme"}',
    credential: { kind: "apiKey", value: "cpq_the_real_secret" },
  });

  test("prints the credential as a shell variable, never as itself", () => {
    const command = trialCurl(request);
    expect(command).not.toContain("cpq_the_real_secret");
    expect(command).toContain(`$${API_KEY_VARIABLE}`);
  });

  test("does the same for a raw user token", () => {
    const withToken = buildRequest(find("listQuotes"), {
      base: "http://localhost:3000",
      values: {},
      body: "",
      credential: { kind: "token", value: "eyJhbGciOi" },
    });
    expect(trialCurl(withToken)).toContain(`$${TOKEN_VARIABLE}`);
    expect(trialCurl(withToken)).not.toContain("eyJhbGciOi");
  });

  test("quotes a body with an apostrophe in it so the shell still runs the right command", () => {
    const quoted = trialCurl(
      buildRequest(find("createQuote"), {
        base: "http://localhost:3000",
        values: {},
        body: `{"name":"O'Neill"}`,
        credential: NO_CREDENTIAL,
      }),
    );
    expect(quoted).toContain(`O'\\''Neill`);
  });
});

describe("finding an endpoint", () => {
  test("narrows on every term, so terms narrow rather than widen", () => {
    expect(matches(find("listQuotes"), "quotes list")).toBe(true);
    expect(matches(find("listQuotes"), "quotes invoices")).toBe(false);
    expect(matches(find("listQuotes"), "")).toBe(true);
  });

  test("anchors on the operationId, which is already unique and already stable", () => {
    expect(anchorId(find("listQuotes"))).toBe("op-listQuotes");
    expect(anchorId({ ...find("listQuotes"), operationId: "" })).toBe("op-get-api-quotes");
  });
});
