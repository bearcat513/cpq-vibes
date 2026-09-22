import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ChevronDown, Download, KeyRound, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLockup } from "@/components/app/Brand";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { Markdown } from "@/components/docs/Markdown";
import { MethodBadge } from "@/components/docs/MethodBadge";
import { OperationCard } from "@/components/docs/OperationCard";
import { SchemaView } from "@/components/docs/SchemaView";
import { api, type SessionUser } from "@/lib/api";
import {
  anchorId,
  groupByTag,
  matches,
  readOperations,
  serverChoices,
  tagId,
  API_KEY_HEADER,
  NO_CREDENTIAL,
  type Credential,
  type OpenApiDoc,
  type Schema,
} from "@/lib/openapiDoc";
import { cn } from "@/lib/utils";

/**
 * The API reference: the document at `/api/openapi.json`, rendered, and
 * callable.
 *
 * It reads the same bytes Postman would — nothing about this API is written
 * down here — so an endpoint added to `src/server/openapi.ts` appears on this
 * page with nothing else to change, and a page that disagreed with the
 * document would be a bug in the document.
 */

const CREDENTIAL_KINDS: { kind: Credential["kind"]; label: string; hint: string }[] = [
  { kind: "apiKey", label: "API key", hint: `Sent as \`${API_KEY_HEADER}\`. Issue one under Settings → API keys.` },
  { kind: "token", label: "User token", hint: "A PocketBase user token, sent raw as `Authorization` — no `Bearer`." },
];

/**
 * The signed-in account's look, applied to this page as it is to the app.
 *
 * The same three attributes `App.tsx` puts on `<html>`, for the same reason:
 * a reference page that flashed white against a dark app would announce that
 * it is a different page, which it is not.
 */
function useAccountTheme(user: SessionUser | null) {
  const theme = user?.preferences.theme ?? "system";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    if (!user) return;
    document.documentElement.dataset.accent = user.preferences.accent;
    document.documentElement.dataset.font = user.preferences.font;
  }, [user?.preferences.accent, user?.preferences.font]);
}

/** The credential box: what to send, and the standing note that nothing is stored. */
function Authorize({
  credential,
  onChange,
  onClose,
  user,
}: {
  credential: Credential;
  onChange: (credential: Credential) => void;
  onClose: () => void;
  user: SessionUser | null;
}) {
  const kind = credential.kind === "none" ? "apiKey" : credential.kind;
  const chosen = CREDENTIAL_KINDS.find(entry => entry.kind === kind) ?? CREDENTIAL_KINDS[0]!;

  return (
    <div className="leaf motion-safe:animate-settle rounded-lg border p-4 shadow-[0_1px_2px_oklch(0.3_0.04_60/0.06)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-[0.95rem] font-semibold">Credential</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {user
              ? `Signed in as ${user.email}. Every call below already travels on that session — a key is only needed to try one as something else.`
              : "Not signed in here. Paste a key or a token, or sign in to the app and the session cookie is used instead."}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close the credential box">
          <X />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="inline-flex gap-0.5 rounded-md border bg-muted/60 p-0.5">
          {CREDENTIAL_KINDS.map(entry => (
            <button
              key={entry.kind}
              type="button"
              aria-pressed={entry.kind === kind}
              onClick={() => onChange({ kind: entry.kind, value: credential.value })}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                entry.kind === kind ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="min-w-56 flex-1">
          <Label htmlFor="docs-credential" className="mb-1 text-xs text-muted-foreground">
            Value
          </Label>
          <Input
            id="docs-credential"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={kind === "apiKey" ? "cpq_…" : "a PocketBase user token"}
            value={credential.value}
            onChange={event => onChange({ kind, value: event.target.value })}
            className="h-8 font-mono text-xs"
          />
        </div>

        <Button variant="outline" className="h-8" onClick={() => onChange(NO_CREDENTIAL)}>
          Clear
        </Button>
      </div>

      <Markdown source={chosen.hint} className="mt-2 text-[11px]" />
      <p className="mt-1 text-[11px] text-muted-foreground/80">
        Kept in this tab only, for as long as it is open — nothing here is written to storage, and the cURL command
        beside each call prints the key as a shell variable rather than as itself.
      </p>
    </div>
  );
}

/** One `components.schemas` entry, opened on demand. */
function Model({ doc, name, schema }: { doc: OpenApiDoc; name: string; schema: Schema }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="leaf overflow-hidden rounded-lg border shadow-[0_1px_2px_oklch(0.3_0.04_60/0.06)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
      >
        <span className="font-mono text-xs font-medium">{name}</span>
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {typeof schema.description === "string" ? schema.description : ""}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="motion-safe:animate-unfurl border-t px-4 py-3">
          <SchemaView doc={doc} schema={schema} seen={[name]} />
        </div>
      )}
    </div>
  );
}

