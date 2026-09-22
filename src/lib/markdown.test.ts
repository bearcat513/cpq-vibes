/**
 * The marks an OpenAPI description actually carries, and — the property that
 * matters — that nothing in one can reach the page as markup.
 *
 * The parser returns blocks and spans; the page renders them as React
 * elements. So the test for safety is not "is it escaped" but "does a
 * description containing a tag come back as *text*", which is what these
 * assert.
 */
import { describe, expect, test } from "bun:test";
import { inlineSpans, parseMarkdown } from "./markdown";

describe("inline marks", () => {
  test("reads code, strong and links, leaving the prose between them", () => {
    expect(inlineSpans("Send `X-API-Key`, **always**, see [docs](/docs).")).toEqual([
      { kind: "text", text: "Send " },
      { kind: "code", text: "X-API-Key" },
      { kind: "text", text: ", " },
      { kind: "strong", text: "always" },
      { kind: "text", text: ", see " },
      { kind: "link", text: "docs", href: "/docs" },
      { kind: "text", text: "." },
    ]);
  });

  test("leaves a mark it does not know as text rather than eating the sentence", () => {
    expect(inlineSpans("a ~~struck~~ word")).toEqual([{ kind: "text", text: "a ~~struck~~ word" }]);
  });

  test("returns markup as text, which is what keeps it out of the page", () => {
    expect(inlineSpans("<script>alert(1)</script>")).toEqual([
      { kind: "text", text: "<script>alert(1)</script>" },
    ]);
  });
});

describe("blocks", () => {
  const blocks = parseMarkdown(
    [
      "### Authentication",
      "",
      "Three credentials reach",
      "the same account:",
      "",
      "- `X-API-Key` — a key",
      "  which a script should use",
      "- `Authorization` — a token",
    ].join("\n"),
  );

  test("reads a heading, a paragraph and a list, in order", () => {
    expect(blocks.map(block => block.kind)).toEqual(["heading", "paragraph", "list"]);
  });

  test("joins a hard-wrapped paragraph, since the break means nothing once rendered", () => {
    const paragraph = blocks[1]!;
    expect(paragraph.kind === "paragraph" && paragraph.spans[0]).toEqual({
      kind: "text",
      text: "Three credentials reach the same account:",
    });
  });

  test("continues a bullet across an indented line rather than starting a paragraph", () => {
    const list = blocks[2]!;
    expect(list.kind === "list" && list.items).toHaveLength(2);
    expect(list.kind === "list" && list.items[0]!.at(-1)).toEqual({
      kind: "text",
      text: " — a key which a script should use",
    });
  });

  test("makes nothing of an empty description", () => {
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});
