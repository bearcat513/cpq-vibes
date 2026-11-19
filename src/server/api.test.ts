/**
 * End-to-end tests against a real Bun.serve process talking to a real
 * PocketBase, so the route table, the storage layer, the migration's access
 * rules and the hooks are all exercised for real.
 *
 * The PocketBase is a throwaway container on its own port and its own empty
 * volume (see ./testPocketBase.ts). Without Docker, everything that needs an
 * account skips, and the handful of anonymous routes still run.
 *
 * The tests that matter most are the ones about *authority*: that the server
 * prices a quote rather than believing one, that an approver sees the quote
 * they were asked about and nothing else, and that a quote in review cannot be
 * edited underneath the person reviewing it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, startTestPocketBase } from "./testPocketBase";
import { DEFAULT_PREFERENCES, PREFERENCE_LIMITS } from "../lib/preferences";
import { WORKSPACE_FILE_KIND } from "../lib/workspaceFile";
import { CATALOG_FILE_KIND } from "../lib/catalogFile";

const PORT = 3100 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;

const PASSWORD = "test-password-123";
/** Unique per run, so re-runs against one PocketBase never collide. */
const suffix = Math.random().toString(36).slice(2, 8);
const ALICE = `alice-${suffix}@example.com`;
const BOB = `bob-${suffix}@example.com`;

// Top-level await: the container has to exist before the describes below
// decide whether to register their account-backed tests or skip them.
const pocketbase = await startTestPocketBase();
if (!pocketbase.available) {
  console.warn(
    `\n[test] skipping every test that needs an account: ${pocketbase.reason}.\n` +
      "[test] start Docker, or point PB_TEST_URL at a PocketBase built from docker/, to run them.\n",
  );
}

/** A test that needs somewhere to store records — which is nearly all of them. */
const signedIn = pocketbase.available ? test : test.skip;

let server: ReturnType<typeof Bun.spawn>;

/** Alice's session. Every request below is hers unless it says otherwise. */
let cookie = "";
let bobCookie = "";

async function api(path: string, init?: RequestInit & { cookie?: string }) {
  const session = init?.cookie ?? cookie;
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(session ? { cookie: session } : {}),
    },
  });
}

const json = async (path: string, init?: RequestInit & { cookie?: string }) =>
  (await api(path, init)).json() as Promise<any>;

const post = (path: string, payload: unknown, init?: RequestInit & { cookie?: string }) =>
  json(path, { ...init, method: "POST", body: JSON.stringify(payload) });

const put = (path: string, payload: unknown, init?: RequestInit & { cookie?: string }) =>
  json(path, { ...init, method: "PUT", body: JSON.stringify(payload) });

