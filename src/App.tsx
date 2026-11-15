import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Building2,
  Eye,
  EyeOff,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  PanelLeft,
  Sun,
  Wind,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountsView } from "@/components/app/AccountsView";
import { ApprovalsQueue } from "@/components/app/ApprovalsQueue";
import { AuthPanel } from "@/components/app/AuthPanel";
import { CatalogView } from "@/components/app/CatalogView";
import { MobileTabBar, MobileTopBar, MoreSheet, Sidebar, StatusBar, TitleBar } from "@/components/app/Chrome";
import { Notice, type NoticeKind } from "@/components/app/common";
import { Dashboard } from "@/components/app/Dashboard";
import { Launcher, type LauncherCommand } from "@/components/app/Launcher";
import {
  CREATE_ORDER,
  CREATES,
  DATA_TABLE,
  NAV_ORDER,
  SHORTCUTS,
  VIEWS,
  hasModifier,
  keysFor,
  type CreateKind,
  type ShortcutId,
  type View,
  type ViewIntent,
} from "@/components/app/navigation";
import { QuoteEditor } from "@/components/app/QuoteEditor";
import { QuoteList } from "@/components/app/QuoteList";
import { ReceivablesView } from "@/components/app/ReceivablesView";
import { RulesView } from "@/components/app/RulesView";
import { SETTINGS_TABS, SettingsPanel, type SaveState, type SettingsTab } from "@/components/app/SettingsPanel";
import { ShareDialog } from "@/components/app/ShareDialog";
import { ShortcutsDialog } from "@/components/app/ShortcutsDialog";
import { TemplatesView } from "@/components/app/TemplatesView";
import { AccessProvider } from "@/components/app/access";
import { NoOrganization } from "@/components/app/NoOrganization";
import { api, isUnauthorized, type DirectoryUser, type Meta, type Shareable, type SessionUser } from "@/lib/api";
import { setTimeZoneProvider, today } from "@/lib/clock";
import { SequenceMatcher, isTypingTarget, keyToken, SEQUENCE_TIMEOUT_MS } from "@/lib/commands";
import { BROWSABLE_COLLECTIONS, tablePageUrl } from "@/lib/dataTable";
import { can, ROLE_LABELS } from "@/lib/organization";
import { DEFAULT_PREFERENCES, normalizePreferences, type Preferences } from "@/lib/preferences";
import type {
  Account,
  ApprovalRule,
  InvoiceStatus,
  PriceBook,
  PricingRule,
  Product,
  ProposalTemplate,
  Quote,
  QuoteStatus,
  QuoteSummary,
} from "@/lib/types";
import "./index.css";

type Banner = { kind: NoticeKind; lines: string[] } | null;

/** The record whose share list is open, if any. */
type Sharing = { kind: Shareable; id: string; title: string } | null;

/** How long the app sits on a preference change before writing it. */
const PREFERENCE_SAVE_DELAY_MS = 500;

/**
 * Whether a keystroke landed somewhere that owns its own keys: a field, an
 * open menu, a listbox. A bare letter there is typing, not a shortcut.
 */
const keysBelongElsewhere = (element: Element | null) =>
  isTypingTarget(element) || Boolean(element?.closest('[role="listbox"],[role="menu"],[role="combobox"]'));

