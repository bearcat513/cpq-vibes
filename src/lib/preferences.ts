/**
 * Per-account preferences: what a new quote starts as, and what the app shows
 * while you work on one.
 *
 * They are stored as one JSON blob on the account's own `users` record, so
 * they travel with the account and need no collection of their own. That blob
 * is whatever was written the day it was written — a key may be missing,
 * stale, or (since a request body wrote it) nonsense — so every read goes
 * through `normalizePreferences`, the single place that decides what a valid
 * preference set looks like. The server normalizes before storing and the UI
 * normalizes before sending, so both agree on the clamped value without a
 * round trip.
 */
import { asCurrency, DEFAULT_CURRENCY } from "./money";
import { CURRENCIES, type CurrencyCode } from "./types";

export type Theme = "system" | "light" | "dark";

/**
 * The signal colour the app is painted in.
 *
 * Each one is a single hue turned in `styles/globals.css`, where the whole
 * accent palette — primary, ring, the sidebar's live colours — is derived
 * from that hue rather than listed. So an accent is two numbers in the
 * stylesheet and a name here, and the seven cannot drift apart.
 *
 * Nothing that *means* something moves with it: a paid invoice is still
 * signal green and an overdue one still alert orange, because a status told
 * by colour alone would start lying the moment somebody chose that colour.
 *
 * An account that was dressed in one of the old earth tones has a name that
 * is no longer on this list, which `normalizePreferences` handles the way it
 * handles any value it does not recognise — by falling back to the default.
 */
export type Accent = "cobalt" | "arc" | "slate" | "signal" | "hazard" | "ember" | "plasma";

/** In the order they are offered: the painted steel, then the signage. */
export const ACCENTS: { id: Accent; label: string }[] = [
  { id: "cobalt", label: "Cobalt" },
  { id: "arc", label: "Arc" },
  { id: "slate", label: "Slate" },
  { id: "signal", label: "Signal" },
  { id: "hazard", label: "Hazard" },
  { id: "ember", label: "Ember" },
  { id: "plasma", label: "Plasma" },
];

/**
 * The face the app is read in.
 *
 * System stacks only, for the same reason `--font-display` is one: a webfont
 * is a network dependency on a tool that runs locally, and the first paint
 * would be in the fallback regardless. Headings keep the stencilled display
 * face whatever is chosen here — the wordmark and the totals are this app's
 * rating plate — so this is the body copy and nothing else.
 */
export type FontChoice = "sans" | "grotesque" | "humanist" | "oldstyle" | "transitional" | "mono";

export const FONTS: { id: FontChoice; label: string; hint: string }[] = [
  { id: "sans", label: "System", hint: "Whatever this machine reads best" },
  { id: "grotesque", label: "Grotesque", hint: "Neutral, tighter" },
  { id: "humanist", label: "Humanist", hint: "Calligraphic, open" },
  { id: "oldstyle", label: "Old style", hint: "The serif on the headings" },
  { id: "transitional", label: "Transitional", hint: "A serif built to be read small" },
  { id: "mono", label: "Monospace", hint: "Everything on the same grid" },
];

export type Preferences = {
  /** "system" follows the OS; the other two override it. */
  theme: Theme;
  /** Which of the seven signal colours carries anything live. */
  accent: Accent;
  /** The face the app is set in. Headings keep the display face. */
  font: FontChoice;
  /** The currency a new quote is denominated in. */
  defaultCurrency: CurrencyCode;
  /** The price book a new quote starts on; empty means the default book. */
  defaultPriceBookId: string;
  /** Subscription length a new quote starts with, in months. */
  defaultTermMonths: number;
  /** Tax applied to a new quote when the account names none, 0-100. */
  defaultTaxPercent: number;
  /** How long a new quote's pricing is good for, in days. */
  quoteValidDays: number;
  /** The proposal template preselected when rendering; empty means the first. */
  defaultProposalTemplateId: string;
  /** The same for an invoice. Its own key because the two are different kinds. */
  defaultInvoiceTemplateId: string;
  /** How many quotes the sidebar lists. */
  quoteListLimit: number;
  /**
   * Whether cost and margin are on screen.
   *
   * Off by default, and worth the switch: margin is the number nobody wants
   * over their shoulder in front of a customer, and a rep sharing their screen
   * on a call should be able to put it away in one click.
   */
  showMargin: boolean;
  /** Formatting locale for money and dates. Empty follows the browser. */
  locale: string;
  /**
   * Whether the left-hand navigation is collapsed to its icons.
   *
   * Here rather than in browser storage because this app keeps everything
   * that persists on the account — a preference follows you to another
   * machine, and nothing else in the UI reaches for `localStorage`.
   */
  navCollapsed: boolean;
  /** Ask before deleting anything. It is the only confirmation there is. */
  confirmDestructive: boolean;
};

