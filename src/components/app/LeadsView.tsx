import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Building2, Check, Loader2, Plus, Search, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Field, FilterChip, formatters, LeadStatusBadge, Notice, Section } from "./common";
import { useAccess } from "./access";
import { api, type LeadConversion } from "@/lib/api";
import { addDaysTo, today } from "@/lib/clock";
import {
  DEFAULT_CLOSE_DAYS,
  EDITABLE_LEAD_STATUSES,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  OPEN_STAGES,
  OPPORTUNITY_STAGE_LABELS,
  defaultOpportunityName,
  filterLeads,
  isConverted,
  leadAccountName,
  type Lead,
  type LeadSource,
  type LeadStatus,
  type OpportunityStage,
} from "@/lib/pipeline";
import type { Preferences } from "@/lib/preferences";
import { CURRENCIES, type Account, type CurrencyCode } from "@/lib/types";
import type { LeadInput } from "@/lib/validate";

type Props = {
  accounts: Account[];
  preferences: Preferences;
  /** Reloads the app's accounts — a conversion may have made one. */
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
  onOpenCustomer: (id: string) => void;
  onOpenOpportunity: (id: string) => void;
  confirmed: (message: string) => boolean;
  initialCreate?: boolean;
  initialOpenId?: string;
};

/**
 * Leads: people who might buy, before anybody has made them a customer.
 *
 * Working one ends in *Convert*, which makes the customer (or picks one that
 * exists), adds the person to it, and opens an opportunity — then takes you
 * there, since that is where the work goes next. A converted lead stays in the
 * list as history, read-only, pointing at what it became.
 */
