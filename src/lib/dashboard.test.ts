import { describe, expect, test } from "bun:test";
import { expiringWithin, greeting, pipelineSummary, totalIn } from "./dashboard";
import type { QuoteSummary } from "./types";

const quote = (overrides: Partial<QuoteSummary>): QuoteSummary =>
  ({
    id: "q",
    number: "Q-1",
    status: "sent",
    currency: "USD",
    validUntil: "",
    totals: { grandTotal: 0 },
    ...overrides,
  }) as QuoteSummary;

describe("the pipeline", () => {
  test("open is everything still in play; the win rate is over what was decided", () => {
    const summary = pipelineSummary({ all: 20, draft: 3, in_review: 2, approved: 1, sent: 4, accepted: 3, declined: 1, expired: 2, rejected: 4 });
    expect(summary.open).toBe(10);
    expect(summary.decided).toBe(6);
    expect(summary.winRate).toBe(50);
  });

  test("nothing decided is no win rate, not zero", () => {
    expect(pipelineSummary({ draft: 2 }).winRate).toBeNull();
  });
});

describe("adding up quotes", () => {
  test("only one currency is summed; the rest are counted", () => {
    const total = totalIn(
      [
        quote({ currency: "USD", totals: { grandTotal: 100.1 } as QuoteSummary["totals"] }),
        quote({ currency: "USD", totals: { grandTotal: 0.2 } as QuoteSummary["totals"] }),
        quote({ currency: "EUR", totals: { grandTotal: 999 } as QuoteSummary["totals"] }),
      ],
      "USD",
    );
    expect(total).toEqual({ currency: "USD", amount: 100.3, count: 2, otherCurrency: 1 });
  });
});

describe("expiring soon", () => {
  test("sent quotes running out within the window, soonest first", () => {
    const list = expiringWithin(
      [
        quote({ id: "later", validUntil: "2026-03-08" }),
        quote({ id: "today", validUntil: "2026-03-01" }),
        quote({ id: "too-far", validUntil: "2026-03-09" }),
        quote({ id: "no-date", validUntil: "" }),
        quote({ id: "draft", status: "draft", validUntil: "2026-03-02" }),
      ],
      7,
      "2026-03-01",
    );
    expect(list.map(item => item.id)).toEqual(["today", "later"]);
  });
});

test("the greeting follows the clock", () => {
  expect(greeting(2)).toBe("Working late");
  expect(greeting(9)).toBe("Good morning");
  expect(greeting(14)).toBe("Good afternoon");
  expect(greeting(20)).toBe("Good evening");
});
