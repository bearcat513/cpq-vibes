/**
 * The approval engine decides who has to look at a deal before it leaves. The
 * tests below are the three properties that make that mean anything: the
 * ladder is cumulative, nobody can approve ahead of their turn, and a rule
 * nobody can answer never blocks a quote forever.
 */
import { describe, expect, test } from "bun:test";
import {
  allApproved,
  anyRejected,
  applyDecision,
  approvalProgress,
  currentApprovers,
  evaluateApprovals,
  requestStatus,
} from "./approvals";
import type { ApprovalRule, PricedLine, QuoteTotals } from "./types";

const totals = (overrides: Partial<QuoteTotals> = {}): QuoteTotals => ({
  currency: "USD",
  lineCount: 1,
  listTotal: 10_000,
  lineDiscountAmount: 3_000,
  subtotal: 7_000,
  quoteDiscountAmount: 0,
  quoteAdjustment: 0,
  netTotal: 7_000,
  taxAmount: 0,
  shipping: 0,
  grandTotal: 7_000,
  effectiveDiscountPercent: 30,
  costTotal: 4_000,
  margin: 3_000,
  marginPercent: 42.86,
  oneTimeTotal: 7_000,
  monthlyRecurringTotal: 0,
  annualRecurringTotal: 0,
  totalContractValue: 7_000,
  ...overrides,
});

const line = (overrides: Partial<PricedLine> = {}): PricedLine =>
  ({
    id: "ln_1",
    sku: "PLAT",
    name: "Platform",
    effectiveDiscountPercent: 30,
    marginPercent: 42,
    margin: 3_000,
    netTotal: 7_000,
    listTotal: 10_000,
    costTotal: 4_000,
    quantity: 10,
    unitPrice: 70,
    listUnitPrice: 100,
    termMonths: 12,
    periods: 12,
    chargeType: "recurring",
    ...overrides,
  }) as PricedLine;

