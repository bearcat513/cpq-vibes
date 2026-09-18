/**
 * Approval policy: deciding whether a quote is the rep's to send, or somebody
 * else's to sign off first.
 *
 * A rule watches one number — the discount, the margin, the value, the term —
 * or, for the cases no single number describes, a formula. When the number
 * crosses the line the rule draws, the quote picks up an approval request
 * naming a level and an approver, and stops being sendable until that request
 * is answered.
 *
 * A rule names **several approvers and two quorums**: how many of them must
 * approve for it to pass, and how many must reject for it to come back. One of
 * three is a rota; three of three is a board; two of three is the case neither
 * of those covers and the reason the numbers are separate.
 *
 * Three decisions here are worth stating plainly, because they are the ones
 * that make an approval mean something:
 *
 * **Levels are cumulative.** A quote that trips a level-3 rule needs every
 * level at or below 3 that also tripped, not just the highest. A discount deep
 * enough for the VP is not a discount that skips the manager.
 *
 * **Editing a quote voids its approvals.** Approvals are recomputed from
 * scratch every time a quote is submitted, and a decision made against the old
 * numbers is not carried forward. Anything else lets a quote be approved at
 * 20% and sent at 40%, which is the one failure an approval system exists to
 * prevent.
 *
 * **A request's status is derived, never set.** `requestStatus` below counts
 * the answers against the quorums and is the only place that decision is
 * made, so a stored request cannot disagree with the votes it is carrying.
 *
 * Evaluation is pure and runs on both sides. The server's copy is the one that
 * counts — a client that decides it needs no approvals changes nothing about
 * what the server stores or what the sharing rules let an approver see.
 */
import { conditionHolds } from "./formula";
import { formatMoney, formatPercent, roundRate } from "./money";
import type { ApprovalRequest, ApprovalRule, Comparator, PricedLine, QuoteTotals } from "./types";

/** What the engine is asked about: a quote that has already been priced. */
export type ApprovableQuote = {
  totals: QuoteTotals;
  lines: PricedLine[];
  termMonths: number;
  /** Products' own discount ceilings, by line id — see the `floorBreach` metric. */
  floorByLineId?: Map<string, number>;
};

export type ApprovalOutcome = {
  /** Every approval the quote needs, pending, ordered by level. */
  required: ApprovalRequest[];
  /** The highest level tripped. 0 when nothing did. */
  highestLevel: number;
  /** Whether the quote may be sent without anyone else's say-so. */
  autoApproved: boolean;
};

/**
 * What a request amounts to, given the answers it has collected.
 *
 * Rejection is tested first: when a request has met both quorums at once — two
 * approvals and one rejection, on a rule that wanted two and one — the honest
 * answer is that somebody objected. An approval system that can be out-voted
 * by filling the room is not one.
 */
export function requestStatus(request: Pick<ApprovalRequest, "decisions" | "approvalsRequired" | "rejectionsRequired">): ApprovalRequest["status"] {
  let approved = 0;
  let rejected = 0;
  for (const decision of request.decisions) {
    if (decision.decision === "approved") approved++;
    else rejected++;
  }

  if (rejected >= Math.max(1, request.rejectionsRequired)) return "rejected";
  if (approved >= Math.max(1, request.approvalsRequired)) return "approved";
  return "pending";
}

/** How far along a request is, for the UI to show "2 of 3". */
export const approvalProgress = (request: ApprovalRequest) => ({
  approved: request.decisions.filter(decision => decision.decision === "approved").length,
  rejected: request.decisions.filter(decision => decision.decision === "rejected").length,
  needed: Math.max(1, request.approvalsRequired),
  toReject: Math.max(1, request.rejectionsRequired),
  /** Who has not answered yet. */
  outstanding: request.approverEmails.filter(
    email => !request.decisions.some(decision => decision.approverEmail === email),
  ),
});

const compare = (value: number, comparator: Comparator, threshold: number): boolean => {
  switch (comparator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
  }
};

/** The variables a `custom` rule sees when it is weighing the whole quote. */
export function quoteVariables(quote: ApprovableQuote): Record<string, number> {
  const totals = quote.totals;
  return {
    discountPercent: totals.effectiveDiscountPercent,
    marginPercent: totals.marginPercent,
    margin: totals.margin,
    netTotal: totals.netTotal,
    grandTotal: totals.grandTotal,
    listTotal: totals.listTotal,
    subtotal: totals.subtotal,
    costTotal: totals.costTotal,
    termMonths: quote.termMonths,
    lineCount: totals.lineCount,
    totalQuantity: quote.lines.reduce((total, line) => total + line.quantity, 0),
    oneTimeTotal: totals.oneTimeTotal,
    recurringTotal: roundRate(totals.netTotal - totals.oneTimeTotal),
    monthlyRecurringTotal: totals.monthlyRecurringTotal,
    annualRecurringTotal: totals.annualRecurringTotal,
  };
}

