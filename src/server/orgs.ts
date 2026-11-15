/**
 * The organization you work in, and the people in it.
 *
 * Membership changes proxy to PocketBase's /api/cpq/org/... routes
 * (docker/pb_hooks/lib/orgs.js): a membership, and the `org`/`role` pair on
 * an account that every collection rule reads, are not writable through the
 * collection API by anyone, so only a hook can write them — and it checks the
 * caller's role itself. Renaming the organization or changing its time zone
 * is an ordinary record update, which the collection's own update rule limits
 * to its admins.
 */
import { isTimeZone, timeZones } from "../lib/clock";
import {
  isRole,
  MAX_ORG_NAME,
  normalizeOrgSettings,
  type MemberListing,
  type Organization,
  type Role,
} from "../lib/organization";
import { ApiError, asRecord } from "./http";
import { callHook, clientFor, toApiError } from "./pocketbase";

export type OrgUpdate = { name?: string; timeZone?: string };

export function readOrgUpdate(raw: unknown): OrgUpdate {
  const body = asRecord(raw);
  const out: OrgUpdate = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name) throw new ApiError("An organization needs a name.");
    if (name.length > MAX_ORG_NAME) throw new ApiError(`An organization's name is ${MAX_ORG_NAME} characters at most.`);
    out.name = name;
  }
  if (body.timeZone !== undefined) {
    const zone = String(body.timeZone ?? "").trim();
    if (zone && !isTimeZone(zone)) {
      throw new ApiError(`"${zone}" is not a time zone. Use an IANA name such as Europe/London, or leave it empty for UTC.`);
    }
    out.timeZone = zone;
  }
  return out;
}

export function readRole(value: unknown): Role {
  const role = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!isRole(role)) throw new ApiError("A role is one of admin, sales, finance or viewer.");
  return role;
}

export async function updateOrganization(token: string, orgId: string, update: OrgUpdate): Promise<Organization> {
  const collection = clientFor(token).collection("organizations");
  try {
    const current = await collection.getOne(orgId);
    const settings = { ...normalizeOrgSettings(current.settings, isTimeZone) };
    if (update.timeZone !== undefined) settings.timeZone = update.timeZone;
    const saved = await collection.update(orgId, {
      ...(update.name !== undefined ? { name: update.name } : {}),
      settings,
    });
    return {
      id: String(saved.id),
      name: String(saved.name ?? ""),
      settings: normalizeOrgSettings(saved.settings, isTimeZone),
    };
  } catch (error) {
    // The update rule is admins-only; a refusal reads as missing.
    const failure = toApiError(error, "Could not update the organization");
    if (failure.status === 404) throw new ApiError("Only an admin can change the organization's settings.", 403);
    throw failure;
  }
}

export const listMembers = (token: string) => callHook<MemberListing>(token, "/api/cpq/org/members");

export const addMember = (token: string, email: string, role: Role) =>
  callHook<MemberListing>(token, "/api/cpq/org/members", { method: "POST", body: JSON.stringify({ email, role }) });

export const changeMemberRole = (token: string, membershipId: string, role: Role) =>
  callHook<MemberListing>(token, `/api/cpq/org/members/${encodeURIComponent(membershipId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });

export const removeMember = (token: string, membershipId: string) =>
  callHook<MemberListing & { left?: boolean }>(token, `/api/cpq/org/members/${encodeURIComponent(membershipId)}`, {
    method: "DELETE",
  });

export const revokeInvitation = (token: string, invitationId: string) =>
  callHook<MemberListing>(token, `/api/cpq/org/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });

export const switchOrganization = (token: string, orgId: string) =>
  callHook<{ org: Organization; role: Role }>(token, "/api/cpq/org/switch", {
    method: "POST",
    body: JSON.stringify({ orgId }),
  });

export const createOrganization = (token: string, name: string) =>
  callHook<{ org: Organization; role: Role }>(token, "/api/cpq/orgs", { method: "POST", body: JSON.stringify({ name }) });

/** For the settings picker. */
export const supportedTimeZones = () => timeZones();
