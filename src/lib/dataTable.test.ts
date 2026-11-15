import { describe, expect, test } from "bun:test";
import { inferFields, isCollectionName, readSort, sortParam, stripMeta, tablePageUrl } from "./dataTable";

describe("inferFields", () => {
  test("types each field from its values, leading and trailing fields in place", () => {
    const fields = inferFields([
      {
        collectionId: "c1",
        collectionName: "quotes",
        updated: "2026-01-31 12:00:00.000Z",
        total: 120,
        id: "abc",
        active: true,
        tags: ["a", "b"],
        quote: { lines: [] },
        name: "First",
        created: "2026-01-30 09:00:00.000Z",
      },
    ]);
    expect(fields).toEqual([
      { name: "id", type: "text" },
      { name: "name", type: "text" },
      { name: "active", type: "boolean" },
      { name: "quote", type: "json" },
      { name: "tags", type: "list" },
      { name: "total", type: "number" },
      { name: "created", type: "date" },
      { name: "updated", type: "date" },
    ]);
  });

  test("an empty value is no evidence, and a disagreement is unknown", () => {
    const fields = inferFields([
      { id: "1", dueDate: "", tags: [], mixed: 1 },
      { id: "2", dueDate: "2026-02-01 00:00:00.000Z", tags: ["x"], mixed: "one" },
    ]);
    expect(fields.find(field => field.name === "dueDate")?.type).toBe("date");
    expect(fields.find(field => field.name === "tags")?.type).toBe("list");
    expect(fields.find(field => field.name === "mixed")?.type).toBe("unknown");
  });

  test("no records, no fields", () => {
    expect(inferFields([])).toEqual([]);
  });

  test("stripMeta drops PocketBase's bookkeeping and keeps the rest", () => {
    expect(stripMeta({ id: "1", collectionId: "c", collectionName: "n", expand: {}, name: "x" })).toEqual({ id: "1", name: "x" });
  });
});

describe("sort", () => {
  test("sortParam writes PocketBase's syntax", () => {
    expect(sortParam([])).toBe("");
    expect(sortParam([{ id: "created", desc: true }, { id: "name", desc: false }])).toBe("-created,name");
  });

  test("readSort accepts field lists and refuses anything else", () => {
    expect(readSort(null)).toEqual({ ok: true, value: "" });
    expect(readSort(" -created , +name ")).toEqual({ ok: true, value: "-created,+name" });
    expect(readSort("org.name")).toEqual({ ok: true, value: "org.name" });
    expect(readSort("name;drop").ok).toBe(false);
    expect(readSort("-").ok).toBe(false);
    expect(readSort("a,,b").ok).toBe(false);
  });
});

describe("names and links", () => {
  test("a collection name is an identifier", () => {
    expect(isCollectionName("quotes")).toBe(true);
    expect(isCollectionName("_superusers")).toBe(true);
    expect(isCollectionName("../users")).toBe(false);
    expect(isCollectionName("a b")).toBe(false);
    expect(isCollectionName("")).toBe(false);
  });

  test("tablePageUrl carries both parameters, encoded", () => {
    expect(tablePageUrl("quotes")).toBe("/table?table_name=quotes");
    const url = new URL(tablePageUrl("quotes", `status = "sent" && total > 5`), "http://x");
    expect(url.searchParams.get("table_name")).toBe("quotes");
    expect(url.searchParams.get("query")).toBe(`status = "sent" && total > 5`);
    expect(tablePageUrl("quotes", "", "q_1")).toBe("/table?table_name=quotes&record=q_1");
  });
});