/** The variables a `custom` rule sees when it is weighing one line. */
export function lineVariables(line: PricedLine, floorDiscountPercent = 0): Record<string, number> {
  return {
    discountPercent: line.effectiveDiscountPercent,
    marginPercent: line.marginPercent,
    margin: line.margin,
    netTotal: line.netTotal,
    listTotal: line.listTotal,
    costTotal: line.costTotal,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    listPrice: line.listUnitPrice,
    termMonths: line.termMonths,
    periods: line.periods,
    floorDiscountPercent,
    isRecurring: line.chargeType === "recurring" ? 1 : 0,
  };
}

/** The number a non-custom rule is actually comparing. */
function metricValue(
  rule: ApprovalRule,
  variables: Record<string, number>,
): number | null {
  switch (rule.metric) {
    case "discountPercent":
      return variables.discountPercent ?? 0;
    case "marginPercent":
      return variables.marginPercent ?? 0;
    case "netTotal":
      return variables.netTotal ?? 0;
    case "termMonths":
      return variables.termMonths ?? 0;
    // Handled by the caller: both need context a single number does not carry.
    case "floorBreach":
    case "custom":
      return null;
  }
}

/** "Discount 32% is above 25%" — the sentence an approver reads first. */
function reasonFor(rule: ApprovalRule, value: number, currency: QuoteTotals["currency"], subject: string): string {
  const shown =
    rule.metric === "netTotal"
      ? formatMoney(value, currency)
      : rule.metric === "termMonths"
        ? `${value} months`
        : formatPercent(value);
  const limit =
    rule.metric === "netTotal"
      ? formatMoney(rule.threshold, currency)
      : rule.metric === "termMonths"
        ? `${rule.threshold} months`
        : formatPercent(rule.threshold);

  return `${subject} ${shown} ${rule.comparator} ${limit}`;
}

const METRIC_SUBJECT: Record<ApprovalRule["metric"], string> = {
  discountPercent: "Discount",
  marginPercent: "Margin",
  netTotal: "Value",
  termMonths: "Term",
  floorBreach: "Discount past the product ceiling:",
  custom: "Policy",
};

let sequence = 0;
const requestId = () => `apr_${Date.now().toString(36)}${(sequence++).toString(36)}`;

/**
 * Works out every approval a priced quote needs.
 *
 * Inactive rules and rules with nobody to ask are skipped: a rule nobody can
 * answer would block a quote forever, which is a worse outcome than the
 * discount it was written to catch.
 */
export function evaluateApprovals(quote: ApprovableQuote, rules: ApprovalRule[], requestedAt = new Date().toISOString()): ApprovalOutcome {
  const currency = quote.totals.currency;
  const required: ApprovalRequest[] = [];

  const add = (rule: ApprovalRule, reason: string, lineId: string | null) => {
    const approverEmails = [
      ...new Set(rule.approvers.map(email => email.trim().toLowerCase()).filter(Boolean)),
    ];

    required.push({
      id: requestId(),
      ruleId: rule.id,
      ruleName: rule.name,
      level: rule.level,
      approverEmails,
      // A quorum larger than the room could never be met, and a rule nobody
      // can satisfy blocks a quote forever — the same reason an approver-less
      // rule is skipped below.
      approvalsRequired: Math.min(Math.max(1, rule.approvalsRequired), approverEmails.length),
      rejectionsRequired: Math.min(Math.max(1, rule.rejectionsRequired), approverEmails.length),
      reason,
      status: "pending",
      lineId,
      decisions: [],
      requestedAt,
    });
  };

  const quoteVars = quoteVariables(quote);

  for (const rule of rules) {
    if (!rule.active || !rule.approvers.some(email => email.trim())) continue;

    if (rule.scope === "quote") {
      if (rule.metric === "custom") {
        if (conditionHolds(rule.condition, quoteVars)) add(rule, rule.message || `Policy “${rule.name}” applies`, null);
        continue;
      }
      // A quote-scoped floor breach means "any line breached its own floor".
      if (rule.metric === "floorBreach") {
        const breached = quote.lines.filter(line => breachAmount(line, quote.floorByLineId) > 0);
        if (breached.length) {
          add(
            rule,
            `${breached.length} line${breached.length === 1 ? "" : "s"} discounted past the product ceiling`,
            null,
          );
        }
        continue;
      }

      const value = metricValue(rule, quoteVars);
      if (value !== null && compare(value, rule.comparator, rule.threshold)) {
        add(rule, reasonFor(rule, value, currency, METRIC_SUBJECT[rule.metric]), null);
      }
      continue;
    }

    /* line scope — the rule is asked of every line, and fires per line */

    for (const line of quote.lines) {
      const floor = quote.floorByLineId?.get(line.id) ?? 0;

      if (rule.metric === "floorBreach") {
        const over = breachAmount(line, quote.floorByLineId);
        if (over > rule.threshold) {
          add(
            rule,
            `${line.sku}: ${formatPercent(line.effectiveDiscountPercent)} off list, ${formatPercent(over)} past its ${formatPercent(floor)} ceiling`,
            line.id,
          );
        }
        continue;
      }

      const variables = lineVariables(line, floor);
      if (rule.metric === "custom") {
        if (conditionHolds(rule.condition, variables)) {
          add(rule, rule.message || `${line.sku}: policy “${rule.name}” applies`, line.id);
        }
        continue;
      }

      const value = metricValue(rule, variables);
      if (value !== null && compare(value, rule.comparator, rule.threshold)) {
        add(rule, `${line.sku}: ${reasonFor(rule, value, currency, METRIC_SUBJECT[rule.metric])}`, line.id);
      }
    }
  }

  required.sort((a, b) => a.level - b.level || a.ruleName.localeCompare(b.ruleName));

  return {
    required,
    highestLevel: required.reduce((highest, request) => Math.max(highest, request.level), 0),
    autoApproved: required.length === 0,
  };
}