/** Bounds shared by the settings inputs and the normalizer below. */
export const PREFERENCE_LIMITS = {
  termMonths: { min: 0, max: 600 },
  validDays: { min: 1, max: 365 },
  quoteList: { min: 5, max: 200 },
  taxPercent: { min: 0, max: 100 },
} as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  accent: "cobalt",
  font: "sans",
  defaultCurrency: DEFAULT_CURRENCY,
  defaultPriceBookId: "",
  defaultTermMonths: 12,
  defaultTaxPercent: 0,
  quoteValidDays: 30,
  defaultProposalTemplateId: "",
  defaultInvoiceTemplateId: "",
  quoteListLimit: 50,
  showMargin: false,
  locale: "",
  navCollapsed: false,
  confirmDestructive: true,
};

export const THEMES: Theme[] = ["system", "light", "dark"];

/** The one member of a closed list, or the default. */
const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;

export { CURRENCIES };

/** Record ids are minted by `newId()` in src/server/db.ts: `pb_1a2b3c4d`. */
const RECORD_ID = /^[a-z0-9_]{3,40}$/;

/** A BCP-47 tag, loosely — enough to keep junk out of `Intl`. */
const LOCALE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/;

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(Math.max(value, min), max);

function asNumber(value: unknown, fallback: number, bounds: { min: number; max: number }, whole = true): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = clamp(parsed, bounds);
  return whole ? Math.trunc(clamped) : clamped;
}

/** An id that has since been deleted is harmless — it falls back to "the first
 * one" wherever it is used — so only a malformed id is discarded here. */
const asRecordId = (value: unknown): string => {
  const id = String(value ?? "").trim();
  return RECORD_ID.test(id) ? id : "";
};

/**
 * Every unknown key is dropped and every bad value falls back to its default,
 * so a preference set is always complete and always in range: the UI renders
 * it without a guard and the app reads it without one.
 */
export function normalizePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PREFERENCES };
  const input = raw as Record<string, unknown>;

  const locale = String(input.locale ?? "").trim().slice(0, 35);

  return {
    theme: oneOf(THEMES, input.theme, DEFAULT_PREFERENCES.theme),
    accent: oneOf(ACCENTS.map(a => a.id), input.accent, DEFAULT_PREFERENCES.accent),
    font: oneOf(FONTS.map(f => f.id), input.font, DEFAULT_PREFERENCES.font),
    defaultCurrency: asCurrency(input.defaultCurrency, DEFAULT_PREFERENCES.defaultCurrency),
    defaultPriceBookId: asRecordId(input.defaultPriceBookId),
    defaultTermMonths: asNumber(input.defaultTermMonths, DEFAULT_PREFERENCES.defaultTermMonths, PREFERENCE_LIMITS.termMonths),
    defaultTaxPercent: asNumber(
      input.defaultTaxPercent,
      DEFAULT_PREFERENCES.defaultTaxPercent,
      PREFERENCE_LIMITS.taxPercent,
      false,
    ),
    quoteValidDays: asNumber(input.quoteValidDays, DEFAULT_PREFERENCES.quoteValidDays, PREFERENCE_LIMITS.validDays),
    defaultProposalTemplateId: asRecordId(input.defaultProposalTemplateId),
    defaultInvoiceTemplateId: asRecordId(input.defaultInvoiceTemplateId),
    quoteListLimit: asNumber(input.quoteListLimit, DEFAULT_PREFERENCES.quoteListLimit, PREFERENCE_LIMITS.quoteList),
    showMargin: input.showMargin === true,
    // A locale `Intl` cannot parse would throw on every formatted number.
    locale: LOCALE.test(locale) ? locale : "",
    navCollapsed: input.navCollapsed === true,
    confirmDestructive: input.confirmDestructive !== false,
  };
}
