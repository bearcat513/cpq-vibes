import { useEffect, useState, type FormEvent } from "react";
import {
  BookOpen,
  Building2,
  Check,
  Copy,
  Database,
  Download,
  FilePlus2,
  KeyRound,
  Loader2,
  LogOut,
  Palette,
  SlidersHorizontal,
  Sparkles,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabPanel, Tabs, type TabItem } from "@/components/ui/tabs";
import { ApiKeys } from "./ApiKeys";
import { useAccess } from "./access";
import { OrganizationSection } from "./OrganizationSection";
import { Field, FieldAction, Section } from "./common";
import { api, type Meta, type SessionUser } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { isRole, ROLE_LABELS } from "@/lib/organization";
import {
  ACCENTS,
  CURRENCIES,
  FONTS,
  MOTIONS,
  PREFERENCE_LIMITS,
  START_VIEWS,
  THEMES,
  paymentTermsLabel,
  type Preferences,
} from "@/lib/preferences";
import type { SampleSetName } from "@/lib/samples";
import type { PriceBook, ProposalTemplate } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "saving" | "saved";

export type SettingsTab = "account" | "organization" | "appearance" | "workspace" | "defaults" | "data" | "keys";

export const SETTINGS_TABS: TabItem<SettingsTab>[] = [
  { id: "account", label: "Account", icon: <UserRound /> },
  { id: "organization", label: "Organization", icon: <Building2 /> },
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "workspace", label: "Workspace", icon: <SlidersHorizontal /> },
  { id: "defaults", label: "Defaults", icon: <FilePlus2 /> },
  { id: "data", label: "Data", icon: <Database /> },
  { id: "keys", label: "API keys", icon: <KeyRound /> },
];

/** The tabs whose controls save themselves, and so show the save indicator. */
const PREFERENCE_TABS: SettingsTab[] = ["appearance", "workspace", "defaults"];

type Props = {
  me: SessionUser;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  preferences: Preferences;
  saveState: SaveState;
  priceBooks: PriceBook[];
  templates: ProposalTemplate[];
  meta: Meta | null;
  hasCatalogue: boolean;
  onChange: (patch: Partial<Preferences>) => void;
  onReset: () => void;
  onSampleInstalled: () => Promise<void>;
  /** The organization, the role, the membership or the name changed: re-read the session. */
  onSessionChanged: () => Promise<void>;
  /** Ends every session this account has, this one included. */
  onSignOutEverywhere: () => void;
  confirmed: (message: string) => boolean;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
};

/**
 * Settings, a tab at a time: who you are, the organization you work in, how
 * the app looks and behaves, what a new record starts as, the data, and the
 * keys a script signs in with.
 *
 * Preferences save themselves a beat after the last change, so there is no
 * Save button for them — a settings page with one is a page people leave
 * without pressing it. The tabs that hold them say when they have saved.
 */
export function SettingsPanel(props: Props) {
  const { me, preferences, tab } = props;
  const savedLabel = props.saveState === "saving" ? "Saving…" : props.saveState === "saved" ? "Saved" : "";

  return (
    <div className="space-y-4">
      <Tabs
        aria-label="Settings"
        idPrefix="settings"
        items={SETTINGS_TABS}
        value={tab}
        onValueChange={props.onTabChange}
        trailing={
          PREFERENCE_TABS.includes(tab) && savedLabel ? (
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {savedLabel}
            </span>
          ) : undefined
        }
      />

      <TabPanel idPrefix="settings" id={tab} key={tab}>
        {tab === "account" && (
          <>
            <ProfileSection
              me={me}
              onSessionChanged={props.onSessionChanged}
              onError={props.onError}
              onNotice={props.onNotice}
            />
            <PasswordSection email={me.email} onError={props.onError} onNotice={props.onNotice} />
            <SessionsSection confirmed={props.confirmed} onSignOutEverywhere={props.onSignOutEverywhere} />
          </>
        )}

        {tab === "organization" && (
          <OrganizationSection
            me={me}
            onSessionChanged={props.onSessionChanged}
            onError={props.onError}
            onNotice={props.onNotice}
            confirmed={props.confirmed}
          />
        )}

        {tab === "appearance" && <AppearanceSection preferences={preferences} onChange={props.onChange} />}

        {tab === "workspace" && <WorkspaceSection preferences={preferences} onChange={props.onChange} />}

        {tab === "defaults" && (
          <DefaultsSection
            preferences={preferences}
            priceBooks={props.priceBooks}
            templates={props.templates}
            onChange={props.onChange}
            onReset={props.onReset}
            confirmed={props.confirmed}
          />
        )}

        {tab === "data" && (
          <DataSection
            meta={props.meta}
            hasCatalogue={props.hasCatalogue}
            onSampleInstalled={props.onSampleInstalled}
            onError={props.onError}
            onNotice={props.onNotice}
          />
        )}

        {tab === "keys" && (
          // A key is a second way to prove the same thing the password does,
          // and acts with your role in the organization it was issued in.
          <Section
            title="API keys"
            description="A long-lived credential for a script, in place of a session that expires in a week. A key works in the organization it was issued in."
            actions={
              <Button variant="outline" size="sm" asChild>
                <a href="/docs" target="_blank" rel="noreferrer">
                  <BookOpen /> API reference
                </a>
              </Button>
            }
          >
            <ApiKeys confirmDestructive={preferences.confirmDestructive} />
          </Section>
        )}
      </TabPanel>
    </div>
  );
}

