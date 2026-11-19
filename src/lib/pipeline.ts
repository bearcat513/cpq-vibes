/**
 * The sales pipeline: leads, and the opportunities they turn into.
 *
 * A **lead** is somebody who might buy — a name, a company, where they came
 * from — before anybody has decided they are worth a customer record. Working
 * it ends one of two ways: it is ruled out (`unqualified`), or it is
 * **converted**, which makes it a customer (or attaches it to one that already
 * exists), adds the person as a contact there, and usually opens an
 * opportunity. A converted lead is history: the collection rule refuses any
 * further edit (1750000017), and it links to what it became.
 *
 * An **opportunity** is a deal being worked with one customer: a stage, an
 * expected amount and close date, and a probability. It is what quotes are
 * written *for* — a quote names its opportunity in the `opportunity`
 * relation, and the opportunity lists them. Revising a quote keeps the link.
 *
 * Three things are derived here rather than stored or typed:
 *
 * - **A closed stage fixes its probability** — won is 100, lost is 0 — so no
 *   pipeline report can count a lost deal at 40%. `readOpportunity` in
 *   validate.ts applies it on every write.
 * - **The weighted amount** is amount × probability, rounded to the
 *   currency, worked out as it is read.
 * - **The pipeline summary never adds two currencies**, for the same reason
 *   `customers.ts` does not: a pipeline figure that summed EUR into USD would
 *   be a wrong number presented confidently. It is one total per currency.
 *
 * Pure, so the screens total without a round trip and the numbers are
 * testable without a database.
 */
import { round, sum } from "./money";
import type { CurrencyCode } from "./types";

/* --------------------------------- leads --------------------------------- */

export const LEAD_STATUSES = ["new", "working", "qualified", "unqualified", "converted"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** What a person may set by editing. `converted` is reached only by converting. */
export const EDITABLE_LEAD_STATUSES: readonly LeadStatus[] = ["new", "working", "qualified", "unqualified"];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  working: "Working",
  qualified: "Qualified",
  unqualified: "Unqualified",
  converted: "Converted",
};

export const LEAD_SOURCES = ["web", "referral", "event", "outbound", "partner", "advertising", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  web: "Website",
  referral: "Referral",
  event: "Event",
  outbound: "Outbound",
  partner: "Partner",
  advertising: "Advertising",
  other: "Other",
};

export type Lead = {
  id: string;
  /** The person. */
  name: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  website: string;
  industry: string;
  source: LeadSource;
  status: LeadStatus;
  /** What it might be worth — seeds the opportunity's amount on conversion. 0 is "no idea yet". */
  estimatedAmount: number;
  currency: CurrencyCode;
  notes: string;
  /** Set by converting, never by an edit. "" until then. */
  convertedAt: string;
  convertedAccountId: string;
  convertedContactId: string;
  convertedOpportunityId: string;
  ownerId: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
};

export const isConverted = (lead: Pick<Lead, "status">) => lead.status === "converted";

/** The name a customer created from this lead is given: the company, or the person when there is none. */
export const leadAccountName = (lead: Pick<Lead, "company" | "name">) => lead.company.trim() || lead.name.trim();

/** How far out a converted deal is expected to close when nobody said. */
export const DEFAULT_CLOSE_DAYS = 90;

/** The opportunity a conversion opens is named after the customer unless told otherwise. */
export const defaultOpportunityName = (lead: Pick<Lead, "company" | "name">) => `${leadAccountName(lead)} — new business`;

/* ----------------------------- opportunities ----------------------------- */

export const OPPORTUNITY_STAGES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const OPEN_STAGES: readonly OpportunityStage[] = ["prospecting", "qualification", "proposal", "negotiation"];

export const OPPORTUNITY_STAGE_LABELS: Record<OpportunityStage, string> = {
  prospecting: "Prospecting",
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed won",
  closed_lost: "Closed lost",
};

/**
 * Where a stage puts the probability when somebody moves a deal into it. The
 * open ones are a starting point the rep may override; the closed ones are
 * fixed (`probabilityFor`).
 */
export const STAGE_PROBABILITY: Record<OpportunityStage, number> = {
  prospecting: 10,
  qualification: 25,
  proposal: 50,
  negotiation: 75,
  closed_won: 100,
  closed_lost: 0,
};

export const isClosedStage = (stage: OpportunityStage) => stage === "closed_won" || stage === "closed_lost";

/**
 * The probability a deal is stored with: whatever was asked for while it is
 * open, and exactly 100 or 0 once it is closed.
 */
export function probabilityFor(stage: OpportunityStage, requested: number | null | undefined): number {
  if (stage === "closed_won") return 100;
  if (stage === "closed_lost") return 0;
  if (requested === null || requested === undefined || !Number.isFinite(requested)) return STAGE_PROBABILITY[stage];
  return Math.min(100, Math.max(0, Math.round(requested)));
}

