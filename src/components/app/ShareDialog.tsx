import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Loader2, Mail, UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { api, type DirectoryUser, type Shareable, type Shares } from "@/lib/api";
import { Combobox } from "@/components/ui/combobox";

type Props = {
  kind: Shareable;
  id: string;
  title: string;
  /** The signed-in address — what "remove me from this" needs to send. */
  viewerEmail: string;
  /**
   * Everyone with an account here.
   *
   * A share only works on an address that has registered, so offering the list
   * turns a guess into a choice. Empty on an instance without the directory
   * hook, where the field falls back to being typed.
   */
  directory: DirectoryUser[];
  onClose: () => void;
  /** Lets the sidebar re-read the record after the share list changes. */
  onChanged: () => void;
};

/**
 * Who a record is shared with.
 *
 * Sharing is read-only by design: a recipient can open it, export it and quote
 * from it, and saving a change gives them their own copy. The dialog says so,
 * because "share" usually implies more than it does here.
 */
export function ShareDialog({ kind, id, title, viewerEmail, directory, onClose, onChanged }: Props) {
  const [shares, setShares] = useState<Shares | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setShares(await api.listShares(kind, id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not read the share list.");
    }
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<Shares>) {
    setBusy(true);
    setError("");
    try {
      setShares(await action());
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  /** Everyone it is not already shared with, and not you. */
  const candidates = directory
    .filter(user => user.email !== viewerEmail && !(shares?.sharedWith ?? []).includes(user.email))
    .map(user => ({ value: user.email, label: user.email, hint: user.name || undefined }));

  async function add(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    await run(async () => {
      const next = await api.addShare(kind, id, address);
      setEmail("");
      return next;
    });
  }

  return (
    <Sheet
      title={`Share \u201C${title}\u201D`}
      description="Recipients can open, export and quote from it — not change it."
      onClose={onClose}
    >
      <div className="space-y-3">
          {!shares ? (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </p>
          ) : shares.canShare ? (
            <>
              <form onSubmit={add} className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Combobox
                    value={email}
                    onChange={setEmail}
                    options={candidates}
                    placeholder={directory.length ? "Choose someone" : "teammate@example.com"}
                    allowCustom
                    aria-label="Who to share with"
                  />
                </div>
                <Button type="submit" disabled={busy || !email.trim()}>
                  {busy ? <Loader2 className="animate-spin" /> : <UserPlus />}
                  Share
                </Button>
              </form>

              {shares.sharedWith.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  Not shared with anyone yet. They need an account here first.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {shares.sharedWith.map(address => (
                    <li key={address} className="flex items-center gap-2 px-3 py-2">
                      <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{address}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        onClick={() => void run(() => api.removeShare(kind, id, address))}
                        aria-label={`Stop sharing with ${address}`}
                        title="Stop sharing"
                      >
                        <UserMinus className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm">
                Shared with you by <span className="font-medium">{shares.owner || "another account"}</span>.
              </p>
              <p className="text-xs text-muted-foreground">
                You can open it, export it and quote from it. Saving a change keeps a copy under your own account.
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    // The server lets a recipient show themselves out; the
                    // record then drops off their list entirely.
                    const next = await api.removeShare(kind, id, viewerEmail);
                    onClose();
                    return next;
                  })
                }
              >
                {busy && <Loader2 className="animate-spin" />}
                Remove from my list
              </Button>
            </div>
          )}

        {error && (
          <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
