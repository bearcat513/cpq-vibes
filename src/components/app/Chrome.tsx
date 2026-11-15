/**
 * The frame around every screen: a desktop window on a computer, a phone app
 * on a phone.
 *
 * On a desk (`lg` and up) the app fills the window and never scrolls as a
 * page: a sidebar down the left, a title bar with the breadcrumb and the
 * launcher across the top, a status bar along the foot, and the screen
 * itself as the one region that scrolls — the way a desktop application is
 * laid out, rather than a document that happens to have buttons in it.
 *
 * On a phone the sidebar and both bars go. What replaces them is a slim top
 * bar (where you are, search, your account) and a tab bar along the bottom,
 * within reach of a thumb, holding the four screens a day out of the office
 * is spent in. Everything else is under More.
 */
import { useEffect, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Keyboard, LogOut, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Portal } from "@/components/ui/portal";
import { BrandLockup, BrandMark } from "./Brand";
import type { SaveState } from "./SettingsPanel";
import { DATA_TABLE, MOBILE_TABS, NAV_ORDER, VIEWS, keysFor, type View } from "./navigation";
import type { Meta, SessionUser } from "@/lib/api";
import { shortcutCaps, isMacPlatform } from "@/lib/commands";
import { ROLE_LABELS } from "@/lib/organization";
import { cn } from "@/lib/utils";

/** A shortcut as words, for a tooltip: "Quotes (G Q)". */
const titled = (label: string, keys: string[]) =>
  keys.length ? `${label} (${shortcutCaps(keys, isMacPlatform()).join(" ")})` : label;

const roleLabel = (me: SessionUser) => (me.role ? ROLE_LABELS[me.role] : "");

/* --------------------------------- sidebar -------------------------------- */