export function DocsPage() {
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [error, setError] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [search, setSearch] = useState("");
  const [credential, setCredential] = useState<Credential>(NO_CREDENTIAL);
  const [authorizing, setAuthorizing] = useState(false);
  /** Which operations are expanded, by anchor — the URL's hash opens one. */
  const [open, setOpen] = useState<string[]>([]);
  /** Where trial calls go. Empty means the first server on offer. */
  const [server, setServer] = useState("");
  const searchBox = useRef<HTMLInputElement>(null);

  useAccountTheme(user);

  useEffect(() => {
    // Never from the cache: a stale document names a host that has since moved,
    // and every trial call would then go somewhere that is no longer there.
    fetch(api.openApiUrl, { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(setDoc)
      .catch(reason => setError(reason instanceof Error ? reason.message : "The document could not be read."));

    // Signed in or not, both are fine: this only decides whose look the page
    // wears and whether the credential box says a cookie is already in play.
    api
      .me()
      .then(({ user: account }) => setUser(account))
      .catch(() => setUser(null));
  }, []);

  /** `/` focuses the filter, the way every reference page people already use does. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchBox.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const operations = useMemo(() => (doc ? readOperations(doc) : []), [doc]);
  const groups = useMemo(() => (doc ? groupByTag(doc, operations) : []), [doc, operations]);

  const filtered = useMemo(
    () =>
      groups
        .map(group => ({ ...group, operations: group.operations.filter(operation => matches(operation, search)) }))
        .filter(group => group.operations.length > 0),
    [groups, search],
  );

  /** A link straight to one endpoint arrives with it already open. */
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash || !operations.length) return;
    setOpen(current => (current.includes(hash) ? current : [...current, hash]));
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [operations.length]);

  const servers = doc ? serverChoices(doc, window.location.origin) : [window.location.origin];
  // The first is this page's own origin, which is the one a call can actually
  // reach; the document's own entry is only used if it is asked for by name.
  const base = servers.includes(server) ? server : servers[0]!;
  const schemas = Object.entries(doc?.components?.schemas ?? {});

  function toggle(anchor: string) {
    setOpen(current => (current.includes(anchor) ? current.filter(entry => entry !== anchor) : [...current, anchor]));
    // The hash makes the open endpoint linkable without adding a history entry
    // for every row someone opens on the way past it.
    history.replaceState(null, "", `#${anchor}`);
  }

  if (error) {
    return (
      <main className="paper mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <h1 className="font-serif text-lg font-semibold">The API document could not be loaded</h1>
        <p className="text-sm text-muted-foreground">
          {error}. It is served from <span className="font-mono">{api.openApiUrl}</span>, with no credential needed —
          if that is failing, the server itself is probably down.
        </p>
        <Button asChild variant="outline">
          <a href="/">
            <ArrowLeft />
            Back to the app
          </a>
        </Button>
      </main>
    );
  }

  if (!doc) {
    return (
      <main className="paper flex min-h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Reading the API document…
      </main>
    );
  }

  return (
    <div className="paper min-h-dvh">
      {/* ------------------------------- header ------------------------------ */}
      <header className="double-rule sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <a href="/" className="rounded">
            <BrandLockup tagline="api reference" markClassName="size-7" />
          </a>
          {doc.info?.version && (
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              v{doc.info.version}
            </span>
          )}
          {servers.length > 1 ? (
            <label className="hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
              Calls go to
              <select
                value={base}
                onChange={event => setServer(event.target.value)}
                className="rounded-md border bg-background px-1.5 py-0.5 font-mono text-[11px]"
              >
                {servers.map(entry => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="hidden font-mono text-[11px] text-muted-foreground md:inline">{base}</span>
          )}

          <div className="relative ml-auto min-w-44 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchBox}
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Filter endpoints  /"
              aria-label="Filter endpoints"
              className="h-8 pl-8 text-xs"
            />
          </div>

          <Button
            variant={credential.value ? "default" : "outline"}
            size="sm"
            onClick={() => setAuthorizing(!authorizing)}
          >
            <KeyRound />
            {credential.value ? "Credential set" : "Authorize"}
          </Button>

          <Button variant="ghost" size="sm" asChild>
            <a href={api.openApiUrl} download={api.openApiFileName}>
              <Download />
              <span className="hidden sm:inline">Spec</span>
            </a>
          </Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* ------------------------------ sidebar ----------------------------- */}
        <nav className="margin-rule hidden lg:block">
          <div className="sticky top-20 space-y-4 pr-3">
            <div className="space-y-1">
              {filtered.map(group => (
                <a
                  key={group.name}
                  href={`#${tagId(group.name)}`}
                  className="flex items-center justify-between rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {group.name}
                  <span className="text-[11px] text-muted-foreground/70">{group.operations.length}</span>
                </a>
              ))}
            </div>

            {schemas.length > 0 && (
              <a
                href="#models"
                className="flex items-center justify-between rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Models
                <span className="text-[11px] text-muted-foreground/70">{schemas.length}</span>
              </a>
            )}

            <a
              href="/"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Back to the app
            </a>
          </div>
        </nav>

        <main className="min-w-0 space-y-6">
          {authorizing && (
            <Authorize
              credential={credential}
              onChange={setCredential}
              onClose={() => setAuthorizing(false)}
              user={user}
            />
          )}

          {doc.info?.description && (
            <section className="leaf motion-safe:animate-rise rounded-lg border p-4 shadow-[0_1px_2px_oklch(0.3_0.04_60/0.06)]">
              <Markdown source={doc.info.description} />
              <div className="mt-3 border-t pt-3">
                <p className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Import it instead
                </p>
                <CodeBlock code={`${base}${api.openApiUrl}`} plain label="the document's URL" />
              </div>
            </section>
          )}

          {filtered.length === 0 && (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing matches “{search}”.
            </p>
          )}

          {filtered.map(group => (
            <section key={group.name} id={tagId(group.name)} className="scroll-mt-20 space-y-2">
              <div>
                <h2 className="font-serif text-[0.95rem] font-semibold tracking-tight">{group.name}</h2>
                {group.description && <p className="text-xs text-muted-foreground">{group.description}</p>}
              </div>

              <div className="space-y-2">
                {group.operations.map(operation => (
                  <OperationCard
                    key={operation.key}
                    doc={doc}
                    operation={operation}
                    base={base}
                    credential={credential}
                    open={open.includes(anchorId(operation))}
                    onToggle={() => toggle(anchorId(operation))}
                    onNeedsCredential={() => setAuthorizing(true)}
                  />
                ))}
              </div>
            </section>
          ))}

          {schemas.length > 0 && (
            <section id="models" className="scroll-mt-20 space-y-2">
              <div>
                <h2 className="font-serif text-[0.95rem] font-semibold tracking-tight">Models</h2>
                <p className="text-xs text-muted-foreground">
                  The shapes the endpoints above send and answer with, as the document declares them.
                </p>
              </div>
              <div className="space-y-2">
                {schemas.map(([name, schema]) => (
                  <Model key={name} doc={doc} name={name} schema={schema} />
                ))}
              </div>
            </section>
          )}

          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-4 text-[11px] text-muted-foreground">
            <span>
              {operations.length} endpoints, rendered from <span className="font-mono">{api.openApiUrl}</span>.
            </span>
            <span className="flex items-center gap-1">
              <MethodBadge method="get" className="w-auto px-1" /> is safe to try;
            </span>
            <span>anything else changes something.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
