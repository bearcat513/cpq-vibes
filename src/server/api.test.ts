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

    // The original is untouched — that is the point of a revision.
    const original = await json(`/api/quotes/${created.quote.id}`);
    expect(original.version).toBe(1);
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

/* --------------------------------- sharing ------------------------------- */

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

  signedIn("the directory lists the accounts, so a picker has something to offer", async () => {
    // The complaint this answers: an empty approver dropdown on an instance
    // with ten accounts, because the list was built from addresses you had
    // already typed rather than from the accounts that exist.
    const payload = await json("/api/directory");

    const emails = payload.users.map((user: any) => user.email);
    expect(emails).toContain(ALICE);
    expect(emails).toContain(BOB);
    expect(payload.users.length).toBeGreaterThanOrEqual(2);

    // Sorted, so a long list is scannable.
    expect([...emails].sort()).toEqual(emails);
  });

  signedIn("the directory gives out an address and a name, and nothing else", async () => {
    const { users } = await json("/api/directory");
    const bob = users.find((user: any) => user.email === BOB);

    expect(Object.keys(bob).sort()).toEqual(["email", "id", "name"]);
    // Not the things an account would not want handed out.
    expect(bob).not.toHaveProperty("verified");
    expect(bob).not.toHaveProperty("created");
    expect(bob).not.toHaveProperty("preferences");
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
});
