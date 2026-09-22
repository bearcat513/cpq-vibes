import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "./common";
import { api, type ApiKey, type IssuedApiKey } from "@/lib/api";
import { copyText } from "@/lib/clipboard";

/** The header a key travels in. Matches API_KEY_HEADER on the server. */
const HEADER = "X-API-Key";

/** The server's own cap, from docker/pb_hooks/lib/apiKeys.js. */
const MAX_KEYS = 25;

const EXPIRY_CHOICES = [
  { value: "0", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "A year" },
] as const;

const formatDate = (iso: string) => (iso ? new Date(iso).toLocaleDateString() : "");

/** "in 29 days" / "expired" — the number of days is what anyone actually reads. */
export function describeExpiry(iso: string): { text: string; expired: boolean } {
  if (!iso) return { text: "Never expires", expired: false };

  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return { text: "Expired", expired: true };
  return { text: days === 1 ? "Expires tomorrow" : `Expires in ${days} days`, expired: false };
}

/** The key itself, shown the once, with the only chance to copy it. */
function IssuedKey({ issued, onDismiss }: { issued: IssuedApiKey; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await copyText(issued.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The value is on screen and selectable; a failed copy is not worth an alert.
    }
  }

  return (
    <div className="motion-safe:animate-settle space-y-2 border-l-2 border-l-primary bg-primary/5 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <TriangleAlert className="size-3.5 text-chart-3 dark:text-chart-2" />
        Copy it now — only its hash is stored, so this is the one time it can be shown.
      </p>

      <div className="flex flex-wrap gap-2">
        <Input
          readOnly
          value={issued.key}
          aria-label="Your new API key"
          className="h-8 min-w-56 flex-1 font-mono text-xs"
          onFocus={event => event.target.select()}
        />
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Send it as <span className="font-mono">{HEADER}</span> on any endpoint under{" "}
        <span className="font-mono">/api</span>, in place of signing in. The reference at{" "}
        <a href="/docs" className="text-primary underline underline-offset-2 hover:no-underline">
          /docs
        </a>{" "}
        will call them with it.
      </p>
    </div>
  );
}

/**
 * Issuing, listing and revoking this account's API keys.
 *
 * A key is a second way to prove the same thing a password does, so it sits
 * next to the password form rather than in a screen of its own. Every row here
 * is what the server will say about a key; the key itself exists only in the
 * response that created it, which is why issuing renders a banner rather than
 * adding a row and moving on.
 */
export function ApiKeys({ confirmDestructive }: { confirmDestructive: boolean }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Which key is mid-revoke, so only its own button spins. */
  const [revoking, setRevoking] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await api.listApiKeys();
        if (!cancelled) setKeys(listed);
      } catch (failure) {
        if (!cancelled) {
          setKeys([]);
          setError(failure instanceof Error ? failure.message : "Could not read your API keys.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const key = await api.createApiKey({ name: name.trim(), expiresInDays: Number(expiry) });
      setIssued(key);
      // The listing's own shape, minus the secret — no need to re-fetch.
      const { key: _secret, ...row } = key;
      setKeys(current => [row, ...(current ?? [])]);
      setName("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not issue an API key.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKey) {
    const label = key.name || "this key";
    // The same preference every other delete in the app honours.
    if (
      confirmDestructive &&
      !window.confirm(`Revoke ${label}? Anything using it stops working on its next request.`)
    ) {
      return;
    }

    setRevoking(key.id);
    setError("");
    try {
      await api.deleteApiKey(key.id);
      setKeys(current => (current ?? []).filter(other => other.id !== key.id));
      if (issued?.id === key.id) setIssued(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not revoke that key.");
    } finally {
      setRevoking("");
    }
  }

  const full = (keys?.length ?? 0) >= MAX_KEYS;

  return (
    <>
      <form onSubmit={event => void create(event)} className="flex flex-wrap items-end gap-3 p-4">
        <Field label="What is it for" className="min-w-40 flex-1">
          <Input
            className="h-8"
            maxLength={100}
            placeholder="Nightly invoice run"
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </Field>

        <Field label="Expires" className="w-32">
          <Select value={expiry} onValueChange={setExpiry}>
            <SelectTrigger className="h-8 w-full" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_CHOICES.map(choice => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Button type="submit" variant="outline" size="sm" disabled={busy || full}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Create key
        </Button>

        <p className="w-full text-xs text-muted-foreground">
          A key reaches exactly what you reach and nothing more — but it cannot issue or revoke keys, so a leaked one
          can always be shut off from here.
          {full && ` You have ${MAX_KEYS}, which is the limit; revoke one to issue another.`}
        </p>

        {error && <p className="w-full text-xs text-destructive">{error}</p>}
      </form>

      {issued && <IssuedKey issued={issued} onDismiss={() => setIssued(null)} />}

      {keys === null ? (
        <p className="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </p>
      ) : keys.length === 0 ? (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          No API keys. A script can use one instead of a session that expires in a week.
        </p>
      ) : (
        <ul className="divide-y border-t">
          {keys.map(key => {
            const lifetime = describeExpiry(key.expiresAt);
            return (
              <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-56 flex-1">
                  <p className="truncate text-sm">
                    {key.name || <span className="text-muted-foreground">Unnamed</span>}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Created {formatDate(key.createdAt)} ·{" "}
                    {key.lastUsedAt ? `last used ${formatDate(key.lastUsedAt)}` : "never used"} ·{" "}
                    <span className={lifetime.expired ? "text-destructive" : undefined}>{lifetime.text}</span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={revoking === key.id}
                  onClick={() => void revoke(key)}
                  aria-label={`Revoke ${key.name || "unnamed key"}`}
                >
                  {revoking === key.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