const rule = (overrides: Partial<ApprovalRule> = {}): ApprovalRule => ({
  id: "apv_1",
  name: "Sales manager",
  scope: "quote",
  metric: "discountPercent",
  comparator: ">",
  threshold: 15,
  condition: "",
  level: 1,
  approvers: ["manager@example.com"],
  approvalsRequired: 1,
  rejectionsRequired: 1,
  message: "",
  active: true,
  ownerId: "u1",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const quote = (overrides: Partial<Parameters<typeof evaluateApprovals>[0]> = {}) => ({
  totals: totals(),
  lines: [line()],
  termMonths: 12,
  ...overrides,
});

describe("what a quote trips", () => {
  test("a metric past its threshold fires, with the numbers in the reason", () => {
    const outcome = evaluateApprovals(quote(), [rule()]);

    expect(outcome.autoApproved).toBe(false);
    expect(outcome.required).toHaveLength(1);
    expect(outcome.required[0]!.reason).toBe("Discount 30% > 15%");
    expect(outcome.required[0]!.approverEmails).toEqual(["manager@example.com"]);
    expect(outcome.required[0]!.decisions).toEqual([]);
    expect(outcome.required[0]!.status).toBe("pending");
  });

  test("a quote inside policy is approved outright", () => {
    const outcome = evaluateApprovals(
      quote({ totals: totals({ effectiveDiscountPercent: 10 }) }),
      [rule()],
    );
    expect(outcome.autoApproved).toBe(true);
    expect(outcome.highestLevel).toBe(0);
  });

  test("levels are cumulative — the VP does not replace the manager", () => {
    const outcome = evaluateApprovals(quote(), [
      rule(),
      rule({ id: "apv_2", name: "VP", threshold: 25, level: 2, approvers: ["vp@example.com"] }),
    ]);

    expect(outcome.required.map(request => request.level)).toEqual([1, 2]);
    expect(outcome.highestLevel).toBe(2);
  });

  test("a line-scoped rule fires per line, naming the SKU", () => {
    const outcome = evaluateApprovals(
      quote({ lines: [line(), line({ id: "ln_2", sku: "STOR", effectiveDiscountPercent: 5 })] }),
      [rule({ scope: "line" })],
    );

    expect(outcome.required).toHaveLength(1);
    expect(outcome.required[0]!.lineId).toBe("ln_1");
    expect(outcome.required[0]!.reason).toContain("PLAT");
  });

  test("floorBreach measures a line against its own product's ceiling", () => {
    const outcome = evaluateApprovals(
      quote({ floorByLineId: new Map([["ln_1", 20]]) }),
      [rule({ scope: "line", metric: "floorBreach", threshold: 0 })],
    );

    expect(outcome.required[0]!.reason).toContain("10% past its 20% ceiling");

    // Within the ceiling, nothing fires.
    const inside = evaluateApprovals(
      quote({ floorByLineId: new Map([["ln_1", 40]]) }),
      [rule({ scope: "line", metric: "floorBreach", threshold: 0 })],
    );
    expect(inside.autoApproved).toBe(true);
  });

  test("a custom rule is a formula over the same variables", () => {
    const services = rule({
      metric: "custom",
      condition: "oneTimeTotal > netTotal * 0.5",
      message: "Services are more than half the deal.",
    });

    expect(evaluateApprovals(quote(), [services]).required[0]!.reason).toBe("Services are more than half the deal.");
  });

  test("an inactive rule, or one with nobody to ask, is skipped", () => {
    // A rule nobody can answer would block the quote forever, which is worse
    // than the discount it was written to catch.
    const outcome = evaluateApprovals(quote(), [
      rule({ active: false }),
      rule({ id: "apv_2", approvers: ["  "] }),
      rule({ id: "apv_3", approvers: [] }),
    ]);
    expect(outcome.autoApproved).toBe(true);
  });
});

describe("deciding", () => {
  const laddered = () =>
    evaluateApprovals(quote(), [
      rule(),
      rule({ id: "apv_2", name: "Deal desk", level: 1, approvers: ["desk@example.com"] }),
      rule({ id: "apv_3", name: "VP", threshold: 25, level: 2, approvers: ["vp@example.com"] }),
    ]).required;

  test("only the lowest outstanding level is asked", () => {
    expect(currentApprovers(laddered()).sort()).toEqual(["desk@example.com", "manager@example.com"]);
  });

  test("nobody can approve ahead of their turn", () => {
    const { changed } = applyDecision(laddered(), "vp@example.com", "approved", "");
    expect(changed).toBe(0);
  });

  test("the ladder advances one level at a time", () => {
    let approvals = laddered();

    approvals = applyDecision(approvals, "manager@example.com", "approved", "fine").approvals;
    expect(currentApprovers(approvals)).toEqual(["desk@example.com"]);

    approvals = applyDecision(approvals, "desk@example.com", "approved", "").approvals;
    expect(currentApprovers(approvals)).toEqual(["vp@example.com"]);

    approvals = applyDecision(approvals, "vp@example.com", "approved", "").approvals;
    expect(currentApprovers(approvals)).toEqual([]);
    expect(allApproved(approvals)).toBe(true);
  });

  test("a rejection lands wherever it is addressed, at any level", () => {
    const { approvals, changed } = applyDecision(laddered(), "vp@example.com", "rejected", "Too deep.");
    expect(changed).toBe(1);

    const vp = approvals.find(request => request.approverEmails.includes("vp@example.com"))!;
    expect(vp.status).toBe("rejected");
    expect(vp.decisions[0]).toMatchObject({ approverEmail: "vp@example.com", comment: "Too deep." });
  });

  test("one decision answers every request addressed to that person at that level", () => {
    const twice = evaluateApprovals(quote(), [
      rule(),
      rule({ id: "apv_2", name: "Margin", metric: "marginPercent", comparator: "<", threshold: 50 }),
    ]).required;

    expect(twice).toHaveLength(2);
    // Both are the same person at the same level — they are asked once.
    expect(applyDecision(twice, "manager@example.com", "approved", "").changed).toBe(2);
  });

  test("an address that is not being asked changes nothing", () => {
    expect(applyDecision(laddered(), "stranger@example.com", "approved", "").changed).toBe(0);
  });
});

/* -------------------------------- quorums --------------------------------- */

describe("a rule that asks several people", () => {
  const board = (overrides: Partial<ApprovalRule> = {}) =>
    rule({
      approvers: ["a@example.com", "b@example.com", "c@example.com"],
      approvalsRequired: 2,
      rejectionsRequired: 1,
      ...overrides,
    });

  const asked = (overrides: Partial<ApprovalRule> = {}) => evaluateApprovals(quote(), [board(overrides)]).required;

  test("makes one request addressed to all of them", () => {
    const required = asked();

    // One request, not one per person: the rule is the thing being answered.
    expect(required).toHaveLength(1);
    expect(required[0]!.approverEmails).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(required[0]!.approvalsRequired).toBe(2);
    expect(currentApprovers(required).sort()).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  test("stays pending until the quorum is met", () => {
    let approvals = asked();

    approvals = applyDecision(approvals, "a@example.com", "approved", "").approvals;
    expect(approvals[0]!.status).toBe("pending");
    expect(approvalProgress(approvals[0]!)).toMatchObject({ approved: 1, needed: 2 });
    expect(allApproved(approvals)).toBe(false);

    approvals = applyDecision(approvals, "b@example.com", "approved", "").approvals;
    expect(approvals[0]!.status).toBe("approved");
    expect(allApproved(approvals)).toBe(true);

    // The third never had to answer.
    expect(approvalProgress(approvals[0]!).outstanding).toEqual(["c@example.com"]);
  });

  test("one of three is a rota: the first answer carries it", () => {
    const approvals = applyDecision(asked({ approvalsRequired: 1 }), "c@example.com", "approved", "").approvals;
    expect(approvals[0]!.status).toBe("approved");
  });

  test("three of three is a board: everyone signs", () => {
    let approvals = asked({ approvalsRequired: 3 });

    for (const email of ["a@example.com", "b@example.com"]) {
      approvals = applyDecision(approvals, email, "approved", "").approvals;
      expect(approvals[0]!.status).toBe("pending");
    }

    approvals = applyDecision(approvals, "c@example.com", "approved", "").approvals;
    expect(approvals[0]!.status).toBe("approved");
  });

  test("rejection has its own quorum, and is usually the cheaper one", () => {
    // Two must approve, but one objection is enough to send it back.
    const approvals = applyDecision(asked(), "b@example.com", "rejected", "No.").approvals;
    expect(approvals[0]!.status).toBe("rejected");
    expect(anyRejected(approvals)).toBe(true);
  });

  test("a rejection quorum that is not met leaves it open", () => {
    let approvals = asked({ rejectionsRequired: 2 });

    approvals = applyDecision(approvals, "a@example.com", "rejected", "").approvals;
    expect(approvals[0]!.status).toBe("pending");

    approvals = applyDecision(approvals, "b@example.com", "rejected", "").approvals;
    expect(approvals[0]!.status).toBe("rejected");
  });

  test("an objection outweighs a quorum met in the same breath", () => {
    // Two approvals and one rejection, on a rule wanting two and one: both
    // quorums are met at once, and the honest answer is that somebody objected.
    expect(
      requestStatus({
        approvalsRequired: 2,
        rejectionsRequired: 1,
        decisions: [
          { approverEmail: "a@example.com", decision: "approved", decidedAt: "", comment: "" },
          { approverEmail: "b@example.com", decision: "approved", decidedAt: "", comment: "" },
          { approverEmail: "c@example.com", decision: "rejected", decidedAt: "", comment: "" },
        ],
      }),
    ).toBe("rejected");
  });

  test("changing your mind replaces your answer rather than counting twice", () => {
    let approvals = asked();

    approvals = applyDecision(approvals, "a@example.com", "approved", "on reflection").approvals;
    approvals = applyDecision(approvals, "a@example.com", "approved", "still yes").approvals;

    // One voice, one vote: the quorum of two is not met by one person twice.
    expect(approvals[0]!.decisions).toHaveLength(1);
    expect(approvals[0]!.decisions[0]!.comment).toBe("still yes");
    expect(approvals[0]!.status).toBe("pending");
  });

  test("nothing lands on a request that has already carried", () => {
    let approvals = asked({ approvalsRequired: 1 });
    approvals = applyDecision(approvals, "a@example.com", "approved", "").approvals;

    const late = applyDecision(approvals, "b@example.com", "rejected", "too late");
    expect(late.changed).toBe(0);
    expect(late.approvals[0]!.status).toBe("approved");
  });

  test("a quorum larger than the room is capped, not left unreachable", () => {
    // Otherwise the quote sits in review forever waiting for a fourth person
    // who was never asked.
    const required = evaluateApprovals(quote(), [board({ approvalsRequired: 9 })]).required;
    expect(required[0]!.approvalsRequired).toBe(3);

    let approvals = required;
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      approvals = applyDecision(approvals, email, "approved", "").approvals;
    }
    expect(allApproved(approvals)).toBe(true);
  });

  test("a duplicated address is one person, not two votes", () => {
    const required = evaluateApprovals(quote(), [
      board({ approvers: ["a@example.com", "A@example.com", "b@example.com"] }),
    ]).required;

    expect(required[0]!.approverEmails).toEqual(["a@example.com", "b@example.com"]);
  });
});
