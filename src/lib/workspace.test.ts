import { describe, expect, test } from "bun:test";
import {
  canCreateIn,
  computeSummary,
  defaultWorkspace,
  layoutForCreate,
  readPath,
  readWorkspaceLayout,
  relatedDefaults,
  relatedFilter,
  rollup,
  uniqueKey,
  type RelatedList,
  type SummaryLayout,
} from "./workspace";

const list = (overrides: Partial<RelatedList> = {}): RelatedList => ({
  key: "payments",
  title: "Payments",
  collection: "payments",
  field: "invoice",
  match: [],
  columns: [],
  sort: "",
  allowCreate: true,
  ...overrides,
});

describe("the built-in workspaces", () => {
  for (const collection of ["accounts", "quotes", "invoices"]) {
    test(`${collection}'s default passes the same check a stored one does`, () => {
      const read = readWorkspaceLayout(defaultWorkspace(collection));
      expect(read).toMatchObject({ ok: true });
    });
  }

  test("anything else opens empty, and a default is a copy nobody can mutate", () => {
    expect(defaultWorkspace("products")).toEqual({ relatedLists: [], summary: { currencyField: "currency", items: [] } });
    defaultWorkspace("quotes").relatedLists.pop();
    expect(defaultWorkspace("quotes").relatedLists.length).toBe(3);
  });
});

