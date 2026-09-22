import { useState, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type SessionUser } from "@/lib/api";
import { BrandLockup } from "./Brand";

/** PocketBase's own minimum for the `users` collection. */
const MIN_PASSWORD = 8;

type Mode = "login" | "register";

/**
 * The whole app behind one form: sign in, or make an account.
 *
 * On success the server sets an httpOnly session cookie, so nothing here ever
 * holds a token — the page just learns who it is talking to.
 */
export function AuthPanel({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const registering = mode === "register";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { user } = registering
        ? await api.register({ email, password, name: name.trim() || undefined })
        : await api.login({ email, password });
      onSignedIn(user);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
  }

  return (
    <div className="slab relative flex h-screen w-full items-center justify-center overflow-hidden p-6 text-foreground">
      {/*
       * Arc light through a roof bay: two soft washes that drift very slowly
       * against each other. It is the only decoration in the app that moves
       * on its own, and it is on the one screen nobody is trying to work on.
       */}
      <div
        aria-hidden="true"
        className="motion-safe:animate-drift pointer-events-none absolute -top-1/3 -left-1/4 size-[80vmax] rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--color-voltage)_12%,transparent),transparent_62%)] blur-3xl"
      />
      <div
        aria-hidden="true"
        className="motion-safe:animate-drift pointer-events-none absolute -right-1/4 -bottom-1/3 size-[70vmax] rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--color-alert)_10%,transparent),transparent_60%)] blur-3xl [animation-delay:-12s]"
      />

      <div className="motion-safe:animate-extend relative w-full max-w-sm">
        <div className="mb-6">
          <BrandLockup markClassName="size-10 rounded-xl" tagline="configure · price · quote" />
          <p className="mt-3 max-w-[30ch] text-sm leading-relaxed text-muted-foreground">
            {registering
              ? "Your own catalogue, your own customers, your own quotes — on your own bench."
              : "Sign in to your catalogue and quotes."}
          </p>
        </div>

        <form onSubmit={submit} className="panel space-y-3 rounded-xl border p-4 shadow-lg">
          {registering && (
            <div>
              <Label htmlFor="auth-name" className="mb-1 text-xs">
                Name <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input id="auth-name" value={name} onChange={e => setName(e.target.value)} autoComplete="name" />
            </div>
          )}

          <div>
            <Label htmlFor="auth-email" className="mb-1 text-xs">
              Email
            </Label>
            <Input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="auth-password" className="mb-1 text-xs">
              Password
            </Label>
            <Input
              id="auth-password"
              type="password"
              required
              minLength={registering ? MIN_PASSWORD : undefined}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete={registering ? "new-password" : "current-password"}
            />
            {registering && (
              <p className="mt-1 text-[11px] text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
            )}
          </div>

          {error && (
            <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <AlertCircle className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {registering ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="mt-3 text-center text-xs text-muted-foreground">
          {registering ? "Already have an account?" : "No account yet?"}{" "}
          <button
            type="button"
            className="decoration-primary/50 font-medium text-foreground underline underline-offset-2 transition-colors hover:text-primary"
            onClick={() => switchMode(registering ? "login" : "register")}
          >
            {registering ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </div>
  );
}