export function Sidebar({
  me,
  active,
  collapsed,
  awaitingCount,
  onGo,
  onOpenOrganization,
  onSignOut,
  onToggle,
}: {
  me: SessionUser;
  /** The screen on show, or null while a quote is open over it. */
  active: View | null;
  collapsed: boolean;
  awaitingCount: number;
  onGo: (view: View) => void;
  onOpenOrganization: () => void;
  onSignOut: () => void;
  onToggle: () => void;
}) {
  return (
    <aside
      className={cn(
        "bg-sidebar/70 text-sidebar-foreground rail hidden h-full shrink-0 flex-col border-r backdrop-blur-[2px] select-none lg:flex",
        "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        collapsed ? "w-16" : "w-56",
      )}
    >
      <div className={cn("flex items-center px-4 py-3.5", collapsed && "justify-center px-0")}>
        {collapsed ? (
          <span className="group">
            <BrandMark />
          </span>
        ) : (
          <BrandLockup />
        )}
      </div>

      {/* Which organization everything below belongs to, and as what. */}
      {!collapsed && me.org && (
        <button
          type="button"
          onClick={onOpenOrganization}
          className="mx-2 mb-2 w-[calc(100%-1rem)] rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/60"
          title="Organization settings"
        >
          <span className="block truncate text-sm font-medium">{me.org.name}</span>
          <span className="block text-xs text-muted-foreground">{roleLabel(me)}</span>
        </button>
      )}

      <nav aria-label="Screens" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
        {NAV_ORDER.map(id => {
          const { label, Icon } = VIEWS[id];
          const on = active === id;
          const badge = id === "approvals" ? awaitingCount : 0;

          return (
            <button
              key={id}
              type="button"
              onClick={() => onGo(id)}
              title={titled(label, keysFor(`go:${id}`))}
              aria-label={label}
              aria-current={on ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap",
                "transition-[color,background-color,transform] duration-200",
                collapsed && "justify-center px-0",
                on
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground motion-safe:hover:translate-x-0.5",
              )}
            >
              {/* The page you are on is marked the way a seam is welded:
                  a bead run down its length, not a filled block. */}
              {on && (
                <span
                  aria-hidden="true"
                  className="bg-primary motion-safe:animate-weld absolute top-1.5 bottom-1.5 left-0 w-[3px] origin-top rounded-full"
                />
              )}
              <Icon
                className={cn(
                  "size-4 shrink-0 transition-transform duration-200",
                  on ? "text-primary" : "motion-safe:group-hover:scale-110",
                )}
              />
              {!collapsed && <span>{label}</span>}

              {badge > 0 &&
                (collapsed ? (
                  <span className="bg-alert motion-safe:animate-throb absolute top-1 right-1 flex size-4 items-center justify-center rounded-full text-[10px] font-medium text-white">
                    {badge > 9 ? "9+" : badge}
                  </span>
                ) : (
                  <Badge tone="pending" className="ml-auto">
                    {badge}
                  </Badge>
                ))}
            </button>
          );
        })}

        <a
          href={DATA_TABLE.href}
          target="_blank"
          rel="noopener"
          title={`${DATA_TABLE.label}: ${DATA_TABLE.description} (opens in a new tab)`}
          aria-label={`${DATA_TABLE.label} (opens in a new tab)`}
          className={cn(
            "group mt-auto flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted-foreground",
            "transition-[color,background-color,transform] duration-200 hover:bg-accent/50 hover:text-foreground motion-safe:hover:translate-x-0.5",
            collapsed && "justify-center px-0",
          )}
        >
          <DATA_TABLE.Icon className="size-4 shrink-0 transition-transform duration-200 motion-safe:group-hover:scale-110" />
          {!collapsed && (
            <>
              <span>{DATA_TABLE.label}</span>
              <ExternalLink className="ml-auto size-3 opacity-50" aria-hidden="true" />
            </>
          )}
        </a>
      </nav>

      <div className="border-t px-2 py-2">
        <FootButton
          collapsed={collapsed}
          label={me.name || me.email}
          title={titled("Settings", keysFor("go:settings"))}
          aria-label="Settings"
          on={active === "settings"}
          onClick={() => onGo("settings")}
        >
          <Settings className="size-4 shrink-0" />
        </FootButton>
        <FootButton collapsed={collapsed} label="Sign out" title="Sign out" aria-label="Sign out" onClick={onSignOut}>
          <LogOut className="size-4 shrink-0" />
        </FootButton>
        <FootButton
          collapsed={collapsed}
          label="Collapse"
          title={titled(collapsed ? "Expand the navigation" : "Collapse the navigation", keysFor("toggleNav"))}
          aria-label={collapsed ? "Expand the navigation" : "Collapse the navigation"}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <PanelLeftOpen className="size-4 shrink-0" /> : <PanelLeftClose className="size-4 shrink-0" />}
        </FootButton>
      </div>
    </aside>
  );
}

function FootButton({
  collapsed,
  label,
  on,
  children,
  ...rest
}: {
  collapsed: boolean;
  label: string;
  on?: boolean;
  children: ReactNode;
  title: string;
  onClick: () => void;
  "aria-label": string;
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
        collapsed && "justify-center px-0",
        on ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60",
      )}
    >
      {children}
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
    </button>
  );
}

/* -------------------------------- title bar ------------------------------- */

/** The launcher's button, dressed as the search field it behaves like. */
export function LauncherButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open the launcher"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        "panel flex h-8 items-center gap-2 rounded-md border px-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
        className,
      )}
    >
      <Search className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search or run a command…</span>
      <Kbd keys={keysFor("launcher")} />
    </button>
  );
}

export function TitleBar({
  me,
  crumbs,
  onOpenLauncher,
  onOpenHelp,
}: {
  me: SessionUser;
  /** Where you are, outermost first: ["Quotes", "Q-2026-0007"]. */
  crumbs: string[];
  onOpenLauncher: () => void;
  onOpenHelp: () => void;
}) {
  return (
    <header className="bg-sidebar/40 hidden h-12 shrink-0 items-center gap-4 border-b px-4 backdrop-blur-[2px] select-none lg:flex">
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <span className="truncate text-muted-foreground">{me.org?.name}</span>
        {crumbs.map((crumb, index) => (
          <span key={`${index}-${crumb}`} className="flex min-w-0 items-center gap-1.5">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
            <span className={cn("truncate", index === crumbs.length - 1 ? "font-medium" : "text-muted-foreground")}>
              {crumb}
            </span>
          </span>
        ))}
      </nav>

      <LauncherButton onClick={onOpenLauncher} className="w-80 max-w-[40vw]" />

      <button
        type="button"
        onClick={onOpenHelp}
        title={titled("Keyboard shortcuts", keysFor("help"))}
        aria-label="Keyboard shortcuts"
        className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <Keyboard className="size-4" />
      </button>
    </header>
  );
}

