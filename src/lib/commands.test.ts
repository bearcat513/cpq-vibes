import { describe, expect, test } from "bun:test";
import {
  SEQUENCE_TIMEOUT_MS,
  SequenceMatcher,
  isMacPlatform,
  isTypingTarget,
  keyToken,
  matchScore,
  rankItems,
  shortcutCaps,
} from "./commands";

describe("reading a keystroke", () => {
  test("Ctrl and ⌘ are the same modifier", () => {
    expect(keyToken({ key: "k", metaKey: true })).toBe("mod+k");
    expect(keyToken({ key: "K", ctrlKey: true })).toBe("mod+k");
  });

  test("a bare letter is itself, lower-cased; a shifted letter is nothing", () => {
    expect(keyToken({ key: "g" })).toBe("g");
    expect(keyToken({ key: "G", shiftKey: true })).toBeNull();
  });

  test("a shifted symbol is the symbol it typed", () => {
    expect(keyToken({ key: "?", shiftKey: true })).toBe("?");
    expect(keyToken({ key: "/" })).toBe("/");
  });

  test("Alt and lone modifiers are never shortcuts", () => {
    expect(keyToken({ key: "g", altKey: true })).toBeNull();
    expect(keyToken({ key: "Shift", shiftKey: true })).toBeNull();
    expect(keyToken({ key: "Meta", metaKey: true })).toBeNull();
  });
});

describe("where typing goes", () => {
  const element = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as Element;

  test("text fields, text areas, selects and editable regions take letters", () => {
    expect(isTypingTarget(element("INPUT", { type: "text" }))).toBe(true);
    expect(isTypingTarget(element("INPUT", { type: "email" }))).toBe(true);
    expect(isTypingTarget(element("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(element("SELECT"))).toBe(true);
    expect(isTypingTarget(element("DIV", { isContentEditable: true }))).toBe(true);
  });

  test("buttons, checkboxes and the page itself do not", () => {
    expect(isTypingTarget(element("BUTTON"))).toBe(false);
    expect(isTypingTarget(element("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTypingTarget(element("BODY"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("sequences", () => {
  const bindings = [
    { id: "go:quotes", keys: ["g", "q"] },
    { id: "go:home", keys: ["g", "h"] },
    { id: "help", keys: ["?"] },
  ];

  test("a single key matches at once", () => {
    expect(new SequenceMatcher(bindings).feed("?", 0)).toEqual({ kind: "match", id: "help" });
  });

  test("the first key of a sequence waits, the second completes it", () => {
    const matcher = new SequenceMatcher(bindings);
    expect(matcher.feed("g", 0)).toEqual({ kind: "pending", prefix: ["g"] });
    expect(matcher.pending).toEqual(["g"]);
    expect(matcher.feed("q", 100)).toEqual({ kind: "match", id: "go:quotes" });
    expect(matcher.pending).toEqual([]);
  });

  test("a pause longer than the timeout forgets the first key", () => {
    const matcher = new SequenceMatcher(bindings);
    matcher.feed("g", 0);
    expect(matcher.feed("q", SEQUENCE_TIMEOUT_MS + 1)).toEqual({ kind: "none" });
  });

  test("a key that breaks a sequence can start the next one", () => {
    const matcher = new SequenceMatcher(bindings);
    matcher.feed("g", 0);
    expect(matcher.feed("x", 10)).toEqual({ kind: "none" });
    matcher.feed("g", 20);
    expect(matcher.feed("g", 30)).toEqual({ kind: "pending", prefix: ["g"] });
    expect(matcher.feed("h", 40)).toEqual({ kind: "match", id: "go:home" });
  });

  test("a key nothing begins with is nothing", () => {
    expect(new SequenceMatcher(bindings).feed("z", 0)).toEqual({ kind: "none" });
  });
});

describe("printing a shortcut", () => {
  test("⌘ on a Mac, Ctrl elsewhere, a cap per key", () => {
    expect(shortcutCaps(["mod+k"], true)).toEqual(["⌘", "K"]);
    expect(shortcutCaps(["mod+k"], false)).toEqual(["Ctrl", "K"]);
    expect(shortcutCaps(["g", "q"], false)).toEqual(["G", "Q"]);
    expect(shortcutCaps(["Escape"], false)).toEqual(["Esc"]);
  });

  test("the platform is read from its name", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});

describe("ranking", () => {
  const items = [
    { label: "Go to Quotes" },
    { label: "New quote", keywords: "create add" },
    { label: "Go to Receivables", keywords: "invoices payments aging" },
    { label: "Use the dark theme", keywords: "appearance" },
  ];

  test("every word has to be found somewhere", () => {
    expect(matchScore("dark", items[3]!)).toBeGreaterThan(0);
    expect(matchScore("dark quote", items[3]!)).toBe(0);
  });

  test("a label that starts with the query beats one that merely contains it", () => {
    expect(rankItems("new", items).map(item => item.label)[0]).toBe("New quote");
    expect(matchScore("go", items[0]!)).toBeGreaterThan(matchScore("quotes", items[0]!));
  });

  test("equal matches keep the order they were given in", () => {
    expect(rankItems("quote", items).map(item => item.label)).toEqual(["Go to Quotes", "New quote"]);
  });

  test("keywords find what the label does not say", () => {
    expect(rankItems("invoice", items).map(item => item.label)).toEqual(["Go to Receivables"]);
  });

  test("letters in order match the label as a last resort", () => {
    expect(rankItems("nq", items).map(item => item.label)).toEqual(["New quote"]);
  });

  test("an empty query keeps the given order, up to the limit", () => {
    expect(rankItems("", items, 2)).toEqual(items.slice(0, 2));
  });

  test("regular-expression characters are matched literally", () => {
    expect(rankItems("(", [{ label: "a (b)" }, { label: "c" }]).map(item => item.label)).toEqual(["a (b)"]);
  });
});
