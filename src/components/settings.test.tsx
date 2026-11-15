/**
 * The settings page, rendered a tab at a time.
 *
 * Static markup catches a tab that throws on first paint, a preference that
 * has no control, and a control offered to a role that cannot use it.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessProvider } from "@/components/app/access";
import { SETTINGS_TABS, SettingsPanel, type SettingsTab } from "@/components/app/SettingsPanel";
import type { SessionUser } from "@/lib/api";
import type { Role } from "@/lib/organization";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";

const noop = () => {};

const member = (role: Role): SessionUser => ({
  id: "usr_1",
  email: "fay@example.com",
  name: "Fay",
  verified: true,
  createdAt: "",
  preferences: DEFAULT_PREFERENCES,
  org: { id: "org_1", name: "Acme", settings: { timeZone: "" } },
  role,
  memberships: [],
});

const render = (tab: SettingsTab, role: Role = "admin") =>
  renderToStaticMarkup(
    <AccessProvider me={member(role)}>
      <SettingsPanel
        me={member(role)}
        tab={tab}
        onTabChange={noop}
        preferences={DEFAULT_PREFERENCES}
        saveState="idle"
        priceBooks={[]}
        templates={[]}
        meta={null}
        hasCatalogue={false}
        onChange={noop}
        onReset={noop}
        onSampleInstalled={async () => {}}
        onSessionChanged={async () => {}}
        onSignOutEverywhere={noop}
        confirmed={() => true}
        onError={noop}
        onNotice={noop}
      />
    </AccessProvider>,
  );

describe("the settings page", () => {
  test("is a tab list, with exactly one tab selected and its panel tied to it", () => {
    const html = render("defaults");
    expect(html).toContain('role="tablist"');
    for (const tab of SETTINGS_TABS) expect(html).toContain(`id="settings-tab-${tab.id}"`);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-labelledby="settings-tab-defaults"');
  });

  test("shows only the selected tab's sections", () => {
    const html = render("account");
    expect(html).toContain("Display name");
    expect(html).toContain("Sign out everywhere");
    expect(html).not.toContain("Quotes per page");
    expect(html).not.toContain("Export workspace");
  });

  test("every tab renders", () => {
    for (const tab of SETTINGS_TABS) expect(() => render(tab.id)).not.toThrow();
  });

  test("the newer preferences each have a control", () => {
    expect(render("appearance")).toContain("Motion");
    expect(render("workspace")).toContain("Open on");
    const defaults = render("defaults");
    expect(defaults).toContain("Payment term (days)");
    expect(defaults).toContain("Net 30");
    expect(defaults).toContain("The standing terms a new quote opens with");
  });

  test("the sample installer is an admin's; the export is everyone's", () => {
    expect(render("data", "admin")).toContain("Install the sample");
    const viewer = render("data", "viewer");
    expect(viewer).not.toContain("Install the sample");
    expect(viewer).toContain("Export workspace");
  });
});
