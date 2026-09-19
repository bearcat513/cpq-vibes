import { useCallback, useEffect, useRef, useState } from "react";
import {
  Building2,
  FileText,
  LayoutList,
  LogOut,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccountsView } from "@/components/app/AccountsView";
import { BrandLockup, BrandMark } from "@/components/app/Brand";
import { ApprovalsQueue } from "@/components/app/ApprovalsQueue";
import { AuthPanel } from "@/components/app/AuthPanel";
import { CatalogView } from "@/components/app/CatalogView";
import { Notice, type NoticeKind } from "@/components/app/common";
import { QuoteEditor } from "@/components/app/QuoteEditor";
import { QuoteList } from "@/components/app/QuoteList";
import { RulesView } from "@/components/app/RulesView";
import { SettingsPanel, type SaveState } from "@/components/app/SettingsPanel";
import { ShareDialog } from "@/components/app/ShareDialog";
import { TemplatesView } from "@/components/app/TemplatesView";
import { api, isUnauthorized, type DirectoryUser, type Meta, type Shareable, type SessionUser } from "@/lib/api";
import { DEFAULT_PREFERENCES, normalizePreferences, type Preferences } from "@/lib/preferences";
import type {
  Account,
  ApprovalRule,
  PriceBook,
  PricingRule,
  Product,
  ProposalTemplate,
  Quote,
  QuoteSummary,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import "./index.css";

type View = "quotes" | "approvals" | "catalog" | "rules" | "customers" | "templates" | "settings";

type Banner = { kind: NoticeKind; lines: string[] } | null;

/** The record whose share list is open, if any. */
type Sharing = { kind: Shareable; id: string; title: string } | null;

/** How long the app sits on a preference change before writing it. */
const PREFERENCE_SAVE_DELAY_MS = 500;

const NAV: { id: View; label: string; Icon: typeof LayoutList }[] = [
  { id: "quotes", label: "Quotes", Icon: ScrollText },
  { id: "approvals", label: "Approvals", Icon: ShieldCheck },
  { id: "catalog", label: "Catalogue", Icon: Package },
  { id: "rules", label: "Rules", Icon: LayoutList },
  { id: "customers", label: "Customers", Icon: Building2 },
  { id: "templates", label: "Templates", Icon: FileText },
];

export function App() {
  // undefined while the session is still being checked, null when signed out.
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);

  const [view, setView] = useState<View>("quotes");
  const [banner, setBanner] = useState<Banner>(null);
  const [sharing, setSharing] = useState<Sharing>(null);

  /* Everything this account can see. */
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [awaiting, setAwaiting] = useState<QuoteSummary[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [priceBooks, setPriceBooks] = useState<PriceBook[]>([]);
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [approvalRules, setApprovalRules] = useState<ApprovalRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [templates, setTemplates] = useState<ProposalTemplate[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  /** Everyone with an account here, for the pickers that name a person. */
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);

  /** The quote on screen: an id being read, null for a new one, undefined for none. */
  const [openQuote, setOpenQuote] = useState<Quote | null | undefined>(undefined);

  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [preferenceSave, setPreferenceSave] = useState<SaveState>("idle");
  const preferenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read by callbacks that must not be rebuilt every time a preference
  // changes — `refresh` is a dependency of half the effects below.
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  /**
   * Shows what went wrong — or drops back to the sign-in screen when the
   * session is the thing that went wrong.
   */
  const fail = useCallback((error: unknown) => {
    if (isUnauthorized(error)) {
      setMe(null);
      return;
    }
    setBanner({ kind: "error", lines: [error instanceof Error ? error.message : "Something went wrong."] });
  }, []);

  const notice = useCallback((lines: string[]) => setBanner({ kind: "info", lines: lines.filter(Boolean) }), []);

  /* ------------------------------ loading ------------------------------- */

  const refresh = useCallback(async () => {
    const [nextQuotes, nextAwaiting, nextProducts, nextBooks, nextPricing, nextApproval, nextAccounts, nextTemplates] =
      await Promise.all([
        api.listQuotes(preferencesRef.current.quoteListLimit),
        api.quotesAwaitingMe(),
        api.listProducts(),
        api.listPriceBooks(),
        api.listPricingRules(),
        api.listApprovalRules(),
        api.listAccounts(),
        api.listProposalTemplates(),
      ]);

    setQuotes(nextQuotes);
    setAwaiting(nextAwaiting);
    setProducts(nextProducts);
    setPriceBooks(nextBooks);
    setPricingRules(nextPricing);
    setApprovalRules(nextApproval);
    setAccounts(nextAccounts);
    setTemplates(nextTemplates);
  }, []);

  const loadWorkspace = useCallback(async () => {
    await refresh();

    // A directory is a convenience, not a dependency: an instance that has
    // dropped the hook still works, you just type the address.
    try {
      setDirectory((await api.directory()).users);
    } catch {
      setDirectory([]);
    }

    // The storage line doubles as an outage signal: PocketBase is a separate
    // service, and "unreachable" explains every other error on the page.
    try {
      setMeta(await api.meta());
    } catch {
      setMeta(null);
    }
  }, [refresh]);

  useEffect(() => {
    void api
      .me()
      .then(({ user }) => setMe(user))
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (me) void loadWorkspace().catch(fail);
  }, [me, loadWorkspace, fail]);

  /**
   * Preferences ride along on the session, so they are here before the first
   * paint rather than after a correction.
   */
  useEffect(() => {
    if (me) setPreferences(me.preferences);
  }, [me]);

  /** The theme is a class on <html>; "system" follows the OS, live. */
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = preferences.theme === "dark" || (preferences.theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);

  // A pending save would otherwise fire into a page that is going away.
  useEffect(() => () => clearTimeout(preferenceTimer.current ?? undefined), []);

  /* ---------------------------- preferences ----------------------------- */

  /**
   * Preferences save themselves a beat after the last change. Normalizing here
   * rather than trusting the response keeps the controls from jumping: the
   * server applies the same clamps to the same object and has nothing left to
   * correct.
   */
  const applyPreferences = (next: Preferences) => {
    setPreferences(next);
    setPreferenceSave("saving");
    clearTimeout(preferenceTimer.current ?? undefined);
    preferenceTimer.current = setTimeout(() => {
      void api
        .savePreferences(next)
        .then(() => setPreferenceSave("saved"))
        .catch(error => {
          setPreferenceSave("idle");
          fail(error);
        });
    }, PREFERENCE_SAVE_DELAY_MS);
  };

  const updatePreferences = (patch: Partial<Preferences>) =>
    applyPreferences(normalizePreferences({ ...preferences, ...patch }));

  /** Guards a delete, unless the account has asked not to be asked. */
  const confirmed = (message: string) => !preferences.confirmDestructive || window.confirm(message);

  /* ------------------------------- quotes -------------------------------- */

  const openQuoteById = async (id: string) => {
    setBanner(null);
    try {
      setOpenQuote(await api.getQuote(id));
      setView("quotes");
    } catch (error) {
      fail(error);
    }
  };

  const onQuoteSaved = (quote: Quote) => {
    setOpenQuote(quote);
    void refresh().catch(fail);
  };

  async function signOut() {
    try {
      await api.logout();
    } catch {
      // The cookie is being dropped either way.
    }
    setMe(null);
    setOpenQuote(undefined);
  }

  /* -------------------------------- render ------------------------------- */

  if (me === undefined) {
    return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (me === null) return <AuthPanel onSignedIn={setMe} />;

  const editingQuote = openQuote !== undefined;
  const navCollapsed = preferences.navCollapsed;

  return (
    <div className="paper min-h-screen text-foreground">
      <div className="mx-auto flex max-w-[110rem] flex-col gap-0 lg:flex-row">
        {/* ------------------------------ nav ------------------------------ */}

        <aside
          className={cn(
            "bg-sidebar/70 text-sidebar-foreground shrink-0 border-b backdrop-blur-[2px]",
            "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            "lg:margin-rule lg:flex lg:h-screen lg:flex-col lg:border-r lg:border-b-0",
            // Collapsing is a desktop affordance: on a phone the nav is
            // already a horizontal strip, and there is nothing to reclaim.
            navCollapsed ? "lg:w-16" : "lg:w-56",
          )}
        >
          <div className={cn("flex items-center px-4 py-3.5", navCollapsed && "lg:justify-center lg:px-0")}>
            {navCollapsed ? (
              <span className="group hidden lg:block">
                <BrandMark />
              </span>
            ) : (
              <BrandLockup />
            )}
            {/* Collapsed on a desktop, the lockup still belongs on a phone,
                where the nav is a strip across the top and has the room. */}
            {navCollapsed && <BrandLockup className="lg:hidden" />}
          </div>

          <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible">
            {NAV.map(({ id, label, Icon }) => {
              const active = view === id && !editingQuote;
              const badge = id === "approvals" && awaiting.length > 0 ? awaiting.length : 0;

              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setView(id);
                    setOpenQuote(undefined);
                    setBanner(null);
                  }}
                  // The label is gone when collapsed, so the tooltip and the
                  // accessible name have to carry it instead.
                  title={navCollapsed ? label : undefined}
                  aria-label={label}
                  className={cn(
                    "group relative flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap",
                    "transition-[color,background-color,transform] duration-200",
                    navCollapsed && "lg:justify-center lg:px-0",
                    active
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground motion-safe:hover:translate-x-0.5",
                  )}
                >
                  {/* The page you are on is marked the way a leaf is veined:
                      a stroke drawn down its length, not a filled block. */}
                  {active && (
                    <span
                      aria-hidden="true"
                      className="bg-primary motion-safe:animate-vein absolute top-1.5 bottom-1.5 left-0 w-[3px] origin-top rounded-full"
                    />
                  )}
                  <Icon
                    className={cn(
                      "size-4 shrink-0 transition-transform duration-200",
                      active ? "text-primary" : "motion-safe:group-hover:scale-110",
                    )}
                  />
                  <span className={cn(navCollapsed && "lg:hidden")}>{label}</span>

                  {badge > 0 &&
                    (navCollapsed ? (
                      // Collapsed, the count has nowhere to sit beside the
                      // label, so it becomes a corner dot with the number.
                      <span className="bg-clay motion-safe:animate-ripen absolute top-1 right-1 hidden size-4 items-center justify-center rounded-full text-[10px] font-medium text-white lg:flex">
                        {badge > 9 ? "9+" : badge}
                      </span>
                    ) : (
                      <Badge tone="pending">{badge}</Badge>
                    ))}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto hidden border-t px-2 py-2 lg:block">
            <button
              type="button"
              onClick={() => {
                setView("settings");
                setOpenQuote(undefined);
              }}
              title={navCollapsed ? (me.name || me.email) : undefined}
              aria-label="Settings"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                navCollapsed && "justify-center px-0",
                view === "settings" ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <Settings className="size-4 shrink-0" />
              {!navCollapsed && <span className="min-w-0 flex-1 truncate text-left">{me.name || me.email}</span>}
            </button>

            <button
              type="button"
              onClick={() => void signOut()}
              title={navCollapsed ? "Sign out" : undefined}
              aria-label="Sign out"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60",
                navCollapsed && "justify-center px-0",
              )}
            >
              <LogOut className="size-4 shrink-0" />
              {!navCollapsed && "Sign out"}
            </button>

            <button
              type="button"
              onClick={() => updatePreferences({ navCollapsed: !navCollapsed })}
              title={navCollapsed ? "Expand the navigation" : "Collapse the navigation"}
              aria-label={navCollapsed ? "Expand the navigation" : "Collapse the navigation"}
              aria-expanded={!navCollapsed}
              className={cn(
                "mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60",
                navCollapsed && "justify-center px-0",
              )}
            >
              {navCollapsed ? (
                <PanelLeftOpen className="size-4 shrink-0" />
              ) : (
                <>
                  <PanelLeftClose className="size-4 shrink-0" /> Collapse
                </>
              )}
            </button>
          </div>
        </aside>

        {/* ----------------------------- content --------------------------- */}

        <main className="min-w-0 flex-1 space-y-4 p-4 lg:h-screen lg:overflow-y-auto">
          <div className="flex items-center justify-end gap-2 lg:hidden">
            <Button variant="ghost" size="sm" onClick={() => setView("settings")}>
              <Settings /> {me.email}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut />
            </Button>
          </div>

          {banner && (
            <div className="relative">
              <Notice kind={banner.kind} lines={banner.lines} className="pr-8" />
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-1 right-1"
                onClick={() => setBanner(null)}
                aria-label="Dismiss"
              >
                <X />
              </Button>
            </div>
          )}

          {/*
           * Keyed on what is being shown, so React remounts the whole screen
           * when you move between them and the entrance animation runs again.
           * Without the key the class is applied once, at first paint, and
           * every view after that arrives without ceremony.
           */}
          <div key={editingQuote ? `quote:${openQuote?.id ?? "new"}` : view} className="motion-safe:animate-unfurl">
            {editingQuote ? (
              <QuoteEditor
                quote={openQuote}
                me={me}
                preferences={preferences}
                products={products}
                priceBooks={priceBooks}
                accounts={accounts}
                pricingRules={pricingRules}
                approvalRules={approvalRules}
                templates={templates}
                onSaved={onQuoteSaved}
                onDeleted={() => {
                  setOpenQuote(undefined);
                  void refresh().catch(fail);
                }}
                onBack={() => setOpenQuote(undefined)}
                onShare={(id, title) => setSharing({ kind: "quotes", id, title })}
                onError={fail}
                onNotice={notice}
                confirmed={confirmed}
              />
            ) : view === "quotes" ? (
              <QuoteList
                quotes={quotes}
                preferences={preferences}
                onOpen={id => void openQuoteById(id)}
                onNew={() => setOpenQuote(null)}
              />
            ) : view === "approvals" ? (
              <ApprovalsQueue quotes={awaiting} preferences={preferences} onOpen={id => void openQuoteById(id)} />
            ) : view === "catalog" ? (
              <CatalogView
                products={products}
                priceBooks={priceBooks}
                preferences={preferences}
                myId={me.id}
                onChanged={refresh}
                onShare={(kind, id, title) => setSharing({ kind, id, title })}
                onError={fail}
                onNotice={notice}
                confirmed={confirmed}
              />
            ) : view === "rules" ? (
              <RulesView
                pricingRules={pricingRules}
                approvalRules={approvalRules}
                products={products}
                directory={directory}
                onChanged={refresh}
                onError={fail}
                confirmed={confirmed}
              />
            ) : view === "customers" ? (
              <AccountsView
                accounts={accounts}
                priceBooks={priceBooks}
                preferences={preferences}
                onChanged={refresh}
                onError={fail}
                onOpenQuote={id => void openQuoteById(id)}
                confirmed={confirmed}
              />
            ) : view === "templates" ? (
              <TemplatesView
                templates={templates}
                sellerName={me.name}
                sellerEmail={me.email}
                locale={preferences.locale}
                myId={me.id}
                onChanged={refresh}
                onShare={(kind, id, title) => setSharing({ kind, id, title })}
                onError={fail}
                confirmed={confirmed}
              />
            ) : (
              <SettingsPanel
                me={me}
                preferences={preferences}
                saveState={preferenceSave}
                priceBooks={priceBooks}
                templates={templates}
                meta={meta}
                hasCatalogue={products.length > 0}
                onChange={updatePreferences}
                onReset={() => applyPreferences({ ...DEFAULT_PREFERENCES })}
                onSampleInstalled={refresh}
                onError={fail}
                onNotice={notice}
              />
            )}
          </div>
        </main>
      </div>

      {sharing && (
        <ShareDialog
          kind={sharing.kind}
          id={sharing.id}
          title={sharing.title}
          viewerEmail={me.email}
          directory={directory}
          onClose={() => setSharing(null)}
          onChanged={() => void refresh().catch(fail)}
        />
      )}
    </div>
  );
}
