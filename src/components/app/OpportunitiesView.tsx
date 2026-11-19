import { useEffect, useMemo, useState } from "react";
import { Check, FilePlus2, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Field, FilterChip, formatters, Notice, Section, StageBadge, StatusBadge } from "./common";
import { useAccess } from "./access";
import { api } from "@/lib/api";
import { addDaysTo, today } from "@/lib/clock";
import {
  DEFAULT_CLOSE_DAYS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_STAGE_LABELS,
  STAGE_PROBABILITY,
  filterOpportunities,
  isClosedStage,
  isPastClose,
  pipelineTotals,
  probabilityFor,
  sortOpportunities,
  weightedAmount,
  type LeadSource,
  type Opportunity,
  type OpportunityStage,
} from "@/lib/pipeline";
import type { Preferences } from "@/lib/preferences";
import { CURRENCIES, type Account, type CurrencyCode, type QuoteSummary } from "@/lib/types";
import type { OpportunityInput } from "@/lib/validate";
import { cn } from "@/lib/utils";

type Props = {
  accounts: Account[];
  preferences: Preferences;
  onError: (error: unknown) => void;
  onOpenQuote: (id: string) => void;
  onOpenCustomer: (id: string) => void;
  confirmed: (message: string) => boolean;
  initialCreate?: boolean;
  initialOpenId?: string;
};

type StageFilter = OpportunityStage | "open" | "";

/**
 * Opportunities: the deals being worked, and what each is expected to bring.
 *
 * The strip at the top is the pipeline — one row per currency, because a
 * total that added EUR to USD would be a wrong number stated confidently. A
 * deal opens in the panel with the quotes written for it underneath, and
 * *New quote* starts one for its customer, linked, and opens it in the quote
 * editor.
 */