/** How far past its product's ceiling a line was discounted. 0 when within it. */
function breachAmount(line: PricedLine, floorByLineId?: Map<string, number>): number {
  const ceiling = floorByLineId?.get(line.id) ?? 0;
  if (ceiling <= 0) return 0;
  return Math.max(0, roundRate(line.effectiveDiscountPercent - ceiling));
}

/* ------------------------------- decisions ------------------------------- */

/** Whether every outstanding approval has been given. */
export const allApproved = (approvals: ApprovalRequest[]): boolean =>
  approvals.length > 0 && approvals.every(request => request.status === "approved");

export const anyRejected = (approvals: ApprovalRequest[]): boolean =>
  approvals.some(request => request.status === "rejected");

export const pendingApprovals = (approvals: ApprovalRequest[]): ApprovalRequest[] =>
  approvals.filter(request => request.status === "pending");

/**
 * Who the quote is currently waiting on.
 *
 * Only the lowest outstanding level: approvals are a ladder, and showing a VP
 * a quote their manager has not looked at yet wastes the scarcer person's
 * time. Everyone addressed at that level is asked at once — including anyone
 * who has already answered, so they can still see the quote they voted on.
 */
export function currentApprovers(approvals: ApprovalRequest[]): string[] {
  const pending = pendingApprovals(approvals);
  if (!pending.length) return [];
  const lowest = Math.min(...pending.map(request => request.level));
  return [...new Set(pending.filter(request => request.level === lowest).flatMap(request => request.approverEmails))];
}

/** Whether this person still has something to answer on this request. */
export const canDecide = (request: ApprovalRequest, approverEmail: string): boolean =>
  request.status === "pending" && request.approverEmails.includes(approverEmail.trim().toLowerCase());

/**
 * Every request this person can act on right now.
 *
 * Approvals are only collectable at the level in play; a rejection lands
 * wherever it is addressed, since objecting early is still objecting.
 */
export function actionableFor(
  approvals: ApprovalRequest[],
  approverEmail: string,
  decision: "approved" | "rejected" = "approved",
): ApprovalRequest[] {
  const email = approverEmail.trim().toLowerCase();
  const pending = pendingApprovals(approvals);
  if (!pending.length) return [];

  const lowest = Math.min(...pending.map(request => request.level));
  return pending.filter(
    request => canDecide(request, email) && (decision === "rejected" || request.level === lowest),
  );
}

/**
 * Records one person's decision.
 *
 * An approver answers every request addressed to them at the level in play,
 * rather than clicking once per rule they happened to trip — the decision is
 * about the quote, and asking them the same question four times is how
 * approvals stop being read.
 *
 * Changing your mind is allowed while the request is still open: a second
 * answer replaces the first rather than counting twice. Once a quorum has
 * carried, the request is closed and nothing further lands on it.
 */
export function applyDecision(
  approvals: ApprovalRequest[],
  approverEmail: string,
  decision: "approved" | "rejected",
  comment: string,
  decidedAt = new Date().toISOString(),
): { approvals: ApprovalRequest[]; changed: number } {
  const email = approverEmail.trim().toLowerCase();
  const actionable = new Set(actionableFor(approvals, email, decision).map(request => request.id));

  let changed = 0;
  const next = approvals.map(request => {
    if (!actionable.has(request.id)) return request;

    const decisions = [
      ...request.decisions.filter(entry => entry.approverEmail !== email),
      { approverEmail: email, decision, decidedAt, comment },
    ];

    changed++;
    // Derived, never assigned: the votes decide, so a stored status cannot
    // drift away from the answers it is carrying.
    return { ...request, decisions, status: requestStatus({ ...request, decisions }) };
  });

  return { approvals: next, changed };
}
