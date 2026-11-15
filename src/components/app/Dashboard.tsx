import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CircleDashed,
  FileWarning,
  Receipt,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { EmptyState, Section, StatusBadge, formatters, statusLabel } from "./common";
import { useAccess } from "./access";
import { CREATE_ORDER, CREATES, keysFor, type CreateKind, type View, type ViewIntent } from "./navigation";
import type { SettingsTab } from "./SettingsPanel";
import { api, type SessionUser } from "@/lib/api";
import { expiringWithin, greeting, pipelineSummary, totalIn } from "@/lib/dashboard";
import type { Preferences } from "@/lib/preferences";
import { daysBetween, today, type AgingReport } from "@/lib/receivable";
import { QUOTE_STATUSES, type Account, type Product, type ProposalTemplate, type QuoteSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  me: SessionUser;
  preferences: Preferences;
  /** Bumped by every refresh, so the figures are read again. */
  version: number;
  awaiting: QuoteSummary[];
  accounts: Account[];
  products: Product[];
  templates: ProposalTemplate[];
  onOpenQuote: (id: string) => void;
  onGo: (view: View, intent?: ViewIntent) => void;
  onCreate: (kind: CreateKind) => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onError: (error: unknown) => void;
};

/** How many quotes the "out with customers" figure reads. */
const SENT_SAMPLE = 200;
/** How far ahead "expiring soon" looks, in days. */
const EXPIRY_HORIZON_DAYS = 7;

/**
 * Home: where the day starts.
 *
 * Four figures across the top that each answer a question somebody opens the
 * app with — what is in play, what is out with customers, what is waiting on
 * me, what are we owed — and each one is a door to the screen that answers it
 * in full. Below them, what needs somebody today, the newest quotes, and the
 * things this account may start.
 *
 * Nothing here is computed that the other screens do not also show: the
 * counts are the quote list's filter chips, the receivable is the aging
 * report, and money is only ever added up in one currency.
 */