export type Opportunity = {
  id: string;
  name: string;
  accountId: string;
  /** The customer's name, read with it — for lists. "" when the account cannot be read. */
  accountName: string;
  /** The contact at that customer the deal is with, by id. "" for nobody in particular. */
  contactId: string;
  stage: OpportunityStage;
  /** Expected contract value, in `currency`. */
  amount: number;
  currency: CurrencyCode;
  /** 0-100. Fixed at 100 / 0 once closed. */
  probability: number;
  /** ISO date it is expected to close — or the day it did. */
  closeDate: string;
  source: LeadSource | "";
  nextStep: string;
  /** Why it was lost. Kept only while the stage is `closed_lost`. */
  lossReason: string;
  notes: string;
  /** The lead it was converted from, if any. */
  leadId: string;
  /** Set by the server when it enters a closed stage, cleared if it is reopened. */
  closedAt: string;
  ownerId: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
};

/** Amount × probability, to the currency's precision. */
export const weightedAmount = (opportunity: Pick<Opportunity, "amount" | "probability" | "currency">): number =>
  round((opportunity.amount * opportunity.probability) / 100, opportunity.currency);

/** An open deal whose close date has gone by: the one to chase or re-date. */
export const isPastClose = (opportunity: Pick<Opportunity, "stage" | "closeDate">, today: string): boolean =>
  !isClosedStage(opportunity.stage) && Boolean(opportunity.closeDate) && opportunity.closeDate < today;

export type PipelineTotals = {
  currency: CurrencyCode;
  /** Open deals. */
  openCount: number;
  openAmount: number;
  /** The open amount, each deal weighted by its probability. */
  weightedAmount: number;
  wonCount: number;
  wonAmount: number;
  lostCount: number;
  /** Won over won-plus-lost, as a percentage; 0 with nothing closed. */
  winRate: number;
};

/**
 * The pipeline, one row per currency, the largest open pipeline first.
 * Nothing in one row is ever added to another.
 */
export function pipelineTotals(opportunities: Opportunity[]): PipelineTotals[] {
  const groups = new Map<CurrencyCode, Opportunity[]>();
  for (const opportunity of opportunities) {
    const group = groups.get(opportunity.currency) ?? [];
    group.push(opportunity);
    groups.set(opportunity.currency, group);
  }

  const rows = [...groups].map(([currency, group]): PipelineTotals => {
    const open = group.filter(opportunity => !isClosedStage(opportunity.stage));
    const won = group.filter(opportunity => opportunity.stage === "closed_won");
    const lost = group.filter(opportunity => opportunity.stage === "closed_lost");
    const closed = won.length + lost.length;
    return {
      currency,
      openCount: open.length,
      openAmount: sum(open.map(opportunity => round(opportunity.amount, currency)), currency),
      weightedAmount: sum(open.map(weightedAmount), currency),
      wonCount: won.length,
      wonAmount: sum(won.map(opportunity => round(opportunity.amount, currency)), currency),
      lostCount: lost.length,
      winRate: closed ? Math.round((won.length / closed) * 1000) / 10 : 0,
    };
  });

  return rows.sort((a, b) => b.openAmount - a.openAmount || a.currency.localeCompare(b.currency));
}

/* -------------------------------- searching ------------------------------- */

const matches = (needle: string, ...haystack: string[]) =>
  !needle || haystack.some(value => value.toLowerCase().includes(needle));

export function filterLeads(leads: Lead[], { search = "", status = "" }: { search?: string; status?: LeadStatus | "" }): Lead[] {
  const needle = search.trim().toLowerCase();
  return leads.filter(
    lead => (!status || lead.status === status) && matches(needle, lead.name, lead.company, lead.email, lead.title),
  );
}

export function filterOpportunities(
  opportunities: Opportunity[],
  { search = "", stage = "" }: { search?: string; stage?: OpportunityStage | "open" | "" },
): Opportunity[] {
  const needle = search.trim().toLowerCase();
  return opportunities.filter(
    opportunity =>
      (!stage || (stage === "open" ? !isClosedStage(opportunity.stage) : opportunity.stage === stage)) &&
      matches(needle, opportunity.name, opportunity.accountName, opportunity.nextStep),
  );
}

/** Open deals by close date, soonest (and most overdue) first; closed ones after, newest first. */
export function sortOpportunities(opportunities: Opportunity[]): Opportunity[] {
  return [...opportunities].sort((a, b) => {
    const aClosed = isClosedStage(a.stage);
    const bClosed = isClosedStage(b.stage);
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    if (aClosed) return (b.closedAt || b.closeDate).localeCompare(a.closedAt || a.closeDate);
    // A deal with no close date is the least urgent of the open ones.
    return (a.closeDate || "9999").localeCompare(b.closeDate || "9999") || a.name.localeCompare(b.name);
  });
}
