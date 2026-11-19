import { describe, expect, test } from "bun:test";
import {
  defaultOpportunityName,
  filterOpportunities,
  isPastClose,
  leadAccountName,
  pipelineTotals,
  probabilityFor,
  sortOpportunities,
  weightedAmount,
  type Opportunity,
} from "./pipeline";
import { readLead, readLeadConversion, readOpportunity, readQuoteHeader } from "./validate";
import { can, canEditOpportunity } from "./organization";

const deal = (overrides: Partial<Opportunity> = {}): Opportunity => ({
  id: "opp_1",
  name: "Expansion",
  accountId: "acc_1",
  accountName: "Harbour Logistics",
  contactId: "",
  stage: "proposal",
  amount: 1000,
  currency: "USD",
  probability: 50,
  closeDate: "2026-12-01",
  source: "",
  nextStep: "",
  lossReason: "",
  notes: "",
  leadId: "",
  closedAt: "",
  ownerId: "usr_1",
  orgId: "org_1",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("probability", () => {
  test("an open stage takes what was asked for, clamped, or its own default", () => {
    expect(probabilityFor("proposal", 65)).toBe(65);
    expect(probabilityFor("proposal", 140)).toBe(100);
    expect(probabilityFor("proposal", -5)).toBe(0);
    expect(probabilityFor("negotiation", null)).toBe(75);
    expect(probabilityFor("prospecting", Number.NaN)).toBe(10);
  });

  test("a closed stage fixes it, whatever was asked", () => {
    expect(probabilityFor("closed_won", 20)).toBe(100);
    expect(probabilityFor("closed_lost", 90)).toBe(0);
  });

  test("the weighted amount is rounded to the currency", () => {
    expect(weightedAmount(deal({ amount: 333.33, probability: 33 }))).toBe(110);
    expect(weightedAmount(deal({ amount: 1001, probability: 33, currency: "JPY" }))).toBe(330);
  });
});

describe("the pipeline", () => {
  test("never adds two currencies", () => {
    const rows = pipelineTotals([
      deal({ id: "a", amount: 1000, probability: 50 }),
      deal({ id: "b", amount: 500, probability: 10 }),
      deal({ id: "c", amount: 9000, currency: "EUR", probability: 25 }),
      deal({ id: "d", amount: 200, stage: "closed_won", probability: 100 }),
      deal({ id: "e", amount: 700, stage: "closed_lost", probability: 0 }),
    ]);

    // The bigger open pipeline first.
    expect(rows.map(row => row.currency)).toEqual(["EUR", "USD"]);
    const usd = rows.find(row => row.currency === "USD")!;
    expect(usd).toMatchObject({ openCount: 2, openAmount: 1500, weightedAmount: 550, wonCount: 1, wonAmount: 200, lostCount: 1, winRate: 50 });
    expect(rows.find(row => row.currency === "EUR")).toMatchObject({ openCount: 1, openAmount: 9000, weightedAmount: 2250, winRate: 0 });
  });

  test("an open deal past its close date is overdue; a closed one never is", () => {
    expect(isPastClose(deal({ closeDate: "2026-11-01" }), "2026-11-19")).toBe(true);
    expect(isPastClose(deal({ closeDate: "2026-11-19" }), "2026-11-19")).toBe(false);
    expect(isPastClose(deal({ closeDate: "2026-11-01", stage: "closed_won" }), "2026-11-19")).toBe(false);
    expect(isPastClose(deal({ closeDate: "" }), "2026-11-19")).toBe(false);
  });

  test("open deals sort by close date, undated last, closed ones after", () => {
    const sorted = sortOpportunities([
      deal({ id: "closed", stage: "closed_won", closedAt: "2026-10-01T00:00:00.000Z" }),
      deal({ id: "undated", closeDate: "" }),
      deal({ id: "late", closeDate: "2027-03-01" }),
      deal({ id: "soon", closeDate: "2026-11-25" }),
    ]);
    expect(sorted.map(opportunity => opportunity.id)).toEqual(["soon", "late", "undated", "closed"]);
  });

  test("the open filter is every stage that is not closed", () => {
    const all = [deal({ id: "a" }), deal({ id: "b", stage: "closed_lost" }), deal({ id: "c", name: "Renewal", accountName: "Acme" })];
    expect(filterOpportunities(all, { stage: "open" }).map(row => row.id)).toEqual(["a", "c"]);
    expect(filterOpportunities(all, { search: "acme" }).map(row => row.id)).toEqual(["c"]);
  });
});

describe("leads", () => {
  test("a customer made from a lead is named after its company, or its person", () => {
    expect(leadAccountName({ company: " Acme ", name: "Dana" })).toBe("Acme");
    expect(leadAccountName({ company: "", name: "Dana Okafor" })).toBe("Dana Okafor");
    expect(defaultOpportunityName({ company: "Acme", name: "" })).toBe("Acme — new business");
  });

  test("a lead needs somebody to call, and cannot be marked converted by hand", () => {
    expect(readLead({})).toEqual({ ok: false, error: "A lead needs a name or a company." });
    expect(readLead({ company: "Acme", status: "converted" }).ok).toBe(false);
    expect(readLead({ name: "Dana", email: "not-an-address" }).ok).toBe(false);

    const read = readLead({ name: " Dana ", email: "DANA@Example.com", source: "nonsense", estimatedAmount: -4, status: "working" });
    expect(read).toMatchObject({ ok: true, value: { name: "Dana", email: "dana@example.com", source: "other", estimatedAmount: 0, status: "working", currency: "USD" } });
  });

  test("an unknown currency is refused rather than guessed", () => {
    expect(readLead({ company: "Acme", currency: "XYZ" }).ok).toBe(false);
  });
});

describe("reading an opportunity", () => {
  test("it needs a name and a customer", () => {
    expect(readOpportunity({ accountId: "acc_1" }).ok).toBe(false);
    expect(readOpportunity({ name: "Deal" }).ok).toBe(false);
    expect(readOpportunity({ name: "Deal", accountId: "acc_1", stage: "won" }).ok).toBe(false);
  });

  test("a closed stage fixes the probability; a loss reason only survives on a lost deal", () => {
    const won = readOpportunity({ name: "Deal", accountId: "acc_1", stage: "closed_won", probability: 10, lossReason: "price" });
    expect(won).toMatchObject({ ok: true, value: { probability: 100, lossReason: "" } });

    const lost = readOpportunity({ name: "Deal", accountId: "acc_1", stage: "closed_lost", probability: 80, lossReason: "price" });
    expect(lost).toMatchObject({ ok: true, value: { probability: 0, lossReason: "price" } });

    // No probability given: the stage's own.
    expect(readOpportunity({ name: "Deal", accountId: "acc_1", stage: "negotiation" })).toMatchObject({ ok: true, value: { probability: 75 } });
  });
});

describe("a conversion request", () => {
  test("everything is optional, and defaults to a new customer with a deal", () => {
    expect(readLeadConversion({})).toEqual({
      ok: true,
      value: { accountId: null, addContact: true, createOpportunity: true, opportunity: { name: "", amount: null, closeDate: "", stage: "qualification" } },
    });
  });

  test("an amount left out takes the lead's estimate; one given is kept, even 0", () => {
    expect(readLeadConversion({ opportunity: { amount: 0 } })).toMatchObject({ ok: true, value: { opportunity: { amount: 0 } } });
    expect(readLeadConversion({ opportunity: { stage: "nope" } }).ok).toBe(false);
  });
});

describe("a quote's opportunity", () => {
  test("left out it is kept; null or empty unlinks it", () => {
    const header = (extra: object) => readQuoteHeader({ name: "Q", ...extra });
    expect(header({})).toMatchObject({ ok: true });
    expect((header({}) as { value: object }).value).not.toHaveProperty("opportunityId");
    expect(header({ opportunityId: null })).toMatchObject({ ok: true, value: { opportunityId: null } });
    expect(header({ opportunityId: "" })).toMatchObject({ ok: true, value: { opportunityId: null } });
    expect(header({ opportunityId: "opp_1" })).toMatchObject({ ok: true, value: { opportunityId: "opp_1" } });
  });
});

describe("who works the pipeline", () => {
  test("admin and sales; finance and viewers read it", () => {
    for (const role of ["admin", "sales"] as const) {
      expect(can(role, "leads.write")).toBe(true);
      expect(can(role, "opportunities.create")).toBe(true);
    }
    for (const role of ["finance", "viewer"] as const) {
      expect(can(role, "leads.write")).toBe(false);
      expect(can(role, "opportunities.create")).toBe(false);
    }
  });

  test("a deal is edited by its owner in sales, or by any admin", () => {
    const mine = { ownerId: "usr_1", orgId: "org_1" };
    const theirs = { ownerId: "usr_2", orgId: "org_1" };
    const me = { id: "usr_1", orgId: "org_1" };
    expect(canEditOpportunity("sales", mine, me)).toBe(true);
    expect(canEditOpportunity("sales", theirs, me)).toBe(false);
    expect(canEditOpportunity("admin", theirs, me)).toBe(true);
    expect(canEditOpportunity("admin", { ownerId: "usr_2", orgId: "org_9" }, me)).toBe(false);
    expect(canEditOpportunity("finance", mine, me)).toBe(false);
  });
});
