import { describe, expect, test } from "bun:test";
import {
  buildPatch,
  checkFormConfigPatch,
  checkPatch,
  defaultLayout,
  editableFields,
  fallbackLayout,
  fieldError,
  fromLocalInput,
  humanize,
  initialValues,
  readFormLayout,
  resolveSections,
  toLocalInput,
  writability,
  type FormLayout,
  type RecordForm,
} from "./recordForm";
import { inferFields } from "./dataTable";

const PRODUCT = {
  id: "prd_1",
  sku: "PLAT",
  name: "Platform",
  active: true,
  listPrice: 120,
  tags: ["core"],
  product: { optionGroups: [] },
  owner: "u1",
  org: "o1",
  created: "2026-01-30 09:00:00.000Z",
  updated: "2026-01-31 12:00:00.000Z",
};

function formOf(layout: FormLayout, collection = "products"): RecordForm {
  return {
    collection,
    title: "Products",
    description: "",
    layout,
    source: "stored",
    configId: "cfg",
    problem: null,
    ...writability(collection),
  };
}

const read = (raw: unknown) => {
  const result = readFormLayout(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("defaultLayout", () => {
  test("every field, editable first, the bookkeeping read-only at the bottom", () => {
    const layout = defaultLayout(inferFields([PRODUCT]));
    expect(layout.sections.map(section => section.title)).toEqual(["Fields", "Record"]);
    expect(layout.sections[1]!.fields.map(field => field.name)).toEqual(["id", "owner", "org", "created", "updated"]);
    expect(layout.sections[1]!.fields.every(field => field.readOnly)).toBe(true);

    const widgets = Object.fromEntries(layout.sections[0]!.fields.map(field => [field.name, field.widget]));
    expect(widgets).toEqual({ name: "text", active: "checkbox", listPrice: "number", product: "json", sku: "text", tags: "tags" });
  });

  test("guesses email, url and long text from the name", () => {
    const layout = defaultLayout([
      { name: "email", type: "text" },
      { name: "website", type: "text" },
      { name: "notes", type: "text" },
    ]);
    expect(layout.sections[0]!.fields.map(field => field.widget)).toEqual(["email", "url", "textarea"]);
  });
});

describe("readFormLayout", () => {
  test("fills defaults, and a bare name is a field", () => {
    expect(read({ sections: [{ fields: ["name", { name: "listPrice", widget: "number", min: 0 }] }] })).toEqual({
      sections: [
        { title: "", description: "", columns: 2, fields: [{ name: "name" }, { name: "listPrice", widget: "number", min: 0 }] },
      ],
      rest: "hidden",
    });
  });

  test("reads JSON text too", () => {
    expect(read(`{"sections":[],"rest":"readOnly"}`)).toEqual({ sections: [], rest: "readOnly" });
  });

  test("refuses with a sentence that says where", () => {
    const cases: [unknown, RegExp][] = [
      ["{not json", /not valid JSON/],
      [[], /must be an object/],
      [{}, /needs a "sections" list/],
      [{ sections: [{ fields: [{ name: "a b" }] }] }, /sections\[0\]\.fields\[0\]\.name "a b" is not a field name/],
      [{ sections: [{ fields: [{ name: "a", widget: "slider" }] }] }, /"slider" is not a widget/],
      [{ sections: [{ fields: ["a"] }, { fields: ["a"] }] }, /"a" appears twice/],
      [{ sections: [{ fields: [{ name: "a", widget: "select" }] }] }, /select with no options/],
      [{ sections: [{ fields: [{ name: "a", min: 5, max: 1 }] }] }, /min \(5\) is more than max \(1\)/],
      [{ sections: [{ columns: 3, fields: [] }] }, /columns must be 1 or 2/],
      [{ sections: [], rest: "shown" }, /"rest" must be/],
    ];
    for (const [raw, message] of cases) {
      const result = readFormLayout(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(message);
    }
  });
});

describe("resolving a form", () => {
  const layout = read({
    sections: [
      { title: "Main", fields: [{ name: "name", required: true, label: "Product name" }, "listPrice", { name: "owner" }] },
    ],
    rest: "readOnly",
  });

  test("labels, widgets from values, and the rest read-only", () => {
    const sections = resolveSections(formOf(layout), PRODUCT);
    const main = sections[0]!.fields;
    expect(main.map(field => [field.name, field.label, field.widget, field.readOnly])).toEqual([
      ["name", "Product name", "text", false],
      ["listPrice", "List price", "number", false],
      // Named by the layout, but stamped by PocketBase: never editable.
      ["owner", "Owner", "text", true],
    ]);
    expect(sections[1]!.title).toBe("Other fields");
    expect(sections[1]!.fields.every(field => field.readOnly)).toBe(true);
    expect(sections[1]!.fields.map(field => field.name)).toContain("sku");
  });

  test("only unlocked layout fields are editable, and nothing in a server-owned collection", () => {
    expect([...editableFields(formOf(layout), PRODUCT).keys()]).toEqual(["name", "listPrice"]);
    expect([...editableFields(formOf(layout, "quotes"), PRODUCT).keys()]).toEqual([]);
    expect(writability("quotes").writable).toBe(false);
    expect(writability("accounts").writable).toBe(true);
  });

  test("buildPatch sends only what moved, as record values", () => {
    const form = formOf(layout);
    const sections = resolveSections(form, PRODUCT);
    const editable = editableFields(form, PRODUCT);
    const values = initialValues(sections, PRODUCT);
    expect(values.listPrice).toBe("120");

    expect(buildPatch(editable, values, PRODUCT)).toEqual({ ok: true, patch: {} });
    expect(buildPatch(editable, { ...values, listPrice: "99.5", sku: "HACK" }, PRODUCT)).toEqual({
      ok: true,
      patch: { listPrice: 99.5 },
    });
    expect(buildPatch(editable, { ...values, name: "" }, PRODUCT)).toEqual({
      ok: false,
      errors: { name: "Product name is required." },
    });
  });

  test("checkPatch is the server's half: unknown, locked and wrong-typed fields are refused", () => {
    const editable = editableFields(formOf(layout), PRODUCT);
    expect(checkPatch(editable, { listPrice: 5 })).toEqual({ ok: true, value: { listPrice: 5 } });
    expect(checkPatch(editable, { sku: "X" })).toMatchObject({ ok: false, error: expect.stringMatching(/not an editable field/) });
    expect(checkPatch(editable, { owner: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/set by PocketBase/) });
    expect(checkPatch(editable, { listPrice: "5" })).toMatchObject({ ok: false, error: expect.stringMatching(/must be a number/) });
    expect(checkPatch(editable, [])).toMatchObject({ ok: false });
  });
});

describe("values", () => {
  const field = (widget: string, extra: object = {}) =>
    ({
      name: "f",
      label: "F",
      widget,
      span: 1,
      readOnly: false,
      required: false,
      help: "",
      placeholder: "",
      options: [],
      min: null,
      max: null,
      rows: 4,
      ...extra,
    }) as Parameters<typeof fieldError>[0];

  test("each widget's check", () => {
    expect(fieldError(field("number"), "ten")).toMatch(/must be a number/);
    expect(fieldError(field("number", { min: 0 }), "-1")).toMatch(/at least 0/);
    expect(fieldError(field("number"), "")).toBeNull();
    expect(fieldError(field("number", { required: true }), "")).toMatch(/required/);
    expect(fieldError(field("email"), "nope")).toMatch(/email/);
    expect(fieldError(field("email"), "a@b.co")).toBeNull();
    expect(fieldError(field("url"), "javascript:alert(1)")).toMatch(/http/);
    expect(fieldError(field("url"), "https://example.com")).toBeNull();
    expect(fieldError(field("select", { options: ["a", "b"] }), "c")).toMatch(/one of a, b/);
    expect(fieldError(field("json"), "{bad")).toMatch(/not valid JSON/);
    expect(fieldError(field("json"), `{"a":1}`)).toBeNull();
    expect(fieldError(field("text", { max: 3 }), "four")).toMatch(/at most 3 characters/);
    expect(fieldError(field("tags", { required: true }), [])).toMatch(/required/);
  });

  test("dates cross between PocketBase and a datetime-local input", () => {
    const local = toLocalInput("2026-01-31 12:00:00.000Z");
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe("2026-01-31 12:00:00.000Z");
    expect(fromLocalInput("")).toBe("");
    expect(fromLocalInput("not a date")).toBeNull();
  });

  test("a date the input cannot show to the second is not rewritten by opening it", () => {
    const record = { id: "x", due: "2026-01-31 12:00:30.123Z" };
    const form = formOf(read({ sections: [{ fields: ["due"] }] }));
    const values = initialValues(resolveSections(form, record), record);
    expect(buildPatch(editableFields(form, record), values, record)).toEqual({ ok: true, patch: {} });
  });
});

describe("record_forms themselves", () => {
  test("a stored layout must be one that can be drawn", () => {
    expect(checkFormConfigPatch({ layout: { sections: [] } })).toEqual({ ok: true, value: { layout: { sections: [], rest: "hidden" } } });
    expect(checkFormConfigPatch({ layout: { sections: "no" } })).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be used/) });
    expect(checkFormConfigPatch({ collection: "../users" })).toMatchObject({ ok: false });
  });

  test("record_forms lays out its own records, with the layout given the room", () => {
    const layout = fallbackLayout("record_forms", [{ name: "layout", type: "json" }]);
    expect(layout.sections.map(section => section.title)).toEqual(["Form", "Layout"]);
    expect(readFormLayout(layout).ok).toBe(true);
    // Everything else is built from the record.
    expect(fallbackLayout("products", inferFields([PRODUCT]))).toEqual(defaultLayout(inferFields([PRODUCT])));
  });

  test("humanize", () => {
    expect(humanize("priceBook")).toBe("Price book");
    expect(humanize("key_hash")).toBe("Key hash");
    expect(humanize("record_forms")).toBe("Record forms");
  });
});