export function App() {
  // undefined while the session is still being checked, null when signed out.
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);

  const [view, setView] = useState<View>("home");
  /** Which settings tab is open — kept here so the nav can open a particular one. */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  /**
   * What the screen should show on arrival — a record open, a form started,
   * a filter on. The nonce is in the screen's key, so arriving with a new
   * intent remounts it even when it is the screen already on show.
   */
  const [intent, setIntent] = useState<ViewIntent & { nonce: number }>({ nonce: 0 });
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** The first key of a shortcut sequence, while it waits for the second. */
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [banner, setBanner] = useState<Banner>(null);
  const [sharing, setSharing] = useState<Sharing>(null);

  /* Everything this account can see. */
  /** Bumped by every refresh, so the quote list — which pages itself — reads again. */
  const [listVersion, setListVersion] = useState(0);
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
    const [nextAwaiting, nextProducts, nextBooks, nextPricing, nextApproval, nextAccounts, nextTemplates] =
      await Promise.all([
        api.quotesAwaitingMe(),
        api.listProducts(),
        api.listPriceBooks(),
        api.listPricingRules(),
        api.listApprovalRules(),
        api.listAccounts(),
        api.listProposalTemplates(),
      ]);

    setListVersion(version => version + 1);
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

  /**
   * "Today" in this browser is the organization's today — the same day the
   * server prices, dates and ages against — so a due date reads the same at
   * the desk as it does on the record. See src/lib/clock.ts.
   */
  const timeZone = me?.org?.settings.timeZone ?? "";
  useEffect(() => {
    setTimeZoneProvider(() => timeZone || undefined);
  }, [timeZone]);

  // Keyed on the organization, not the whole session: switching reloads
  // everything, while a preference saved on `me` does not.
  const orgId = me?.org?.id ?? "";
  const signedIn = Boolean(me);
  useEffect(() => {
    if (signedIn && orgId) void loadWorkspace().catch(fail);
  }, [signedIn, orgId, loadWorkspace, fail]);

  /**
   * Preferences ride along on the session, so they are here before the first
   * paint rather than after a correction.
   */
  useEffect(() => {
    if (me) setPreferences(me.preferences);
  }, [me]);

  /**
   * The screen the account opens on. Keyed on who is signed in, not on the
   * session object, so re-reading the session (a rename, a switch) leaves you
   * where you were — and changing the preference takes effect next sign-in
   * rather than yanking you off the settings page.
   */
  const myId = me?.id ?? "";
  useEffect(() => {
    if (myId && me) setView(me.preferences.startView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

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

  /**
   * The accent and the reading face are attributes on the same element, which
   * is all styles/globals.css needs: both are a handful of custom properties
   * keyed off `[data-accent]` / `[data-font]`, so changing one re-tints or
   * re-sets the whole app without a re-render.
   */
  useEffect(() => {
    document.documentElement.dataset.accent = preferences.accent;
    document.documentElement.dataset.font = preferences.font;
    document.documentElement.dataset.motion = preferences.motion;
  }, [preferences.accent, preferences.font, preferences.motion]);

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
      setMoreOpen(false);
    } catch (error) {
      fail(error);
    }
  };

  const onQuoteSaved = (quote: Quote) => {
    setOpenQuote(quote);
    void refresh().catch(fail);
  };

  async function signOut(everywhere = false) {
    try {
      await api.logout(everywhere);
    } catch {
      // The cookie is being dropped either way.
    }
    setMe(null);
    setOpenQuote(undefined);
  }

  /**
   * Re-reads the session after the organization changed under it — a switch,
   * a new organization, a role change, leaving — and starts the screen over,
   * since everything on it belonged to the organization before.
   */
  const reloadSession = useCallback(async () => {
    try {
      const { user } = await api.me();
      setOpenQuote(undefined);
      setBanner(null);
      setMe(user);
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  /* ----------------------------- navigation ------------------------------ */

  /** Goes to a screen, closing whatever quote was open over the last one. */
  const go = (next: View, withIntent?: ViewIntent) => {
    setOpenQuote(undefined);
    setBanner(null);
    setMoreOpen(false);
    setView(next);
    setIntent(previous => (withIntent ? { ...withIntent, nonce: previous.nonce + 1 } : { nonce: previous.nonce }));
  };

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    go("settings");
  };

  /** Starts a new record of a kind, on the screen it belongs to. */
  const create = (kind: CreateKind) => {
    if (!me || !can(me.role, CREATES[kind].permission)) return;
    if (kind === "quote") {
      setBanner(null);
      setMoreOpen(false);
      setView("quotes");
      setOpenQuote(null);
      return;
    }
    go(CREATES[kind].view, { create: true });
  };

  const toggleNav = () => updatePreferences({ navCollapsed: !preferences.navCollapsed });

  /* ------------------------------ shortcuts ------------------------------- */

  const runShortcut = (id: ShortcutId) => {
    if (id === "launcher") setLauncherOpen(open => !open);
    else if (id === "search") setLauncherOpen(true);
    else if (id === "help") setHelpOpen(true);
    else if (id === "toggleNav") toggleNav();
    else if (id.startsWith("go:")) go(id.slice(3) as View);
    else if (id.startsWith("new:")) create(id.slice(4) as CreateKind);
  };

  // The handler is registered once; it reads the latest of everything through refs.
  const shortcutRef = useRef(runShortcut);
  shortcutRef.current = runShortcut;
  const launcherOpenRef = useRef(launcherOpen);
  launcherOpenRef.current = launcherOpen;
  const matcher = useMemo(() => new SequenceMatcher(SHORTCUTS), []);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * One listener for every shortcut in the app.
   *
   * It stands down whenever the keys are somebody else's: in a field, in an
   * open menu, and under any modal — a half-filled form in a panel must not
   * be thrown away by a `g` meant as a letter. The launcher's Ctrl/⌘ K is the
   * exception that proves it: it toggles the launcher from anywhere except
   * over another modal, and it is the only shortcut that survives switching
   * the single-key ones off.
   */
  const workspaceReady = Boolean(me?.org);
  useEffect(() => {
    if (!workspaceReady) return;

    const clearPending = () => {
      clearTimeout(pendingTimer.current ?? undefined);
      setPendingKeys([]);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const token = keyToken(event);
      if (!token) return;

      const modal = document.querySelector('[aria-modal="true"]');
      const launcherIsTheModal = launcherOpenRef.current;

      if (token === "mod+k") {
        if (modal && !launcherIsTheModal) return;
        event.preventDefault();
        matcher.reset();
        clearPending();
        shortcutRef.current("launcher");
        return;
      }

      if (modal || event.metaKey || event.ctrlKey || !preferencesRef.current.keyboardShortcuts) return;
      if (keysBelongElsewhere(document.activeElement)) {
        matcher.reset();
        clearPending();
        return;
      }

      const result = matcher.feed(token, event.timeStamp || performance.now());
      if (result.kind === "pending") {
        event.preventDefault();
        setPendingKeys(result.prefix);
        clearTimeout(pendingTimer.current ?? undefined);
        pendingTimer.current = setTimeout(() => {
          matcher.reset();
          setPendingKeys([]);
        }, SEQUENCE_TIMEOUT_MS);
        return;
      }
      clearPending();
      if (result.kind === "match" && !hasModifier(result.id)) {
        event.preventDefault();
        shortcutRef.current(result.id);
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(pendingTimer.current ?? undefined);
    };
  }, [workspaceReady, matcher]);

  // A phone rotated to a desk-sized window should not keep a phone's sheet open.
  useEffect(() => {
    if (!moreOpen) return;
    const desk = window.matchMedia("(min-width: 64rem)");
    const close = () => desk.matches && setMoreOpen(false);
    desk.addEventListener("change", close);
    return () => desk.removeEventListener("change", close);
  }, [moreOpen]);

  /* -------------------------------- render ------------------------------- */

  if (me === undefined) {
    return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (me === null) return <AuthPanel onSignedIn={setMe} />;

  // Between organizations — removed from the last one, say — there is nothing
  // to show and nothing to write to, so the one thing on offer is somewhere to work.
  if (!me.org) {
    return <NoOrganization me={me} onReady={reloadSession} onSignOut={() => void signOut()} onError={fail} />;
  }

  const editingQuote = openQuote !== undefined;
  const navCollapsed = preferences.navCollapsed;
  /** The screen the chrome marks as current; none while a quote is open over it. */
  const active: View | null = editingQuote ? null : view;
  const quoteCrumb = openQuote ? openQuote.number || openQuote.name : "New quote";
  const crumbs = editingQuote ? [VIEWS.quotes.label, quoteCrumb] : [VIEWS[view].label];
  const todayLabel = new Date(`${today()}T00:00:00`).toLocaleDateString(preferences.locale || undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  /* ------------------------------- commands ------------------------------ */

  const commands: LauncherCommand[] = [
    ...CREATE_ORDER.filter(kind => can(me.role, CREATES[kind].permission)).map(kind => ({
      id: `new:${kind}`,
      label: CREATES[kind].label,
      group: "Start",
      Icon: CREATES[kind].Icon,
      keywords: `create add ${kind}`,
      keys: keysFor(`new:${kind}`),
      run: () => create(kind),
    })),
    ...[...NAV_ORDER, "settings" as const].map(id => ({
      id: `go:${id}`,
      label: `Go to ${VIEWS[id].label}`,
      group: "Go to",
      Icon: VIEWS[id].Icon,
      keywords: `${VIEWS[id].description} open view screen`,
      keys: keysFor(`go:${id}`),
      run: () => go(id),
    })),
    ...SETTINGS_TABS.map(tab => ({
      id: `settings:${tab.id}`,
      label: `Settings: ${tab.label}`,
      group: "Settings",
      Icon: VIEWS.settings.Icon,
      keywords: "preferences options configure",
      run: () => openSettings(tab.id),
    })),
    ...(["light", "dark", "system"] as const)
      .filter(theme => theme !== preferences.theme)
      .map(theme => ({
        id: `theme:${theme}`,
        label: theme === "system" ? "Follow the system theme" : `Use the ${theme} theme`,
        group: "Preferences",
        Icon: theme === "light" ? Sun : theme === "dark" ? Moon : Monitor,
        keywords: "appearance theme mode colour color",
        run: () => updatePreferences({ theme }),
      })),
    {
      id: "margin",
      label: preferences.showMargin ? "Hide cost and margin" : "Show cost and margin",
      group: "Preferences",
      Icon: preferences.showMargin ? EyeOff : Eye,
      keywords: "margin cost profit screen share",
      run: () => updatePreferences({ showMargin: !preferences.showMargin }),
    },
    {
      id: "nav",
      label: navCollapsed ? "Expand the navigation" : "Collapse the navigation",
      group: "Preferences",
      Icon: PanelLeft,
      keywords: "sidebar menu",
      keys: keysFor("toggleNav"),
      run: toggleNav,
    },
    {
      id: "motion",
      label: preferences.motion === "reduced" ? "Allow motion" : "Reduce motion",
      group: "Preferences",
      Icon: Wind,
      keywords: "animation accessibility",
      run: () => updatePreferences({ motion: preferences.motion === "reduced" ? "system" : "reduced" }),
    },
    ...me.memberships
      .filter(membership => membership.org.id !== me.org?.id)
      .map(membership => ({
        id: `switch:${membership.org.id}`,
        label: `Switch to ${membership.org.name}`,
        group: "Organization",
        Icon: Building2,
        keywords: `organization workspace ${ROLE_LABELS[membership.role]}`,
        run: () =>
          void api
            .switchOrg(membership.org.id)
            .then(reloadSession)
            .catch(fail),
      })),
    // The record browser is its own page, so these open a tab rather than
    // leaving this one — a quote half-edited here would not survive the trip.
    {
      id: "table",
      label: `Open the ${DATA_TABLE.label.toLowerCase()}`,
      group: "Data",
      Icon: DATA_TABLE.Icon,
      keywords: "table records collection filter query browse database pocketbase",
      run: () => window.open(DATA_TABLE.href, "_blank", "noopener"),
    },
    ...BROWSABLE_COLLECTIONS.map(collection => ({
      id: `table:${collection}`,
      label: `Browse ${collection.replace(/_/g, " ")}`,
      group: "Data",
      Icon: DATA_TABLE.Icon,
      keywords: `table records ${collection} filter query`,
      searchOnly: true,
      run: () => window.open(tablePageUrl(collection), "_blank", "noopener"),
    })),
    {
      id: "help",
      label: "Keyboard shortcuts",
      group: "Help",
      Icon: Keyboard,
      keywords: "keys hotkeys bindings",
      keys: keysFor("help"),
      run: () => setHelpOpen(true),
    },
    {
      id: "docs",
      label: "Open the API reference",
      group: "Help",
      Icon: BookOpen,
      keywords: "docs openapi rest developer",
      run: () => window.open("/docs", "_blank", "noopener"),
    },
    {
      id: "signout",
      label: "Sign out",
      group: "Help",
      Icon: LogOut,
      keywords: "log out logout leave",
      run: () => void signOut(),
    },
  ];

  /* -------------------------------- screen ------------------------------- */

  const screen = editingQuote ? (
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
      onOpenQuote={id => void openQuoteById(id)}
      onError={fail}
      onNotice={notice}
      confirmed={confirmed}
    />
  ) : view === "home" ? (
    <Dashboard
      me={me}
      preferences={preferences}
      version={listVersion}
      awaiting={awaiting}
      accounts={accounts}
      products={products}
      templates={templates}
      onOpenQuote={id => void openQuoteById(id)}
      onGo={go}
      onCreate={create}
      onOpenSettings={openSettings}
      onError={fail}
    />
  ) : view === "quotes" ? (
    <QuoteList
      version={listVersion}
      preferences={preferences}
      initialStatus={intent.status as QuoteStatus | undefined}
      onOpen={id => void openQuoteById(id)}
      onNew={() => create("quote")}
      onError={fail}
    />
  ) : view === "approvals" ? (
    <ApprovalsQueue quotes={awaiting} preferences={preferences} onOpen={id => void openQuoteById(id)} />
  ) : view === "receivables" ? (
    <ReceivablesView
      accounts={accounts}
      templates={templates}
      preferences={preferences}
      initialCreate={intent.create}
      initialStatus={intent.status as InvoiceStatus | undefined}
      onError={fail}
      onNotice={notice}
      confirmed={confirmed}
    />
  ) : view === "catalog" ? (
    <CatalogView
      products={products}
      priceBooks={priceBooks}
      preferences={preferences}
      initialCreate={intent.create}
      initialProductId={intent.openId}
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
      initialCreate={intent.create}
      initialOpenId={intent.openId}
      onChanged={refresh}
      onError={fail}
      onOpenQuote={id => void openQuoteById(id)}
      onOpenReceivables={() => go("receivables")}
      confirmed={confirmed}
    />
  ) : view === "templates" ? (
    <TemplatesView
      templates={templates}
      sellerName={me.name}
      sellerEmail={me.email}
      locale={preferences.locale}
      initialId={intent.openId}
      onChanged={refresh}
      onShare={(kind, id, title) => setSharing({ kind, id, title })}
      onError={fail}
      confirmed={confirmed}
    />
  ) : (
    <SettingsPanel
      me={me}
      tab={settingsTab}
      onTabChange={setSettingsTab}
      preferences={preferences}
      saveState={preferenceSave}
      priceBooks={priceBooks}
      templates={templates}
      meta={meta}
      hasCatalogue={products.length > 0}
      onChange={updatePreferences}
      onReset={() => applyPreferences({ ...DEFAULT_PREFERENCES })}
      onSampleInstalled={refresh}
      onSessionChanged={reloadSession}
      onSignOutEverywhere={() => void signOut(true)}
      confirmed={confirmed}
      onError={fail}
      onNotice={notice}
    />
  );

  return (
    <AccessProvider me={me}>
      {/*
       * A phone scrolls the page, so its browser can fold the address bar
       * away; a desk holds the window still and scrolls only the screen, the
       * way a desktop application does.
       */}
      <div className="slab min-h-dvh text-foreground lg:flex lg:h-dvh lg:overflow-hidden">
        <Sidebar
          me={me}
          active={active}
          collapsed={navCollapsed}
          awaitingCount={awaiting.length}
          onGo={id => go(id)}
          onOpenOrganization={() => openSettings("organization")}
          onSignOut={() => void signOut()}
          onToggle={toggleNav}
        />

        <div className="flex min-w-0 flex-1 flex-col lg:h-full">
          <MobileTopBar
            me={me}
            title={editingQuote ? quoteCrumb : VIEWS[view].label}
            onOpenLauncher={() => setLauncherOpen(true)}
            onOpenSettings={() => go("settings")}
          />
          <TitleBar
            me={me}
            crumbs={crumbs}
            onOpenLauncher={() => setLauncherOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
          />

          <main
            id="main"
            className="min-w-0 flex-1 space-y-4 p-3 pb-[calc(env(safe-area-inset-bottom)+5rem)] sm:p-4 sm:pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:overflow-y-auto lg:overscroll-contain lg:p-5"
          >
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
             * when you move between them and the entrance animation runs again —
             * and keyed on the intent too, so arriving with one ("open this
             * customer") starts the screen over even if it was already on show.
             */}
            <div
              key={editingQuote ? `quote:${openQuote?.id ?? "new"}` : `${view}:${intent.nonce}`}
              className="motion-safe:animate-extend"
            >
              {screen}
            </div>
          </main>

          <StatusBar
            me={me}
            meta={meta}
            saveState={preferenceSave}
            pendingKeys={pendingKeys}
            todayLabel={todayLabel}
            onOpenLauncher={() => setLauncherOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
          />
        </div>

        <MobileTabBar
          active={active}
          awaitingCount={awaiting.length}
          moreOpen={moreOpen}
          onGo={id => go(id)}
          onMore={() => setMoreOpen(open => !open)}
        />
      </div>

      {moreOpen && (
        <MoreSheet
          me={me}
          active={active}
          onGo={id => go(id)}
          onOpenOrganization={() => openSettings("organization")}
          onOpenLauncher={() => {
            setMoreOpen(false);
            setLauncherOpen(true);
          }}
          onSignOut={() => void signOut()}
          onClose={() => setMoreOpen(false)}
        />
      )}

      {launcherOpen && (
        <Launcher
          commands={commands}
          accounts={accounts}
          products={products}
          templates={templates}
          locale={preferences.locale}
          onOpenQuote={id => void openQuoteById(id)}
          onOpenCustomer={id => go("customers", { openId: id })}
          onOpenProduct={id => go("catalog", { openId: id })}
          onOpenTemplate={id => go("templates", { openId: id })}
          onClose={() => setLauncherOpen(false)}
        />
      )}

      {helpOpen && (
        <ShortcutsDialog
          enabled={preferences.keyboardShortcuts}
          onEnable={() => updatePreferences({ keyboardShortcuts: true })}
          onClose={() => setHelpOpen(false)}
        />
      )}

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
    </AccessProvider>
  );
}
