/**
 * A tokenizer for the JSON the reference page prints.
 *
 * It returns tokens rather than markup: the page renders them as React
 * elements, so a response body from the server is text on the page no matter
 * what it contains — a customer name with a `<script>` in it included.
 *
 * JSON only, deliberately. Everything coloured here is a request body, a
 * response, or an example out of the OpenAPI document; a cURL command is
 * printed plain, which is right, since none of it is JSON.
 */

export type TokenKind = "plain" | "key" | "string" | "number" | "literal" | "punctuation";

export type Token = { kind: TokenKind; text: string };

const LITERALS = new Set(["true", "false", "null"]);

const isDigit = (char: string) => char >= "0" && char <= "9";

/** Where a quoted run ends, past any escapes; the end of the source if unclosed. */
function endOfString(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"') return i + 1;
    // A JSON string cannot span a line break. Ending the run at one is what
    // keeps a single stray quote from colouring the rest of the document.
    if (char === "\n") return i;
  }
  return source.length;
}

/** The next non-space character, which is how a key is told from a value. */
function peekNonSpace(source: string, from: number): string {
  for (let i = from; i < source.length; i++) {
    const char = source[i]!;
    if (!/\s/.test(char)) return char;
  }
  return "";
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let plain = "";

  const flush = () => {
    if (plain) tokens.push({ kind: "plain", text: plain });
    plain = "";
  };

  const push = (kind: TokenKind, text: string) => {
    flush();
    tokens.push({ kind, text });
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i]!;

    if (char === '"') {
      const end = endOfString(source, i);
      // A quoted run followed by a colon is a key, and reads differently from
      // a value — which is most of what makes a body scannable at a glance.
      push(peekNonSpace(source, end) === ":" ? "key" : "string", source.slice(i, end));
      i = end;
      continue;
    }

    if (isDigit(char) || (char === "-" && isDigit(source[i + 1] ?? ""))) {
      let end = i + 1;
      while (end < source.length && /[0-9.eE+-]/.test(source[end]!)) end++;
      push("number", source.slice(i, end));
      i = end;
      continue;
    }

    if (/[A-Za-z]/.test(char)) {
      let end = i;
      while (end < source.length && /[A-Za-z]/.test(source[end]!)) end++;
      const word = source.slice(i, end);
      if (LITERALS.has(word)) push("literal", word);
      else plain += word;
      i = end;
      continue;
    }

    if ("{}[],:".includes(char)) {
      push("punctuation", char);
      i++;
      continue;
    }

    plain += char;
    i++;
  }

  flush();
  return tokens;
}
