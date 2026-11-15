/**
 * What the signed-in account may do here, for hiding what would be refused.
 *
 * Nothing in this file grants anything. PocketBase's collection rules decide
 * every write, whatever the UI shows; this exists so a viewer is not offered a
 * "New product" button that can only end in an error. The table it reads is
 * `PERMISSIONS` in src/lib/organization.ts — the same one the server checks
 * multi-record operations against, and the API tests walk against the rules.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { SessionUser } from "@/lib/api";
import { can, canEditQuote, type Permission, type Role } from "@/lib/organization";

export type Access = {
  userId: string;
  orgId: string;
  role: Role | "";
  can: (permission: Permission) => boolean;
  /** Whether this account may edit, submit, revise or delete one quote. */
  canEditQuote: (quote: { ownerId?: string; orgId?: string }) => boolean;
  /** The record is the organization's — as opposed to shared in from outside it. */
  isOurs: (record: { orgId?: string }) => boolean;
};

const NOBODY: Access = {
  userId: "",
  orgId: "",
  role: "",
  can: () => false,
  canEditQuote: () => false,
  isOurs: () => false,
};

const AccessContext = createContext<Access>(NOBODY);

export function AccessProvider({ me, children }: { me: SessionUser; children: ReactNode }) {
  const value = useMemo<Access>(() => {
    const orgId = me.org?.id ?? "";
    return {
      userId: me.id,
      orgId,
      role: me.role,
      can: permission => can(me.role, permission),
      canEditQuote: quote => canEditQuote(me.role, quote, { id: me.id, orgId }),
      isOurs: record => Boolean(orgId) && record.orgId === orgId,
    };
  }, [me.id, me.org?.id, me.role]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export const useAccess = () => useContext(AccessContext);
