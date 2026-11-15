import { useState, type FormEvent } from "react";
import { Building2, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type SessionUser } from "@/lib/api";
import { MAX_ORG_NAME } from "@/lib/organization";
import { BrandLockup } from "./Brand";

type Props = {
  me: SessionUser;
  /** Called once the account has somewhere to work; the app re-reads the session. */
  onReady: () => void;
  onSignOut: () => void;
  onError: (error: unknown) => void;
};

/**
 * An account with nowhere to work.
 *
 * Every record belongs to an organization, so an account that is in none —
 * removed from the last one it belonged to — can see nothing and write
 * nothing. What it can do is start an organization of its own, or wait for
 * an admin to add it to one; both are said here rather than left to be
 * discovered through a screen of empty lists.
 */
export function NoOrganization({ me, onReady, onSignOut, onError }: Props) {
  const [name, setName] = useState(me.name ? `${me.name}'s workspace` : "");
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createOrg(name.trim());
      onReady();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="slab grid min-h-screen place-items-center p-6 text-foreground">
      <div className="panel w-full max-w-md space-y-5 rounded-lg border p-6 motion-safe:animate-rise">
        <BrandLockup />

        <div className="space-y-1.5">
          <h1 className="font-display text-lg font-semibold">You are not in an organization</h1>
          <p className="text-sm text-muted-foreground">
            Quotes, customers and the catalogue all belong to an organization. Ask an admin to add{" "}
            <span className="font-medium text-foreground">{me.email}</span> to theirs, or start one of your own.
          </p>
        </div>

        <form onSubmit={create} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="org-name">Organization name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={MAX_ORG_NAME}
              placeholder="Acme Industrial"
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Building2 />} Create organization
          </Button>
        </form>

        <div className="flex items-center justify-between border-t pt-4 text-sm">
          <Button variant="ghost" size="sm" onClick={onReady}>
            Check again
          </Button>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
