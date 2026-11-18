import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Building2, Loader2, LogOut, Mail, Plus, Trash2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { Field, FieldAction, Section } from "./common";
import { useAccess } from "./access";
import { api, type SessionUser } from "@/lib/api";
import { timeZones } from "@/lib/clock";
import {
  MAX_ORG_NAME,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
  type MemberListing,
  type Role,
} from "@/lib/organization";

type Props = {
  me: SessionUser;
  /** The organization, the role or the membership changed: re-read the session. */
  onSessionChanged: () => Promise<void> | void;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
  confirmed: (message: string) => boolean;
};

/**
 * The organization you work in: its name and calendar, who is in it and as
 * what, and the other organizations you could be working in instead.
 *
 * Everybody sees the member list — knowing who can approve or invoice is
 * part of working in a team. Only an admin can change it, and PocketBase
 * enforces that; the controls are simply not offered to anyone else.
 */
export function OrganizationSection({ me, onSessionChanged, onError, onNotice, confirmed }: Props) {
  const access = useAccess();
  const admin = access.can("org.manage");
  const org = me.org!;

  const [listing, setListing] = useState<MemberListing | null>(null);
  const [name, setName] = useState(org.name);
  const [timeZone, setTimeZone] = useState(org.settings.timeZone);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("sales");
  const [newOrg, setNewOrg] = useState("");
  const [busy, setBusy] = useState("");

  const zones = useMemo(() => timeZones().map(zone => ({ value: zone, label: zone })), []);
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(async () => {
    try {
      setListing(await api.members());
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load, org.id]);

  useEffect(() => {
    setName(org.name);
    setTimeZone(org.settings.timeZone);
  }, [org.id, org.name, org.settings.timeZone]);

  const run = async (label: string, action: () => Promise<unknown>, after?: () => Promise<void> | void) => {
    setBusy(label);
    try {
      await action();
      await after?.();
    } catch (error) {
      onError(error);
    } finally {
      setBusy("");
    }
  };

  const saveSettings = (event: FormEvent) => {
    event.preventDefault();
    void run("settings", () => api.updateOrg({ name: name.trim(), timeZone }), async () => {
      await onSessionChanged();
      onNotice(["Organization settings saved."]);
    });
  };

  const invite = (event: FormEvent) => {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    void run("invite", async () => {
      const next = await api.addMember(email, inviteRole);
      setListing(next);
      setInviteEmail("");
      onNotice([
        next.outcome === "added"
          ? `${email} already had an account and is now a member, as ${ROLE_LABELS[inviteRole].toLowerCase()}.`
          : `${email} is invited as ${ROLE_LABELS[inviteRole].toLowerCase()}. They join when they register with that address.`,
      ]);
    });
  };

  const changeRole = (membershipId: string, role: Role, self: boolean) =>
    void run(`role:${membershipId}`, async () => setListing(await api.changeMemberRole(membershipId, role)), () =>
      self ? onSessionChanged() : undefined,
    );

  const remove = (membershipId: string, email: string, self: boolean) => {
    const message = self
      ? `Leave ${org.name}? You will lose access to everything in it. The records you made stay with the organization.`
      : `Remove ${email} from ${org.name}? Their records stay with the organization.`;
    if (!confirmed(message)) return;
    void run(`remove:${membershipId}`, async () => {
      const next = await api.removeMember(membershipId);
      if (self) await onSessionChanged();
      else setListing(next);
    });
  };

  const switchTo = (orgId: string) => void run(`switch:${orgId}`, () => api.switchOrg(orgId), onSessionChanged);

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!newOrg.trim()) return;
    void run("create", () => api.createOrg(newOrg.trim()), async () => {
      setNewOrg("");
      await onSessionChanged();
    });
  };

  const others = me.memberships.filter(membership => membership.org.id !== org.id);

  return (
    <Section
      title="Organization"
      description="Records belong to the organization. What each member may change is decided by their role."
    >
      {/* ---------------------------- settings ---------------------------- */}
      <form onSubmit={saveSettings} className="grid gap-4 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
        <Field label="Name">
          <Input value={name} onChange={event => setName(event.target.value)} maxLength={MAX_ORG_NAME} disabled={!admin} />
        </Field>
        <Field
          label="Time zone"
          hint={`"Today" for expiry, due dates and overdue. Empty is UTC${browserZone ? `; this browser is ${browserZone}` : ""}.`}
        >
          <Combobox
            value={timeZone}
            onChange={setTimeZone}
            options={zones}
            placeholder="UTC"
            emptyLabel="UTC"
            disabled={!admin}
            aria-label="Organization time zone"
          />
        </Field>
        {admin && (
          <FieldAction>
            <Button type="submit" variant="outline" disabled={busy === "settings" || !name.trim()}>
              {busy === "settings" && <Loader2 className="animate-spin" />} Save
            </Button>
          </FieldAction>
        )}
      </form>

      {/* ----------------------------- members ---------------------------- */}
      <div className="border-t">
        {listing === null ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Loading members…</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Member</Th>
                <Th>Role</Th>
                <Th className="w-24" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {listing.members.map(member => {
                const self = member.userId === me.id;
                return (
                  <Tr key={member.id}>
                    <Td>
                      <span className="block font-medium">
                        {member.name || member.email}
                        {self && (
                          <Badge tone="outline" className="ml-1.5">
                            you
                          </Badge>
                        )}
                      </span>
                      {member.name && <span className="text-xs text-muted-foreground">{member.email}</span>}
                    </Td>
                    <Td>
                      {admin ? (
                        <Select
                          value={member.role}
                          onValueChange={value => changeRole(member.id, value as Role, self)}
                          disabled={busy === `role:${member.id}`}
                        >
                          <SelectTrigger className="h-8 w-32" aria-label={`Role of ${member.email}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map(role => (
                              <SelectItem key={role} value={role}>
                                {ROLE_LABELS[role]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span title={ROLE_DESCRIPTIONS[member.role]}>{ROLE_LABELS[member.role]}</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex justify-end">
                        {(admin || self) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove(member.id, member.email, self)}
                            disabled={busy === `remove:${member.id}`}
                            aria-label={self ? "Leave this organization" : `Remove ${member.email}`}
                          >
                            {self ? (
                              <>
                                <LogOut /> Leave
                              </>
                            ) : (
                              <Trash2 className="text-muted-foreground hover:text-destructive" />
                            )}
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}

              {listing.invitations.map(invitation => (
                <Tr key={invitation.id}>
                  <Td>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Mail className="size-3.5" /> {invitation.email}
                      <Badge tone="pending">invited</Badge>
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{ROLE_LABELS[invitation.role]}</Td>
                  <Td>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          void run(`invite:${invitation.id}`, async () =>
                            setListing(await api.revokeInvitation(invitation.id)),
                          )
                        }
                        aria-label={`Withdraw the invitation to ${invitation.email}`}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>

      {admin && (
        <form onSubmit={invite} className="grid gap-3 border-t p-4 sm:grid-cols-[1fr_9rem_auto] sm:items-start">
          <Field
            label="Add a member"
            hint={
              <>
                An address with an account joins now; any other is invited and joins on sign-up.{" "}
                <span className="text-foreground/70">{ROLE_LABELS[inviteRole]}:</span> {ROLE_DESCRIPTIONS[inviteRole]}
              </>
            }
          >
            <Input
              type="email"
              value={inviteEmail}
              onChange={event => setInviteEmail(event.target.value)}
              placeholder="colleague@example.com"
            />
          </Field>
          <Field label="Role">
            <Select value={inviteRole} onValueChange={value => setInviteRole(value as Role)}>
              <SelectTrigger aria-label="Role for the new member">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map(role => (
                  <SelectItem key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <FieldAction>
            <Button type="submit" disabled={busy === "invite" || !inviteEmail.trim()}>
              {busy === "invite" ? <Loader2 className="animate-spin" /> : <UserPlus />} Add
            </Button>
          </FieldAction>
        </form>
      )}

      {/* --------------------------- elsewhere ---------------------------- */}
      <div className="space-y-3 border-t p-4">
        {others.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Your other organizations</p>
            <div className="flex flex-wrap gap-2">
              {others.map(membership => (
                <Button
                  key={membership.org.id}
                  variant="outline"
                  size="sm"
                  onClick={() => switchTo(membership.org.id)}
                  disabled={Boolean(busy)}
                  title={`Switch to ${membership.org.name}, as ${ROLE_LABELS[membership.role].toLowerCase()}`}
                >
                  <Building2 /> {membership.org.name}
                  <span className="text-xs text-muted-foreground">{ROLE_LABELS[membership.role]}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={create} className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-start">
          <Field label="Start another organization" hint="You become its admin and move into it.">
            <Input
              value={newOrg}
              onChange={event => setNewOrg(event.target.value)}
              maxLength={MAX_ORG_NAME}
              placeholder="Organization name"
            />
          </Field>
          <FieldAction>
            <Button type="submit" variant="outline" disabled={busy === "create" || !newOrg.trim()}>
              {busy === "create" ? <Loader2 className="animate-spin" /> : <Plus />} Create
            </Button>
          </FieldAction>
        </form>
      </div>
    </Section>
  );
}