/* -------------------------------- status bar ------------------------------ */

export function StatusBar({
  me,
  meta,
  saveState,
  pendingKeys,
  todayLabel,
  onOpenLauncher,
  onOpenHelp,
}: {
  me: SessionUser;
  meta: Meta | null;
  saveState: SaveState;
  /** The first key of a sequence still waiting for its second. */
  pendingKeys: string[];
  /** Today in the organization's calendar, already formatted. */
  todayLabel: string;
  onOpenLauncher: () => void;
  onOpenHelp: () => void;
}) {
  const connection =
    meta === null
      ? { dot: "bg-muted-foreground/50", text: "Connecting…" }
      : meta.reachable
        ? { dot: "bg-signal", text: "Connected" }
        : { dot: "bg-alert", text: "Database unreachable" };

  return (
    <footer className="bg-sidebar/60 hidden h-7 shrink-0 items-center gap-4 border-t px-3 text-[11px] text-muted-foreground backdrop-blur-[2px] select-none lg:flex">
      <span className="flex items-center gap-1.5" role="status">
        <span className={cn("size-1.5 rounded-full", connection.dot)} aria-hidden="true" />
        {connection.text}
      </span>
      {saveState !== "idle" && <span>{saveState === "saving" ? "Saving preferences…" : "Preferences saved"}</span>}
      {pendingKeys.length > 0 && (
        <span className="flex items-center gap-1 text-foreground" aria-live="polite">
          <Kbd keys={pendingKeys} /> then a letter…
        </span>
      )}

      <span className="ml-auto truncate">
        {me.org?.name} · {roleLabel(me)} · {todayLabel}
        {me.org?.settings.timeZone ? ` (${me.org.settings.timeZone})` : " (UTC)"}
      </span>
      <button type="button" onClick={onOpenLauncher} className="flex items-center gap-1 hover:text-foreground">
        <Kbd keys={keysFor("launcher")} /> Commands
      </button>
      <button type="button" onClick={onOpenHelp} className="flex items-center gap-1 hover:text-foreground">
        <Kbd keys={keysFor("help")} /> Shortcuts
      </button>
    </footer>
  );
}

/* ---------------------------------- phone --------------------------------- */

export function MobileTopBar({
  me,
  title,
  onOpenLauncher,
  onOpenSettings,
}: {
  me: SessionUser;
  title: string;
  onOpenLauncher: () => void;
  onOpenSettings: () => void;
}) {
  const initials = (me.name || me.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]!.toUpperCase())
    .join("");

  return (
    <header className="bg-sidebar/85 sticky top-0 z-30 flex shrink-0 items-center gap-2 border-b px-3 pt-[env(safe-area-inset-top)] backdrop-blur-md select-none lg:hidden">
      <div className="flex h-12 min-w-0 flex-1 items-center gap-2">
        <BrandMark animated={false} className="size-6 shrink-0" />
        <h1 className="truncate font-display text-base font-semibold tracking-tight">{title}</h1>
      </div>
      <button
        type="button"
        onClick={onOpenLauncher}
        aria-label="Search"
        className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <Search className="size-[1.1rem]" />
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Settings"
        className="grid size-8 place-items-center rounded-full border bg-accent text-[11px] font-semibold text-accent-foreground"
      >
        {initials || <Settings className="size-4" />}
      </button>
    </header>
  );
}

