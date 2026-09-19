import { ShieldCheck, ShieldAlert, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ApprovalRequest, QuoteTotals } from "@/lib/types";
import type { Formatter } from "./common";

type Props = {
  totals: QuoteTotals;
  format: Formatter;
  showMargin: boolean;
  /** What submitting would ask for, worked out live as the quote is edited. */
  approvalsRequired: ApprovalRequest[];
  termMonths: number;
};

/**
 * The totals, and what they will cost the rep in process.
 *
 * The approval preview is the reason this panel is worth its space. A rep who
 * learns at submit time that 32% needs the VP has already told the customer
 * 32%; showing it while the discount is being typed is the difference between
 * a guardrail and a complaint.
 */
export function TotalsPanel({ totals, format, showMargin, approvalsRequired, termMonths }: Props) {
  const recurring = totals.netTotal - totals.oneTimeTotal;

  return (
    <div className="space-y-4">
      <div className="leaf rounded-lg border shadow-[0_1px_2px_oklch(0.3_0.04_60/0.06)]">
        <div className="space-y-1 px-4 py-3 text-sm">
          <Line label="List price" value={format.money(totals.listTotal)} muted />
          {totals.lineDiscountAmount !== 0 && (
            <Line label="Line discounts" value={`−${format.money(totals.lineDiscountAmount)}`} muted />
          )}
          <Line label="Subtotal" value={format.money(totals.subtotal)} />
          {totals.quoteDiscountAmount !== 0 && (
            <Line label="Quote discount" value={`−${format.money(totals.quoteDiscountAmount)}`} muted />
          )}
          {totals.quoteAdjustment !== 0 && (
            <Line
              label="Adjustments"
              value={`${totals.quoteAdjustment > 0 ? "+" : ""}${format.money(totals.quoteAdjustment)}`}
              muted
            />
          )}
          {totals.shipping !== 0 && <Line label="Shipping" value={format.money(totals.shipping)} muted />}
          {totals.taxAmount !== 0 && <Line label="Tax" value={format.money(totals.taxAmount)} muted />}

          {/* The one number the customer will read back to you, set the way a
              printed proposal sets it. */}
          <div className="border-primary/30 mt-2 flex items-baseline justify-between border-t-2 pt-2">
            <span className="font-medium">Total</span>
            <span className="text-primary font-serif text-xl font-semibold tabular-nums">
              {format.money(totals.grandTotal)}
            </span>
          </div>

          {totals.effectiveDiscountPercent > 0 && (
            <p className="text-right text-xs text-muted-foreground">
              {format.percent(totals.effectiveDiscountPercent)} off list
            </p>
          )}
        </div>
      </div>

      {/* Revenue shape — the numbers the business reports, not the customer. */}
      {(recurring !== 0 || totals.oneTimeTotal !== 0) && (
        <div className="leaf rounded-lg border px-4 py-3 text-sm">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <TrendingUp className="size-3.5" /> Contract
          </p>
          <Line label="One-time" value={format.money(totals.oneTimeTotal)} muted />
          <Line label={`Recurring (${termMonths} months)`} value={format.money(recurring)} muted />
          <Line label="Monthly recurring" value={format.money(totals.monthlyRecurringTotal)} />
          <Line label="Annual recurring" value={format.money(totals.annualRecurringTotal)} />
          <Line label="Total contract value" value={format.money(totals.totalContractValue)} />
          {showMargin && (
            <>
              <div className="my-2 border-t" />
              <Line label="Cost" value={format.money(totals.costTotal)} muted />
              <Line
                label="Margin"
                value={`${format.money(totals.margin)} · ${format.percent(totals.marginPercent)}`}
                className={cn(totals.marginPercent < 30 && "text-destructive")}
              />
            </>
          )}
        </div>
      )}

      <ApprovalPreview approvals={approvalsRequired} />
    </div>
  );
}

/** What submitting this quote would ask for, before it is submitted. */
function ApprovalPreview({ approvals }: { approvals: ApprovalRequest[] }) {
  if (!approvals.length) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-xs">
        <ShieldCheck className="mt-px size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div>
          <p className="font-medium text-emerald-700 dark:text-emerald-300">No approval needed</p>
          <p className="text-muted-foreground">This quote is within policy and can be sent as soon as it is submitted.</p>
        </div>
      </div>
    );
  }

  // Grouped by level, because that is the order they will actually be asked.
  const levels = [...new Set(approvals.map(request => request.level))].sort((a, b) => a - b);

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
        <ShieldAlert className="size-4" />
        Needs {approvals.length} approval{approvals.length === 1 ? "" : "s"}
      </p>
      <ul className="space-y-2 text-xs">
        {levels.map(level => (
          <li key={level}>
            <p className="text-muted-foreground">Level {level}</p>
            <ul className="mt-0.5 space-y-1">
              {approvals
                .filter(request => request.level === level)
                .map(request => (
                  <li key={request.id} className="flex flex-wrap items-baseline gap-1.5">
                    <Badge tone="pending">{request.ruleName}</Badge>
                    <span className="text-muted-foreground">{request.reason}</span>
                    <span className="text-muted-foreground">
                      ·{" "}
                      {request.approverEmails.length > 1
                        ? `${request.approvalsRequired} of ${request.approverEmails.length}: ${request.approverEmails.join(", ")}`
                        : request.approverEmails[0]}
                    </span>
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Line({
  label,
  value,
  muted,
  className,
}: {
  label: string;
  value: string;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4", className)}>
      <span className={cn(muted && "text-muted-foreground")}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
