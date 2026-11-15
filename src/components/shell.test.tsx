/**
 * The frame, the home screen and the launcher.
 *
 * Static markup, like the other component tests: enough to catch a piece that
 * throws on first paint, a shortcut table that cannot be typed, and a
 * command offered to a role that would be refused.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessProvider } from "@/components/app/access";
import { MobileTabBar, Sidebar, StatusBar, TitleBar } from "@/components/app/Chrome";
import { Dashboard } from "@/components/app/Dashboard";
import { Launcher } from "@/components/app/Launcher";
import { CREATES, MOBILE_TABS, NAV_ORDER, SHORTCUTS, VIEWS, type View } from "@/components/app/navigation";
import { ShortcutsDialog } from "@/components/app/ShortcutsDialog";
import type { SessionUser } from "@/lib/api";
import type { Role } from "@/lib/organization";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";

const noop = () => {};

const member = (role: Role): SessionUser => ({
  id: "usr_1",
  email: "fay@example.com",
  name: "Fay Adeyemi",
  verified: true,
  createdAt: "",
  preferences: DEFAULT_PREFERENCES,
  org: { id: "org_1", name: "Acme", settings: { timeZone: "" } },
  role,
  memberships: [],
});

describe("the shortcut table", () => {
  test("every binding can be typed: none is the start of another", () => {
    for (const a of SHORTCUTS) {
      for (const b of SHORTCUTS) {
        if (a === b) continue;
        const prefix = b.keys.slice(0, a.keys.length);
        const shadows = a.keys.length < b.keys.length && prefix.every((key, index) => key === a.keys[index]);
        expect(shadows ? `${a.id} shadows ${b.id}` : "").toBe("");
      }
    }
  });

  test("every screen and every kind of record has its own letter", () => {
    const goLetters = Object.values(VIEWS).map(view => view.go);
    expect(new Set(goLetters).size).toBe(goLetters.length);
    const newLetters = Object.values(CREATES).map(create => create.key);
    expect(new Set(newLetters).size).toBe(newLetters.length);
  });

  test("the phone's tabs are screens the sidebar has too", () => {
    for (const tab of MOBILE_TABS) expect(NAV_ORDER).toContain(tab);
  });

  test("the help lists every shortcut there is", () => {
    const html = renderToStaticMarkup(<ShortcutsDialog enabled onEnable={noop} onClose={noop} />);
    for (const view of Object.keys(VIEWS) as View[]) expect(html).toContain(VIEWS[view].label);
    for (const create of Object.values(CREATES)) expect(html).toContain(create.label);
    expect(html).not.toContain("switched off");
  });

  test("and says so when the single-key ones are off", () => {
    expect(renderToStaticMarkup(<ShortcutsDialog enabled={false} onEnable={noop} onClose={noop} />)).toContain(
      "switched off",
    );
  });
});

describe("the frame", () => {
  test("the sidebar marks where you are and counts what waits on you", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        me={member("admin")}
        active="quotes"
        collapsed={false}
        awaitingCount={3}
        onGo={noop}
        onOpenOrganization={noop}
        onSignOut={noop}
        onToggle={noop}
      />,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    for (const view of NAV_ORDER) expect(html).toContain(`aria-label="${VIEWS[view].label}"`);
    expect(html).toContain(">3<");
  });

  test("the title bar carries the breadcrumb and the launcher", () => {
    const html = renderToStaticMarkup(
      <TitleBar me={member("sales")} crumbs={["Quotes", "Q-2026-0007"]} onOpenLauncher={noop} onOpenHelp={noop} />,
    );
    expect(html).toContain("Acme");
    expect(html).toContain("Q-2026-0007");
    expect(html).toContain('aria-label="Open the launcher"');
  });

  test("the status bar says when the database is unreachable", () => {
    const html = renderToStaticMarkup(
      <StatusBar
        me={member("viewer")}
        meta={{ url: "", reachable: false, accounts: null, products: null, priceBooks: null, quotes: null, invoices: null, proposalTemplates: null }}
        saveState="idle"
        pendingKeys={["g"]}
        todayLabel="Fri, Nov 13"
        onOpenLauncher={noop}
        onOpenHelp={noop}
      />,
    );
    expect(html).toContain("Database unreachable");
    expect(html).toContain("then a letter");
  });

  test("the phone's tab bar has the four screens and More, which lights up for the rest", () => {
    const html = renderToStaticMarkup(
      <MobileTabBar active="receivables" awaitingCount={0} moreOpen={false} onGo={noop} onMore={noop} />,
    );
    for (const tab of MOBILE_TABS) expect(html).toContain(VIEWS[tab].label);
    expect(html).toContain("More");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe("the home screen", () => {
  const render = (role: Role) =>
    renderToStaticMarkup(
      <AccessProvider me={member(role)}>
        <Dashboard
          me={member(role)}
          preferences={DEFAULT_PREFERENCES}
          version={0}
          awaiting={[]}
          accounts={[]}
          products={[]}
          templates={[]}
          onOpenQuote={noop}
          onGo={noop}
          onCreate={noop}
          onOpenSettings={noop}
          onError={noop}
        />
      </AccessProvider>,
    );

  test("greets by first name and shows the four figures", () => {
    const html = render("sales");
    expect(html).toContain("Fay");
    expect(html).not.toContain("Adeyemi");
    for (const label of ["Open quotes", "Out with customers", "Waiting on you", "Receivable"]) expect(html).toContain(label);
  });

  test("offers only what the role may start", () => {
    const sales = render("sales");
    expect(sales).toContain("New quote");
    expect(sales).toContain("New customer");
    expect(sales).not.toContain("New invoice");
    expect(sales).not.toContain("New product");

    const viewer = render("viewer");
    expect(viewer).not.toContain("Start something");
  });
});

describe("the launcher", () => {
  test("is a combobox over a listbox, with the commands it was given", () => {
    const html = renderToStaticMarkup(
      <Launcher
        commands={[
          { id: "a", label: "New quote", group: "Start", keys: ["n", "q"], run: noop },
          { id: "b", label: "Go to Home", group: "Go to", run: noop },
        ]}
        accounts={[]}
        products={[]}
        templates={[]}
        locale=""
        onOpenQuote={noop}
        onOpenCustomer={noop}
        onOpenProduct={noop}
        onOpenTemplate={noop}
        onClose={noop}
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-modal="true"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("Start");
    expect(html).toContain("Go to Home");
  });
});
