/**
 * The app's screens, the things it can start, and the keys that reach both.
 *
 * One table, read by the sidebar, the phone's tab bar, the launcher, the
 * dashboard and the shortcut list — so a screen added here gets a nav entry,
 * a launcher command and a `g` shortcut together, and the label a shortcut is
 * listed under cannot differ from the label on the button.
 */
import {
  Building2,
  FileText,
  Home,
  LayoutList,
  Package,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Table2,
  Target,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { Binding } from "@/lib/commands";
import { TABLE_PAGE_PATH } from "@/lib/dataTable";
import type { Permission } from "@/lib/organization";

export type View =
  | "home"
  | "leads"
  | "opportunities"
  | "quotes"
  | "approvals"
  | "receivables"
  | "catalog"
  | "rules"
  | "customers"
  | "templates"
  | "settings";

export type ViewInfo = {
  label: string;
  Icon: LucideIcon;
  /** The second key of its `g` shortcut: `g q` is Quotes. */
  go: string;
  /** One line, for the launcher and the phone's More sheet. */
  description: string;
};

export const VIEWS: Record<View, ViewInfo> = {
  home: { label: "Home", Icon: Home, go: "h", description: "What needs you, and where to start" },
  leads: { label: "Leads", Icon: UserPlus, go: "l", description: "People who might buy, before they are customers" },
  opportunities: { label: "Opportunities", Icon: Target, go: "o", description: "Deals in the pipeline, and the quotes written for them" },
  quotes: { label: "Quotes", Icon: ScrollText, go: "q", description: "Every quote in the organization" },
  approvals: { label: "Approvals", Icon: ShieldCheck, go: "a", description: "Quotes waiting for your decision" },
  receivables: { label: "Receivables", Icon: Receipt, go: "i", description: "Invoices, payments and aging" },
  catalog: { label: "Catalogue", Icon: Package, go: "p", description: "Products and price books" },
  rules: { label: "Rules", Icon: LayoutList, go: "r", description: "Pricing and approval rules" },
  customers: { label: "Customers", Icon: Building2, go: "c", description: "Accounts, contacts and history" },
  templates: { label: "Templates", Icon: FileText, go: "t", description: "Proposal and invoice documents" },
  settings: { label: "Settings", Icon: Settings, go: "s", description: "Your account, preferences and organization" },
};

/** The sidebar, top to bottom. Settings sits at its foot, beside your name. */
export const NAV_ORDER: View[] = ["home", "leads", "opportunities", "quotes", "approvals", "receivables", "catalog", "rules", "customers", "templates"];

/**
 * The phone's tab bar: the four screens a day on the road is spent in. The
 * rest are one tap further, under More — a row of nine icons across a phone
 * is a row nobody can hit.
 */
export const MOBILE_TABS: View[] = ["home", "quotes", "approvals", "customers"];

/**
 * The record browser at `/table` — a page of its own rather than a screen
 * (see `src/table.html`), so it is a link, not a `View`. The sidebar, the
 * More sheet and the launcher all offer it from here, and all open it in a
 * new tab: leaving the app's tab would drop a quote half-edited in it.
 */
export const DATA_TABLE = {
  label: "Data table",
  href: TABLE_PAGE_PATH,
  Icon: Table2,
  description: "Any collection's records, with a filter builder",
} as const;

export type CreateKind = "quote" | "customer" | "lead" | "opportunity" | "invoice" | "product";

export type CreateInfo = {
  label: string;
  Icon: LucideIcon;
  /** The second key of its `n` shortcut: `n q` is a new quote. */
  key: string;
  /** Who may start one. The launcher and the dashboard only offer what this allows. */
  permission: Permission;
  /** The screen it opens on. */
  view: View;
};

export const CREATES: Record<CreateKind, CreateInfo> = {
  quote: { label: "New quote", Icon: ScrollText, key: "q", permission: "quotes.create", view: "quotes" },
  customer: { label: "New customer", Icon: Building2, key: "c", permission: "accounts.write", view: "customers" },
  lead: { label: "New lead", Icon: UserPlus, key: "l", permission: "leads.write", view: "leads" },
  opportunity: { label: "New opportunity", Icon: Target, key: "o", permission: "opportunities.create", view: "opportunities" },
  invoice: { label: "New invoice", Icon: Receipt, key: "i", permission: "invoices.write", view: "receivables" },
  product: { label: "New product", Icon: Package, key: "p", permission: "catalogue.write", view: "catalog" },
};

export const CREATE_ORDER: CreateKind[] = ["quote", "customer", "lead", "opportunity", "invoice", "product"];

/* ------------------------------- shortcuts ------------------------------- */

export type ShortcutId = "launcher" | "search" | "help" | "toggleNav" | `go:${View}` | `new:${CreateKind}`;

export const SHORTCUTS: Binding<ShortcutId>[] = [
  { id: "launcher", keys: ["mod+k"] },
  { id: "search", keys: ["/"] },
  { id: "help", keys: ["?"] },
  { id: "toggleNav", keys: ["["] },
  ...(Object.keys(VIEWS) as View[]).map(view => ({ id: `go:${view}` as const, keys: ["g", VIEWS[view].go] })),
  ...CREATE_ORDER.map(kind => ({ id: `new:${kind}` as const, keys: ["n", CREATES[kind].key] })),
];

/** The keys of one shortcut, for printing beside whatever it does. */
export const keysFor = (id: ShortcutId): string[] => SHORTCUTS.find(binding => binding.id === id)?.keys ?? [];

/**
 * Shortcuts that carry a modifier, and so answer even with single-key
 * shortcuts switched off — a stray keystroke cannot fire one.
 */
export const hasModifier = (id: ShortcutId) => keysFor(id).some(key => key.startsWith("mod+"));

/**
 * What to show on arrival at a screen — a record open, a new one started, a
 * filter applied. The launcher and the dashboard go through this, and the
 * screen reads it once, as its initial state.
 */
export type ViewIntent = {
  create?: boolean;
  openId?: string;
  /** A quote status on Quotes, an invoice condition on Receivables. */
  status?: string;
};
