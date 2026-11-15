/**
 * Organizations and roles — what each role may do.
 *
 * The rules that *enforce* this are PocketBase collection rules, in
 * docker/pb_migrations/1750000010_organizations.js; nothing here grants
 * anything. This table is the same policy written down once for the two
 * places that need to *know* it without asking the database: the UI, which
 * hides a button rather than offering one that will be refused, and the Bun
 * server, which refuses a multi-step operation (a sample install, an import)
 * before it has written half of it. src/server/api.test.ts walks the table
 * against the real rules, so the two cannot drift apart quietly.
 *
 * Approving is not a role. Being named by an approval rule is what lets
 * somebody decide a quote, whatever their role — a viewer can approve a
 * discount they could not have written.
 */

export const ROLES = ["admin", "sales", "finance", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  sales: "Sales",
  finance: "Finance",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Everything: members, the catalogue, pricing and approval policy, templates, quotes and receivables.",
  sales: "Customers, and their own quotes. Reads everything else.",
  finance: "Customers, invoices, payments and credits. Reads everything else.",
  viewer: "Reads everything and changes nothing. Can still approve a quote they are named on.",
};

export type Permission =
  /** Products, price books and the catalogue import. */
  | "catalogue.write"
  /** Pricing rules and approval rules. */
  | "policy.write"
  | "templates.write"
  | "accounts.write"
  | "accounts.delete"
  | "quotes.create"
  /** Any quote in the organization, not only one's own. */
  | "quotes.manageAll"
  | "invoices.write"
  | "org.manage"
  /** Installing a worked example writes every collection at once. */
  | "samples.install"
  /** The data table's record form layouts, in `record_forms`. */
  | "forms.write";

export const PERMISSIONS: Record<Permission, readonly Role[]> = {
  "catalogue.write": ["admin"],
  "policy.write": ["admin"],
  "templates.write": ["admin"],
  "accounts.write": ["admin", "sales", "finance"],
  "accounts.delete": ["admin", "sales"],
  "quotes.create": ["admin", "sales"],
  "quotes.manageAll": ["admin"],
  "invoices.write": ["admin", "finance"],
  "org.manage": ["admin"],
  "samples.install": ["admin"],
  "forms.write": ["admin"],
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

/** Whether `role` may do `permission`. No role — no organization — may do nothing. */
export function can(role: Role | "" | null | undefined, permission: Permission): boolean {
  return Boolean(role) && PERMISSIONS[permission].includes(role as Role);
}

/**
 * Whether `role` may edit or delete one particular quote: an admin any quote
 * in the organization, a sales member the ones they own.
 */
export function canEditQuote(
  role: Role | "" | null | undefined,
  quote: { ownerId?: string; orgId?: string },
  me: { id: string; orgId?: string },
): boolean {
  if (!role || !quote.orgId || quote.orgId !== me.orgId) return false;
  if (can(role, "quotes.manageAll")) return true;
  return can(role, "quotes.create") && quote.ownerId === me.id;
}

/* ------------------------------- the record -------------------------------- */

export type OrganizationSettings = {
  /** IANA zone the organization's "today" is read in. Empty is UTC. */
  timeZone: string;
};

export type Organization = {
  id: string;
  name: string;
  settings: OrganizationSettings;
};

export type Membership = {
  id: string;
  org: { id: string; name: string };
  role: Role;
};

export type Member = {
  /** The membership's id — what a role change or removal names. */
  id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  joined: string;
};

export type Invitation = {
  id: string;
  email: string;
  role: Role;
  created: string;
};

export type MemberListing = {
  members: Member[];
  invitations: Invitation[];
  canManage: boolean;
  /** Present after adding: whether the address joined, or was invited. */
  outcome?: "added" | "invited";
};

export const MAX_ORG_NAME = 200;

/** Whatever was stored, as settings with every key present. */
export function normalizeOrgSettings(raw: unknown, isZone: (value: unknown) => boolean = () => true): OrganizationSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const zone = typeof source.timeZone === "string" ? source.timeZone.trim() : "";
  return { timeZone: zone && isZone(zone) ? zone : "" };
}