export function OpportunitiesView({
  accounts,
  preferences,
  onError,
  onOpenQuote,
  onOpenCustomer,
  confirmed,
  initialCreate,
  initialOpenId,
}: Props) {
  const access = useAccess();
  const canCreate = access.can("opportunities.create");

  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null);
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<StageFilter>("open");
  const [editing, setEditing] = useState<Opportunity | null | undefined>(initialCreate && canCreate ? null : undefined);
  const [openId] = useState(initialOpenId);

  const load = async () => {
    try {
      const all = await api.listOpportunities();
      setOpportunities(all);
      return all;
    } catch (error) {
      onError(error);
      return [];
    }
  };

  useEffect(() => {
    void load().then(all => {
      const arriving = openId ? all.find(opportunity => opportunity.id === openId) : undefined;
      if (arriving) {
        setEditing(arriving);
        // Arriving on a closed deal should still show it in the list behind.
        if (isClosedStage(arriving.stage)) setStage("");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all = opportunities ?? [];
  const now = today();
  const totals = useMemo(() => pipelineTotals(all), [all]);
  const counts = useMemo(() => {
    const tally = new Map<StageFilter, number>();
    for (const opportunity of all) {
      tally.set(opportunity.stage, (tally.get(opportunity.stage) ?? 0) + 1);
      if (!isClosedStage(opportunity.stage)) tally.set("open", (tally.get("open") ?? 0) + 1);
    }
    return tally;
  }, [all]);
  const visible = useMemo(() => sortOpportunities(filterOpportunities(all, { search, stage })), [all, search, stage]);
  const format = formatters(preferences.defaultCurrency, preferences.locale);

  const remove = async (opportunity: Opportunity) => {
    if (!confirmed(`Delete ${opportunity.name}? Its quotes are kept, and stop naming it.`)) return;
    try {
      await api.deleteOpportunity(opportunity.id);
      setEditing(undefined);
      await load();
    } catch (error) {
      onError(error);
    }
  };

  return (
    <>
      <Section
        title="Opportunities"
        description={
          opportunities === null
            ? "Loading…"
            : `${counts.get("open") ?? 0} open of ${all.length}`
        }
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search"
                aria-label="Search opportunities"
                className="h-8 w-44 pl-8"
              />
            </div>
            {canCreate && (
              <Button size="sm" onClick={() => setEditing(null)} disabled={accounts.length === 0} title={accounts.length ? undefined : "Add a customer first"}>
                <Plus /> New opportunity
              </Button>
            )}
          </>
        }
      >
        {totals.length > 0 && (
          <div className="grid gap-px border-b bg-border sm:grid-cols-2 xl:grid-cols-4" aria-label="Pipeline">
            {totals.map(row => (
              <div key={row.currency} className="panel space-y-1 px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  Open pipeline · {row.currency} · {row.openCount} deal{row.openCount === 1 ? "" : "s"}
                </p>
                <p className="font-display text-lg font-semibold tabular-nums">{format.money(row.openAmount, row.currency)}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {format.money(row.weightedAmount, row.currency)} weighted · {format.money(row.wonAmount, row.currency)} won
                  {row.wonCount + row.lostCount > 0 && ` · ${row.winRate}% win rate`}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
          <FilterChip label="Open" count={counts.get("open") ?? 0} on={stage === "open"} onClick={() => setStage("open")} />
          <FilterChip label="All" count={all.length} on={stage === ""} onClick={() => setStage("")} />
          {OPPORTUNITY_STAGES.map(candidate => (
            <FilterChip
              key={candidate}
              label={OPPORTUNITY_STAGE_LABELS[candidate]}
              count={counts.get(candidate) ?? 0}
              on={stage === candidate}
              onClick={() => setStage(candidate)}
            />
          ))}
        </div>

        {opportunities === null ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title={all.length ? "Nothing matches" : "No opportunities yet"}>
            {all.length
              ? "Try a different search, or another stage."
              : "Convert a lead, or open one for a customer you already have. Quotes written for a deal are listed with it."}
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Opportunity</Th>
                <Th>Stage</Th>
                <Th numeric>Amount</Th>
                <Th numeric>Probability</Th>
                <Th numeric>Weighted</Th>
                <Th>Close</Th>
              </Tr>
            </Thead>
            <Tbody>
              {visible.map(opportunity => (
                <Tr
                  key={opportunity.id}
                  onClick={() => setEditing(opportunity)}
                  className="cursor-pointer"
                  tabIndex={0}
                  onKeyDown={event => event.key === "Enter" && setEditing(opportunity)}
                >
                  <Td>
                    <span className="font-medium">{opportunity.name}</span>
                    <p className="text-xs text-muted-foreground">{opportunity.accountName || "—"}</p>
                  </Td>
                  <Td>
                    <StageBadge stage={opportunity.stage} />
                  </Td>
                  <Td numeric>{format.money(opportunity.amount, opportunity.currency)}</Td>
                  <Td numeric className="text-muted-foreground">
                    {opportunity.probability}%
                  </Td>
                  <Td numeric className="text-muted-foreground">
                    {format.money(weightedAmount(opportunity), opportunity.currency)}
                  </Td>
                  <Td className={cn(isPastClose(opportunity, now) ? "text-alert" : "text-muted-foreground")}>
                    {format.date(opportunity.closeDate)}
                    {isPastClose(opportunity, now) && <span className="sr-only"> (past its close date)</span>}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      {editing !== undefined && (
        <OpportunityEditor
          opportunity={editing}
          accounts={accounts}
          preferences={preferences}
          canEdit={editing ? access.canEditOpportunity(editing) : canCreate}
          canQuote={access.can("quotes.create")}
          onSave={async (input, id) => {
            const saved = id ? await api.updateOpportunity(id, input) : await api.createOpportunity(input);
            await load();
            return saved;
          }}
          onDelete={() => editing && void remove(editing)}
          onOpenQuote={onOpenQuote}
          onOpenCustomer={onOpenCustomer}
          onError={onError}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

/* --------------------------------- editing -------------------------------- */

function OpportunityEditor({
  opportunity,
  accounts,
  preferences,
  canEdit,
  canQuote,
  onSave,
  onDelete,
  onOpenQuote,
  onOpenCustomer,
  onError,
  onClose,
}: {
  opportunity: Opportunity | null;
  accounts: Account[];
  preferences: Preferences;
  canEdit: boolean;
  canQuote: boolean;
  onSave: (input: OpportunityInput, id: string | null) => Promise<Opportunity>;
  onDelete: () => void;
  onOpenQuote: (id: string) => void;
  onOpenCustomer: (id: string) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<OpportunityInput>(() => {
    if (opportunity) {
      const { id, accountName, leadId, closedAt, ownerId, orgId, createdAt, updatedAt, ...rest } = opportunity;
      return { ...rest };
    }
    return {
      name: "",
      accountId: "",
      contactId: "",
      stage: "prospecting",
      amount: 0,
      currency: preferences.defaultCurrency,
      probability: STAGE_PROBABILITY.prospecting,
      closeDate: addDaysTo(today(), DEFAULT_CLOSE_DAYS),
      source: "",
      nextStep: "",
      lossReason: "",
      notes: "",
    };
  });
  /** The saved record, once there is one — what the quotes section hangs off. */
  const [saved, setSaved] = useState<Opportunity | null>(opportunity);
  const [quotes, setQuotes] = useState<QuoteSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "quote">("");

  useEffect(() => {
    if (!saved) return;
    api.opportunityQuotes(saved.id).then(setQuotes, onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.id]);

  const locked = !canEdit;
  const account = accounts.find(candidate => candidate.id === draft.accountId);
  const patch = (changes: Partial<OpportunityInput>) => setDraft(current => ({ ...current, ...changes }));

  /** A new stage brings its probability with it; a closed one fixes it. */
  const moveTo = (stage: OpportunityStage) => patch({ stage, probability: probabilityFor(stage, null) });

  /** Picking a customer brings their currency, until somebody chose one. */
  const pickAccount = (accountId: string) => {
    const picked = accounts.find(candidate => candidate.id === accountId);
    patch({ accountId, contactId: "", ...(picked && !saved ? { currency: picked.currency } : {}) });
  };

  const save = async () => {
    setBusy("save");
    setError("");
    try {
      const stored = await onSave(draft, saved?.id ?? null);
      if (saved) onClose();
      else setSaved(stored);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this opportunity.");
    } finally {
      setBusy("");
    }
  };

  const newQuote = async () => {
    if (!saved) return;
    setBusy("quote");
    setError("");
    try {
      const { quote } = await api.quoteOpportunity(saved.id);
      onOpenQuote(quote.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start a quote.");
      setBusy("");
    }
  };

  const format = formatters(draft.currency, preferences.locale);
  const closed = isClosedStage(draft.stage);

  return (
    <Sheet
      title={saved ? saved.name : "New opportunity"}
      description={saved?.accountName || undefined}
      onClose={onClose}
      footer={
        <>
          {saved && canEdit && (
            <Button variant="ghost" onClick={onDelete} className="mr-auto" aria-label="Delete this opportunity">
              <Trash2 className="text-muted-foreground" />
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {locked ? "Close" : "Cancel"}
          </Button>
          {!locked && (
            <Button onClick={() => void save()} disabled={busy !== ""}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} Save
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {locked && saved && (
          <Notice kind="info" lines={["This is somebody else's deal. Its owner, or an admin, can change it."]} />
        )}

        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Name" className="@md:col-span-2">
            <Input value={draft.name} onChange={event => patch({ name: event.target.value })} disabled={locked} autoFocus={!saved} />
          </Field>
          <Field
            label="Customer"
            hint={
              account && saved ? (
                <button type="button" className="underline underline-offset-2" onClick={() => onOpenCustomer(account.id)}>
                  Open {account.name}
                </button>
              ) : undefined
            }
          >
            <Combobox
              value={draft.accountId}
              onChange={pickAccount}
              options={accounts.map(candidate => ({ value: candidate.id, label: candidate.name, hint: candidate.industry || undefined }))}
              placeholder="Pick a customer"
              disabled={locked}
              aria-label="Customer"
            />
          </Field>
          <Field label="Contact">
            <Combobox
              value={draft.contactId}
              onChange={contactId => patch({ contactId })}
              options={(account?.contacts ?? []).map(contact => ({ value: contact.id, label: contact.name, hint: contact.title || contact.email || undefined }))}
              emptyLabel="Nobody in particular"
              placeholder={account ? "Pick a contact" : "Pick a customer first"}
              disabled={locked || !account}
              aria-label="Contact"
            />
          </Field>
          <Field label="Stage">
            <Select value={draft.stage} onValueChange={value => moveTo(value as OpportunityStage)} disabled={locked}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPPORTUNITY_STAGES.map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    {OPPORTUNITY_STAGE_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Probability (%)" hint={closed ? "Fixed by a closed stage." : `Weighted: ${format.money(weightedAmount(draft))}`}>
            <Input
              type="number"
              min={0}
              max={100}
              value={draft.probability}
              onChange={event => patch({ probability: probabilityFor(draft.stage, Number(event.target.value)) })}
              disabled={locked || closed}
            />
          </Field>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label="Amount">
              <Input
                type="number"
                min={0}
                value={draft.amount || ""}
                onChange={event => patch({ amount: Number(event.target.value) || 0 })}
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
          <Field label={closed ? "Closed on" : "Expected close"}>
            <Input type="date" value={draft.closeDate} onChange={event => patch({ closeDate: event.target.value })} disabled={locked} />
          </Field>
          <Field label="Source">
            <Select value={draft.source || "none"} onValueChange={value => patch({ source: value === "none" ? "" : (value as LeadSource) })} disabled={locked}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not recorded</SelectItem>
                {LEAD_SOURCES.map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    {LEAD_SOURCE_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Next step" className="@md:col-span-2">
            <Input value={draft.nextStep} onChange={event => patch({ nextStep: event.target.value })} disabled={locked} />
          </Field>
          {draft.stage === "closed_lost" && (
            <Field label="Why it was lost" className="@md:col-span-2">
              <Input value={draft.lossReason} onChange={event => patch({ lossReason: event.target.value })} disabled={locked} />
            </Field>
          )}
        </div>

        <Field label="Notes">
          <Textarea value={draft.notes} onChange={event => patch({ notes: event.target.value })} rows={3} disabled={locked} />
        </Field>

        {error && <Notice kind="error" lines={[error]} />}

        {/* -------------------------------- quotes ------------------------------ */}

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Quotes</p>
              <p className="text-xs text-muted-foreground">
                {saved ? "Written for this deal, newest first." : "Save the opportunity to quote it."}
              </p>
            </div>
            {saved && canQuote && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void newQuote()}
                disabled={busy !== "" || isClosedStage(saved.stage)}
                title={isClosedStage(saved.stage) ? "Reopen the deal to quote it again." : undefined}
              >
                {busy === "quote" ? <Loader2 className="animate-spin" /> : <FilePlus2 />} New quote
              </Button>
            )}
          </div>

          {saved &&
            (quotes === null ? (
              <Loader2 className="mx-auto animate-spin text-muted-foreground" />
            ) : quotes.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">No quotes yet.</p>
            ) : (
              <ul className="divide-y">
                {quotes.map(quote => (
                  <li key={quote.id}>
                    <button
                      type="button"
                      onClick={() => onOpenQuote(quote.id)}
                      className="flex w-full items-center justify-between gap-3 py-2 text-left text-sm hover:bg-accent/50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{quote.name}</span>
                        <span className="text-xs text-muted-foreground">{quote.number}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusBadge status={quote.status} />
                        <span className="tabular-nums">{format.money(quote.totals.grandTotal ?? 0, quote.currency)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </Sheet>
  );
}
