import { useState, type FormEvent } from "react";
import { Check, Copy, Download, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Notice, Section } from "./common";
import { api, type Meta, type SessionUser } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { CURRENCIES, PREFERENCE_LIMITS, THEMES, type Preferences } from "@/lib/preferences";
import type { PriceBook, ProposalTemplate } from "@/lib/types";

export type SaveState = "idle" | "saving" | "saved";

type Props = {
  me: SessionUser;
  preferences: Preferences;
  saveState: SaveState;
  priceBooks: PriceBook[];
  templates: ProposalTemplate[];
  meta: Meta | null;
  hasCatalogue: boolean;
  onChange: (patch: Partial<Preferences>) => void;
  onReset: () => void;
  onSampleInstalled: () => Promise<void>;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
};

/**
 * Preferences, the account's password, and the two things that move data in
 * and out of the workspace.
 *
 * Preferences save themselves a beat after the last change, so there is no
 * Save button for them — a settings page with one is a page people leave
 * without pressing it.
 */
export function SettingsPanel(props: Props) {
  const { me, preferences, priceBooks, templates, meta } = props;
  const [installing, setInstalling] = useState(false);

  const installSample = async () => {
    setInstalling(true);
    try {
      const report = await api.installSample();
      await props.onSampleInstalled();
      const created = Object.entries(report.created)
        .map(([what, count]) => `${count} ${what}`)
        .join(", ");
      props.onNotice([created ? `Installed ${created}.` : "Everything in the sample was already here.", ...report.notes]);
    } catch (error) {
      props.onError(error);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Defaults"
        description="What a new quote starts as. Saved automatically."
        actions={
          <span className="text-xs text-muted-foreground">
            {props.saveState === "saving" ? "Saving…" : props.saveState === "saved" ? "Saved" : ""}
          </span>
        }
      >
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Theme">
            <Select value={preferences.theme} onValueChange={value => props.onChange({ theme: value as Preferences["theme"] })}>
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

          <Field label="Currency">
            <Select
              value={preferences.defaultCurrency}
              onValueChange={value => props.onChange({ defaultCurrency: value as Preferences["defaultCurrency"] })}
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
              onValueChange={value => props.onChange({ defaultPriceBookId: value === "default" ? "" : value })}
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
              onChange={event => props.onChange({ defaultTermMonths: Number(event.target.value) })}
            />
          </Field>

          <Field label="Tax %" hint="A customer's own rate wins over this.">
            <Input
              type="number"
              min={0}
              max={100}
              step="0.25"
              value={preferences.defaultTaxPercent}
              onChange={event => props.onChange({ defaultTaxPercent: Number(event.target.value) })}
            />
          </Field>

          <Field label="Quote valid for (days)">
            <Input
              type="number"
              min={PREFERENCE_LIMITS.validDays.min}
              max={PREFERENCE_LIMITS.validDays.max}
              value={preferences.quoteValidDays}
              onChange={event => props.onChange({ quoteValidDays: Number(event.target.value) })}
            />
          </Field>

          <Field label="Proposal template">
            <Select
              value={preferences.defaultProposalTemplateId || "first"}
              onValueChange={value => props.onChange({ defaultProposalTemplateId: value === "first" ? "" : value })}
            >
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

          <Field label="Quotes listed">
            <Input
              type="number"
              min={PREFERENCE_LIMITS.quoteList.min}
              max={PREFERENCE_LIMITS.quoteList.max}
              value={preferences.quoteListLimit}
              onChange={event => props.onChange({ quoteListLimit: Number(event.target.value) })}
            />
          </Field>

          <Field label="Locale" hint="Empty follows the browser. e.g. en-GB, de-DE.">
            <Input
              value={preferences.locale}
              onChange={event => props.onChange({ locale: event.target.value })}
              placeholder="browser default"
            />
          </Field>

          <Field label="Show cost and margin" hint="Off is the safer default on a shared screen.">
            <div className="flex h-9 items-center">
              <Switch
                checked={preferences.showMargin}
                onChange={event => props.onChange({ showMargin: event.target.checked })}
              />
            </div>
          </Field>

          <Field label="Ask before deleting">
            <div className="flex h-9 items-center">
              <Switch
                checked={preferences.confirmDestructive}
                onChange={event => props.onChange({ confirmDestructive: event.target.checked })}
              />
            </div>
          </Field>
        </div>

        <div className="border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={props.onReset}>
            Reset to defaults
          </Button>
        </div>
      </Section>

      <Section
        title="The worked example"
        description="A catalogue, the policy around it, two customers and a quote that trips the approval ladder."
      >
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Button onClick={() => void installSample()} disabled={installing}>
            {installing ? <Loader2 className="animate-spin" /> : <Sparkles />} Install the sample
          </Button>
          <p className="text-xs text-muted-foreground">
            {props.hasCatalogue
              ? "Additive — anything already here by the same SKU or name is left exactly as it is."
              : "Eight products, two price books, three pricing rules, five approval rules and a sample quote."}
          </p>
        </div>
      </Section>

      <Section title="Your data" description="Everything this account can see, as one file.">
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
                .catch(props.onError)
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
                {meta.quotes ?? 0} quotes · {meta.proposalTemplates ?? 0} templates, in PocketBase at{" "}
                <code>{meta.url}</code>
              </>
            ) : (
              <>PocketBase is unreachable at <code>{meta.url}</code>.</>
            )}
          </p>
        )}
      </Section>

      <PasswordSection email={me.email} onError={props.onError} onNotice={props.onNotice} />
    </div>
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
    <Section title="Account" description={email}>
      <form onSubmit={submit} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
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
        <Button type="submit" disabled={busy || newPassword.length < 8 || !currentPassword}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Change
        </Button>
      </form>
    </Section>
  );
}