export function Dashboard({
  me,
  preferences,
  version,
  awaiting,
  accounts,
  products,
  templates,
  onOpenQuote,
  onGo,
  onCreate,
  onOpenSettings,
  onError,
}: Props) {
  const access = useAccess();
  const currency = preferences.defaultCurrency;
  const format = formatters(currency, preferences.locale);
  const asOf = today();

  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [recent, setRecent] = useState<QuoteSummary[] | null>(null);
  const [sent, setSent] = useState<{ items: QuoteSummary[]; total: number } | null>(null);
  const [aging, setAging] = useState<AgingReport | null>(null);

  // Each figure appears as its own answer arrives, rather than all of them
  // waiting on the slowest — the sent-quote total reads a couple of hundred rows.
  useEffect(() => {
    let current = true;
    const failed = (error: unknown) => current && onError(error);
    api
      .quoteCounts()
      .then(next => current && setCounts(next))
      .catch(error => {
        if (current) setCounts({});
        failed(error);
      });
    api
      .searchQuotes({ perPage: 6 })
      .then(page => current && setRecent(page.items))
      .catch(() => current && setRecent([]));
    api
      .searchQuotes({ status: "sent", perPage: SENT_SAMPLE })
      .then(page => current && setSent(page))
      .catch(() => current && setSent({ items: [], total: 0 }));
    // The receivable is a nice-to-have here; its own screen reports a failure.
    api
      .aging(currency)
      .then(report => current && setAging(report))
      .catch(() => current && setAging(null));
    return () => {
      current = false;
    };
  }, [version, currency, onError]);

  const pipeline = pipelineSummary(counts ?? {});
  const outstanding = useMemo(() => totalIn(sent?.items ?? [], currency), [sent, currency]);
  const expiring = useMemo(() => expiringWithin(sent?.items ?? [], EXPIRY_HORIZON_DAYS, asOf), [sent, asOf]);
  const overdueCount = aging ? aging.invoiceCount - aging.buckets.current.count : 0;

  const firstName = (me.name || me.email.split("@")[0] || "").split(/\s+/)[0];
  const longDate = useMemo(() => {
    const parsed = new Date(`${asOf}T00:00:00`);
    return parsed.toLocaleDateString(preferences.locale || undefined, { weekday: "long", month: "long", day: "numeric" });
  }, [asOf, preferences.locale]);

  const creatable = CREATE_ORDER.filter(kind => access.can(CREATES[kind].permission));

  /* ------------------------------ attention ------------------------------ */

  const attention: AttentionItem[] = [];
  if (awaiting.length) {
    attention.push({
      key: "approvals",
      Icon: ShieldCheck,
      tone: "hazard",
      title: `${awaiting.length} quote${awaiting.length === 1 ? "" : "s"} waiting for your approval`,
      detail: awaiting
        .slice(0, 2)
        .map(quote => quote.number)
        .join(", "),
      onClick: () => (awaiting.length === 1 ? onOpenQuote(awaiting[0]!.id) : onGo("approvals")),
    });
  }
  for (const quote of expiring.slice(0, 3)) {
    const left = daysBetween(asOf, quote.validUntil);
    attention.push({
      key: `expiring:${quote.id}`,
      Icon: CalendarClock,
      tone: "hazard",
      title: `${quote.number} expires ${left === 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`}`,
      detail: [quote.customer.name, format.money(quote.totals?.grandTotal ?? 0, quote.currency)].filter(Boolean).join(" · "),
      onClick: () => onOpenQuote(quote.id),
    });
  }
  if (overdueCount > 0 && aging) {
    attention.push({
      key: "overdue",
      Icon: AlertTriangle,
      tone: "alert",
      title: `${overdueCount} invoice${overdueCount === 1 ? "" : "s"} overdue`,
      detail: `${format.money(aging.overdue)} late, the oldest by ${aging.maxDaysOverdue} day${aging.maxDaysOverdue === 1 ? "" : "s"}`,
      onClick: () => onGo("receivables", { status: "overdue" }),
    });
  }
  if ((counts?.rejected ?? 0) > 0) {
    const rejected = counts!.rejected!;
    attention.push({
      key: "rejected",
      Icon: FileWarning,
      tone: "flare",
      title: `${rejected} quote${rejected === 1 ? "" : "s"} came back rejected`,
      detail: "Revise and resubmit, or let them go.",
      onClick: () => onGo("quotes", { status: "rejected" }),
    });
  }
  if (aging && aging.draftCount > 0 && access.can("invoices.write")) {
    attention.push({
      key: "drafts",
      Icon: Receipt,
      tone: "muted",
      title: `${aging.draftCount} draft invoice${aging.draftCount === 1 ? "" : "s"} not yet issued`,
      detail: `${format.money(aging.draftAmount)} that nobody has been asked for.`,
      onClick: () => onGo("receivables", { status: "draft" }),
    });
  }

  /* ---------------------------- getting started --------------------------- */

  const steps: Step[] = [
    {
      label: "Add a product to the catalogue",
      done: products.length > 0,
      onClick: () => (access.can("catalogue.write") ? onCreate("product") : onGo("catalog")),
    },
    {
      label: "Add a customer",
      done: accounts.length > 0,
      onClick: () => (access.can("accounts.write") ? onCreate("customer") : onGo("customers")),
    },
    {
      label: "Write your first quote",
      done: (counts?.all ?? 0) > 0,
      onClick: () => (access.can("quotes.create") ? onCreate("quote") : onGo("quotes")),
    },
    { label: "Set up a proposal template", done: templates.length > 0, onClick: () => onGo("templates") },
  ];
  const settingUp = counts !== null && steps.some(step => !step.done);

  /* -------------------------------- render -------------------------------- */

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {longDate} · {me.org?.name}
          </p>
          <h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
            {greeting(new Date().getHours())}
            {firstName ? `, ${firstName}` : ""}
          </h1>
        </div>
      </header>

      {/* ------------------------------ figures ----------------------------- */}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile
          label="Open quotes"
          value={counts ? String(pipeline.open) : "—"}
          detail={
            counts
              ? `${counts.draft ?? 0} draft · ${counts.in_review ?? 0} in review · ${counts.sent ?? 0} sent`
              : "Counting…"
          }
          onClick={() => onGo("quotes")}
        />
        <Tile
          label="Out with customers"
          value={sent ? format.money(outstanding.amount) : "—"}
          detail={
            sent
              ? [
                  `${outstanding.count} sent`,
                  outstanding.otherCurrency ? `+${outstanding.otherCurrency} in other currencies` : "",
                  sent.total > sent.items.length ? `newest ${sent.items.length} of ${sent.total}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Adding up…"
          }
          onClick={() => onGo("quotes", { status: "sent" })}
        />
        <Tile
          label="Waiting on you"
          value={String(awaiting.length)}
          detail={awaiting.length ? "Approvals to decide" : "Nothing to approve"}
          tone={awaiting.length ? "hazard" : undefined}
          onClick={() => onGo("approvals")}
        />
        <Tile
          label="Receivable"
          value={aging ? format.money(aging.outstanding) : "—"}
          detail={
            aging
              ? aging.overdue > 0
                ? `${format.money(aging.overdue)} overdue`
                : `${aging.invoiceCount} open invoice${aging.invoiceCount === 1 ? "" : "s"}, none late`
              : "Not available"
          }
          tone={aging && aging.overdue > 0 ? "alert" : undefined}
          onClick={() => onGo("receivables")}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* The side column comes first in the markup, so a phone — one column —
            reads "what needs me" before "what happened lately". */}
        <div className="space-y-4 xl:col-start-3 xl:row-start-1">
          <Section title="Needs attention" description={attention.length ? undefined : "Nothing is waiting on anybody."}>
            {attention.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                <Check className="size-4 text-signal" /> All clear.
              </p>
            ) : (
              <ul className="divide-y">
                {attention.map(item => (
                  <li key={item.key}>
                    <AttentionRow item={item} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {creatable.length > 0 && (
            <Section title="Start something">
              <div className="grid grid-cols-2 gap-2 p-3 xl:grid-cols-1">
                {creatable.map(kind => {
                  const { label, Icon } = CREATES[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => onCreate(kind)}
                      className="liftable flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm hover:border-primary/40"
                    >
                      <Icon className="size-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <Kbd keys={keysFor(`new:${kind}`)} className="hidden lg:inline-flex" />
                    </button>
                  );
                })}
              </div>
            </Section>
          )}

          {settingUp && (
            <Section title="Getting started" description={`${steps.filter(step => step.done).length} of ${steps.length} done`}>
              <ul className="divide-y">
                {steps.map(step => (
                  <li key={step.label}>
                    <button
                      type="button"
                      onClick={step.onClick}
                      disabled={step.done}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm enabled:hover:bg-accent/50 disabled:text-muted-foreground"
                    >
                      {step.done ? (
                        <Check className="size-4 shrink-0 text-signal" />
                      ) : (
                        <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className={cn("flex-1", step.done && "line-through")}>{step.label}</span>
                      {!step.done && <ArrowRight className="size-3.5 text-muted-foreground" />}
                    </button>
                  </li>
                ))}
              </ul>
              {access.can("samples.install") && products.length === 0 && (
                <div className="border-t px-4 py-3">
                  <Button variant="outline" size="sm" onClick={() => onOpenSettings("data")}>
                    <Sparkles /> Or install a worked example
                  </Button>
                </div>
              )}
            </Section>
          )}
        </div>

        <div className="space-y-4 xl:col-span-2 xl:col-start-1 xl:row-start-1">
          <Section
            title="Recent quotes"
            description="The last few touched, by anybody."
            actions={
              <Button variant="ghost" size="sm" onClick={() => onGo("quotes")}>
                All quotes <ArrowRight />
              </Button>
            }
          >
            {recent === null ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">Loading…</p>
            ) : recent.length === 0 ? (
              <EmptyState title="No quotes yet">The newest quotes appear here as soon as there are some.</EmptyState>
            ) : (
              <ul className="divide-y">
                {recent.map(quote => {
                  const money = formatters(quote.currency, preferences.locale);
                  return (
                    <li key={quote.id}>
                      <button
                        type="button"
                        onClick={() => onOpenQuote(quote.id)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{quote.name || quote.number}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            <span className="font-mono">{quote.number}</span>
                            {quote.customer.name ? ` · ${quote.customer.name}` : ""}
                            <span className="hidden sm:inline"> · updated {money.date(quote.updatedAt)}</span>
                          </span>
                        </span>
                        <span className="hidden text-sm tabular-nums sm:block">{money.money(quote.totals?.grandTotal ?? 0)}</span>
                        <StatusBadge status={quote.status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {/* Detail for a desk; a phone has the figures above and that is plenty. */}
          {counts && (counts.all ?? 0) > 0 && (
            <Section
              title="Pipeline"
              description={
                pipeline.winRate === null
                  ? "Nothing decided yet."
                  : `${pipeline.winRate}% won — ${pipeline.accepted} of ${pipeline.decided} decided`
              }
              className="hidden sm:block"
            >
              <ul className="space-y-1 p-3">
                {QUOTE_STATUSES.filter(status => (counts[status] ?? 0) > 0).map(status => {
                  const count = counts[status] ?? 0;
                  const share = (count / Math.max(counts.all ?? 1, 1)) * 100;
                  return (
                    <li key={status}>
                      <button
                        type="button"
                        onClick={() => onGo("quotes", { status })}
                        className="grid w-full grid-cols-[7rem_1fr_3rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                        aria-label={`${statusLabel(status)}: ${count}`}
                      >
                        <span className="text-muted-foreground">{statusLabel(status)}</span>
                        <span className="h-2 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(share, 2)}%` }} />
                        </span>
                        <span className="text-right tabular-nums">{count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- pieces --------------------------------- */

const TILE_TONE = {
  hazard: "text-hazard",
  alert: "text-alert",
} as const;

function Tile({
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  detail: ReactNode;
  tone?: keyof typeof TILE_TONE;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="panel liftable motion-safe:animate-rise min-w-0 rounded-lg border p-3 text-left shadow-[0_1px_2px_var(--cast)] hover:border-primary/40 sm:p-4"
    >
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span className={cn("block truncate font-display text-xl font-semibold tabular-nums sm:text-2xl", tone && TILE_TONE[tone])}>
        {value}
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}

type AttentionItem = {
  key: string;
  Icon: LucideIcon;
  tone: "hazard" | "alert" | "flare" | "muted";
  title: string;
  detail: string;
  onClick: () => void;
};

const ATTENTION_TONE: Record<AttentionItem["tone"], string> = {
  hazard: "text-hazard",
  alert: "text-alert",
  flare: "text-flare",
  muted: "text-muted-foreground",
};

function AttentionRow({ item }: { item: AttentionItem }) {
  const { Icon } = item;
  return (
    <button type="button" onClick={item.onClick} className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-accent/50">
      <Icon className={cn("mt-0.5 size-4 shrink-0", ATTENTION_TONE[item.tone])} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{item.title}</span>
        {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
      </span>
      <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

type Step = { label: string; done: boolean; onClick: () => void };