/** Registers an account and returns the session cookie it was handed. */
async function register(email: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (response.status !== 201) throw new Error(`could not register ${email}: ${await response.text()}`);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

/* -------------------------------- fixtures ------------------------------- */

const PLATFORM = {
  sku: "PLAT",
  name: "Platform",
  family: "Software",
  chargeType: "recurring",
  billingPeriod: "monthly",
  unitOfMeasure: "user",
  listPrice: 100,
  cost: 30,
  currency: "USD",
  minQuantity: 1,
  floorDiscountPercent: 20,
  optionGroups: [
    {
      key: "tier",
      name: "Tier",
      select: "one",
      required: true,
      options: [
        { key: "standard", name: "Standard", priceDelta: 0, default: true },
        { key: "premium", name: "Premium", priceDelta: 0, priceFactor: 1.5 },
      ],
    },
  ],
  volumeTiers: [
    { minQuantity: 1, maxQuantity: 49, kind: "percent", value: 0 },
    { minQuantity: 50, maxQuantity: null, kind: "percent", value: 10 },
  ],
};

/** Ids minted during setup and reused across the describes below. */
let platformId = "";
let accountId = "";
let templateId = "";

beforeAll(async () => {
  server = Bun.spawn(["bun", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      POCKETBASE_URL: pocketbase.url,
      PB_ADMIN_EMAIL: TEST_ADMIN_EMAIL,
      PB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }

  if (pocketbase.available) {
    cookie = await register(ALICE);
    bobCookie = await register(BOB);

    platformId = (await post("/api/products", PLATFORM)).id;
    accountId = (await post("/api/accounts", {
      name: "Harbour Logistics",
      contactName: "Dana Okafor",
      contactEmail: "dana@harbour.example.com",
      currency: "USD",
      paymentTerms: "Net 30",
      taxPercent: 10,
    })).id;
    templateId = (await post("/api/proposal-templates", {
      name: "Plain quote",
      format: "text",
      body: "{{quote.number}} for {{customer.name}}\n{{lines.table}}\nTotal {{totals.grandTotal}}",
    })).id;
  }
});

afterAll(async () => {
  server?.kill();
  await pocketbase.stop();
});

/** A quote body with one line of `quantity` platform users. */
const quoteBody = (overrides: Record<string, unknown> = {}, line: Record<string, unknown> = {}) => ({
  name: "Expansion",
  accountId,
  currency: "USD",
  termMonths: 12,
  taxPercent: 0,
  lines: [
    {
      id: "ln_1",
      productId: platformId,
      quantity: 10,
      discountPercent: 0,
      selectedOptions: ["standard"],
      sortOrder: 0,
      ...line,
    },
  ],
  ...overrides,
});

/* ------------------------------- the basics ------------------------------ */

describe("the front door", () => {
  test("GET /api/health answers without an account", async () => {
    const payload = await json("/api/health", { cookie: " " });
    expect(payload.status).toBe("ok");
  });

  test("GET /api documents itself", async () => {
    const payload = await json("/api", { cookie: " " });
    expect(payload.name).toBe("cpq");
    expect(payload.endpoints["POST   /api/quotes"]).toBeString();
    // The pricing pipeline is documented in the order it actually runs.
    expect(payload.pricing.pipeline[0]).toContain("price book");
    expect(payload.currencies).toContain("USD");
  });

  test("an unknown API path is a 404, not the SPA", async () => {
    const response = await api("/api/nope", { cookie: " " });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("anything that touches data needs an account", async () => {
    for (const path of ["/api/quotes", "/api/products", "/api/accounts", "/api/preferences"]) {
      expect((await api(path, { cookie: " " })).status).toBe(401);
    }
  });

  signedIn("GET /api/reference gives the UI its vocabulary", async () => {
    const payload = await json("/api/reference");
    expect(payload.quoteStatuses).toContain("in_review");
    expect(payload.quoteTransitions.draft).toEqual(["sent"]);
    expect(payload.pricingVariables.line.map((v: any) => v.name)).toContain("unitPrice");
  });
});

/* -------------------------------- catalogue ------------------------------ */

describe("the catalogue", () => {
  signedIn("a product round-trips with its options and tiers", async () => {
    const product = await json(`/api/products/${platformId}`);
    expect(product.sku).toBe("PLAT");
    expect(product.optionGroups[0].options[1].priceFactor).toBe(1.5);
    expect(product.volumeTiers).toHaveLength(2);
    expect(product.ownerId).toBeString();
  });

  signedIn("a product without a SKU is refused with a sentence", async () => {
    const response = await api("/api/products", {
      method: "POST",
      body: JSON.stringify({ name: "Nameless" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("needs a SKU");
  });

  signedIn("a configuration rule naming an option that does not exist is refused", async () => {
    const payload = await post("/api/products", {
      ...PLATFORM,
      sku: "BADRULE",
      rules: [{ kind: "requires", when: ["premium"], then: ["nonexistent"], message: "" }],
    });
    expect(payload.error).toContain("references an option that does not exist");
  });

  signedIn("two products cannot share a SKU", async () => {
    const response = await api("/api/products", { method: "POST", body: JSON.stringify(PLATFORM) });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  signedIn("POST /api/products/:id/configure enforces the product's own rules", async () => {
    const valid = await post(`/api/products/${platformId}/configure`, {
      selectedOptions: ["premium"],
      quantity: 10,
    });
    expect(valid.valid).toBe(true);
    expect(valid.unitFactor).toBe(1.5);

    const missing = await post(`/api/products/${platformId}/configure`, { selectedOptions: [], quantity: 10 });
    expect(missing.valid).toBe(false);
    expect(missing.errors[0]).toContain("Tier");
    expect(missing.defaults).toEqual(["standard"]);
  });

  signedIn("a price book will not take a floor above its own price", async () => {
    const payload = await post("/api/price-books", {
      name: "Broken",
      currency: "USD",
      entries: [{ sku: "PLAT", unitPrice: 80, minPrice: 100 }],
    });
    expect(payload.error).toContain("floor");
  });
});

/* -------------------------------- customers ------------------------------ */

describe("customers", () => {
  /** A customer created by this block alone, so its quote history is knowable. */
  let meridianId = "";

  signedIn("a customer round-trips with its contacts, tags and two addresses", async () => {
    const created = await post("/api/accounts", {
      name: "Meridian Health",
      status: "customer",
      // Deliberately shouted, duplicated and out of order.
      tags: ["Enterprise", "enterprise", "EMEA"],
      contacts: [
        { name: "Sam Ellery", title: "Procurement", email: "S.Ellery@meridian.example.org", role: "commercial" },
        { name: "Accounts Payable", email: "ap@meridian.example.org", role: "billing", primary: true },
      ],
      billingAddress: { line1: "88 Longwood Avenue", city: "Boston", state: "MA", country: "United States" },
      shippingSameAsBilling: false,
      shippingAddress: { line1: "Dock 4", city: "Chelsea", state: "MA", country: "United States" },
      currency: "USD",
      paymentTerms: "Net 45",
    });
    meridianId = created.id;

    expect(created.status).toBe("customer");
    expect(created.tags).toEqual(["emea", "enterprise"]);
    expect(created.contacts).toHaveLength(2);
    expect(created.contacts[0].email).toBe("s.ellery@meridian.example.org");
    // Each contact is given an id, since nothing in the body carried one.
    expect(created.contacts[0].id).toBeString();
    expect(created.shippingAddress.city).toBe("Chelsea");

    // And it reads back the same way, which is the half that goes through
    // the JSON column rather than through the validator.
    const read = await json(`/api/accounts/${meridianId}`);
    expect(read.contacts.map((contact: any) => contact.name)).toEqual(["Sam Ellery", "Accounts Payable"]);
    expect(read.tags).toEqual(["emea", "enterprise"]);
  });

  signedIn("exactly one contact is primary, whatever the body claims", async () => {
    const none = await post("/api/accounts", {
      name: "No primary named",
      currency: "USD",
      contacts: [{ name: "First" }, { name: "Second" }],
    });
    expect(none.contacts.map((contact: any) => contact.primary)).toEqual([true, false]);

    const several = await put(`/api/accounts/${none.id}`, {
      name: "No primary named",
      currency: "USD",
      contacts: [{ name: "First", primary: true }, { name: "Second", primary: true }],
    });
    expect(several.contacts.map((contact: any) => contact.primary)).toEqual([true, false]);
  });

  signedIn("a body written before contacts existed becomes one contact", async () => {
    // The shape `POST /api/accounts` took a version ago, and the shape the
    // account every other test in this file uses was created with.
    const legacy = await json(`/api/accounts/${accountId}`);
    expect(legacy.contacts).toHaveLength(1);
    expect(legacy.contacts[0].name).toBe("Dana Okafor");
    expect(legacy.contacts[0].email).toBe("dana@harbour.example.com");
    expect(legacy.contacts[0].primary).toBe(true);
    // Nothing was said about shipping, so it goes where the invoice goes.
    expect(legacy.shippingSameAsBilling).toBe(true);
  });

  signedIn("a contact with a broken address is refused with a sentence", async () => {
    const payload = await post("/api/accounts", {
      name: "Typo",
      currency: "USD",
      contacts: [{ name: "Nobody", email: "not-an-address" }],
    });
    expect(payload.error).toContain("is not an email address");
  });

  signedIn("the quote snapshots the primary contact, title and shipping address", async () => {
    const quote = await post("/api/quotes", {
      name: "Meridian pilot",
      accountId: meridianId,
      currency: "USD",
      termMonths: 12,
      lines: [{ id: "ln_1", productId: platformId, quantity: 10, selectedOptions: ["standard"] }],
    });

    // The billing contact was flagged primary, so that is who it is addressed to.
    expect(quote.quote.customer.contactName).toBe("Accounts Payable");
    expect(quote.quote.customer.contactEmail).toBe("ap@meridian.example.org");
    expect(quote.quote.customer.shippingAddress.city).toBe("Chelsea");
    expect(quote.quote.customer.billingAddress.city).toBe("Boston");
  });

  signedIn("GET /api/accounts/:id/quotes is that customer's history and nobody else's", async () => {
    const history = await json(`/api/accounts/${meridianId}/quotes`);
    expect(history).toHaveLength(1);
    expect(history[0].name).toBe("Meridian pilot");
    expect(history[0].customer.accountId).toBe(meridianId);

    // A quote for the other customer stays out of it, and vice versa.
    await post("/api/quotes", quoteBody({ name: "Harbour expansion" }));

    const others = await json(`/api/accounts/${accountId}/quotes`);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((quote: any) => quote.customer.accountId === accountId)).toBe(true);
    expect(await json(`/api/accounts/${meridianId}/quotes`)).toHaveLength(1);
  });

  signedIn("somebody else's customer has no history to read", async () => {
    const response = await api(`/api/accounts/${meridianId}/quotes`, { cookie: bobCookie });
    expect(response.status).toBe(404);
  });
});

/* --------------------------------- pricing ------------------------------- */

describe("pricing is the server's job", () => {
  signedIn("the totals in a request body are ignored", async () => {
    const created = await post("/api/quotes", {
      ...quoteBody(),
      // A client insisting the quote is free changes nothing.
      totals: { grandTotal: 0, netTotal: 0 },
      lines: [{ ...quoteBody().lines[0], netTotal: 0, unitPrice: 0 }],
    });

    expect(created.quote.totals.netTotal).toBe(12_000);
    expect(created.quote.lines[0].unitPrice).toBe(100);
    expect(created.quote.lines[0].netTotal).toBe(12_000);
  });

  signedIn("options, tiers and the term all reach the price", async () => {
    const created = await post(
      "/api/quotes",
      quoteBody({ termMonths: 24 }, { quantity: 50, selectedOptions: ["premium"] }),
    );
    const line = created.quote.lines[0];

    // 100 × 1.5 = 150, less the 10% tier at 50 users = 135/user/month.
    expect(line.optionsUnitDelta).toBe(50);
    expect(line.tier.value).toBe(10);
    expect(line.unitPrice).toBe(135);
    expect(line.periods).toBe(24);
    expect(line.netTotal).toBe(162_000);
    expect(created.quote.totals.monthlyRecurringTotal).toBe(6_750);
  });

  signedIn("a pricing rule fires only when its condition holds", async () => {
    const rule = await post("/api/pricing-rules", {
      name: "Volume break",
      scope: "line",
      condition: "quantity >= 100",
      target: "discountPercent",
      expression: "15",
      message: "100+ users",
    });
    expect(rule.id).toBeString();

    const small = await post("/api/quotes", quoteBody({ name: "Small" }, { quantity: 10 }));
    expect(small.quote.lines[0].appliedRules).toEqual([]);

    const large = await post("/api/quotes", quoteBody({ name: "Large" }, { quantity: 100 }));
    expect(large.quote.lines[0].appliedRules[0].name).toBe("Volume break");
    expect(large.quote.lines[0].effectiveDiscountPercent).toBeGreaterThan(15);

    await api(`/api/pricing-rules/${rule.id}`, { method: "DELETE" });
  });

  signedIn("a pricing rule referencing an unknown variable is refused", async () => {
    const payload = await post("/api/pricing-rules", {
      name: "Typo",
      scope: "line",
      target: "discountPercent",
      expression: "quantitty * 2",
    });
    expect(payload.error).toContain("Unknown variable");
  });

  signedIn("POST /api/quotes/preview prices without storing", async () => {
    const before = (await json("/api/quotes")).length;
    const preview = await post("/api/quotes/preview", quoteBody({ name: "Hypothetical" }));

    expect(preview.totals.netTotal).toBe(12_000);
    expect((await json("/api/quotes")).length).toBe(before);
  });

  signedIn("POST /api/formula/validate checks against the scope's own variables", async () => {
    const good = await post("/api/formula/validate", { expression: "subtotal * 0.9", scope: "quote" });
    expect(good.valid).toBe(true);

    const bad = await post("/api/formula/validate", { expression: "unitPrice * 2", scope: "quote" });
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain("Unknown variable");
  });
});

/* -------------------------------- lifecycle ------------------------------ */

describe("a quote's life", () => {
  signedIn("a quote is numbered, and a revision says what it supersedes", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Numbered" }));
    expect(created.quote.number).toMatch(/^Q-\d{4}-\d{4}$/);
    expect(created.quote.status).toBe("draft");
    expect(created.quote.version).toBe(1);
    expect(created.quote.customer.name).toBe("Harbour Logistics");

    const revised = await post(`/api/quotes/${created.quote.id}/revise`, {});
    expect(revised.quote.version).toBe(2);
    expect(revised.quote.supersedesId).toBe(created.quote.id);
    expect(revised.quote.number).toContain("-r2");

    // The original keeps its own content — that is the point of a revision —
    // but it is retired: it reads superseded, and names what replaced it.
    const original = await json(`/api/quotes/${created.quote.id}`);
    expect(original.version).toBe(1);
    expect(original.status).toBe("superseded");
    expect(original.supersededById).toBe(revised.quote.id);
  });

  signedIn("a revision of a revision is -r3, not -r2-r3", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Thrice" }));
    const second = await post(`/api/quotes/${created.quote.id}/revise`, {});
    const third = await post(`/api/quotes/${second.quote.id}/revise`, {});

    expect(second.quote.number).toBe(`${created.quote.number}-r2`);
    expect(third.quote.number).toBe(`${created.quote.number}-r3`);
    expect(third.quote.version).toBe(3);
  });

  signedIn("only the latest version can be revised", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Forked" }));
    await post(`/api/quotes/${created.quote.id}/revise`, {});

    // Revising the original again would leave two live revisions of one deal.
    const again = await api(`/api/quotes/${created.quote.id}/revise`, { method: "POST" });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toContain("latest");
  });

  signedIn("a superseded quote cannot be sent, edited or invoiced", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Retired" }));
    await post(`/api/quotes/${created.quote.id}/revise`, {});

    const send = await api(`/api/quotes/${created.quote.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "sent" }),
    });
    expect(send.status).toBe(409);
    expect((await send.json()).error).toContain("superseded");

    const edit = await api(`/api/quotes/${created.quote.id}`, { method: "PUT", body: JSON.stringify(quoteBody()) });
    expect(edit.status).toBe(409);

    const invoice = await api(`/api/quotes/${created.quote.id}/invoice`, { method: "POST" });
    expect(invoice.status).toBe(409);
  });

  signedIn("deleting the revision brings the original back", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Second thoughts" }));
    const revised = await post(`/api/quotes/${created.quote.id}/revise`, {});
    expect((await json(`/api/quotes/${created.quote.id}`)).status).toBe("superseded");

    expect((await api(`/api/quotes/${revised.quote.id}`, { method: "DELETE" })).status).toBe(200);

    const original = await json(`/api/quotes/${created.quote.id}`);
    expect(original.status).toBe("draft");
    expect(original.supersededById).toBeNull();
  });

  signedIn("an accepted quote is a contract, and cannot be revised", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Signed" }));
    await post(`/api/quotes/${created.quote.id}/submit`, {});
    await post(`/api/quotes/${created.quote.id}/status`, { status: "sent" });
    await post(`/api/quotes/${created.quote.id}/status`, { status: "accepted" });

    const response = await api(`/api/quotes/${created.quote.id}/revise`, { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("contract");
  });

  signedIn("quotes are found by the server, however old, and the page says how many matched", async () => {
    const needle = `Needle ${suffix}`;
    const created = await post("/api/quotes", quoteBody({ name: needle }));
    // Bury it under a page's worth of newer quotes' worth of noise is not
    // needed: a page of one is enough to prove the search is not client-side.
    await post("/api/quotes", quoteBody({ name: "Noise" }));

    const response = await api(`/api/quotes?q=${encodeURIComponent(needle)}&perPage=1`);
    const found = await response.json();
    expect(found.map((quote: any) => quote.id)).toEqual([created.quote.id]);
    expect(response.headers.get("X-Total-Count")).toBe("1");

    const paged = await api("/api/quotes?perPage=1&page=2");
    expect((await paged.json()).length).toBe(1);
    expect(Number(paged.headers.get("X-Total-Count"))).toBeGreaterThan(1);
  });

  signedIn("filtering by status uses the status a quote actually has", async () => {
    const created = await post("/api/quotes", quoteBody({ name: `Superseded ${suffix}` }));
    await post(`/api/quotes/${created.quote.id}/revise`, {});

    const superseded = await json(`/api/quotes?status=superseded&q=${encodeURIComponent(suffix)}`);
    expect(superseded.map((quote: any) => quote.id)).toContain(created.quote.id);
    const drafts = await json(`/api/quotes?status=draft&q=${encodeURIComponent(`Superseded ${suffix}`)}`);
    expect(drafts.map((quote: any) => quote.id)).not.toContain(created.quote.id);

    const counts = await json("/api/quotes/counts");
    expect(counts.superseded).toBeGreaterThanOrEqual(1);
    expect(counts.all).toBeGreaterThanOrEqual(counts.superseded);
  });

  signedIn("a usage line is reported apart from the contract value", async () => {
    const meter = await post("/api/products", {
      sku: `METER-${suffix}`,
      name: "API calls",
      chargeType: "usage",
      unitOfMeasure: "1k calls",
      listPrice: 2,
      currency: "USD",
    });
    const created = await post("/api/quotes", {
      ...quoteBody({ name: "Metered", discountPercent: 10 }),
      lines: [{ id: "ln_m", productId: meter.id, quantity: 1000, discountPercent: 0, unitPriceOverride: null, selectedOptions: [], termMonths: 0, description: "", parentId: null, sortOrder: 0 }],
    });

    const totals = created.quote.totals;
    expect(totals.oneTimeTotal).toBe(0);
    // 2,000 at list, less the 10% quote discount.
    expect(totals.usageTotal).toBe(1800);
    // An estimate is not a commitment.
    expect(totals.totalContractValue).toBe(0);
    expect(totals.netTotal).toBe(1800);

    await api(`/api/quotes/${created.quote.id}`, { method: "DELETE" });
    await api(`/api/products/${meter.id}`, { method: "DELETE" });
  });

  signedIn("with no approval rules, a submitted quote is approved outright", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Clean" }));
    const submitted = await post(`/api/quotes/${created.quote.id}/submit`, {});

    expect(submitted.quote.status).toBe("approved");
    expect(submitted.required).toEqual([]);

    const sent = await post(`/api/quotes/${created.quote.id}/status`, { status: "sent" });
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBeString();

    const accepted = await post(`/api/quotes/${created.quote.id}/status`, { status: "accepted" });
    expect(accepted.status).toBe("accepted");
  });

  signedIn("an illegal transition is refused with the legal ones", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Stuck" }));
    const response = await api(`/api/quotes/${created.quote.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "accepted" }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("can only become sent");
  });

  signedIn("an empty quote cannot be submitted", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Empty", lines: [] }));
    const response = await api(`/api/quotes/${created.quote.id}/submit`, { method: "POST" });
    expect(response.status).toBe(400);
  });
});

/* ------------------------------- receivables ----------------------------- */

/*
 * Placed before the approvals block on purpose: that one creates approval
 * rules, and once any exist a draft can no longer be sent without going
 * through them. Everything here needs a quote it can get to `accepted`.
 */
describe("receivables", () => {
  /** A quote taken all the way to accepted, and the invoice raised from it. */
  let acceptedQuote: any = null;
  let invoiceId = "";

  /** Walks a fresh quote to `accepted` and hands it back. */
  const acceptedQuoteFor = async (name: string) => {
    const created = await post("/api/quotes", quoteBody({ name }));
    await post(`/api/quotes/${created.quote.id}/submit`, {});
    await post(`/api/quotes/${created.quote.id}/status`, { status: "sent" });
    return post(`/api/quotes/${created.quote.id}/status`, { status: "accepted" });
  };

  signedIn("an accepted quote raises a draft invoice that reconciles with it", async () => {
    acceptedQuote = await acceptedQuoteFor("To be invoiced");

    const raised = await post(`/api/quotes/${acceptedQuote.id}/invoice`, {});
    invoiceId = raised.invoice.id;

    // A draft has no number yet — it takes one when it is issued.
    expect(raised.invoice.number).toStartWith("DRAFT-");
    // Always a draft: issuing is a separate, deliberate act.
    expect(raised.invoice.state).toBe("draft");
    expect(raised.invoice.issueDate).toBe("");
    expect(raised.invoice.dueDate).toBe("");
    expect(raised.invoice.quoteId).toBe(acceptedQuote.id);
    expect(raised.invoice.quoteNumber).toBe(acceptedQuote.number);

    // The customer came from the quote's own snapshot, not from the account.
    expect(raised.invoice.customer.name).toBe("Harbour Logistics");
    expect(raised.invoice.lines.length).toBeGreaterThan(0);

    // The whole point: it adds up to what the customer accepted.
    expect(raised.invoice.totals.total).toBe(acceptedQuote.totals.grandTotal);
    expect(raised.warnings).toEqual([]);
  });

  signedIn("an invoice's quote is a relation: kept when a save leaves it out, changed or removed when named", async () => {
    const other = await acceptedQuoteFor("Another deal");
    const draft = (await post("/api/invoices", { accountId, quoteId: other.id })).invoice;
    expect(draft.quoteId).toBe(other.id);
    expect(draft.quoteNumber).toBe(other.number);

    // A client that never heard of the link cannot unlink it by saving.
    const kept = await put(`/api/invoices/${draft.id}`, { accountId, poNumber: "PO-1" });
    expect(kept.invoice.quoteId).toBe(other.id);

    // Naming one that is not accepted links it, and says so.
    const open = (await post("/api/quotes", quoteBody({ name: "Still a draft" }))).quote;
    const relinked = await put(`/api/invoices/${draft.id}`, { accountId, quoteId: open.id });
    expect(relinked.invoice.quoteId).toBe(open.id);
    expect(relinked.warnings.join(" ")).toContain("not accepted");

    // null removes it; a quote that does not exist is refused.
    expect((await put(`/api/invoices/${draft.id}`, { accountId, quoteId: null })).invoice.quoteId).toBeNull();
    const missing = await api(`/api/invoices/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ accountId, quoteId: "nosuchquote0000" }),
    });
    expect(missing.status).toBe(400);

    // Nor can anybody point an invoice at a quote they cannot read.
    const bobs = await api("/api/invoices", {
      method: "POST",
      body: JSON.stringify({ quoteId: other.id }),
      cookie: bobCookie,
    });
    expect(bobs.status).toBe(400);

    await api(`/api/invoices/${draft.id}`, { method: "DELETE" });
  });

  signedIn("the totals in a request body are ignored, the same as a quote's", async () => {
    const lying = await put(`/api/invoices/${invoiceId}`, {
      accountId,
      totals: { total: 1, balance: 0, paidAmount: 999 },
      lines: [{ description: "One thing", quantity: 2, unitPrice: 50 }],
    });

    expect(lying.invoice.totals.total).toBe(100);
    expect(lying.invoice.totals.paidAmount).toBe(0);
    expect(lying.invoice.totals.balance).toBe(100);
    // And the line got its own amount worked out for it.
    expect(lying.invoice.lines[0].amount).toBe(100);
  });

  signedIn("a quote nobody has sent cannot be invoiced", async () => {
    const draft = await post("/api/quotes", quoteBody({ name: "Never sent" }));
    const response = await api(`/api/quotes/${draft.quote.id}/invoice`, { method: "POST" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("sent or accepted");
  });

  signedIn("invoicing the same quote twice warns rather than refusing", async () => {
    // A deposit and then the balance is legitimate; double-billing by
    // accident is the thing worth saying out loud.
    const again = await post(`/api/quotes/${acceptedQuote.id}/invoice`, {});
    expect(again.warnings.join(" ")).toContain("has already been invoiced");
    await api(`/api/invoices/${again.invoice.id}`, { method: "DELETE" });
  });

  signedIn("issuing dates it and works out when it falls due", async () => {
    const issued = await post(`/api/invoices/${invoiceId}/issue`, { issueDate: "2026-03-01" });

    expect(issued.state).toBe("issued");
    expect(issued.issueDate).toBe("2026-03-01");
    // Harbour Logistics is Net 30, seeded from their payment terms text.
    expect(issued.paymentTermDays).toBe(30);
    expect(issued.dueDate).toBe("2026-03-31");
  });

  signedIn("an issued invoice's lines are fixed", async () => {
    const response = await api(`/api/invoices/${invoiceId}`, {
      method: "PUT",
      body: JSON.stringify({ accountId, lines: [{ description: "Sneaky", quantity: 1, unitPrice: 5 }] }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("credit against it instead");
  });

  signedIn("an issued invoice is never deleted, only voided", async () => {
    const response = await api(`/api/invoices/${invoiceId}`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("gapless");
  });

  signedIn("a payment moves the balance and nothing else", async () => {
    const paid = await post(`/api/invoices/${invoiceId}/payments`, {
      amount: 40,
      receivedOn: "2026-03-10",
      method: "bank_transfer",
      reference: "FT-99",
    });

    expect(paid.invoice.totals.paidAmount).toBe(40);
    expect(paid.invoice.totals.balance).toBe(60);
    expect(paid.invoice.totals.total).toBe(100);
    expect(paid.invoice.payments).toHaveLength(1);
    expect(paid.invoice.payments[0].reference).toBe("FT-99");
    expect(paid.warnings).toEqual([]);
  });

  signedIn("a payment of nothing is refused", async () => {
    const payload = await post(`/api/invoices/${invoiceId}/payments`, { amount: 0 });
    expect(payload.error).toContain("greater than zero");
  });

  signedIn("a credit bigger than the balance is refused; the balance is not", async () => {
    const tooBig = await api(`/api/invoices/${invoiceId}/credits`, {
      method: "POST",
      body: JSON.stringify({ amount: 500, reason: "adjustment" }),
    });
    expect(tooBig.status).toBe(400);
    expect((await tooBig.json()).error).toContain("more than the");

    const credited = await post(`/api/invoices/${invoiceId}/credits`, { amount: 10, reason: "goodwill" });
    expect(credited.invoice.totals.creditedAmount).toBe(10);
    expect(credited.invoice.totals.balance).toBe(50);
  });

  signedIn("an invoice with a payment on it cannot be voided", async () => {
    const response = await api(`/api/invoices/${invoiceId}/void`, { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("Credit it instead");
  });

  signedIn("an overpayment is recorded, warned about, and left negative", async () => {
    // The money is in the bank whether or not the invoice expected it.
    const paid = await post(`/api/invoices/${invoiceId}/payments`, { amount: 90 });

    expect(paid.invoice.totals.balance).toBe(-40);
    expect(paid.warnings.join(" ")).toContain("overpaid");

    // Settled, so it drops out of the aging entirely.
    const aged = await json("/api/receivables/aging?currency=USD&asOf=2030-01-01");
    expect(aged.buckets["90+"].count).toBe(0);
  });

  signedIn("a payment entered in error can be taken back off", async () => {
    const before = await json(`/api/invoices/${invoiceId}`);
    const removed = await api(`/api/invoices/${invoiceId}/payments/${before.payments[1].id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await removed.json()).totals.balance).toBe(50);
  });

  signedIn("the aging report buckets the balance, as of a date", async () => {
    // Due 2026-03-31, £50 still owed. Read on 2026-05-20 that is 50 days late.
    const report = await json("/api/receivables/aging?currency=USD&asOf=2026-05-20");

    expect(report.currency).toBe("USD");
    expect(report.asOf).toBe("2026-05-20");
    expect(report.buckets["31-60"].amount).toBe(50);
    expect(report.outstanding).toBe(50);
    expect(report.overdue).toBe(50);

    // Read the day after issue, the same invoice is simply not yet due.
    const early = await json("/api/receivables/aging?currency=USD&asOf=2026-03-02");
    expect(early.buckets.current.amount).toBe(50);
    expect(early.overdue).toBe(0);
  });

  signedIn("a customer's invoices are their own, and nobody else's", async () => {
    const mine = await json(`/api/accounts/${accountId}/invoices`);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((one: any) => one.customer.accountId === accountId)).toBe(true);

    expect((await api(`/api/invoices/${invoiceId}`, { cookie: bobCookie })).status).toBe(404);
    expect(await json("/api/invoices", { cookie: bobCookie })).toEqual([]);
  });

  signedIn("a blank invoice picks up the customer's terms and currency", async () => {
    const raised = await post("/api/invoices", {
      accountId,
      lines: [{ description: "Consultancy", quantity: 2, unitPrice: 750, taxPercent: 10 }],
      poNumber: "PO-4417",
    });

    expect(raised.invoice.state).toBe("draft");
    expect(raised.invoice.currency).toBe("USD");
    expect(raised.invoice.paymentTermDays).toBe(30);
    expect(raised.invoice.poNumber).toBe("PO-4417");
    expect(raised.invoice.totals.subtotal).toBe(1_500);
    expect(raised.invoice.totals.taxAmount).toBe(150);
    expect(raised.invoice.totals.total).toBe(1_650);

    // A draft is not a receivable, and a draft can be thrown away.
    expect((await api(`/api/invoices/${raised.invoice.id}`, { method: "DELETE" })).status).toBe(200);
  });

  signedIn("nothing can be paid against a draft", async () => {
    const raised = await post("/api/invoices", {
      accountId,
      lines: [{ description: "Not yet", quantity: 1, unitPrice: 10 }],
    });
    const response = await api(`/api/invoices/${raised.invoice.id}/payments`, {
      method: "POST",
      body: JSON.stringify({ amount: 10 }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("not been issued");
    await api(`/api/invoices/${raised.invoice.id}`, { method: "DELETE" });
  });

  signedIn("a payment is a record of its own, with an identity and an owner", async () => {
    const ledger = await json(`/api/invoices/${invoiceId}/payments`);

    expect(ledger.length).toBeGreaterThan(0);
    const payment = ledger[0];
    expect(payment.id).toMatch(/^pmt_/);
    expect(payment.invoiceId).toBe(invoiceId);
    expect(payment.ownerId).toBeString();
    // Its own created date, rather than a timestamp inside somebody's JSON.
    expect(payment.createdAt).toBeString();
    expect(payment.receivedOn).toBe("2026-03-10");
  });

  signedIn("cash is answerable on its own, across invoices", async () => {
    // The question the embedded ledger could not answer without opening every
    // invoice in the workspace.
    const all = await json("/api/payments");
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((one: any) => one.invoiceId && one.amount > 0)).toBe(true);

    const mine = await json(`/api/payments?invoiceId=${invoiceId}`);
    expect(mine.every((one: any) => one.invoiceId === invoiceId)).toBe(true);
    expect(mine.length).toBeLessThanOrEqual(all.length);

    const credits = await json(`/api/credits?invoiceId=${invoiceId}`);
    expect(credits.every((one: any) => one.invoiceId === invoiceId)).toBe(true);
  });

  signedIn("two payments banked at the same moment both land", async () => {
    // The bug that made this a collection. When the ledger was an array on the
    // invoice, recording a payment was a read-modify-write of the whole
    // record, so the second save wrote back the ledger the first had read and
    // one payment vanished. An insert cannot do that.
    const raised = await post("/api/invoices", {
      accountId,
      lines: [{ description: "Concurrent", quantity: 1, unitPrice: 300 }],
    });
    await post(`/api/invoices/${raised.invoice.id}/issue`, {});

    await Promise.all([
      post(`/api/invoices/${raised.invoice.id}/payments`, { amount: 100, reference: "A" }),
      post(`/api/invoices/${raised.invoice.id}/payments`, { amount: 100, reference: "B" }),
      post(`/api/invoices/${raised.invoice.id}/payments`, { amount: 100, reference: "C" }),
    ]);

    const after = await json(`/api/invoices/${raised.invoice.id}`);
    expect(after.payments).toHaveLength(3);
    expect(after.payments.map((one: any) => one.reference).sort()).toEqual(["A", "B", "C"]);
    // And the balance is read off the ledger, so it agrees with all three.
    expect(after.totals.paidAmount).toBe(300);
    expect(after.totals.balance).toBe(0);
  });

  signedIn("the balance is computed from the ledger, never cached on the invoice", async () => {
    // Deleting a payment row is enough to move the balance: nothing has to
    // remember to rewrite a number on the invoice.
    const before = await json(`/api/invoices/${invoiceId}`);
    const balanceBefore = before.totals.balance;
    const payment = before.payments[0];

    const removed = await api(`/api/invoices/${invoiceId}/payments/${payment.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await removed.json()).totals.balance).toBe(balanceBefore + payment.amount);

    // The list endpoint agrees, which is the half that reads every ledger at once.
    const listed = (await json("/api/invoices")).find((one: any) => one.id === invoiceId);
    expect(listed.totals.balance).toBe(balanceBefore + payment.amount);

    // Put it back so the aging assertions above still describe this invoice.
    await post(`/api/invoices/${invoiceId}/payments`, {
      amount: payment.amount,
      receivedOn: payment.receivedOn,
      reference: payment.reference,
    });
  });

  signedIn("a payment belonging to another invoice cannot be removed through this one", async () => {
    const other = await post("/api/invoices", {
      accountId,
      lines: [{ description: "Elsewhere", quantity: 1, unitPrice: 50 }],
    });
    await post(`/api/invoices/${other.invoice.id}/issue`, {});
    const recorded = await post(`/api/invoices/${other.invoice.id}/payments`, { amount: 50 });
    const paymentId = recorded.invoice.payments[0].id;

    const response = await api(`/api/invoices/${invoiceId}/payments/${paymentId}`, { method: "DELETE" });
    expect(response.status).toBe(404);

    // Still there, on the invoice it actually belongs to.
    expect(await json(`/api/invoices/${other.invoice.id}/payments`)).toHaveLength(1);
  });

  signedIn("nobody else can file a payment against your invoice", async () => {
    // Through the API Bob cannot even see the invoice, so this goes straight
    // at PocketBase to check the collection rule rather than the route.
    const response = await fetch(`${pocketbase.url}/api/collections/payments/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: await bobToken() },
      body: JSON.stringify({ id: "pmt_intruder", invoice: invoiceId, amount: 999, receivedOn: "2026-03-10" }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    // And Alice's ledger is untouched by it.
    const ledger = await json(`/api/invoices/${invoiceId}/payments`);
    expect(ledger.every((one: any) => one.id !== "pmt_intruder")).toBe(true);
  });

  signedIn("Bob sees no ledger at all, because he sees no invoices", async () => {
    expect(await json("/api/payments", { cookie: bobCookie })).toEqual([]);
    expect(await json("/api/credits", { cookie: bobCookie })).toEqual([]);
  });

  signedIn("the cash receipts export names the invoice, not its id", async () => {
    const response = await api("/api/payments?format=csv");
    const csv = await response.text();

    expect(csv).toContain("receivedOn,invoice,customer");
    expect(csv).toContain("reference");
    // Read beside a bank statement, so it carries the human-facing number.
    expect(csv).toMatch(/INV-\d{4}-\d{4}/);
    expect(csv).toContain("Harbour Logistics");
  });

  signedIn("the receivables export carries the derived status and aging", async () => {
    const response = await api("/api/invoices/export?format=csv&asOf=2026-05-20");
    const csv = await response.text();

    expect(csv).toContain("invoice,quote,customer");
    expect(csv).toContain("daysOverdue");
    expect(csv).toContain("agingBucket");
    // Status is derived on the way out, because it is stored nowhere.
    expect(csv).toContain("status");
  });
});

/* -------------------------------- approvals ------------------------------ */

describe("approvals", () => {
  let ruleId = "";
  let quoteId = "";

  signedIn("a deep discount puts a quote into review and tells Bob", async () => {
    ruleId = (
      await post("/api/approval-rules", {
        name: "Sales manager",
        scope: "quote",
        metric: "discountPercent",
        comparator: ">",
        threshold: 15,
        level: 1,
        approvers: [BOB],
        message: "Past 15% needs a manager.",
      })
    ).id;

    const created = await post("/api/quotes", quoteBody({ name: "Deep discount" }, { discountPercent: 30 }));
    quoteId = created.quote.id;

    const submitted = await post(`/api/quotes/${quoteId}/submit`, {});
    expect(submitted.quote.status).toBe("in_review");
    expect(submitted.required).toHaveLength(1);
    expect(submitted.required[0].approverEmails).toEqual([BOB]);
    expect(submitted.required[0].reason).toContain("30%");
    expect(submitted.unresolved).toEqual([]);
  });

  signedIn("a quote in review cannot be edited underneath its reviewer", async () => {
    const response = await api(`/api/quotes/${quoteId}`, {
      method: "PUT",
      body: JSON.stringify(quoteBody({ name: "Sneaky" })),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("cannot be edited");
  });

  signedIn("nor sent while an approval is outstanding", async () => {
    const response = await api(`/api/quotes/${quoteId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "sent" }),
    });
    expect(response.status).toBe(409);
  });

  signedIn("the approver sees it in their queue — and nothing else of Alice's", async () => {
    const queue = await json("/api/quotes/awaiting", { cookie: bobCookie });
    expect(queue.map((quote: any) => quote.id)).toEqual([quoteId]);

    // Bob can read that one quote, because he was asked to approve it.
    expect((await api(`/api/quotes/${quoteId}`, { cookie: bobCookie })).status).toBe(200);

    // He cannot read Alice's catalogue, customers or anything else.
    expect(await json("/api/products", { cookie: bobCookie })).toEqual([]);
    expect(await json("/api/accounts", { cookie: bobCookie })).toEqual([]);
    expect((await api(`/api/products/${platformId}`, { cookie: bobCookie })).status).toBe(404);
  });

  signedIn("an approver cannot rewrite the quote they are approving", async () => {
    // PocketBase's update rule lets Bob write this record; the hook holds him
    // to the approval fields, so a re-priced body changes nothing.
    const response = await fetch(`${pocketbase.url}/api/collections/quotes/records/${quoteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: await bobToken() },
      body: JSON.stringify({ name: "Rewritten by the approver", totals: { grandTotal: 1 } }),
    });

    // The write is accepted or refused depending on the field; what matters is
    // that the stored quote is unchanged.
    void response;
    const after = await json(`/api/quotes/${quoteId}`);
    expect(after.name).toBe("Deep discount");
    expect(after.totals.grandTotal).toBeGreaterThan(1);
  });

  signedIn("the approval is Bob's to give, and it releases the quote", async () => {
    // Alice cannot approve her own quote: there is nothing addressed to her.
    const mine = await api(`/api/quotes/${quoteId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(mine.status).toBe(403);

    const decided = await post(
      `/api/quotes/${quoteId}/decision`,
      { decision: "approved", comment: "Fine at this volume." },
      { cookie: bobCookie },
    );
    expect(decided.quote.status).toBe("approved");
    expect(decided.quote.approvals[0].decisions[0].approverEmail).toBe(BOB);

    const sent = await post(`/api/quotes/${quoteId}/status`, { status: "sent" });
    expect(sent.status).toBe("sent");
  });

  signedIn("a rejection sends it back, and editing clears the decisions", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "To reject" }, { discountPercent: 40 }));
    const id = created.quote.id;
    await post(`/api/quotes/${id}/submit`, {});

    const rejected = await post(
      `/api/quotes/${id}/decision`,
      { decision: "rejected", comment: "Too deep." },
      { cookie: bobCookie },
    );
    expect(rejected.quote.status).toBe("rejected");

    // A rejected quote is the rep's again, and saving it drops the approvals
    // that were made about numbers which no longer apply.
    const saved = await put(`/api/quotes/${id}`, quoteBody({ name: "To reject" }, { discountPercent: 5 }));
    expect(saved.quote.status).toBe("draft");
    expect(saved.quote.approvals).toEqual([]);

    await api(`/api/approval-rules/${ruleId}`, { method: "DELETE" });
  });

  signedIn("an approval rule with no approver is refused", async () => {
    const payload = await post("/api/approval-rules", { name: "Nobody", metric: "discountPercent", threshold: 10 });
    expect(payload.error).toContain("approver");
  });

  signedIn("a rule can ask several people, and the quote waits for the quorum", async () => {
    const carol = `carol-quorum-${suffix}@example.com`;
    const carolCookie = await register(carol);

    const twoOfTwo = (
      await post("/api/approval-rules", {
        name: "Both directors",
        scope: "quote",
        metric: "discountPercent",
        comparator: ">",
        threshold: 15,
        level: 1,
        approvers: [BOB, carol],
        approvalsRequired: 2,
        rejectionsRequired: 1,
      })
    ).id;

    const created = await post("/api/quotes", quoteBody({ name: "Needs two" }, { discountPercent: 30 }));
    const submitted = await post(`/api/quotes/${created.quote.id}/submit`, {});

    // One request addressed to both, not one request each.
    expect(submitted.required).toHaveLength(1);
    expect(submitted.required[0].approverEmails.sort()).toEqual([BOB, carol].sort());
    expect(submitted.required[0].approvalsRequired).toBe(2);
    expect(submitted.unresolved).toEqual([]);

    // Both can see it; neither alone can release it.
    expect((await json("/api/quotes/awaiting", { cookie: bobCookie })).length).toBeGreaterThan(0);
    expect((await json("/api/quotes/awaiting", { cookie: carolCookie })).length).toBeGreaterThan(0);

    const first = await post(
      `/api/quotes/${created.quote.id}/decision`,
      { decision: "approved", comment: "Fine by me." },
      { cookie: bobCookie },
    );
    expect(first.quote.status).toBe("in_review");
    expect(first.quote.approvals[0].decisions).toHaveLength(1);

    // Still not sendable on one approval.
    const early = await api(`/api/quotes/${created.quote.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "sent" }),
    });
    expect(early.status).toBe(409);

    const second = await post(
      `/api/quotes/${created.quote.id}/decision`,
      { decision: "approved" },
      { cookie: carolCookie },
    );
    expect(second.quote.status).toBe("approved");
    expect(second.quote.approvals[0].decisions).toHaveLength(2);

    await api(`/api/approval-rules/${twoOfTwo}`, { method: "DELETE" });
  });

  signedIn("one rejection sends it back even when two approvals were wanted", async () => {
    const dana = `dana-quorum-${suffix}@example.com`;
    const danaCookie = await register(dana);

    const ruleId = (
      await post("/api/approval-rules", {
        name: "Two yeses, one no",
        scope: "quote",
        metric: "discountPercent",
        comparator: ">",
        threshold: 15,
        level: 1,
        approvers: [BOB, dana],
        approvalsRequired: 2,
        rejectionsRequired: 1,
      })
    ).id;

    const created = await post("/api/quotes", quoteBody({ name: "One no" }, { discountPercent: 35 }));
    await post(`/api/quotes/${created.quote.id}/submit`, {});

    const rejected = await post(
      `/api/quotes/${created.quote.id}/decision`,
      { decision: "rejected", comment: "Margin is too thin." },
      { cookie: danaCookie },
    );
    expect(rejected.quote.status).toBe("rejected");

    await api(`/api/approval-rules/${ruleId}`, { method: "DELETE" });
  });

  signedIn("a quorum larger than the room is clamped on the way in", async () => {
    const created = await post("/api/approval-rules", {
      name: "Impossible",
      metric: "discountPercent",
      threshold: 10,
      approvers: [BOB],
      approvalsRequired: 5,
    });

    // Otherwise the rule could never be satisfied and would block forever.
    expect(created.approvalsRequired).toBe(1);
    await api(`/api/approval-rules/${created.id}`, { method: "DELETE" });
  });

  signedIn("a rule written the old way, with one approverEmail, still reads", async () => {
    // The shape before a rule could name several people.
    const created = await post("/api/approval-rules", {
      name: "Legacy shape",
      metric: "discountPercent",
      threshold: 20,
      approverEmail: BOB,
    });

    expect(created.approvers).toEqual([BOB]);
    expect(created.approvalsRequired).toBe(1);
    await api(`/api/approval-rules/${created.id}`, { method: "DELETE" });
  });
});

/** Bob's raw PocketBase token, for the one test that bypasses this API. */
async function bobToken(): Promise<string> {
  const response = await fetch(`${pocketbase.url}/api/collections/users/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: BOB, password: PASSWORD }),
  });
  return (await response.json()).token;
}

/* ------------------------- accounts, normalized -------------------------- */

describe("an account's people and addresses are records", () => {
  const table = (path: string, init?: RequestInit & { cookie?: string }) => json(`/api/table/${path}`, init);
  const filter = (expression: string) => `?filter=${encodeURIComponent(expression)}`;
  const body = (extra: Record<string, unknown> = {}) => ({
    name: "Normal Form Ltd",
    currency: "EUR",
    paymentTerms: "Net 15",
    creditLimit: 5000,
    tags: ["Normalized"],
    contacts: [
      { name: "Ada", email: "ada@normal.example.com", role: "commercial" },
      { name: "Bea", email: "bea@normal.example.com", role: "billing", primary: true },
    ],
    billingAddress: { line1: "1 First Street", line2: "", city: "Leeds", state: "", postalCode: "LS1 1AA", country: "United Kingdom" },
    shippingSameAsBilling: true,
    ...extra,
  });

  signedIn("contacts, locations and the account's own columns are what is stored", async () => {
    const account = await post("/api/accounts", body());

    const contacts = await table(`contacts${filter(`account = "${account.id}"`)}&sort=position`);
    expect(contacts.items.map((row: any) => [row.name, row.contactEmail, row.primary, row.position])).toEqual([
      ["Ada", "ada@normal.example.com", false, 0],
      ["Bea", "bea@normal.example.com", true, 1],
    ]);
    // The auth email stays blank: nobody signs in as a contact.
    expect(contacts.items.every((row: any) => !row.email)).toBe(true);

    // One location, named on one line by the hook, and both relations on it.
    expect(account.billingAddressId).toBeTruthy();
    expect(account.shippingAddressId).toBe(account.billingAddressId);
    const location = (await table(`sys_physical_location/${account.billingAddressId}`)).record;
    expect(location.name).toBe("1 First Street, Leeds, LS1 1AA, United Kingdom");

    // The details blob is gone; its contents are columns a filter can reach.
    const row = (await table(`accounts/${account.id}`)).record;
    expect(row.details).toBeUndefined();
    expect(row).toMatchObject({ creditLimit: 5000, paymentTermDays: 15, tags: ["normalized"], billingAddress: account.billingAddressId });
    expect((await table(`accounts${filter(`creditLimit = 5000 && id = "${account.id}"`)}`)).totalItems).toBe(1);

    await api(`/api/accounts/${account.id}`, { method: "DELETE" });
  });

  signedIn("shipping elsewhere gets its own location, and one nothing names is removed", async () => {
    const account = await post("/api/accounts", body());
    const shared = account.billingAddressId;

    const apart = await put(`/api/accounts/${account.id}`, {
      ...body({ shippingSameAsBilling: false, shippingAddress: { line1: "Unit 9", city: "Wakefield", country: "United Kingdom" } }),
      contacts: account.contacts,
    });
    expect(apart.billingAddressId).toBe(shared);
    expect(apart.shippingAddressId).not.toBe(shared);
    expect(apart.shippingAddress.city).toBe("Wakefield");
    const shipping = apart.shippingAddressId;

    // Editing the billing address edits its record in place.
    const moved = await put(`/api/accounts/${account.id}`, {
      ...body({ billingAddress: { ...body().billingAddress, city: "York" } }),
      contacts: account.contacts,
    });
    expect(moved.billingAddressId).toBe(shared);
    expect(moved.shippingSameAsBilling).toBe(true);
    expect((await table(`sys_physical_location/${shared}`)).record.name).toContain("York");
    // And the shipping location it no longer points at is gone.
    expect((await api(`/api/table/sys_physical_location/${shipping}`)).status).toBe(404);

    await api(`/api/accounts/${account.id}`, { method: "DELETE" });
    expect((await api(`/api/table/sys_physical_location/${shared}`)).status).toBe(404);
    expect((await table(`contacts${filter(`account = "${account.id}"`)}`)).totalItems).toBe(0);
  });

  signedIn("a contact keeps its id while it is edited; a dropped one is deleted; a borrowed id is not trusted", async () => {
    const account = await post("/api/accounts", body());
    const [ada, bea] = account.contacts;

    const other = await post("/api/accounts", { ...body(), name: "Other Ltd" });
    const saved = await put(`/api/accounts/${account.id}`, {
      ...body(),
      contacts: [
        { ...bea, title: "Controller" },
        // Another account's contact id: a new contact here, not a move.
        { ...other.contacts[0], name: "Cy" },
      ],
    });
    expect(saved.contacts.map((contact: any) => contact.name)).toEqual(["Bea", "Cy"]);
    expect(saved.contacts[0].id).toBe(bea.id);
    expect(saved.contacts[0].title).toBe("Controller");
    expect(saved.contacts[1].id).not.toBe(other.contacts[0].id);
    expect((await api(`/api/table/contacts/${ada.id}`)).status).toBe(404);
    // The other account still has its own.
    expect((await json(`/api/accounts/${other.id}`)).contacts.map((contact: any) => contact.id)).toContain(other.contacts[0].id);

    await api(`/api/accounts/${account.id}`, { method: "DELETE" });
    await api(`/api/accounts/${other.id}`, { method: "DELETE" });
  });

  signedIn("nobody can sign in as a contact", async () => {
    const methods = await (await fetch(`${pocketbase.url}/api/collections/contacts/auth-methods`)).json();
    expect(methods.password.enabled).toBe(false);
    expect(methods.otp.enabled).toBe(false);
    expect(methods.oauth2.enabled).toBe(false);

    const attempt = await fetch(`${pocketbase.url}/api/collections/contacts/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: "ada@normal.example.com", password: "anything-at-all" }),
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);
  });

  signedIn("another organization sees none of it, and cannot hang a contact on your account", async () => {
    const account = await post("/api/accounts", body());

    expect((await table("contacts", { cookie: bobCookie })).totalItems).toBe(0);
    expect((await table("sys_physical_location", { cookie: bobCookie })).totalItems).toBe(0);

    const intrusion = await fetch(`${pocketbase.url}/api/collections/contacts/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: await bobToken() },
      body: JSON.stringify({ account: account.id, name: "Mallory" }),
    });
    expect(intrusion.status).toBeGreaterThanOrEqual(400);
    expect((await json(`/api/accounts/${account.id}`)).contacts.map((contact: any) => contact.name)).toEqual(["Ada", "Bea"]);

    await api(`/api/accounts/${account.id}`, { method: "DELETE" });
  });
});

/* ------------------------- line items as records ------------------------ */

describe("quote and invoice lines are records", () => {
  const table = (path: string, init?: RequestInit & { cookie?: string }) => json(`/api/table/${path}`, init);
  const linesOf = (collection: string, parent: string, id: string, init?: RequestInit & { cookie?: string }) =>
    table(`${collection}?filter=${encodeURIComponent(`${parent} = "${id}"`)}&sort=position`, init);
  const pbAs = async (path: string, init: RequestInit) =>
    fetch(`${pocketbase.url}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: await bobToken(), ...(init.headers ?? {}) },
    });

  signedIn("a quote's lines are rows, edited in place, and the quote keeps no copy", async () => {
    const two = quoteBody({ name: "Line items" });
    two.lines.push({ ...two.lines[0], id: "ln_2", quantity: 3, sortOrder: 1 } as any);
    const created = (await post("/api/quotes", two)).quote;
    expect(created.lines.map((line: any) => [line.id, line.quantity])).toEqual([
      ["ln_1", 10],
      ["ln_2", 3],
    ]);

    const rows = (await linesOf("quote_lines", "quote", created.id)).items;
    expect(rows.map((row: any) => [row.lineId, row.position, row.sku, row.quantity, row.netTotal])).toEqual([
      ["ln_1", 0, "PLAT", 10, created.lines[0].netTotal],
      ["ln_2", 1, "PLAT", 3, created.lines[1].netTotal],
    ]);
    // What is nested rides in `detail`; the quote record has no lines of its own.
    expect(rows[0].detail.selectedOptions).toEqual(["standard"]);
    expect((await table(`quotes/${created.id}`)).record.lines).toBeUndefined();

    // Changing one line updates its row and leaves the other alone; dropping
    // a line deletes its row.
    const kept = rows[0];
    const saved = await put(`/api/quotes/${created.id}`, quoteBody({ name: "Line items" }, { quantity: 12 }));
    expect(saved.quote.lines.map((line: any) => [line.id, line.quantity])).toEqual([["ln_1", 12]]);
    const after = (await linesOf("quote_lines", "quote", created.id)).items;
    expect(after.map((row: any) => [row.id, row.quantity])).toEqual([[kept.id, 12]]);
    expect((await api(`/api/table/quote_lines/${rows[1].id}`)).status).toBe(404);

    // A line is written through the quote, never as a raw record.
    const raw = await api(`/api/table/quote_lines/${kept.id}`, { method: "PATCH", body: JSON.stringify({ quantity: 1, updated: kept.updated }) });
    expect(raw.status).toBeGreaterThanOrEqual(400);

    await api(`/api/quotes/${created.id}`, { method: "DELETE" });
    expect((await linesOf("quote_lines", "quote", created.id)).totalItems).toBe(0);
  });

  signedIn("another organization reads none of them, and cannot add one to your quote", async () => {
    const created = (await post("/api/quotes", quoteBody({ name: "Private lines" }))).quote;

    expect((await linesOf("quote_lines", "quote", created.id, { cookie: bobCookie })).totalItems).toBe(0);
    const intrusion = await pbAs("/api/collections/quote_lines/records", {
      method: "POST",
      body: JSON.stringify({ quote: created.id, lineId: "ln_evil", sku: "FREE", netTotal: 0 }),
    });
    expect(intrusion.status).toBeGreaterThanOrEqual(400);
    expect((await json(`/api/quotes/${created.id}`)).lines.map((line: any) => line.id)).toEqual(["ln_1"]);

    await api(`/api/quotes/${created.id}`, { method: "DELETE" });
  });

  signedIn("an invoice's lines are rows, and fixed in PocketBase itself once it is issued", async () => {
    const { invoice: draft } = await post("/api/invoices", {
      accountId,
      lines: [
        { description: "Setup", quantity: 1, unitPrice: 300 },
        { description: "Training", quantity: 2, unitPrice: 50, taxPercent: 10 },
      ],
    });
    const rows = (await linesOf("invoice_lines", "invoice", draft.id)).items;
    expect(rows.map((row: any) => [row.description, row.amount, row.taxAmount])).toEqual([
      ["Setup", 300, 0],
      ["Training", 100, 10],
    ]);
    expect((await table(`invoices/${draft.id}`)).record.lines).toBeUndefined();

    await post(`/api/invoices/${draft.id}/issue`, { issueDate: "2026-04-01" });

    // The server refuses to edit an issued invoice's lines; the collection
    // rule refuses it too, for anyone writing to PocketBase directly.
    const login = await fetch(`${pocketbase.url}/api/collections/users/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: ALICE, password: PASSWORD }),
    });
    const alice = (await login.json()).token;
    const direct = await fetch(`${pocketbase.url}/api/collections/invoice_lines/records/${rows[0].id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: alice },
      body: JSON.stringify({ unitPrice: 1, amount: 1 }),
    });
    expect(direct.status).toBe(404);
    expect((await json(`/api/invoices/${draft.id}`)).lines[0].amount).toBe(300);

    // Voiding it writes the invoice alone: nothing on a line changed.
    const voided = await post(`/api/invoices/${draft.id}/void`, {});
    expect(voided.state).toBe("void");
    expect(voided.lines).toHaveLength(2);
  });

  signedIn("discarding a draft takes its lines with it", async () => {
    const { invoice: draft } = await post("/api/invoices", { accountId, lines: [{ description: "Discarded", quantity: 1, unitPrice: 10 }] });
    expect((await linesOf("invoice_lines", "invoice", draft.id)).totalItems).toBe(1);
    await api(`/api/invoices/${draft.id}`, { method: "DELETE" });
    expect((await linesOf("invoice_lines", "invoice", draft.id)).totalItems).toBe(0);
  });
});

