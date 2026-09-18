/**
 * The small pieces every screen in the app is built from.
 *
 * They exist so that a number formatted on the quote editor and the same
 * number on the quote list are formatted by the same function, and so that
 * "there is nothing here yet" looks the same wherever it happens.
 */
import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { formatMoney, formatPercent } from "@/lib/money";
import type { CurrencyCode, QuoteStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/* -------------------------------- status --------------------------------- */

/**
 * A quote's status, coloured by what it means for the person reading it:
 * amber is waiting on somebody, green has landed, red came back.
 */
const STATUS_TONE: Record<QuoteStatus, "neutral" | "info" | "pending" | "success" | "danger"> = {
  draft: "neutral",
  in_review: "pending",
  approved: "info",
  rejected: "danger",
  sent: "info",
  accepted: "success",
  declined: "danger",
  expired: "neutral",
};

const STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

export const statusLabel = (status: QuoteStatus) => STATUS_LABEL[status] ?? status;

export function StatusBadge({ status }: { status: QuoteStatus }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{statusLabel(status)}</Badge>;
}

/* ------------------------------- formatting ------------------------------ */

export type Formatter = {
  money: (value: number, currency?: CurrencyCode) => string;
  percent: (value: number) => string;
  date: (value: string) => string;
};

/**
 * Formatters bound to the account's currency and locale, built once per render
 * of a screen and passed down — so a preference change moves every number on
 * the page at the same time.
 */
export function formatters(currency: CurrencyCode, locale: string): Formatter {
  const resolved = locale || undefined;
  return {
    money: (value, override) => formatMoney(value, override ?? currency, resolved),
    percent: value => formatPercent(value),
    date: value => {
      if (!value) return "—";
      const parsed = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
      return Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleDateString(resolved, { year: "numeric", month: "short", day: "numeric" });
    },
  };
}

/* --------------------------------- layout -------------------------------- */

/** A labelled control. `hint` is for the sentence that saves a support email. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

/* --------------------------------- notices ------------------------------- */

const NOTICE_STYLE = {
  error: { className: "bg-destructive/10 text-destructive", Icon: AlertCircle },
  warning: { className: "bg-amber-500/10 text-amber-700 dark:text-amber-300", Icon: AlertTriangle },
  info: { className: "bg-sky-500/10 text-sky-700 dark:text-sky-300", Icon: Info },
} as const;

export type NoticeKind = keyof typeof NOTICE_STYLE;

/**
 * The one way this app tells you something went wrong, or nearly did.
 *
 * A quote carries two separate lists — problems that stop it and things worth
 * knowing — and they are rendered by the same component with different tones,
 * because the difference between them is exactly the tone.
 */
export function Notice({ kind, lines, className }: { kind: NoticeKind; lines: string[]; className?: string }) {
  if (!lines.length) return null;
  const { className: tone, Icon } = NOTICE_STYLE[kind];

  return (
    <div className={cn("flex items-start gap-2 rounded-md p-2.5 text-xs", tone, className)}>
      <Icon className="mt-px size-3.5 shrink-0" />
      <ul className="min-w-0 space-y-1">
        {lines.map((line, index) => (
          <li key={`${index}-${line}`}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** A number that should read as money even before it has been formatted. */
export function Money({ value, format, muted }: { value: number; format: Formatter; muted?: boolean }) {
  return <span className={cn("tabular-nums", muted && "text-muted-foreground")}>{format.money(value)}</span>;
}