export function LeadsView({
  accounts,
  preferences,
  onChanged,
  onError,
  onOpenCustomer,
  onOpenOpportunity,
  confirmed,
  initialCreate,
  initialOpenId,
}: Props) {
  const access = useAccess();
  const canWrite = access.can("leads.write");

  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LeadStatus | "">("");
  /** The lead in the editor: one being edited, null for a new one, undefined for none. */
  const [editing, setEditing] = useState<Lead | null | undefined>(initialCreate && canWrite ? null : undefined);
  const [converting, setConverting] = useState<Lead | null>(null);
  const [openId] = useState(initialOpenId);

  const load = async () => {
    try {
      const all = await api.listLeads();
      setLeads(all);
      return all;
    } catch (error) {
      onError(error);
      return [];
    }
  };

  useEffect(() => {
    void load().then(all => {
      const arriving = openId ? all.find(lead => lead.id === openId) : undefined;
      if (arriving) setEditing(arriving);
    });
    // Read once on arrival; every change below reloads explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all = leads ?? [];
  const counts = useMemo(() => {
    const tally = new Map<LeadStatus, number>();
    for (const lead of all) tally.set(lead.status, (tally.get(lead.status) ?? 0) + 1);
    return tally;
  }, [all]);
  const visible = useMemo(() => filterLeads(all, { search, status }), [all, search, status]);
  const format = formatters(preferences.defaultCurrency, preferences.locale);

  const remove = async (lead: Lead) => {
    const what = isConverted(lead) ? " The customer and opportunity it became are kept." : "";
    if (!confirmed(`Delete the lead for ${lead.name || lead.company}?${what}`)) return;
    try {
      await api.deleteLead(lead.id);
      setEditing(undefined);
      await load();
    } catch (error) {
      onError(error);
    }
  };

  const converted = async (result: LeadConversion) => {
    setConverting(null);
    setEditing(undefined);
    await Promise.all([load(), onChanged()]);
    if (result.opportunity) onOpenOpportunity(result.opportunity.id);
    else onOpenCustomer(result.account.id);
  };

  return (
    <>
      <Section
        title="Leads"
        description={
          leads === null
            ? "Loading…"
            : visible.length === all.length
              ? `${all.length} lead${all.length === 1 ? "" : "s"}`
              : `${visible.length} of ${all.length}`
        }
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search"
                aria-label="Search leads"
                className="h-8 w-44 pl-8"
              />
            </div>
            {canWrite && (
              <Button size="sm" onClick={() => setEditing(null)}>
                <Plus /> New lead
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
          <FilterChip label="All" count={all.length} on={status === ""} onClick={() => setStatus("")} />
          {LEAD_STATUSES.map(candidate => (
            <FilterChip
              key={candidate}
              label={LEAD_STATUS_LABELS[candidate]}
              count={counts.get(candidate) ?? 0}
              on={status === candidate}
              onClick={() => setStatus(candidate)}
            />
          ))}
        </div>

        {leads === null ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title={all.length ? "Nothing matches" : "No leads yet"}>
            {all.length
              ? "Try a different search, or clear the status filter."
              : "Anybody who might buy goes here first. Convert one when it is worth a customer record and a deal."}
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Lead</Th>
                <Th>Contact</Th>
                <Th>Source</Th>
                <Th numeric>Estimate</Th>
                <Th>Added</Th>
                <Th className="w-28" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {visible.map(lead => (
                <Tr
                  key={lead.id}
                  onClick={() => setEditing(lead)}
                  className="cursor-pointer"
                  tabIndex={0}
                  onKeyDown={event => event.key === "Enter" && setEditing(lead)}
                >
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{lead.name || lead.company}</span>
                      <LeadStatusBadge status={lead.status} />
                    </div>
                    {lead.name && lead.company && (
                      <p className="text-xs text-muted-foreground">
                        {lead.title ? `${lead.title}, ` : ""}
                        {lead.company}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <span className="block text-sm">{lead.email || "—"}</span>
                    {lead.phone && <span className="text-xs text-muted-foreground">{lead.phone}</span>}
                  </Td>
                  <Td className="text-muted-foreground">{LEAD_SOURCE_LABELS[lead.source]}</Td>
                  <Td numeric className="text-muted-foreground">
                    {lead.estimatedAmount ? format.money(lead.estimatedAmount, lead.currency) : "—"}
                  </Td>
                  <Td className="text-muted-foreground">{format.date(lead.createdAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-0.5">
                      {canWrite && !isConverted(lead) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={event => {
                            event.stopPropagation();
                            setConverting(lead);
                          }}
                          aria-label={`Convert ${lead.name || lead.company}`}
                        >
                          <Wand2 /> Convert
                        </Button>
                      )}
                      {isConverted(lead) && lead.convertedOpportunityId && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={event => {
                            event.stopPropagation();
                            onOpenOpportunity(lead.convertedOpportunityId);
                          }}
                          aria-label="Open the opportunity it became"
                        >
                          <ArrowRight />
                        </Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      {editing !== undefined && (
        <LeadEditor
          lead={editing}
          accounts={accounts}
          preferences={preferences}
          canWrite={canWrite}
          onSave={async input => {
            if (editing) await api.updateLead(editing.id, input);
            else await api.createLead(input);
            await load();
            setEditing(undefined);
          }}
          onConvert={() => editing && setConverting(editing)}
          onDelete={() => editing && void remove(editing)}
          onOpenCustomer={onOpenCustomer}
          onOpenOpportunity={onOpenOpportunity}
          onClose={() => setEditing(undefined)}
        />
      )}

      {converting && (
        <ConvertLeadSheet
          lead={converting}
          accounts={accounts}
          onConverted={result => void converted(result)}
          onClose={() => setConverting(null)}
        />
      )}
    </>
  );
}

/* --------------------------------- editing -------------------------------- */

const blankLead = (currency: CurrencyCode): LeadInput => ({
  name: "",
  company: "",
  title: "",
  email: "",
  phone: "",
  website: "",
  industry: "",
  source: "web",
  status: "new",
  estimatedAmount: 0,
  currency,
  notes: "",
});

function LeadEditor({
  lead,
  accounts,
  preferences,
  canWrite,
  onSave,
  onConvert,
  onDelete,
  onOpenCustomer,
  onOpenOpportunity,
  onClose,
}: {
  lead: Lead | null;
  accounts: Account[];
  preferences: Preferences;
  canWrite: boolean;
  onSave: (input: LeadInput) => Promise<void>;
  onConvert: () => void;
  onDelete: () => void;
  onOpenCustomer: (id: string) => void;
  onOpenOpportunity: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<LeadInput>(() => {
    if (!lead) return blankLead(preferences.defaultCurrency);
    const { id, ownerId, orgId, createdAt, updatedAt, convertedAt, convertedAccountId, convertedContactId, convertedOpportunityId, ...rest } = lead;
    return { ...rest };
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const locked = !canWrite || (lead !== null && isConverted(lead));
  const patch = (changes: Partial<LeadInput>) => setDraft(current => ({ ...current, ...changes }));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this lead.");
    } finally {
      setBusy(false);
    }
  };

  const becameAccount = lead?.convertedAccountId ? accounts.find(account => account.id === lead.convertedAccountId) : undefined;

  return (
    <Sheet
      title={lead ? lead.name || lead.company : "New lead"}
      description={lead && isConverted(lead) ? "Converted — kept as history, and no longer editable." : undefined}
      onClose={onClose}
      footer={
        <>
          {lead && canWrite && (
            <Button variant="ghost" onClick={onDelete} className="mr-auto" aria-label="Delete this lead">
              <Trash2 className="text-muted-foreground" />
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {locked ? "Close" : "Cancel"}
          </Button>
          {lead && !locked && (
            <Button variant="outline" onClick={onConvert}>
              <Wand2 /> Convert
            </Button>
          )}
          {!locked && (
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {lead && isConverted(lead) && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
            <p>
              Converted {lead.convertedAt ? `on ${formatters(lead.currency, preferences.locale).date(lead.convertedAt)}` : ""}.
            </p>
            <div className="flex flex-wrap gap-2">
              {lead.convertedAccountId && (
                <Button variant="outline" size="sm" onClick={() => onOpenCustomer(lead.convertedAccountId)}>
                  <Building2 /> {becameAccount?.name ?? "Customer"}
                </Button>
              )}
              {lead.convertedOpportunityId && (
                <Button variant="outline" size="sm" onClick={() => onOpenOpportunity(lead.convertedOpportunityId)}>
                  <ArrowRight /> Opportunity
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Name" hint="The person. A lead needs a name or a company.">
            <Input value={draft.name} onChange={event => patch({ name: event.target.value })} disabled={locked} autoFocus={!lead} />
          </Field>
          <Field label="Company">
            <Input value={draft.company} onChange={event => patch({ company: event.target.value })} disabled={locked} />
          </Field>
          <Field label="Title">
            <Input value={draft.title} onChange={event => patch({ title: event.target.value })} disabled={locked} />
          </Field>
          <Field label="Status">
            <Select value={draft.status} onValueChange={value => patch({ status: value as LeadStatus })} disabled={locked}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(locked && lead ? [lead.status] : EDITABLE_LEAD_STATUSES).map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    {LEAD_STATUS_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Email">
            <Input type="email" value={draft.email} onChange={event => patch({ email: event.target.value })} disabled={locked} />
          </Field>
          <Field label="Phone">
            <Input value={draft.phone} onChange={event => patch({ phone: event.target.value })} disabled={locked} />
          </Field>
          <Field label="Website">
            <Input value={draft.website} onChange={event => patch({ website: event.target.value })} disabled={locked} />
          </Field>
          <Field label="Industry">
            <Input value={draft.industry} onChange={event => patch({ industry: event.target.value })} disabled={locked} />
          </Field>
          <Field label="Source">
            <Select value={draft.source} onValueChange={value => patch({ source: value as LeadSource })} disabled={locked}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAD_SOURCES.map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    {LEAD_SOURCE_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label="Estimated value" hint="Seeds the opportunity's amount when converted.">
              <Input
                type="number"
                min={0}
                value={draft.estimatedAmount || ""}
                onChange={event => patch({ estimatedAmount: Number(event.target.value) || 0 })}
                disabled={locked}
              />
            </Field>
            <Field label="Currency">
              <Select value={draft.currency} onValueChange={value => patch({ currency: value as CurrencyCode })} disabled={locked}>
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
          </div>
        </div>

        <Field label="Notes">
          <Textarea value={draft.notes} onChange={event => patch({ notes: event.target.value })} rows={4} disabled={locked} />
        </Field>

        {error && <Notice kind="error" lines={[error]} />}
      </div>
    </Sheet>
  );
}

/* -------------------------------- converting ------------------------------ */

/**
 * What converting will make, before it makes it. Offers the customer whose
 * name matches the lead's company, if there is one — converting a second
 * contact at a customer you already have is the common case, and a duplicate
 * account is the mistake it would otherwise invite.
 */
function ConvertLeadSheet({
  lead,
  accounts,
  onConverted,
  onClose,
}: {
  lead: Lead;
  accounts: Account[];
  onConverted: (result: LeadConversion) => void;
  onClose: () => void;
}) {
  const match = useMemo(() => {
    const name = leadAccountName(lead).toLowerCase();
    return accounts.find(account => account.name.trim().toLowerCase() === name);
  }, [accounts, lead]);

  const [useExisting, setUseExisting] = useState(Boolean(match));
  const [accountId, setAccountId] = useState(match?.id ?? "");
  const [addContact, setAddContact] = useState(true);
  const [createOpportunity, setCreateOpportunity] = useState(true);
  const [name, setName] = useState("");
  /** What was typed; null until something is, so the lead's estimate shows only where it applies. */
  const [typedAmount, setTypedAmount] = useState<string | null>(null);
  const [closeDate, setCloseDate] = useState(() => addDaysTo(today(), DEFAULT_CLOSE_DAYS));
  const [stage, setStage] = useState<OpportunityStage>("qualification");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const existing = useExisting ? accounts.find(account => account.id === accountId) : undefined;
  const customerName = existing?.name ?? leadAccountName(lead);
  const currencyMismatch = existing && lead.estimatedAmount > 0 && existing.currency !== lead.currency;
  // Never carried across currencies: the server would refuse to, and so does the form.
  const amount = typedAmount ?? (lead.estimatedAmount && !currencyMismatch ? String(lead.estimatedAmount) : "");

  const convert = async () => {
    if (useExisting && !accountId) {
      setError("Pick the customer to convert onto, or create a new one.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onConverted(
        await api.convertLead(lead.id, {
          accountId: useExisting ? accountId : null,
          addContact,
          createOpportunity,
          opportunity: { name: name.trim(), amount: Number(amount) || 0, closeDate, stage },
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not convert this lead.");
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Convert ${lead.name || lead.company}`}
      description="Makes a customer and a deal out of this lead, all at once. The lead is kept, read-only, as history."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void convert()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Convert
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">Customer</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Customer">
            <Button
              variant={useExisting ? "outline" : "default"}
              size="sm"
              role="radio"
              aria-checked={!useExisting}
              onClick={() => setUseExisting(false)}
            >
              <Plus /> New: {leadAccountName(lead)}
            </Button>
            <Button
              variant={useExisting ? "default" : "outline"}
              size="sm"
              role="radio"
              aria-checked={useExisting}
              onClick={() => setUseExisting(true)}
              disabled={accounts.length === 0}
            >
              <Building2 /> An existing customer
            </Button>
          </div>

          {useExisting && (
            <>
              <Field label="Convert onto" hint={match && accountId === match.id ? "Matches the lead's company." : undefined}>
                <Combobox
                  value={accountId}
                  onChange={setAccountId}
                  options={accounts.map(account => ({ value: account.id, label: account.name, hint: account.industry || undefined }))}
                  placeholder="Pick a customer"
                  aria-label="Customer to convert onto"
                />
              </Field>
              {lead.name && (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span>Add {lead.name} as a contact there</span>
                  <Switch checked={addContact} onChange={event => setAddContact(event.target.checked)} aria-label={`Add ${lead.name} as a contact`} />
                </div>
              )}
            </>
          )}
          {!useExisting && (
            <p className="text-xs text-muted-foreground">
              Created as a prospect, in {lead.currency}, on your default payment terms
              {lead.name ? `, with ${lead.name} as its primary contact` : ""}.
            </p>
          )}
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Open an opportunity</span>
            <Switch checked={createOpportunity} onChange={event => setCreateOpportunity(event.target.checked)} aria-label="Open an opportunity" />
          </div>

          {createOpportunity && (
            <div className="grid gap-3 @md:grid-cols-2">
              <Field label="Name" className="@md:col-span-2">
                <Input value={name} onChange={event => setName(event.target.value)} placeholder={defaultOpportunityName({ company: customerName, name: "" })} />
              </Field>
              <Field
                label={`Amount (${existing?.currency ?? lead.currency})`}
                hint={currencyMismatch ? `The lead's estimate is in ${lead.currency}; it is not carried over into ${existing.currency}.` : undefined}
              >
                <Input type="number" min={0} value={amount} onChange={event => setTypedAmount(event.target.value)} />
              </Field>
              <Field label="Expected close">
                <Input type="date" value={closeDate} onChange={event => setCloseDate(event.target.value)} />
              </Field>
              <Field label="Stage">
                <Select value={stage} onValueChange={value => setStage(value as OpportunityStage)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPEN_STAGES.map(candidate => (
                      <SelectItem key={candidate} value={candidate}>
                        {OPPORTUNITY_STAGE_LABELS[candidate]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
        </div>

        {error && <Notice kind="error" lines={[error]} />}
      </div>
    </Sheet>
  );
}