/* --------------------------------- sharing ------------------------------- */

/* ------------------------------ attachments ------------------------------ */

describe("attachments", () => {
  /** A multipart upload — no JSON Content-Type, so fetch writes the boundary. */
  const upload = (fields: Record<string, string>, file: File | null, session = cookie) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    if (file) form.set("file", file, file.name);
    return fetch(`${BASE}/api/attachments`, { method: "POST", body: form, headers: { cookie: session } });
  };
  const textFile = (name: string, text: string, type = "text/plain") => new File([text], name, { type });

  let quoteId = "";
  let attachmentId = "";

  signedIn("a file goes onto a quote, with its own name, size and type", async () => {
    quoteId = (await post("/api/quotes", quoteBody({ name: "With a PO" }))).quote.id;

    const response = await upload({ target: "quotes", recordId: quoteId, note: "Signed" }, textFile("order form.txt", "PO 4471"));
    expect(response.status).toBe(201);
    const stored = await response.json();
    expect(stored).toMatchObject({ target: "quotes", recordId: quoteId, name: "order form.txt", size: 7, note: "Signed" });
    expect(stored.mimeType).toStartWith("text/plain");
    attachmentId = stored.id;

    const listed = await json(`/api/attachments?target=quotes&recordId=${quoteId}`);
    expect(listed.map((one: any) => one.id)).toEqual([attachmentId]);
    // A quote's files are not its approval's, nor anybody else's record's.
    expect(await json(`/api/attachments?target=approvals&recordId=${quoteId}`)).toEqual([]);
  });

  signedIn("the bytes come back as a download, as the caller", async () => {
    const response = await api(`/api/attachments/${attachmentId}/file`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PO 4471");
    expect(response.headers.get("content-disposition")).toStartWith("attachment;");
    expect(response.headers.get("content-disposition")).toContain("order%20form.txt");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  signedIn("an HTML file is never shown in place, whatever is asked", async () => {
    const stored = await (
      await upload({ target: "quotes", recordId: quoteId }, textFile("page.html", "<script>alert(1)</script>", "text/html"))
    ).json();
    const response = await api(`/api/attachments/${stored.id}/file?inline=1`);
    expect(response.headers.get("content-disposition")).toStartWith("attachment;");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    await api(`/api/attachments/${stored.id}`, { method: "DELETE" });
  });

  signedIn("somebody outside the organization sees none of it", async () => {
    expect((await api(`/api/attachments?target=quotes&recordId=${quoteId}`, { cookie: bobCookie })).status).toBe(200);
    expect(await json(`/api/attachments?target=quotes&recordId=${quoteId}`, { cookie: bobCookie })).toEqual([]);
    expect((await api(`/api/attachments/${attachmentId}/file`, { cookie: bobCookie })).status).toBe(404);
    expect((await upload({ target: "quotes", recordId: quoteId }, textFile("x.txt", "x"), bobCookie)).status).toBe(404);
    expect((await api(`/api/attachments/${attachmentId}`, { method: "DELETE", cookie: bobCookie })).status).toBe(404);
  });

  signedIn("a file goes on a customer and an invoice too", async () => {
    const onAccount = await upload({ target: "accounts", recordId: accountId }, textFile("w9.txt", "W-9"));
    expect(onAccount.status).toBe(201);

    const invoice = await post("/api/invoices", { accountId });
    const invoiceId = invoice.invoice?.id ?? invoice.id;
    const onInvoice = await upload({ target: "invoices", recordId: invoiceId }, textFile("remittance.txt", "paid"));
    expect(onInvoice.status).toBe(201);

    // Discarding the draft takes its files with it: nothing points at a ghost.
    await api(`/api/invoices/${invoiceId}`, { method: "DELETE" });
    expect(await json(`/api/attachments?target=invoices&recordId=${invoiceId}`)).toEqual([]);
  });

  signedIn("a record that does not exist, and a target that is not one, are refused", async () => {
    expect((await upload({ target: "quotes", recordId: "nosuchquote0000" }, textFile("a.txt", "a"))).status).toBe(404);
    expect((await upload({ target: "products", recordId: platformId }, textFile("a.txt", "a"))).status).toBe(400);
    expect((await upload({ target: "quotes", recordId: quoteId }, null)).status).toBe(400);
    expect((await upload({ target: "quotes", recordId: quoteId }, textFile("empty.txt", ""))).status).toBe(400);
  });

  signedIn("an approver from another organization reads, and adds to, the approval's files", async () => {
    const ruleId = (
      await post("/api/approval-rules", {
        name: "Attachments test",
        scope: "quote",
        metric: "discountPercent",
        comparator: ">",
        threshold: 40,
        level: 1,
        approvers: [BOB],
      })
    ).id;

    const created = await post("/api/quotes", quoteBody({ name: "Needs a case" }, { discountPercent: 45 }));
    const id = created.quote.id;
    const evidence = await (await upload({ target: "approvals", recordId: id }, textFile("case.txt", "competitor at 40%"))).json();
    const internal = await (await upload({ target: "quotes", recordId: id }, textFile("internal.txt", "ours"))).json();
    expect((await post(`/api/quotes/${id}/submit`, {})).quote.status).toBe("in_review");

    // Bob was asked: he sees the case, and the quote's own files, because he sees the quote.
    const seen = await json(`/api/attachments?target=approvals&recordId=${id}`, { cookie: bobCookie });
    expect(seen.map((one: any) => one.id)).toEqual([evidence.id]);
    expect((await json(`/api/attachments?target=quotes&recordId=${id}`, { cookie: bobCookie })).map((one: any) => one.id)).toEqual([
      internal.id,
    ]);
    expect(await (await api(`/api/attachments/${evidence.id}/file`, { cookie: bobCookie })).text()).toBe("competitor at 40%");

    // He may add to the approval — and it is filed under Alice's organization, where she sees it.
    const his = await upload({ target: "approvals", recordId: id }, textFile("note.txt", "ok if 2-year"), bobCookie);
    expect(his.status).toBe(201);
    const hisFile = await his.json();
    expect(hisFile.orgId).toBe(evidence.orgId);
    expect((await json(`/api/attachments?target=approvals&recordId=${id}`)).map((one: any) => one.id)).toContain(hisFile.id);

    // But not to the quote itself, and not remove what Alice put there.
    expect((await upload({ target: "quotes", recordId: id }, textFile("x.txt", "x"), bobCookie)).status).toBe(403);
    expect((await api(`/api/attachments/${evidence.id}`, { method: "DELETE", cookie: bobCookie })).status).toBe(404);
    // His own, he may.
    expect((await api(`/api/attachments/${hisFile.id}`, { method: "DELETE", cookie: bobCookie })).status).toBe(200);

    await api(`/api/approval-rules/${ruleId}`, { method: "DELETE" });
  });

  signedIn("deleting a quote takes its files, and its approval's, with it", async () => {
    const id = (await post("/api/quotes", quoteBody({ name: "Short-lived" }))).quote.id;
    await upload({ target: "quotes", recordId: id }, textFile("a.txt", "a"));
    await upload({ target: "approvals", recordId: id }, textFile("b.txt", "b"));
    expect((await api(`/api/quotes/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await json(`/api/attachments?target=quotes&recordId=${id}`)).toEqual([]);
    expect(await json(`/api/attachments?target=approvals&recordId=${id}`)).toEqual([]);
  });
});

/* -------------------------------- api keys ------------------------------- */

describe("an API key", () => {
  /** Sent the way a script would: a header, and no cookie at all. */
  const withKey = (path: string, key: string, init?: RequestInit) =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), "X-API-Key": key },
    });

  signedIn("is returned once, and reaches exactly what its owner reaches", async () => {
    const issued = await post("/api/keys", { name: "Nightly invoice run" });
    expect(issued.key).toStartWith("cpq_");
    expect(issued.id).toBeString();

    // The listing describes it and never carries it again.
    const listed = await json("/api/keys");
    const row = listed.find((entry: any) => entry.id === issued.id);
    expect(row.name).toBe("Nightly invoice run");
    expect(row.key).toBeUndefined();
    // Never expires, so the field is empty rather than a date in 1970.
    expect(row.expiresAt).toBe("");

    // It sees Alice's catalogue, because PocketBase resolves it to Alice.
    const catalogue = await (await withKey("/api/products", issued.key)).json();
    expect(catalogue.map((product: any) => product.sku)).toContain("PLAT");

    // And it is Alice to /api/auth/me as well, which is what the docs page reads.
    const me = await (await withKey("/api/auth/me", issued.key)).json();
    expect(me.user.email).toBe(ALICE);

    // It does not see Bob's.
    const bobsKey = (await post("/api/keys", { name: "Bob's" }, { cookie: bobCookie })).key;
    const bobsCatalogue = await (await withKey("/api/products", bobsKey)).json();
    expect(bobsCatalogue.map((product: any) => product.sku)).not.toContain("PLAT");
  });

  signedIn("cannot manage keys, because revoking is how you recover from a leak", async () => {
    const issued = await post("/api/keys", { name: "Leaked" });

    for (const [path, method] of [
      ["/api/keys", "GET"],
      ["/api/keys", "POST"],
      [`/api/keys/${issued.id}`, "DELETE"],
    ] as const) {
      const response = await withKey(path, issued.key, {
        method,
        ...(method === "POST" ? { body: JSON.stringify({ name: "another" }) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    // The sentence is the app's, not a 403 from two layers down.
    const refused = await (await withKey("/api/keys", issued.key)).json();
    expect(refused.error).toContain("cannot manage API keys");
  });

  signedIn("stops working the moment it is revoked", async () => {
    const issued = await post("/api/keys", { name: "Short-lived" });
    expect((await withKey("/api/products", issued.key)).status).toBe(200);

    expect((await api(`/api/keys/${issued.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await withKey("/api/products", issued.key)).status).toBe(401);

    // Revoking it twice is a 404, not a second success.
    expect((await api(`/api/keys/${issued.id}`, { method: "DELETE" })).status).toBe(404);
  });

  signedIn("a key that was never issued is refused, whatever it looks like", async () => {
    expect((await withKey("/api/products", "cpq_not_a_real_key_at_all")).status).toBe(401);
  });

  signedIn("carries an expiry when one is asked for", async () => {
    const issued = await post("/api/keys", { name: "Ninety days", expiresInDays: 90 });
    const days = Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(90);
  });
});

/* -------------------------------- the docs ------------------------------- */

describe("the API document", () => {
  test("is served without a credential, because /docs is read before signing in", async () => {
    const response = await api("/api/openapi.json", { cookie: " " });
    expect(response.status).toBe(200);

    const document = await response.json();
    expect(document.openapi).toBe("3.0.3");
    // It names the host it was fetched from, so an imported collection points
    // back at this server rather than at whatever the file happened to say.
    expect(document.servers[0].url).toBe(BASE);
    expect(document.paths["/api/quotes"].get.operationId).toBe("listQuotes");
  });

  test("and /api prints the same list of endpoints", async () => {
    const [index, document] = await Promise.all([
      json("/api", { cookie: " " }),
      json("/api/openapi.json", { cookie: " " }),
    ]);

    const documented = Object.values(document.paths as Record<string, Record<string, unknown>>).reduce(
      (count, methods) => count + Object.keys(methods).length,
      0,
    );
    expect(Object.keys(index.endpoints)).toHaveLength(documented);
  });

  test("/docs is a page, not the SPA's shell by accident", async () => {
    const response = await api("/docs", { cookie: " " });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("API reference");
  });
});

describe("the data table", () => {
  test("/table is a page of its own", async () => {
    const response = await api("/table?table_name=products", { cookie: " " });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Data table");
  });

  test("reading a collection needs an account", async () => {
    expect((await api("/api/table/products", { cookie: " " })).status).toBe(401);
  });

  signedIn("lists a collection through PocketBase's own filter, with its columns", async () => {
    const page = await json(`/api/table/products?filter=${encodeURIComponent('sku = "PLAT"')}`);
    expect(page.totalItems).toBe(1);
    expect(page.items[0].sku).toBe("PLAT");
    expect(page.items[0].collectionId).toBeUndefined();
    expect(page.fields.map((field: { name: string }) => field.name)).toContain("sku");
    expect(page.fields[0]).toEqual({ name: "id", type: "text" });
  });

  signedIn("sorts and pages in PocketBase, not on the loaded rows", async () => {
    const made = [
      await post("/api/products", { ...PLATFORM, sku: "TBL-B", name: "Table B" }),
      await post("/api/products", { ...PLATFORM, sku: "TBL-A", name: "Table A" }),
    ];
    const filter = encodeURIComponent('sku ~ "TBL-"');

    const descending = await json(`/api/table/products?filter=${filter}&sort=-sku&perPage=1`);
    expect(descending.totalItems).toBe(2);
    expect(descending.totalPages).toBe(2);
    expect(descending.items.map((item: { sku: string }) => item.sku)).toEqual(["TBL-B"]);

    const second = await json(`/api/table/products?filter=${filter}&sort=-sku&perPage=1&page=2`);
    expect(second.items.map((item: { sku: string }) => item.sku)).toEqual(["TBL-A"]);

    // Later describes count the catalogue.
    for (const product of made) await api(`/api/products/${product.id}`, { method: "DELETE" });
  });

  signedIn("a filter that matches nothing still says what the columns are", async () => {
    const page = await json(`/api/table/products?filter=${encodeURIComponent('sku = "no-such-sku"')}`);
    expect(page.totalItems).toBe(0);
    expect(page.items).toEqual([]);
    expect(page.fields.map((field: { name: string }) => field.name)).toContain("sku");
  });

  signedIn("the collection's rules decide the rows: another organization's are invisible", async () => {
    const filter = encodeURIComponent('name = "Harbour Logistics"');
    expect((await json(`/api/table/accounts?filter=${filter}`)).totalItems).toBe(1);
    expect((await json(`/api/table/accounts?filter=${filter}`, { cookie: bobCookie })).totalItems).toBe(0);
  });

  signedIn("a hidden field never leaves PocketBase", async () => {
    const issued = await post("/api/keys", { name: "table check" });
    const page = await json("/api/table/api_keys");
    const row = page.items.find((item: { id: string }) => item.id === issued.id);
    expect(row).toBeDefined();
    expect(row.key_hash).toBeUndefined();
    expect(page.fields.map((field: { name: string }) => field.name)).not.toContain("key_hash");
    await api(`/api/keys/${issued.id}`, { method: "DELETE" });
  });

  signedIn("refusals are sentences with honest statuses", async () => {
    const badFilter = await api(`/api/table/products?filter=${encodeURIComponent("nonsense ===")}`);
    expect(badFilter.status).toBe(400);
    expect((await badFilter.json()).error).toContain("refused the filter");

    const missing = await api("/api/table/no_such_collection");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toContain("no collection called");

    // No user rule reaches the counters at all.
    const counters = await api("/api/table/counters");
    expect(counters.status).toBe(403);

    expect((await api("/api/table/a-b")).status).toBe(400);
    expect((await api("/api/table/products?sort=name;drop")).status).toBe(400);
    expect((await api("/api/table/products?perPage=100000")).status).toBe(400);
  });

  const patchRecord = (path: string, payload: unknown, init?: RequestInit & { cookie?: string }) =>
    api(path, { ...init, method: "PATCH", body: JSON.stringify(payload) });

  signedIn("a row opens as a record with a form, built from the record when none is stored", async () => {
    const opened = await json(`/api/table/products/${platformId}`);
    expect(opened.record.sku).toBe("PLAT");
    expect(opened.record.collectionId).toBeUndefined();
    expect(opened.form).toMatchObject({ collection: "products", source: "default", configId: null, writable: true });
    const names = opened.form.layout.sections.flatMap((section: any) => section.fields.map((field: any) => field.name));
    expect(names).toContain("sku");

    // Another organization's record is simply not there.
    expect((await api(`/api/table/products/${platformId}`, { cookie: bobCookie })).status).toBe(404);
    expect((await api("/api/table/products/no_such_record")).status).toBe(404);
    expect((await api("/api/table/products/a-b")).status).toBe(400);
  });

  signedIn("saving writes the fields the form offers, and refuses a stale or locked write", async () => {
    const before = (await json(`/api/table/products/${platformId}`)).record;

    const saved = await patchRecord(`/api/table/products/${platformId}`, {
      values: { name: "Platform (table)" },
      updated: before.updated,
    });
    expect(saved.status).toBe(200);
    const after = (await saved.json()).record;
    expect(after.name).toBe("Platform (table)");

    // Opened before that save: refused rather than overwritten.
    const stale = await patchRecord(`/api/table/products/${platformId}`, { values: { name: "Stale" }, updated: before.updated });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain("changed since you opened it");

    const locked = await patchRecord(`/api/table/products/${platformId}`, { values: { owner: "someone" } });
    expect(locked.status).toBe(400);
    expect((await locked.json()).error).toContain("set by PocketBase");

    const mistyped = await patchRecord(`/api/table/products/${platformId}`, { values: { listPrice: "lots" } });
    expect(mistyped.status).toBe(400);

    expect((await patchRecord(`/api/table/products/${platformId}`, { values: { name: "Hijack" } }, { cookie: bobCookie })).status).toBe(404);

    // Later describes read the product's name.
    await patchRecord(`/api/table/products/${platformId}`, { values: { name: before.name } });
    expect((await json(`/api/table/products/${platformId}`)).record.name).toBe(before.name);
  });

  signedIn("quotes open read-only: the server prices them, so this route never writes one", async () => {
    const quote = (await post("/api/quotes", quoteBody({ name: "Table read-only" }))).quote;
    expect(quote.id).toBeDefined();
    const opened = await json(`/api/table/quotes/${quote.id}`);
    expect(opened.form.writable).toBe(false);
    expect(opened.form.readOnlyReason).toContain("quote editor");

    const write = await patchRecord(`/api/table/quotes/${quote.id}`, { values: { total: 1 } });
    expect(write.status).toBe(409);

    // Later describes count the quotes.
    await api(`/api/quotes/${quote.id}`, { method: "DELETE" });
  });

  signedIn("a layout stored in record_forms shapes the form and narrows the write", async () => {
    const account = (await json(`/api/table/accounts?filter=${encodeURIComponent('name = "Harbour Logistics"')}`)).items[0];

    const response = await api("/api/record-forms/accounts", { method: "POST" });
    expect(response.status).toBe(201);
    const config = await response.json();
    expect(config.collection).toBe("accounts");
    expect(config.layout.sections.length).toBeGreaterThan(0);
    expect((await api("/api/record-forms/accounts", { method: "POST" })).status).toBe(409);

    // The layout is a record like any other, edited through the same form.
    const layout = { sections: [{ title: "Basics", fields: [{ name: "name", required: true, label: "Account name" }] }] };
    const edited = await patchRecord(`/api/table/record_forms/${config.id}`, { values: { layout } });
    expect(edited.status).toBe(200);

    const unusable = await patchRecord(`/api/table/record_forms/${config.id}`, {
      values: { layout: { sections: [{ fields: [{ name: "x", widget: "slider" }] }] } },
    });
    expect(unusable.status).toBe(400);
    expect((await unusable.json()).error).toContain("cannot be used");

    const opened = await json(`/api/table/accounts/${account.id}`);
    expect(opened.form).toMatchObject({ source: "stored", configId: config.id, problem: null });
    expect(opened.form.layout).toEqual({ sections: [{ ...layout.sections[0], description: "", columns: 2 }], rest: "hidden" });

    const offLayout = await patchRecord(`/api/table/accounts/${account.id}`, { values: { currency: "EUR" } });
    expect(offLayout.status).toBe(400);
    expect((await offLayout.json()).error).toContain("not an editable field");

    const blank = await patchRecord(`/api/table/accounts/${account.id}`, { values: { name: "" } });
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toContain("Account name is required");

    // Another organization neither sees this layout nor gets it.
    expect((await json("/api/table/record_forms", { cookie: bobCookie })).totalItems).toBe(0);
    expect((await patchRecord(`/api/table/record_forms/${config.id}`, { values: { title: "x" } }, { cookie: bobCookie })).status).toBe(404);
  });
});

describe("the record workspace", () => {
  const send = (method: string, path: string, payload: unknown, init?: RequestInit & { cookie?: string }) =>
    api(path, { ...init, method, body: JSON.stringify(payload) });

  signedIn("an invoice opens with its ledger as tabs, and a summary worked out from it", async () => {
    const created = await post("/api/quotes", quoteBody({ name: "Workspace" }));
    await post(`/api/quotes/${created.quote.id}/submit`, {});
    await post(`/api/quotes/${created.quote.id}/status`, { status: "sent" });
    await post(`/api/quotes/${created.quote.id}/status`, { status: "accepted" });
    const invoice = (await post(`/api/quotes/${created.quote.id}/invoice`, {})).invoice;
    await post(`/api/invoices/${invoice.id}/issue`, {});
    await post(`/api/invoices/${invoice.id}/payments`, { amount: 100, receivedOn: "2026-01-10", method: "bank" });
    await post(`/api/invoices/${invoice.id}/payments`, { amount: 50, receivedOn: "2026-01-11", method: "bank" });

    const page = await json(`/api/workspace/invoices/${invoice.id}`);
    expect(page.record.id).toBe(invoice.id);
    expect(page.workspaceSource).toBe("default");
    expect(page.workspace.relatedLists.map((list: any) => list.key)).toEqual(["lines", "payments", "credits", "files"]);
    expect(page.counts).toMatchObject({ payments: 2, credits: 0, files: 0 });

    const line = (key: string) => page.summary.lines.find((entry: any) => entry.key === key);
    expect(line("paid").value).toBe(150);
    expect(line("credited").value).toBe(0);
    expect(line("balanceDue").value).toBe(invoice.totals.total - 150);
    expect(line("balanceDue").emphasis).toBe(true);

    // The quote it bills lists it, and says what is left to bill.
    const quotePage = await json(`/api/workspace/quotes/${created.quote.id}`);
    expect(quotePage.counts.invoices).toBe(1);
    expect(quotePage.summary.lines.find((entry: any) => entry.key === "toBill").value).toBe(0);

    // Somebody in another organization gets neither the record nor a count of anything behind it.
    expect((await api(`/api/workspace/invoices/${invoice.id}`, { cookie: bobCookie })).status).toBe(404);
  });

  signedIn("a draft previews without being stored; a broken one is refused with where it broke", async () => {
    const workspace = {
      relatedLists: [{ key: "quotes", collection: "quotes", field: "header.customer.accountId" }],
      summary: {
        items: [
          { kind: "rollup", key: "n", label: "Quotes", list: "quotes", op: "count" },
          { kind: "formula", key: "twice", label: "Twice", expression: "n * 2" },
        ],
      },
    };
    const preview = await (await send("POST", `/api/workspace/accounts/${accountId}/preview`, { workspace })).json();
    const n = preview.summary.lines[0].value;
    expect(n).toBeGreaterThan(0);
    expect(preview.summary.lines[1].value).toBe(n * 2);

    const broken = await send("POST", `/api/workspace/accounts/${accountId}/preview`, {
      workspace: { ...workspace, summary: { items: [{ kind: "formula", key: "x", expression: "later + 1" }] } },
    });
    expect(broken.status).toBe(400);
    expect((await broken.json()).error).toContain("later");

    expect((await json(`/api/workspace/accounts/${accountId}`)).workspaceSource).not.toBe("stored");
  });

  signedIn("both layouts are stored together, read back, and drawn", async () => {
    const before = await json("/api/record-forms/accounts");
    expect(before.fields.map((field: any) => field.name)).toContain("currency");

    const saved = await send("PUT", "/api/record-forms/accounts", {
      title: "Customer",
      description: "",
      layout: { sections: [{ title: "Basics", fields: ["name", "currency"] }], rest: "hidden" },
      workspace: {
        relatedLists: [{ key: "files", collection: "sys_attachment", field: "recordId", match: [{ field: "target", value: "accounts" }], allowCreate: true }],
        summary: { items: [{ kind: "field", key: "cur", label: "Currency", field: "currency", format: "text" }] },
      },
    });
    expect(saved.status).toBe(200);
    const config = await saved.json();
    expect(config.configId).toBeTruthy();
    expect(config.workspace.relatedLists[0].key).toBe("files");

    const page = await json(`/api/workspace/accounts/${accountId}`);
    expect(page.workspaceSource).toBe("stored");
    expect(page.summary.lines).toMatchObject([{ key: "cur", value: "USD" }]);
    expect(page.form.layout.sections[0].fields.map((field: any) => field.name)).toEqual(["name", "currency"]);

    const refused = await send("PUT", "/api/record-forms/accounts", {
      layout: { sections: [] },
      workspace: { summary: { items: [{ kind: "rollup", key: "x", list: "missing", op: "count" }] } },
    });
    expect(refused.status).toBe(400);
  });

  signedIn("New in a related list creates through the form, pointing back at the record", async () => {
    const response = await send("POST", "/api/table/accounts", { values: { name: "Made in a tab", currency: "EUR" }, link: {} });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ name: "Made in a tab", currency: "EUR" });
    // Stamped by the hooks, not the request.
    expect(created.org).toBeTruthy();

    // Only what the form offers is written; the link may not reach for what PocketBase stamps.
    expect((await send("POST", "/api/table/accounts", { values: { name: "x", currency: "USD", details: {} } })).status).toBe(400);
    expect((await send("POST", "/api/table/accounts", { values: { name: "x", currency: "USD" }, link: { owner: "someone" } })).status).toBe(400);

    // The ledger, and anything else the server totals, is never made through a form.
    expect((await send("POST", "/api/table/payments", { values: {}, link: { invoice: "x" } })).status).toBe(409);
    expect((await send("POST", "/api/table/quotes", { values: {} })).status).toBe(409);

    await api(`/api/accounts/${created.id}`, { method: "DELETE" });
  });
});

describe("sharing", () => {
  signedIn("a shared product is readable, not writable, and quotable", async () => {
    await post(`/api/products/${platformId}/shares`, { email: BOB });

    const shares = await json(`/api/products/${platformId}/shares`);
    expect(shares.sharedWith).toEqual([BOB]);
    expect(shares.canShare).toBe(true);

    // Bob sees it now.
    const bobsCatalogue = await json("/api/products", { cookie: bobCookie });
    expect(bobsCatalogue.map((product: any) => product.sku)).toEqual(["PLAT"]);

    // He cannot change it.
    const write = await api(`/api/products/${platformId}`, {
      method: "PUT",
      cookie: bobCookie,
      body: JSON.stringify({ ...PLATFORM, name: "Bob's platform" }),
    });
    expect(write.status).toBe(404);

    // But he can quote from it, and the quote is his.
    const bobsQuote = await post(
      "/api/quotes",
      { name: "Bob's deal", currency: "USD", termMonths: 12, lines: [{ productId: platformId, quantity: 5, selectedOptions: ["standard"] }] },
      { cookie: bobCookie },
    );
    expect(bobsQuote.quote.totals.netTotal).toBe(6_000);
    expect((await json("/api/quotes")).find((quote: any) => quote.id === bobsQuote.quote.id)).toBeUndefined();

    // A recipient sees who shared it, and not who else has it.
    const bobsView = await json(`/api/products/${platformId}/shares`, { cookie: bobCookie });
    expect(bobsView.owner).toBe(ALICE);
    expect(bobsView.canShare).toBe(false);
    expect(bobsView.sharedWith).toEqual([]);

    await api(`/api/products/${platformId}/shares?email=${encodeURIComponent(BOB)}`, { method: "DELETE" });
    expect(await json("/api/products", { cookie: bobCookie })).toEqual([]);
  });

  signedIn("the directory lists your organization, and nobody outside it", async () => {
    // A picker needs something to offer — but an instance shared by several
    // companies must not hand any one of them the others' staff list.
    const payload = await json("/api/directory");

    const emails = payload.users.map((user: any) => user.email);
    expect(emails).toContain(ALICE);
    expect(emails).not.toContain(BOB);

    // Sorted, so a long list is scannable.
    expect([...emails].sort()).toEqual(emails);
  });

  signedIn("the directory gives out an address and a name, and nothing else", async () => {
    const { users } = await json("/api/directory");
    const alice = users.find((user: any) => user.email === ALICE);

    expect(Object.keys(alice).sort()).toEqual(["email", "id", "name"]);
    // Not the things an account would not want handed out.
    expect(alice).not.toHaveProperty("verified");
    expect(alice).not.toHaveProperty("created");
    expect(alice).not.toHaveProperty("preferences");
  });

  signedIn("it still takes an account to read it", async () => {
    expect((await api("/api/directory", { cookie: " " })).status).toBe(401);
  });

  signedIn("the collection itself stays closed — the directory is the only way through", async () => {
    // Bob's own token against PocketBase directly: the `users` list rule is
    // untouched, so he sees himself and nobody else.
    const response = await fetch(`${pocketbase.url}/api/collections/users/records?perPage=100`, {
      headers: { Authorization: await bobToken() },
    });

    const listed = (await response.json()).items ?? [];
    expect(listed.every((user: any) => user.id === undefined || user.email === BOB || !user.email)).toBe(true);
  });

  signedIn("sharing an address with no account says so", async () => {
    const response = await api(`/api/products/${platformId}/shares`, {
      method: "POST",
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("No account is registered");
  });
});

/* ------------------------------- the outputs ----------------------------- */

describe("what comes out", () => {
  let quoteId = "";

  signedIn("a quote exports as CSV with one row per line", async () => {
    quoteId = (await post("/api/quotes", quoteBody({ name: "For export" }))).quote.id;

    const response = await api(`/api/quotes/${quoteId}/export?format=csv`);
    expect(response.headers.get("content-type")).toContain("text/csv");

    const [header, row] = (await response.text()).split("\n");
    expect(header).toContain("sku");
    expect(header).toContain("netTotal");
    // Bare numbers, because a spreadsheet has to add them up.
    expect(row).toContain("12000");
  });

  signedIn("a quote renders through a proposal template", async () => {
    const response = await api(`/api/quotes/${quoteId}/document?templateId=${templateId}`);
    expect(response.headers.get("content-disposition")).toContain(".txt");

    const text = await response.text();
    expect(text).toContain("Harbour Logistics");
    expect(text).toContain("PLAT");
    expect(text).toContain("$12,000.00");
  });

  signedIn("a PDF template answers with a PDF, not with text", async () => {
    const pdfTemplateId = (
      await post("/api/proposal-templates", {
        name: "PDF proposal",
        format: "pdf",
        // An empty body means "the starter", which is what the editor opens.
        body: "",
      })
    ).id;

    const response = await api(`/api/quotes/${quoteId}/document?templateId=${pdfTemplateId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(".pdf");

    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.7")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // The quote's own details are in the file.
    expect(text).toContain("Harbour Logistics");

    // `?inline` is the same PDF, dispositioned for an iframe rather than a save.
    const inline = await api(`/api/quotes/${quoteId}/document?templateId=${pdfTemplateId}&inline`);
    expect(inline.headers.get("content-type")).toBe("application/pdf");
    expect(inline.headers.get("content-disposition")).toContain("inline");
  });

  signedIn("a PDF template is stored as the canonical document, margin rows dropped", async () => {
    const created = await post("/api/proposal-templates", {
      name: "Hand-written PDF",
      format: "pdf",
      body: JSON.stringify({
        page: { size: "Letter", fontSize: 99 },
        blocks: [
          { type: "text", text: "Hello {{customer.name}}" },
          { type: "totals", rows: [{ label: "Margin", field: "marginPercent" }] },
        ],
        footer: { text: "" },
      }),
    });

    const stored = JSON.parse(created.body);
    expect(stored.page.size).toBe("Letter");
    // Clamped rather than refused.
    expect(stored.page.fontSize).toBeLessThanOrEqual(18);
    // A proposal template has no way to name an internal number, so the row
    // was dropped and the block fell back to the customer-facing default.
    expect(JSON.stringify(stored)).not.toContain("marginPercent");
  });

  signedIn("a PDF template whose body is not JSON is refused", async () => {
    const response = await api("/api/proposal-templates", {
      method: "POST",
      body: JSON.stringify({ name: "Broken", format: "pdf", body: "# not a document" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("valid JSON");
  });

  signedIn("an invoice renders through an invoice template", async () => {
    const invoiceTemplateId = (
      await post("/api/proposal-templates", {
        name: "Plain invoice",
        kind: "invoice",
        format: "text",
        body: "{{invoice.number}} for {{customer.name}}\n{{lines.table}}\nDue {{invoice.dueDate}}: {{totals.balance}}",
      })
    ).id;

    const raised = await post("/api/invoices", {
      accountId,
      lines: [{ description: "Consultancy", quantity: 2, unitPrice: 750, taxPercent: 10 }],
    });
    const invoice = await post(`/api/invoices/${raised.invoice.id}/issue`, {});

    const response = await api(`/api/invoices/${invoice.id}/document?templateId=${invoiceTemplateId}`);
    expect(response.headers.get("content-disposition")).toContain(".txt");

    const text = await response.text();
    expect(text).toContain(invoice.number);
    expect(text).toContain("Harbour Logistics");
    expect(text).toContain("Consultancy");
    expect(text).toContain("$1,650.00");

    // The balance on the page is the ledger's, computed on this read — so a
    // payment banked a second ago is on the document a customer downloads.
    await post(`/api/invoices/${invoice.id}/payments`, { amount: 650 });
    expect(await (await api(`/api/invoices/${invoice.id}/document?templateId=${invoiceTemplateId}`)).text()).toContain(
      "$1,000.00",
    );

    // And ?inline is the preview pane's envelope, as it is for a quote.
    const payload = await json(`/api/invoices/${invoice.id}/document?templateId=${invoiceTemplateId}&inline`);
    expect(payload.format).toBe("text");
    expect(payload.unknownTokens).toEqual([]);
  });

  signedIn("a template of the wrong kind is refused, with what is wrong", async () => {
    // Rendering a quote template against an invoice would resolve every token
    // to a blank and hand the customer a document full of holes.
    const raised = await post("/api/invoices", {
      accountId,
      lines: [{ description: "Mismatched", quantity: 1, unitPrice: 100 }],
    });

    const response = await api(`/api/invoices/${raised.invoice.id}/document?templateId=${templateId}`);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("quote template");

    await api(`/api/invoices/${raised.invoice.id}`, { method: "DELETE" });
  });

  signedIn("an invoice PDF template is held to the invoice totals list", async () => {
    const created = await post("/api/proposal-templates", {
      name: "Hand-written invoice PDF",
      kind: "invoice",
      format: "pdf",
      body: JSON.stringify({
        page: {},
        blocks: [
          { type: "text", text: "Invoice {{invoice.number}}" },
          {
            type: "totals",
            rows: [
              { label: "Contract value", field: "totalContractValue" },
              { label: "Margin", field: "marginPercent" },
            ],
          },
        ],
        footer: { text: "" },
      }),
    });

    expect(created.kind).toBe("invoice");
    // Neither a quote's numbers nor an internal one survive the read.
    expect(created.body).not.toContain("totalContractValue");
    expect(created.body).not.toContain("marginPercent");
    expect(created.body).toContain("balance");
  });

  signedIn("a template written before invoices existed is still a quote's", async () => {
    // No `kind` in the body at all, which is every template stored before the
    // column existed and every script written against the old API.
    const created = await post("/api/proposal-templates", {
      name: "Kindless",
      format: "text",
      body: "{{quote.number}}",
    });
    expect(created.kind).toBe("quote");
  });

  signedIn("?inline gives the preview pane the text and its warnings", async () => {
    const payload = await json(`/api/quotes/${quoteId}/document?templateId=${templateId}&inline`);
    expect(payload.format).toBe("text");
    expect(payload.unknownTokens).toEqual([]);
    expect(payload.text).toContain("Harbour Logistics");
  });

  signedIn("the catalogue round-trips through *.cpq.json", async () => {
    const file = await json("/api/catalog/export");
    expect(file.kind).toBe(CATALOG_FILE_KIND);
    expect(file.products[0].sku).toBe("PLAT");
    // Ids are stripped, so the file is stable and diffable.
    expect(file.products[0].id).toBeUndefined();

    // Re-importing skips what is already there rather than duplicating it.
    const reimport = await post("/api/catalog/import", file);
    expect(reimport.skipped).toContain("product PLAT");

    // Into a fresh account it imports whole.
    const carol = await register(`carol-${suffix}@example.com`);
    const fresh = await post("/api/catalog/import", file, { cookie: carol });
    expect(fresh.created.products).toBeGreaterThan(0);
    expect((await json("/api/products", { cookie: carol })).map((p: any) => p.sku)).toContain("PLAT");
  });

  signedIn("a catalogue file from a newer version is refused", async () => {
    const payload = await post("/api/catalog/import", { kind: CATALOG_FILE_KIND, version: 99, products: [] });
    expect(payload.error).toContain("version 99");
  });

  signedIn("the workspace export holds everything, quotes included", async () => {
    const file = await json("/api/export");
    expect(file.kind).toBe(WORKSPACE_FILE_KIND);
    expect(file.exportedBy).toBe(ALICE);
    expect(file.catalog.kind).toBe(CATALOG_FILE_KIND);
    expect(file.accounts[0].name).toBe("Harbour Logistics");
    expect(file.quotes.length).toBeGreaterThan(0);

    // The receivables come out too, with their ledgers — an export that kept
    // what you offered but not what you are owed is half a backup.
    expect(Array.isArray(file.invoices)).toBe(true);
    expect(file.invoices.length).toBeGreaterThan(0);
    const withLedger = file.invoices.find((one: any) => one.payments.length > 0);
    expect(withLedger).toBeDefined();
    expect(withLedger.lines.length).toBeGreaterThan(0);
    // Nothing derived is in the file: status and aging are recomputed on read.
    expect(withLedger.status).toBeUndefined();
    expect(file.quotes[0].lines).toBeArray();
    expect(file.preferences.defaultCurrency).toBe("USD");
  });
});

/* ------------------------------- preferences ----------------------------- */

describe("preferences", () => {
  signedIn("they start at the defaults and clamp what they are sent", async () => {
    expect(await json("/api/preferences")).toEqual(DEFAULT_PREFERENCES);

    const saved = await put("/api/preferences", {
      theme: "dark",
      defaultTermMonths: 9_999,
      quoteValidDays: 0,
      defaultCurrency: "NOPE",
      showMargin: true,
      locale: "en-GB",
      somethingElse: "dropped",
    });

    expect(saved.theme).toBe("dark");
    expect(saved.defaultTermMonths).toBe(PREFERENCE_LIMITS.termMonths.max);
    expect(saved.quoteValidDays).toBe(PREFERENCE_LIMITS.validDays.min);
    expect(saved.defaultCurrency).toBe("USD");
    expect(saved.showMargin).toBe(true);
    expect(saved).not.toHaveProperty("somethingElse");

    await put("/api/preferences", DEFAULT_PREFERENCES);
  });

  signedIn("a display name can be changed, and nothing else on the account rides along", async () => {
    const before = (await json("/api/auth/me")).user;
    const patch = (body: unknown) =>
      api("/api/auth/profile", { method: "PATCH", body: JSON.stringify(body) });

    // The org and role are hook-guarded fields; a body naming them changes neither.
    const renamed = await patch({ name: "  Alice Example  ", org: "org_elsewhere", role: "viewer" });
    expect(renamed.status).toBe(200);
    const { user } = await renamed.json();
    expect(user.name).toBe("Alice Example");
    expect(user.email).toBe(before.email);
    expect(user.org?.id).toBe(before.org?.id);
    expect(user.role).toBe(before.role);

    expect((await patch({ name: "x".repeat(500) })).status).toBe(400);

    await patch({ name: before.name });
  });
});

/* --------------------------------- sample -------------------------------- */

describe("the worked example", () => {
  signedIn("installs into a fresh account, and is idempotent", async () => {
    const dave = await register(`dave-${suffix}@example.com`);

    const first = await post("/api/sample", {}, { cookie: dave });
    expect(first.created.products).toBe(8);
    expect(first.created.quotes).toBe(1);
    expect(first.quoteId).toBeString();

    // The sample quote is built to need approval.
    const submitted = await post(`/api/quotes/${first.quoteId}/submit`, {}, { cookie: dave });
    expect(submitted.quote.status).toBe("in_review");
    expect(submitted.required.length).toBeGreaterThan(0);

    const second = await post("/api/sample", {}, { cookie: dave });
    expect(second.created.products ?? 0).toBe(0);
    expect(second.skipped.products).toBe(8);
  });

  signedIn("the healthcare set arrives with quotes at every stage", async () => {
    const hana = await register(`hana-${suffix}@example.com`);

    const first = await post("/api/sample?set=healthcare", {}, { cookie: hana });
    expect(first.created.products).toBe(42);
    expect(first.created.priceBooks).toBe(4);
    expect(first.created.accounts).toBe(5);
    expect(first.created.quotes).toBe(5);
    expect(first.notes.filter((note: string) => note.includes("stopped short"))).toEqual([]);

    const quotes = await json("/api/quotes?limit=0", { cookie: hana });
    const statuses = Object.fromEntries(quotes.map((quote: any) => [quote.name.split(" - ")[0], quote.status]));
    expect(statuses).toEqual({
      Riverbend: "accepted",
      Lakeshore: "approved",
      "Prairie View": "sent",
      "Bluff County": "in_review",
      "Cedar Valley": "draft",
    });

    // A customer with a contract book is priced from it without the quote naming it.
    const riverbend = quotes.find((quote: any) => quote.name.startsWith("Riverbend"));
    const whole = await json(`/api/quotes/${riverbend.id}`, { cookie: hana });
    expect(whole.lines.find((line: any) => line.sku === "HST-HOT").unitPrice).toBe(240);

    const second = await post("/api/sample?set=healthcare", {}, { cookie: hana });
    expect(second.created.quotes ?? 0).toBe(0);
    expect(second.skipped.quotes).toBe(5);
    expect(second.skipped.products).toBe(42);
  });

  signedIn("an unknown set is refused", async () => {
    const ivo = await register(`ivo-${suffix}@example.com`);
    const response = await fetch(`${BASE}/api/sample?set=nope`, { method: "POST", headers: { cookie: ivo } });
    expect(response.status).toBe(400);
  });

  signedIn("it arrives with a receivables book spread across the aging", async () => {
    const erin = await register(`erin-${suffix}@example.com`);
    const report = await post("/api/sample", {}, { cookie: erin });

    expect(report.created.invoices).toBe(3);

    // The invoices went in through the ordinary path, so they are issued,
    // dated, and one of them is part paid.
    const invoices = await json("/api/invoices", { cookie: erin });
    expect(invoices).toHaveLength(3);
    expect(invoices.every((one: any) => one.state === "issued")).toBe(true);
    expect(invoices.every((one: any) => one.issueDate && one.dueDate)).toBe(true);
    expect(invoices.some((one: any) => one.totals.paidAmount > 0)).toBe(true);

    // One settled, one late, one badly late — which is the whole point of
    // shipping sample invoices rather than an empty five-column report.
    const aged = await json("/api/receivables/aging?currency=USD", { cookie: erin });
    expect(aged.outstanding).toBeGreaterThan(0);
    expect(aged.overdue).toBeGreaterThan(0);
    expect(aged.paidAmount).toBeGreaterThan(0);
    expect(aged.buckets["90+"].count).toBe(1);

    // And a second install does not raise the same three again.
    const again = await post("/api/sample", {}, { cookie: erin });
    expect(again.created.invoices ?? 0).toBe(0);
    expect(again.skipped.invoices).toBe(3);
    expect(await json("/api/invoices", { cookie: erin })).toHaveLength(3);
  });
});

/* ------------------------- organizations and roles ----------------------- */

/**
 * The rules that decide who may change what live in PocketBase
 * (1750000010_organizations.js); `PERMISSIONS` in src/lib/organization.ts is
 * the same table written down for the UI. These walk the table against the
 * real rules with one account per role, invited into Alice's organization.
 */
describe("organizations and roles", () => {
  const SALES = `sam-${suffix}@example.com`;
  const FINANCE = `fay-${suffix}@example.com`;
  const VIEWER = `vic-${suffix}@example.com`;
  const sessions: Record<string, string> = {};
  let orgId = "";

  const as = (role: string) => ({ cookie: sessions[role] });

  /** Status only — what a refused write comes back as. */
  const status = async (path: string, method: string, payload: unknown, role: string) =>
    (await api(path, { method, body: JSON.stringify(payload), cookie: sessions[role] })).status;

  signedIn("every account starts as the admin of an organization of its own", async () => {
    const alice = await json("/api/org");
    const bob = await json("/api/org", { cookie: bobCookie });

    expect(alice.role).toBe("admin");
    expect(alice.org.id).toBeString();
    expect(bob.org.id).not.toBe(alice.org.id);
    orgId = alice.org.id;

    // The session carries it, so the first paint knows what to hide.
    const me = await json("/api/auth/me");
    expect(me.user.org.id).toBe(orgId);
    expect(me.user.role).toBe("admin");
  });

  signedIn("an invited address joins the organization when it registers", async () => {
    const invited = await post("/api/org/members", { email: SALES, role: "sales" });
    expect(invited.outcome).toBe("invited");
    expect(invited.invitations.map((invite: any) => invite.email)).toContain(SALES);

    sessions.sales = await register(SALES);
    const me = await json("/api/auth/me", as("sales"));
    expect(me.user.org.id).toBe(orgId);
    expect(me.user.role).toBe("sales");

    // An existing account is added straight away instead.
    sessions.finance = await register(FINANCE);
    const added = await post("/api/org/members", { email: FINANCE, role: "finance" });
    expect(added.outcome).toBe("added");
    // They now belong to two organizations, and are still working in their own.
    const finance = await json("/api/org", as("finance"));
    expect(finance.memberships).toHaveLength(2);
    const switched = await post("/api/org/switch", { orgId }, as("finance"));
    expect(switched.role).toBe("finance");

    await post("/api/org/members", { email: VIEWER, role: "viewer" });
    sessions.viewer = await register(VIEWER);
  });

  signedIn("everyone in the organization reads everything in it", async () => {
    for (const role of ["sales", "finance", "viewer"]) {
      const products = await json("/api/products", as(role));
      expect(products.map((product: any) => product.id)).toContain(platformId);
      const accounts = await json("/api/accounts", as(role));
      expect(accounts.map((account: any) => account.id)).toContain(accountId);
    }
    // …and nobody outside it does.
    const bobs = await json("/api/products", { cookie: bobCookie });
    expect(bobs.map((product: any) => product.id)).not.toContain(platformId);
  });

  signedIn("the catalogue and pricing policy are the admins' to change", async () => {
    for (const role of ["sales", "finance", "viewer"]) {
      expect(await status("/api/products", "POST", { ...PLATFORM, sku: `X-${role}-${suffix}` }, role)).toBeGreaterThanOrEqual(400);
      expect(await status(`/api/products/${platformId}`, "PUT", { ...PLATFORM, name: "Renamed" }, role)).toBe(404);
      expect(await status("/api/pricing-rules", "POST", { name: "Sneaky", scope: "line", target: "discountPercent", expression: "50" }, role)).toBeGreaterThanOrEqual(400);
      expect((await api("/api/sample", { method: "POST", cookie: sessions[role] })).status).toBe(403);
    }
    expect((await json(`/api/products/${platformId}`)).name).toBe("Platform");
  });

  signedIn("sales and finance keep customers; a viewer does not", async () => {
    expect(await status("/api/accounts", "POST", { name: `By sales ${suffix}`, currency: "USD" }, "sales")).toBe(201);
    expect(await status("/api/accounts", "POST", { name: `By finance ${suffix}`, currency: "USD" }, "finance")).toBe(201);
    expect(await status("/api/accounts", "POST", { name: `By viewer ${suffix}`, currency: "USD" }, "viewer")).toBeGreaterThanOrEqual(400);
  });

  signedIn("a sales member writes their own quotes, and only an admin writes anybody's", async () => {
    const theirs = await post("/api/quotes", quoteBody({ name: "Sam's deal" }), as("sales"));
    expect(theirs.quote.ownerId).not.toBe("");
    // Numbered in the organization's run, not a run of their own.
    expect(theirs.quote.number).toMatch(/^Q-\d{4}-\d{4}$/);

    const alices = await post("/api/quotes", quoteBody({ name: "Alice's deal" }));
    expect(await status(`/api/quotes/${alices.quote.id}`, "PUT", quoteBody({ name: "Taken" }), "sales")).toBe(404);
    expect((await api(`/api/quotes/${alices.quote.id}/revise`, { method: "POST", cookie: sessions.sales })).status).toBe(403);
    expect(await status(`/api/quotes/${theirs.quote.id}`, "PUT", quoteBody({ name: "Sam's bigger deal" }), "sales")).toBe(200);

    // The admin can write anybody's — a deal outlives the rep who wrote it.
    expect(await status(`/api/quotes/${theirs.quote.id}`, "PUT", quoteBody({ name: "Reassigned" }), "admin")).toBe(200);

    for (const role of ["finance", "viewer"]) {
      expect(await status("/api/quotes", "POST", quoteBody({ name: "Not mine to write" }), role)).toBeGreaterThanOrEqual(400);
    }
  });

  signedIn("quote numbers run per organization, from one counter", async () => {
    const sequence = (number: string) => Number(number.split("-")[2]);
    const first = await post("/api/quotes", quoteBody({ name: "One" }));
    const second = await post("/api/quotes", quoteBody({ name: "Two" }), as("sales"));
    expect(sequence(second.quote.number)).toBe(sequence(first.quote.number) + 1);

    // Another organization's quotes — even one shared with Alice — move nothing.
    const bobs = await post("/api/quotes", quoteBody({ name: "Bob's", accountId: null, lines: [] }), { cookie: bobCookie });
    await post(`/api/quotes/${bobs.quote.id}/shares`, { email: ALICE }, { cookie: bobCookie });
    const third = await post("/api/quotes", quoteBody({ name: "Three" }));
    expect(sequence(third.quote.number)).toBe(sequence(second.quote.number) + 1);
  });

  signedIn("invoices are finance's and the admin's", async () => {
    const quote = await post("/api/quotes", quoteBody({ name: "To bill" }));
    await post(`/api/quotes/${quote.quote.id}/submit`, {});
    await post(`/api/quotes/${quote.quote.id}/status`, { status: "sent" });

    expect((await api(`/api/quotes/${quote.quote.id}/invoice`, { method: "POST", cookie: sessions.sales })).status).toBeGreaterThanOrEqual(400);
    const raised = await api(`/api/quotes/${quote.quote.id}/invoice`, { method: "POST", cookie: sessions.finance });
    expect(raised.status).toBe(201);
    const invoice = (await raised.json()).invoice;

    expect((await api(`/api/invoices/${invoice.id}/issue`, { method: "POST", body: "{}", cookie: sessions.viewer })).status).toBeGreaterThanOrEqual(400);
    const issued = await post(`/api/invoices/${invoice.id}/issue`, {}, as("finance"));
    expect(issued.number).toMatch(/^INV-/);
  });

  /** A fresh quote walked to `accepted` — no approval rule trips on the default body. */
  const acceptedQuote = async (name: string) => {
    const created = await post("/api/quotes", quoteBody({ name }));
    await post(`/api/quotes/${created.quote.id}/submit`, {});
    await post(`/api/quotes/${created.quote.id}/status`, { status: "sent" });
    return post(`/api/quotes/${created.quote.id}/status`, { status: "accepted" });
  };

  signedIn("an invoice is numbered when it is issued, so a discarded draft leaves no gap", async () => {
    const quote = await acceptedQuote("Numbered on issue");
    const issue = async () => {
      const raised = await post(`/api/quotes/${quote.id}/invoice`, {});
      return post(`/api/invoices/${raised.invoice.id}/issue`, { issueDate: "2026-04-01" });
    };
    const sequence = (number: string) => Number(number.split("-")[2]);

    const first = await issue();
    expect(first.number).toMatch(/^INV-2026-\d{4}$/);

    // A draft raised and thrown away in between…
    const discarded = await post(`/api/quotes/${quote.id}/invoice`, {});
    expect((await api(`/api/invoices/${discarded.invoice.id}`, { method: "DELETE" })).status).toBe(200);

    // …takes nothing from the run.
    const second = await issue();
    expect(sequence(second.number)).toBe(sequence(first.number) + 1);
  });

  signedIn("a draft cannot be issued by editing its state", async () => {
    const quote = await acceptedQuote("Sneaky issue");
    const raised = await post(`/api/quotes/${quote.id}/invoice`, {});

    // Straight at PocketBase, past this server: the hook still refuses it.
    const response = await fetch(`${pocketbase.url}/api/collections/invoices/records/${raised.invoice.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: decodeURIComponent(cookie.split("=")[1] ?? "") },
      body: JSON.stringify({ state: "issued", number: "INV-1999-0001" }),
    });
    expect(response.status).toBe(400);
    expect((await json(`/api/invoices/${raised.invoice.id}`)).state).toBe("draft");
  });

  signedIn("only an admin manages members, and the last admin cannot leave", async () => {
    expect(await status("/api/org/members", "POST", { email: `x-${suffix}@example.com`, role: "admin" }, "sales")).toBe(403);

    const { members } = await json("/api/org/members");
    const alice = members.find((member: any) => member.email === ALICE);
    const demote = await api(`/api/org/members/${alice.id}`, { method: "PUT", body: JSON.stringify({ role: "viewer" }) });
    expect(demote.status).toBe(400);
    expect((await demote.json()).error).toContain("only admin");

    // A role change applies at once — the very next request.
    const viewer = members.find((member: any) => member.email === VIEWER);
    await put(`/api/org/members/${viewer.id}`, { role: "sales" });
    expect(await status("/api/accounts", "POST", { name: `Promoted ${suffix}`, currency: "USD" }, "viewer")).toBe(201);
    await put(`/api/org/members/${viewer.id}`, { role: "viewer" });
    expect(await status("/api/accounts", "POST", { name: `Demoted ${suffix}`, currency: "USD" }, "viewer")).toBeGreaterThanOrEqual(400);
  });

  signedIn("a role cannot be granted by writing it onto your own account", async () => {
    const me = await json("/api/auth/me", as("viewer"));
    const token = decodeURIComponent(sessions.viewer!.split("=")[1] ?? "");
    await fetch(`${pocketbase.url}/api/collections/users/records/${me.user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ role: "admin", org: orgId }),
    });
    expect((await json("/api/auth/me", as("viewer"))).user.role).toBe("viewer");
  });

  signedIn("a removed member loses access at once, and their records stay", async () => {
    const leaver = `leo-${suffix}@example.com`;
    await post("/api/org/members", { email: leaver, role: "sales" });
    const session = await register(leaver);
    const quote = await post("/api/quotes", quoteBody({ name: "Leo's deal" }), { cookie: session });

    const { members } = await json("/api/org/members");
    const leo = members.find((member: any) => member.email === leaver);
    expect((await api(`/api/org/members/${leo.id}`, { method: "DELETE" })).status).toBe(200);

    expect((await api(`/api/quotes/${quote.quote.id}`, { cookie: session })).status).toBe(404);
    // The deal belongs to the organization, not to the person who left.
    expect((await json(`/api/quotes/${quote.quote.id}`)).name).toBe("Leo's deal");
  });

  signedIn("an API key works in the organization it was issued in", async () => {
    const issued = await post("/api/keys", { name: "pinned" });
    const keyed = (path: string) => fetch(`${BASE}${path}`, { headers: { "X-API-Key": issued.key } });

    // Alice starts a second organization and moves into it…
    const second = await post("/api/orgs", { name: `Side project ${suffix}` });
    expect(second.role).toBe("admin");
    expect((await json("/api/org")).org.id).toBe(second.org.id);
    expect((await json("/api/products")).map((product: any) => product.id)).not.toContain(platformId);

    // …and the key, issued in the first, refuses to follow her: a script
    // written against one catalogue must not start writing to another.
    const refused = await keyed("/api/products");
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("another organization");

    // Back in the first, it works again.
    await post("/api/org/switch", { orgId });
    expect((await json("/api/org")).org.id).toBe(orgId);
    expect((await (await keyed("/api/org")).json()).org.id).toBe(orgId);
    expect((await (await keyed("/api/products")).json()).map((product: any) => product.id)).toContain(platformId);

    // A key cannot move between organizations or manage members.
    const switched = await fetch(`${BASE}/api/org/switch`, {
      method: "POST",
      headers: { "X-API-Key": issued.key, "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: second.org.id }),
    });
    expect(switched.status).toBe(403);
  });

  signedIn("today is a day in the organization's time zone", async () => {
    expect((await api("/api/org", { method: "PUT", body: JSON.stringify({ timeZone: "Mars/Olympus" }) })).status).toBe(400);
    expect(await status("/api/org", "PUT", { timeZone: "Pacific/Kiritimati" }, "sales")).toBe(403);

    // UTC+14: the zone most often on a different date from UTC.
    const zone = "Pacific/Kiritimati";
    const saved = await put("/api/org", { timeZone: zone });
    expect(saved.settings.timeZone).toBe(zone);

    const { quoteValidDays } = await json("/api/preferences");
    const created = await post("/api/quotes", quoteBody({ name: "Dated", validUntil: "" }));
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
    const expected = new Date(`${local}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + Math.max(1, quoteValidDays));
    expect(created.quote.validUntil).toBe(expected.toISOString().slice(0, 10));

    await put("/api/org", { timeZone: "" });
  });

  signedIn("signing out ends the session, not just the cookie", async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ALICE, password: PASSWORD }),
    });
    const session = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await api("/api/org", { cookie: session })).status).toBe(200);

    const out = await post("/api/auth/logout", {}, { cookie: session });
    expect(out.revoked).toBe(true);

    // Somebody who copied the cookie before it was cleared gets nothing.
    expect((await api("/api/org", { cookie: session })).status).toBe(401);
    // Alice's other session is untouched.
    expect((await api("/api/org")).status).toBe(200);
  });
});