describe("reading a stored workspace", () => {
  test("a formula may only name the lines above it", () => {
    const read = readWorkspaceLayout({
      relatedLists: [],
      summary: {
        items: [
          { kind: "formula", key: "early", label: "Early", expression: "late * 2" },
          { kind: "field", key: "late", label: "Late", field: "total" },
        ],
      },
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("late");
  });

  test("a roll-up has to name a related list that exists, and a sum has to name a field", () => {
    const noList = readWorkspaceLayout({ summary: { items: [{ kind: "rollup", key: "n", list: "nope", op: "count" }] } });
    expect(noList.ok).toBe(false);
    if (!noList.ok) expect(noList.error).toContain('"nope"');

    const noField = readWorkspaceLayout({
      relatedLists: [list()],
      summary: { items: [{ kind: "rollup", key: "paid", list: "payments", op: "sum" }] },
    });
    expect(noField.ok).toBe(false);
  });

  test("keys are unique across the summary, and names are names", () => {
    const twice = readWorkspaceLayout({
      summary: { items: [{ kind: "heading", key: "a", label: "A" }, { kind: "heading", key: "a", label: "B" }] },
    });
    expect(twice).toMatchObject({ ok: false });
    expect(readWorkspaceLayout({ relatedLists: [list({ field: "x; drop" })] })).toMatchObject({ ok: false });
    expect(readWorkspaceLayout({ relatedLists: [list({ collection: "../users" })] })).toMatchObject({ ok: false });
    expect(readWorkspaceLayout({ relatedLists: [list({ sort: "-created;" })] })).toMatchObject({ ok: false });
  });

  test("it fills what was left out, and reads its own JSON text", () => {
    const read = readWorkspaceLayout(JSON.stringify({ relatedLists: [{ key: "p", collection: "payments", field: "invoice" }] }));
    expect(read).toEqual({
      ok: true,
      value: {
        relatedLists: [{ key: "p", title: "Payments", collection: "payments", field: "invoice", match: [], columns: [], sort: "", allowCreate: false }],
        summary: { currencyField: "currency", items: [] },
      },
    });
  });
});

describe("related lists", () => {
  test("the filter quotes the record's id and every fixed condition, and adds the roll-up's own", () => {
    const files = list({ collection: "sys_attachment", field: "recordId", match: [{ field: "target", value: "quotes" }] });
    expect(relatedFilter(files, "abc")).toBe('recordId = "abc" && target = "quotes"');
    expect(relatedFilter(list(), 'a"b', 'amount > 5')).toBe(`invoice = 'a"b' && (amount > 5)`);
  });

  test("a new related record starts pointing back here", () => {
    const files = list({ field: "recordId", match: [{ field: "target", value: "accounts" }] });
    expect(relatedDefaults(files, "acc1")).toEqual({ recordId: "acc1", target: "accounts" });
  });

  test("New is offered only where a form may create, and only through a plain field", () => {
    expect(canCreateIn(list({ collection: "accounts", field: "priceBook" }))).toBe(true);
    expect(canCreateIn(list())).toBe(false); // payments: the server keeps the ledger
    expect(canCreateIn(list({ collection: "sys_attachment", field: "recordId" }))).toBe(true); // an upload, not a form
    expect(canCreateIn(list({ collection: "quotes", field: "header.customer.accountId" }))).toBe(false);
    expect(canCreateIn(list({ collection: "accounts", allowCreate: false }))).toBe(false);
  });

  test("the create form leaves out the link and everything a request cannot set", () => {
    const layout = layoutForCreate(
      {
        rest: "readOnly",
        sections: [
          { title: "A", description: "", columns: 2, fields: [{ name: "name" }, { name: "invoice" }, { name: "owner" }, { name: "note", readOnly: true }] },
          { title: "Record", description: "", columns: 2, fields: [{ name: "id" }, { name: "created" }] },
        ],
      },
      ["invoice"],
    );
    expect(layout).toEqual({ rest: "hidden", sections: [{ title: "A", description: "", columns: 2, fields: [{ name: "name" }] }] });
  });

  test("a fresh key never collides", () => {
    expect(uniqueKey("total", ["total", "total2"])).toBe("total3");
    expect(uniqueKey("9 lives!", [])).toBe("lives");
  });
});

describe("the summary", () => {
  const layout: SummaryLayout = {
    currencyField: "currency",
    items: [
      { kind: "heading", key: "h", label: "Balance" },
      { kind: "field", key: "total", label: "Total", field: "totals.total", format: "money", emphasis: false },
      { kind: "rollup", key: "paid", label: "Paid", list: "payments", op: "sum", field: "amount", where: "", format: "money", emphasis: false },
      { kind: "formula", key: "due", label: "Due", expression: "total - paid", format: "money", emphasis: true },
    ],
  };

  test("fields read through JSON, roll-ups come in, formulas see the lines above", () => {
    const summary = computeSummary(layout, { currency: "USD", totals: { total: 1000 } }, { paid: { value: 400, rows: 2, partial: false } });
    expect(summary.currency).toBe("USD");
    expect(summary.lines.map(line => (line.kind === "value" ? line.value : line.label))).toEqual(["Balance", 1000, 400, 600]);
    const due = summary.lines.at(-1)!;
    expect(due).toMatchObject({ emphasis: true, note: "" });
    expect(due.kind === "value" && due.display).toContain("600");
  });

  test("a missing input is said, not zeroed", () => {
    const summary = computeSummary(layout, { currency: "EUR" }, { paid: { value: null, rows: 0, partial: false, error: 'You may not read "payments".' } });
    const [, total, paid, due] = summary.lines;
    expect(total).toMatchObject({ value: null, display: "—", note: 'This record has no "totals.total".' });
    expect(paid).toMatchObject({ display: "—", note: 'You may not read "payments".' });
    expect(due).toMatchObject({ value: null, display: "—" });
  });

  test("a roll-up that stopped short says how far it read", () => {
    const summary = computeSummary(layout, { totals: { total: 1 } }, { paid: { value: 9, rows: 5000, partial: true } });
    expect(summary.lines[2]).toMatchObject({ note: "From the first 5,000 rows only." });
  });

  test("roll-ups skip what is not a number rather than counting it as zero", () => {
    expect(rollup("sum", [1, "2", null, 3.5])).toBe(4.5);
    expect(rollup("avg", [2, null, 4])).toBe(3);
    expect(rollup("min", [])).toBeNull();
    expect(rollup("sum", [])).toBe(0);
    expect(rollup("count", [], 7)).toBe(7);
    expect(rollup("sum", [0.1, 0.2])).toBe(0.3);
  });

  test("a path stops at anything that is not an object", () => {
    expect(readPath({ a: { b: [1] } }, "a.b.c")).toBeUndefined();
    expect(readPath({ a: { b: 2 } }, "a.b")).toBe(2);
  });
});