/* --------------------------------- account -------------------------------- */

function ProfileSection({
  me,
  onSessionChanged,
  onError,
  onNotice,
}: {
  me: SessionUser;
  onSessionChanged: () => Promise<void>;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
}) {
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(me.name), [me.name]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.updateProfile({ name: name.trim() });
      await onSessionChanged();
      onNotice(["Your name is changed."]);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const where = me.org && isRole(me.role) ? `${ROLE_LABELS[me.role]} in ${me.org.name}.` : undefined;

  return (
    <Section title="Profile" description="How you appear to the people you work with.">
      <form onSubmit={submit} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
        <Field label="Display name" hint="Shown to members, approvers and in the nav. Empty shows your email.">
          <Input value={name} onChange={event => setName(event.target.value)} maxLength={120} autoComplete="name" />
        </Field>
        <Field label="Email" hint={where}>
          <Input value={me.email} readOnly disabled />
        </Field>
        <FieldAction>
          <Button type="submit" variant="outline" disabled={busy || name.trim() === me.name}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
          </Button>
        </FieldAction>
      </form>
    </Section>
  );
}

function PasswordSection({
  email,
  onError,
  onNotice,
}: {
  email: string;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      // PocketBase invalidates every existing token on a password change, so
      // the server hands back a fresh session and nothing here has to reload.
      onNotice(["Password changed. Your session was renewed; anything else signed in as you was signed out."]);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Password" description={email}>
      <form onSubmit={submit} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
        {/* For the password manager: which account this form changes. */}
        <input type="text" name="username" value={email} autoComplete="username" readOnly hidden />
        <Field label="Current password">
          <Input
            type="password"
            value={currentPassword}
            onChange={event => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="New password" hint="At least eight characters.">
          <Input
            type="password"
            value={newPassword}
            onChange={event => setNewPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <FieldAction>
          <Button type="submit" disabled={busy || newPassword.length < 8 || !currentPassword}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Change
          </Button>
        </FieldAction>
      </form>
    </Section>
  );
}

function SessionsSection({
  confirmed,
  onSignOutEverywhere,
}: {
  confirmed: (message: string) => boolean;
  onSignOutEverywhere: () => void;
}) {
  return (
    <Section title="Sessions" description="Signing out ends the session on the server, not just in this browser.">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <Button
          variant="outline"
          onClick={() => {
            if (confirmed("Sign out of every browser and device, this one included? API keys keep working.")) {
              onSignOutEverywhere();
            }
          }}
        >
          <LogOut /> Sign out everywhere
        </Button>
        <p className="text-xs text-muted-foreground">
          For a lost laptop or a shared machine. API keys are revoked one by one, under API keys.
        </p>
      </div>
    </Section>
  );
}

/* ------------------------------- appearance -------------------------------- */

/**
 * The choices that change nothing but the look of the place: light or dark,
 * which of the seven signal colours carries anything live, the face it is all
 * read in, and whether any of it moves.
 *
 * The swatches paint themselves — each carries its own `data-accent`, so the
 * colour on the button is the colour the app will wear, out of the stylesheet
 * rather than out of a second list here that could disagree with it.
 */
function AppearanceSection({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
}) {
  const accent = ACCENTS.find(one => one.id === preferences.accent);
  const font = FONTS.find(one => one.id === preferences.font);

  return (
    <Section title="Appearance" description="How the app looks while you work. Saved automatically, and follows you to any machine.">
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label="Theme" hint="System follows this machine, live.">
          <Select value={preferences.theme} onValueChange={value => onChange({ theme: value as Preferences["theme"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map(theme => (
                <SelectItem key={theme} value={theme}>
                  {theme}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Font" hint={font ? `${font.hint}. Headings stay in the display face.` : undefined}>
          <Select value={preferences.font} onValueChange={value => onChange({ font: value as Preferences["font"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Each option is set in the face it names — the attribute is all
                  the stylesheet needs, portalled menu or not. */}
              {FONTS.map(one => (
                <SelectItem key={one.id} value={one.id} data-font={one.id} className="font-sans">
                  {one.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Accent" hint={accent ? `${accent.label} — seven signal colours. Status colours never change.` : undefined}>
          <div className="flex min-h-9 flex-wrap items-center gap-2">
            {ACCENTS.map(one => {
              const chosen = one.id === preferences.accent;
              return (
                <button
                  key={one.id}
                  type="button"
                  data-accent={one.id}
                  title={one.label}
                  aria-pressed={chosen}
                  onClick={() => onChange({ accent: one.id })}
                  className={cn(
                    "bg-primary ring-primary ring-offset-card flex size-7 items-center justify-center rounded-sm",
                    "border border-black/10 ring-offset-2 dark:border-white/10",
                    "motion-safe:transition-transform motion-safe:duration-200 motion-safe:hover:-translate-y-px",
                    chosen && "ring-2",
                  )}
                >
                  {chosen && <Check className="text-primary-foreground size-3.5" />}
                  <span className="sr-only">{one.label}</span>
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Motion" hint="Reduce turns off every animation on this account, whatever the machine says.">
          <Select value={preferences.motion} onValueChange={value => onChange({ motion: value as Preferences["motion"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MOTIONS.map(one => (
                <SelectItem key={one.id} value={one.id}>
                  {one.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </Section>
  );
}

/* -------------------------------- workspace -------------------------------- */

/** How the locale would print a sum and a date — so a typo shows before it matters. */
function localeSample(locale: string, currency: string): string {
  try {
    const money = new Intl.NumberFormat(locale || undefined, { style: "currency", currency }).format(12345.67);
    const date = new Intl.DateTimeFormat(locale || undefined, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 2, 31)),
    );
    return `${money} · ${date}`;
  } catch {
    return "";
  }
}

function WorkspaceSection({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
}) {
  const sample = localeSample(preferences.locale, preferences.defaultCurrency);

  return (
    <>
      <Section title="Working" description="How the app behaves while you use it. Saved automatically.">
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Open on" hint="The screen you land on after signing in.">
            <Select
              value={preferences.startView}
              onValueChange={value => onChange({ startView: value as Preferences["startView"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {START_VIEWS.map(one => (
                  <SelectItem key={one.id} value={one.id}>
                    {one.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Quotes per page">
            <Input
              type="number"
              min={PREFERENCE_LIMITS.quoteList.min}
              max={PREFERENCE_LIMITS.quoteList.max}
              value={preferences.quoteListLimit}
              onChange={event => onChange({ quoteListLimit: Number(event.target.value) })}
            />
          </Field>

          <Field label="Locale" hint={sample ? `Reads as ${sample}.` : "Empty follows the browser. e.g. en-GB, de-DE."}>
            <Input
              value={preferences.locale}
              onChange={event => onChange({ locale: event.target.value })}
              placeholder="browser default"
            />
          </Field>
        </div>
      </Section>

      <Section title="Switches">
        <div className="divide-y">
          <ToggleRow
            label="Show cost and margin"
            hint="Off is the safer default on a shared screen — margin is the number nobody wants over their shoulder."
            checked={preferences.showMargin}
            onChange={showMargin => onChange({ showMargin })}
          />
          <ToggleRow
            label="Ask before deleting"
            hint="It is the only confirmation there is."
            checked={preferences.confirmDestructive}
            onChange={confirmDestructive => onChange({ confirmDestructive })}
          />
          <ToggleRow
            label="Collapse the navigation"
            hint="Icons only, for more room. The same as the button at the foot of the nav."
            checked={preferences.navCollapsed}
            onChange={navCollapsed => onChange({ navCollapsed })}
          />
          <ToggleRow
            label="Single-key shortcuts"
            hint="G then a letter to go somewhere, N then a letter to start something, ? for the list. Ctrl/⌘ K opens the launcher either way."
            checked={preferences.keyboardShortcuts}
            onChange={keyboardShortcuts => onChange({ keyboardShortcuts })}
          />
        </div>
      </Section>
    </>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onChange={event => onChange(event.target.checked)} aria-label={label} />
    </div>
  );
}

/* --------------------------------- defaults -------------------------------- */

function DefaultsSection({
  preferences,
  priceBooks,
  templates,
  onChange,
  onReset,
  confirmed,
}: {
  preferences: Preferences;
  priceBooks: PriceBook[];
  templates: ProposalTemplate[];
  onChange: (patch: Partial<Preferences>) => void;
  onReset: () => void;
  confirmed: (message: string) => boolean;
}) {
  return (
    <>
      <Section title="A new quote" description="What it starts as. Every value can still be changed on the quote.">
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Currency" hint="A new customer starts in it too.">
            <Select
              value={preferences.defaultCurrency}
              onValueChange={value => onChange({ defaultCurrency: value as Preferences["defaultCurrency"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map(code => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Price book">
            <Select
              value={preferences.defaultPriceBookId || "default"}
              onValueChange={value => onChange({ defaultPriceBookId: value === "default" ? "" : value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Whichever book is marked default</SelectItem>
                {priceBooks.map(book => (
                  <SelectItem key={book.id} value={book.id}>
                    {book.name} ({book.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Term (months)">
            <Input
              type="number"
              min={PREFERENCE_LIMITS.termMonths.min}
              max={PREFERENCE_LIMITS.termMonths.max}
              value={preferences.defaultTermMonths}
              onChange={event => onChange({ defaultTermMonths: Number(event.target.value) })}
            />
          </Field>

          <Field label="Tax %" hint="A customer's own rate wins over this.">
            <Input
              type="number"
              min={PREFERENCE_LIMITS.taxPercent.min}
              max={PREFERENCE_LIMITS.taxPercent.max}
              step="0.25"
              value={preferences.defaultTaxPercent}
              onChange={event => onChange({ defaultTaxPercent: Number(event.target.value) })}
            />
          </Field>

          <Field label="Valid for (days)">
            <Input
              type="number"
              min={PREFERENCE_LIMITS.validDays.min}
              max={PREFERENCE_LIMITS.validDays.max}
              value={preferences.quoteValidDays}
              onChange={event => onChange({ quoteValidDays: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Notes"
            hint="The standing terms a new quote opens with. The customer sees them."
            className="sm:col-span-2 lg:col-span-3"
          >
            <Textarea
              rows={4}
              maxLength={PREFERENCE_LIMITS.quoteNotes.max}
              value={preferences.defaultQuoteNotes}
              onChange={event => onChange({ defaultQuoteNotes: event.target.value })}
              placeholder="e.g. Prices exclude implementation services. Payment due within 30 days of invoice."
            />
          </Field>
        </div>
      </Section>

      <Section title="A new customer">
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Payment term (days)"
            hint={`Reads as "${paymentTermsLabel(preferences.defaultPaymentTermDays)}". An invoice's due date counts from it.`}
          >
            <Input
              type="number"
              min={PREFERENCE_LIMITS.paymentTermDays.min}
              max={PREFERENCE_LIMITS.paymentTermDays.max}
              value={preferences.defaultPaymentTermDays}
              onChange={event => onChange({ defaultPaymentTermDays: Number(event.target.value) })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Documents" description="The template preselected when you render or download one.">
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <TemplateField
            label="Quote template"
            templates={templates.filter(template => template.kind === "quote")}
            value={preferences.defaultProposalTemplateId}
            onChange={defaultProposalTemplateId => onChange({ defaultProposalTemplateId })}
          />
          <TemplateField
            label="Invoice template"
            templates={templates.filter(template => template.kind === "invoice")}
            value={preferences.defaultInvoiceTemplateId}
            onChange={defaultInvoiceTemplateId => onChange({ defaultInvoiceTemplateId })}
          />
        </div>
      </Section>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (confirmed("Reset every preference — appearance and workspace included — to its default?")) onReset();
          }}
        >
          Reset all preferences
        </Button>
      </div>
    </>
  );
}

function TemplateField({
  label,
  templates,
  value,
  onChange,
}: {
  label: string;
  templates: ProposalTemplate[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value || "first"} onValueChange={next => onChange(next === "first" ? "" : next)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="first">The first one</SelectItem>
          {templates.map(template => (
            <SelectItem key={template.id} value={template.id}>
              {template.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/* ----------------------------------- data ---------------------------------- */

function DataSection({
  meta,
  hasCatalogue,
  onSampleInstalled,
  onError,
  onNotice,
}: {
  meta: Meta | null;
  hasCatalogue: boolean;
  onSampleInstalled: () => Promise<void>;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
}) {
  const access = useAccess();
  const [installing, setInstalling] = useState(false);

  const installSample = async (set: SampleSetName) => {
    setInstalling(true);
    try {
      const report = await api.installSample(set);
      await onSampleInstalled();
      const created = Object.entries(report.created)
        .map(([what, count]) => `${count} ${what}`)
        .join(", ");
      onNotice([created ? `Installed ${created}.` : "Everything in the sample was already here.", ...report.notes]);
    } catch (error) {
      onError(error);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <Section title="Your data" description="Everything your organization holds that you can see, as one file.">
        <div className="flex flex-wrap items-center gap-2 p-4">
          <Button variant="outline" asChild>
            <a href={api.workspaceExportUrl}>
              <Download /> Export workspace
            </a>
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void api
                .workspaceExportText()
                .then(copyText)
                .catch(onError)
            }
          >
            <Copy /> Copy
          </Button>
          <Button variant="outline" asChild>
            <a href={api.catalogExportUrl}>
              <Download /> Catalogue only
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={api.productsCsvUrl}>
              <Download /> Products as CSV
            </a>
          </Button>
        </div>
        {meta && (
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            {meta.reachable ? (
              <>
                {meta.products ?? 0} products · {meta.priceBooks ?? 0} price books · {meta.accounts ?? 0} customers ·{" "}
                {meta.quotes ?? 0} quotes · {meta.invoices ?? 0} invoices · {meta.proposalTemplates ?? 0} templates,
                in PocketBase at <code>{meta.url}</code>
              </>
            ) : (
              <>
                PocketBase is unreachable at <code>{meta.url}</code>.
              </>
            )}
          </p>
        )}
      </Section>

      {/* A sample writes every collection at once, so it is an admin's to install. */}
      {access.can("samples.install") && (
        <Section
          title="The worked example"
          description="A catalogue, the policy around it, customers and quotes that trip the approval ladder."
        >
          <div className="flex flex-wrap items-center gap-3 p-4">
            <Button onClick={() => void installSample("nimbus")} disabled={installing}>
              {installing ? <Loader2 className="animate-spin" /> : <Sparkles />} Install the sample
            </Button>
            <Button variant="outline" onClick={() => void installSample("healthcare")} disabled={installing}>
              {installing ? <Loader2 className="animate-spin" /> : <Sparkles />} Install the healthcare sample
            </Button>
            <p className="text-xs text-muted-foreground">
              {hasCatalogue
                ? "Additive — anything already here by the same SKU or name is left exactly as it is."
                : "Software: eight products, a quote and a receivables book. Healthcare: 42 archive products, five price books, seven customers, eight quotes at every stage, a pipeline of leads and opportunities, and five invoices."}
            </p>
          </div>
        </Section>
      )}
    </>
  );
}