export function MobileTabBar({
  active,
  awaitingCount,
  moreOpen,
  onGo,
  onMore,
}: {
  active: View | null;
  awaitingCount: number;
  moreOpen: boolean;
  onGo: (view: View) => void;
  onMore: () => void;
}) {
  const elsewhere = active !== null && !MOBILE_TABS.includes(active);

  return (
    <nav
      aria-label="Screens"
      className="bg-sidebar/90 fixed inset-x-0 bottom-0 z-30 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md select-none lg:hidden"
    >
      <div className="grid grid-cols-5">
        {MOBILE_TABS.map(id => {
          const { label, Icon } = VIEWS[id];
          const on = active === id && !moreOpen;
          const badge = id === "approvals" ? awaitingCount : 0;
          return (
            <TabButton key={id} label={label} on={on} onClick={() => onGo(id)}>
              <span className="relative">
                <Icon className="size-5" />
                {badge > 0 && (
                  <span className="bg-alert absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white">
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </span>
            </TabButton>
          );
        })}
        <TabButton label="More" on={moreOpen || elsewhere} onClick={onMore} aria-haspopup="dialog">
          <MoreHorizontal className="size-5" />
        </TabButton>
      </div>
    </nav>
  );
}

function TabButton({
  label,
  on,
  onClick,
  children,
  ...rest
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  "aria-haspopup"?: "dialog";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? "page" : undefined}
      {...rest}
      className={cn(
        "relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors",
        on ? "text-primary font-medium" : "text-muted-foreground active:text-foreground",
      )}
    >
      {on && <span aria-hidden="true" className="bg-primary absolute top-0 h-0.5 w-8 rounded-full" />}
      {children}
      {label}
    </button>
  );
}

/** Everything the tab bar has no room for, as a sheet rising from the bottom. */
export function MoreSheet({
  me,
  active,
  onGo,
  onOpenOrganization,
  onOpenLauncher,
  onSignOut,
  onClose,
}: {
  me: SessionUser;
  active: View | null;
  onGo: (view: View) => void;
  onOpenOrganization: () => void;
  onOpenLauncher: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const rest: View[] = [...NAV_ORDER.filter(view => !MOBILE_TABS.includes(view)), "settings"];

  return (
    <Portal>
      <div className="fixed inset-0 z-40 lg:hidden">
        <div
          className="animate-in fade-in absolute inset-0 bg-[var(--scrim)] duration-200"
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="More"
          className="panel animate-in slide-in-from-bottom-4 absolute inset-x-0 bottom-0 rounded-t-xl border-t pb-[calc(env(safe-area-inset-bottom)+4.5rem)] shadow-2xl duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]"
        >
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

          {me.org && (
            <button
              type="button"
              onClick={onOpenOrganization}
              className="mx-3 mt-3 flex w-[calc(100%-1.5rem)] items-center justify-between rounded-md border px-3 py-2.5 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{me.org.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {roleLabel(me)} · {me.email}
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          )}

          <div className="grid grid-cols-3 gap-2 p-3">
            {rest.map(id => {
              const { label, Icon } = VIEWS[id];
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onGo(id)}
                  aria-current={active === id ? "page" : undefined}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs",
                    active === id ? "border-primary/50 bg-accent font-medium text-accent-foreground" : "active:bg-accent/60",
                  )}
                >
                  <Icon className={cn("size-5", active === id ? "text-primary" : "text-muted-foreground")} />
                  {label}
                </button>
              );
            })}
            <a
              href={DATA_TABLE.href}
              target="_blank"
              rel="noopener"
              onClick={onClose}
              aria-label={`${DATA_TABLE.label} (opens in a new tab)`}
              className="flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs active:bg-accent/60"
            >
              <DATA_TABLE.Icon className="size-5 text-muted-foreground" />
              {DATA_TABLE.label}
            </a>
          </div>

          <div className="flex gap-2 px-3">
            <button
              type="button"
              onClick={onOpenLauncher}
              className="flex flex-1 items-center justify-center gap-2 rounded-md border py-2.5 text-sm"
            >
              <Search className="size-4" /> Search
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="flex flex-1 items-center justify-center gap-2 rounded-md border py-2.5 text-sm text-muted-foreground"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
