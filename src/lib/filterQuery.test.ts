import { describe, expect, test } from "bun:test";
import {
  conditionProblem,
  countConditions,
  emptyGroup,
  filterProblems,
  newCondition,
  parseFilter,
  quote,
  serializeFilter,
  updateNode,
  type FilterGroup,
  type FilterNode,
} from "./filterQuery";

/** The tree without its React keys, for comparing shapes. */
function shape(node: FilterNode): unknown {
  return node.type === "condition"
    ? [node.field, node.op, node.value.kind, node.value.text]
    : { join: node.join, children: node.children.map(shape) };
}

function parsed(text: string): FilterGroup {
  const result = parseFilter(text);
  if (!result.ok) throw new Error(result.error);
  return result.group;
}

const roundTrip = (text: string) => serializeFilter(parsed(text));

describe("parseFilter", () => {
  test("an empty filter is an empty group", () => {
    expect(shape(parsed(""))).toEqual({ join: "&&", children: [] });
    expect(shape(parsed("   "))).toEqual({ join: "&&", children: [] });
  });

  test("reads each kind of value", () => {
    expect(shape(parsed(`status = "sent"`))).toEqual({ join: "&&", children: [["status", "=", "string", "sent"]] });
    expect(shape(parsed(`total >= 1000.5`))).toEqual({ join: "&&", children: [["total", ">=", "number", "1000.5"]] });
    expect(shape(parsed(`total > -3`))).toEqual({ join: "&&", children: [["total", ">", "number", "-3"]] });
    expect(shape(parsed(`active = false`))).toEqual({ join: "&&", children: [["active", "=", "boolean", "false"]] });
    expect(shape(parsed(`dueDate = null`))).toEqual({ join: "&&", children: [["dueDate", "=", "null", ""]] });
    expect(shape(parsed(`created > @todayStart`))).toEqual({
      join: "&&",
      children: [["created", ">", "identifier", "@todayStart"]],
    });
    expect(shape(parsed(`owner = @request.auth.id`))).toEqual({
      join: "&&",
      children: [["owner", "=", "identifier", "@request.auth.id"]],
    });
  });

  test("reads single quotes and escaped quotes", () => {
    expect(shape(parsed(`name = 'O\\'Brien'`))).toEqual({ join: "&&", children: [["name", "=", "string", "O'Brien"]] });
    expect(shape(parsed(`name ~ "say \\"hi\\""`))).toEqual({ join: "&&", children: [["name", "~", "string", 'say "hi"']] });
  });

  test("reads every operator, longest first", () => {
    for (const op of ["=", "!=", ">", ">=", "<", "<=", "~", "!~", "?=", "?!=", "?>", "?>=", "?<", "?<=", "?~", "?!~"]) {
      expect(shape(parsed(`tags ${op} "x"`))).toEqual({ join: "&&", children: [["tags", op, "string", "x"]] });
    }
    // No spaces at all.
    expect(shape(parsed(`tags?!="x"`))).toEqual({ join: "&&", children: [["tags", "?!=", "string", "x"]] });
  });

  test("field paths keep their dots and modifiers", () => {
    expect(shape(parsed(`org.name:lower = "acme" && lines:length > 2`))).toEqual({
      join: "&&",
      children: [
        ["org.name:lower", "=", "string", "acme"],
        ["lines:length", ">", "number", "2"],
      ],
    });
  });

  test("&& binds tighter than ||, the way PocketBase's SQL does", () => {
    expect(shape(parsed(`a = 1 && b = 2 || c = 3`))).toEqual({
      join: "||",
      children: [{ join: "&&", children: [["a", "=", "number", "1"], ["b", "=", "number", "2"]] }, ["c", "=", "number", "3"]],
    });
  });

  test("parentheses group, and a group of the same join folds into its parent", () => {
    expect(shape(parsed(`a = 1 && (b = 2 || c = 3)`))).toEqual({
      join: "&&",
      children: [["a", "=", "number", "1"], { join: "||", children: [["b", "=", "number", "2"], ["c", "=", "number", "3"]] }],
    });
    expect(shape(parsed(`(a = 1 && b = 2) && c = 3`))).toEqual({
      join: "&&",
      children: [["a", "=", "number", "1"], ["b", "=", "number", "2"], ["c", "=", "number", "3"]],
    });
    expect(shape(parsed(`((a = 1))`))).toEqual({ join: "&&", children: [["a", "=", "number", "1"]] });
  });

  test("skips line comments", () => {
    expect(shape(parsed(`a = 1 // the first\n&& b = 2`))).toEqual({
      join: "&&",
      children: [["a", "=", "number", "1"], ["b", "=", "number", "2"]],
    });
  });

  test("refuses what the builder cannot show, with a sentence", () => {
    const cases: [string, RegExp][] = [
      [`status = "sent`, /never closed/],
      [`status "sent"`, /Expected an operator/],
      [`status =`, /has no value/],
      [`(a = 1`, /Expected "\)"/],
      [`a = 1)`, /Unexpected/],
      [`a = 1 &&`, /ends where a condition/],
      [`"x" = status`, /field on the left/],
      [`geoDistance(a, b, c, d) < 5`, /function call/],
      [`a = 1 $ b`, /Unexpected "\$"/],
    ];
    for (const [text, message] of cases) {
      const result = parseFilter(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(message);
    }
  });
});

describe("serializeFilter", () => {
  test("round-trips what it can read", () => {
    for (const text of [
      `status = "sent"`,
      `total >= 1000 && active = true`,
      `a = 1 || b = 2`,
      `a = 1 && (b = 2 || c = 3)`,
      `(a = 1 && b = 2) || c = 3`,
      `created > @now && dueDate != null`,
    ]) {
      expect(roundTrip(text)).toBe(text);
    }
  });

  test("parenthesises every nested group, so precedence never decides", () => {
    expect(roundTrip(`a = 1 && b = 2 || c = 3`)).toBe(`(a = 1 && b = 2) || c = 3`);
  });

  test("writes back exactly what it read, for any text", () => {
    for (const text of [`it's`, `say "hi"`, `both ' and "`, ``, `back\\slash`]) {
      const group: FilterGroup = { ...emptyGroup(), children: [{ ...newCondition("name"), value: { kind: "string", text } }] };
      const again = parsed(serializeFilter(group));
      expect((again.children[0] as { value: { text: string } }).value.text).toBe(text);
    }
  });

  test("an empty group writes nothing, and empty nested groups vanish", () => {
    expect(serializeFilter(emptyGroup())).toBe("");
    const group: FilterGroup = { ...emptyGroup(), children: [emptyGroup("||"), { ...newCondition("a"), value: { kind: "number", text: "1" } }] };
    expect(serializeFilter(group)).toBe("a = 1");
  });

  test("picks the quote that needs no escaping", () => {
    expect(quote(`plain`)).toBe(`"plain"`);
    expect(quote(`say "hi"`)).toBe(`'say "hi"'`);
    expect(quote(`it's`)).toBe(`"it's"`);
    expect(quote(`both ' and "`)).toBe(`"both ' and \\""`);
  });
});

describe("validation", () => {
  test("a condition needs a field, and a value its kind can be", () => {
    expect(conditionProblem(newCondition(""))).toMatch(/Choose a field/);
    expect(conditionProblem(newCondition("bad field"))).toMatch(/not a field name/);
    expect(conditionProblem({ ...newCondition("total"), value: { kind: "number", text: "ten" } })).toMatch(/number/);
    expect(conditionProblem({ ...newCondition("total"), value: { kind: "number", text: "10" } })).toBeNull();
    expect(conditionProblem({ ...newCondition("created"), value: { kind: "identifier", text: "" } })).toMatch(/macro/);
    expect(conditionProblem({ ...newCondition("created"), value: { kind: "identifier", text: "@now" } })).toBeNull();
    // An empty text value is a legitimate filter: `name = ""`.
    expect(conditionProblem(newCondition("name"))).toBeNull();
  });

  test("problems are collected at any depth, by id", () => {
    const bad = newCondition("");
    const group: FilterGroup = { ...emptyGroup(), children: [newCondition("a"), { ...emptyGroup("||"), children: [bad] }] };
    expect(Object.keys(filterProblems(group))).toEqual([bad.id]);
  });
});

describe("editing", () => {
  test("updateNode replaces or removes a node at any depth", () => {
    const inner = newCondition("b");
    const nested = { ...emptyGroup("||"), children: [inner, newCondition("c")] };
    const group: FilterGroup = { ...emptyGroup(), children: [newCondition("a"), nested] };

    const renamed = updateNode(group, inner.id, node => ({ ...(node as typeof inner), field: "bee" }));
    expect(serializeFilter(renamed)).toBe(`a = "" && (bee = "" || c = "")`);

    const removed = updateNode(group, inner.id, () => null);
    expect(serializeFilter(removed)).toBe(`a = "" && c = ""`);
    expect(countConditions(removed)).toBe(2);
    // The original is untouched.
    expect(countConditions(group)).toBe(3);
  });
});
