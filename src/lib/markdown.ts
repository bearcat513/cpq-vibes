/**
 * The little bit of Markdown an OpenAPI document actually carries.
 *
 * Descriptions in `src/server/openapi.ts` are written as prose with headings,
 * bullets and `code spans` in them, because that is what Postman and Bruno
 * render. The reference page renders the same document, so it has to read the
 * same marks — but only those: this returns blocks and spans rather than HTML,
 * and the page renders them as React elements, so no description can put
 * markup into the page however it is written.
 *
 * Anything it does not know stays as text. A document is not a place where an
 * unsupported mark should cost the reader the sentence around it.
 */

export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; items: Span[][] };

/** `code`, **strong**, [text](href) — in one pass, first match wins. */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inlineSpans(source: string): Span[] {
  const spans: Span[] = [];
  let last = 0;

  for (const match of source.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) spans.push({ kind: "text", text: source.slice(last, at) });

    if (match[1] !== undefined) spans.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined) spans.push({ kind: "strong", text: match[2] });
    else spans.push({ kind: "link", text: match[3]!, href: match[4]! });

    last = at + match[0].length;
  }

  if (last < source.length) spans.push({ kind: "text", text: source.slice(last) });
  return spans;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;

/**
 * Blocks, in order.
 *
 * Wrapped lines are joined with a space rather than kept apart: the document's
 * own descriptions are hard-wrapped to fit the source file, and a line break
 * there means nothing to a reader of the rendered page.
 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", spans: inlineSpans(paragraph.join(" ")) });
    paragraph = [];
  };

  const endList = () => {
    if (items.length) blocks.push({ kind: "list", items: items.map(inlineSpans) });
    items = [];
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();

    if (!line) {
      endParagraph();
      endList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      endList();
      blocks.push({ kind: "heading", level: heading[1]!.length, spans: inlineSpans(heading[2]!) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      endParagraph();
      items.push(bullet[1]!);
      continue;
    }

    // An indented line under a bullet continues it; the same line under
    // nothing starts a paragraph like any other.
    if (items.length && raw.startsWith(" ")) {
      items[items.length - 1] += ` ${line}`;
      continue;
    }

    endList();
    paragraph.push(line);
  }

  endParagraph();
  endList();
  return blocks;
}
