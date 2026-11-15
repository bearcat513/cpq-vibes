/**
 * Keyboard shortcuts and the launcher's search, with no React in them.
 *
 * Three things live here, all pure so they can be tested without a page:
 *
 * - **Reading a keystroke.** `keyToken` turns a `KeyboardEvent` into the one
 *   string a binding is written in — `mod+k`, `g`, `?` — with Ctrl and ⌘
 *   folded together, because a binding written twice drifts.
 * - **Sequences.** `g` then `q` is two keystrokes, and `SequenceMatcher` is
 *   the small state machine that remembers the first one for a moment. It is
 *   handed the time rather than reading the clock, so a test can step it.
 * - **Ranking.** `rankItems` scores what the launcher lists against what has
 *   been typed. It is deliberately simple: a whole-word prefix beats a
 *   substring beats letters in order, and anything else is out.
 */

/* --------------------------------- keys ---------------------------------- */

/** What a keystroke looks like to `keyToken` — the subset of `KeyboardEvent` it reads. */
export type KeyLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * The binding a keystroke spells, or null for one no binding could mean.
 *
 * Ctrl and ⌘ are one modifier, `mod`: the launcher is ⌘K on a Mac and Ctrl K
 * everywhere else, and nobody presses both. Alt is never a shortcut here —
 * on a Mac it is how half the keyboard's characters are typed. Shift is
 * only meaningful as part of the character it produced (`?` is Shift /), so
 * a shifted letter is ignored rather than read as the letter.
 */
export function keyToken(event: KeyLike): string | null {
  const { key } = event;
  if (!key || key === "Unidentified" || event.altKey) return null;
  if (key === "Shift" || key === "Control" || key === "Meta" || key === "Alt") return null;

  const single = key.length === 1;
  if (event.metaKey || event.ctrlKey) return single ? `mod+${key.toLowerCase()}` : `mod+${key}`;
  if (single && /[a-z]/i.test(key)) return event.shiftKey ? null : key.toLowerCase();
  return key;
}

/** Whether focus is somewhere typing goes — where a bare letter is a letter. */
export function isTypingTarget(element: Element | null | undefined): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = ((element as HTMLInputElement).type || "text").toLowerCase();
    // A checkbox or a button that happens to be an <input> takes no text.
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return (element as HTMLElement).isContentEditable === true;
}

/* ------------------------------- sequences ------------------------------- */

/** How long the first key of a sequence waits for its second. */
export const SEQUENCE_TIMEOUT_MS = 1200;

/** A binding: one keystroke (`["mod+k"]`) or a sequence of them (`["g", "q"]`). */
export type Binding<T extends string = string> = { id: T; keys: string[] };

export type MatchResult<T extends string> =
  /** A whole binding was typed. */
  | { kind: "match"; id: T }
  /** The start of one or more bindings — wait for the next key. */
  | { kind: "pending"; prefix: string[] }
  /** Nothing begins this way. */
  | { kind: "none" };

/**
 * Feeds keystrokes through a set of bindings and says when one completes.
 *
 * A key that begins nothing resets the sequence, and so does a pause longer
 * than `timeoutMs` — so a stray `g` does not lie in wait to turn the next
 * `q` you type, a minute later, into a navigation.
 */
export class SequenceMatcher<T extends string> {
  private buffer: string[] = [];
  private last = 0;

  constructor(
    private readonly bindings: readonly Binding<T>[],
    private readonly timeoutMs = SEQUENCE_TIMEOUT_MS,
  ) {}

  /** The keys typed so far of a sequence still in progress. */
  get pending(): readonly string[] {
    return this.buffer;
  }

  reset(): void {
    this.buffer = [];
  }

  feed(token: string, now: number): MatchResult<T> {
    if (this.buffer.length && now - this.last > this.timeoutMs) this.buffer = [];
    this.last = now;

    const attempt = (buffer: string[]): MatchResult<T> => {
      const exact = this.bindings.find(binding => sameKeys(binding.keys, buffer));
      if (exact) return { kind: "match", id: exact.id };
      const started = this.bindings.some(
        binding => binding.keys.length > buffer.length && sameKeys(binding.keys.slice(0, buffer.length), buffer),
      );
      return started ? { kind: "pending", prefix: buffer } : { kind: "none" };
    };

    let result = attempt([...this.buffer, token]);
    // A key that does not continue the sequence may still start a new one:
    // `g`, `x`, `g`, `q` is a `g q`.
    if (result.kind === "none" && this.buffer.length) result = attempt([token]);

    this.buffer = result.kind === "pending" ? result.prefix : [];
    return result;
  }
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * How a binding is printed: `["⌘", "K"]` on a Mac, `["Ctrl", "K"]` elsewhere,
 * `["G", "Q"]` for a sequence. One entry per key cap.
 */
export function shortcutCaps(keys: readonly string[], mac: boolean): string[] {
  return keys.flatMap(key => {
    if (key.startsWith("mod+")) return [mac ? "⌘" : "Ctrl", capFor(key.slice(4))];
    return [capFor(key)];
  });
}

const CAP_NAMES: Record<string, string> = {
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  ",": ",",
};

const capFor = (key: string) => CAP_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);

/** Whether this browser is on a Mac — for ⌘ against Ctrl, and nothing else. */
export function isMacPlatform(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/* -------------------------------- ranking -------------------------------- */

/** Anything the launcher can list: a label to show, and more words to match on. */
export type Rankable = { label: string; keywords?: string };

/**
 * How well `query` matches `text`, from 0 (not at all) up.
 *
 * - every word of the query has to be found, or the item is out
 * - a word found at the start of a word in the text scores highest, at the
 *   very start of the text higher still
 * - a word found inside a word scores less
 * - a word whose letters appear in order (`nq` in "New quote") scores least,
 *   and only against the label — matching scattered letters across a long
 *   keyword list finds everything
 */
export function matchScore(query: string, item: Rankable): number {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;

  const label = item.label.toLowerCase();
  const haystack = `${label} ${(item.keywords ?? "").toLowerCase()}`;

  let total = 0;
  for (const word of words) {
    const score = wordScore(word, label, haystack);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

function wordScore(word: string, label: string, haystack: string): number {
  if (label.startsWith(word)) return 12;
  const boundary = new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}`);
  if (boundary.test(label)) return 9;
  if (boundary.test(haystack)) return 6;
  if (label.includes(word)) return 4;
  if (haystack.includes(word)) return 3;
  return inOrder(word, label) ? 1 : 0;
}

function inOrder(needle: string, text: string): boolean {
  let from = 0;
  for (const char of needle) {
    const at = text.indexOf(char, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The items that match, best first, at most `limit` of them. Ties keep the
 * order they were given in, which is how the caller says what matters more.
 */
export function rankItems<T extends Rankable>(query: string, items: readonly T[], limit = Infinity): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, index) => ({ item, index, score: matchScore(query, item) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(entry => entry.item);
}
