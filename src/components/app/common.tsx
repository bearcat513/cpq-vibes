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
import { BrandWatermark } from "./Brand";
import { Label } from "@/components/ui/label";
import { formatMoney, formatPercent } from "@/lib/money";
import {
  ACCOUNT_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  type AccountStatus,
  type CurrencyCode,
  type InvoiceStatus,
  type QuoteStatus,
} from "@/lib/types";
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

/**
 * A customer's standing, coloured the same way: ochre for somebody you are
 * still chasing, moss for somebody who has bought, and nothing at all for
 * somebody you have stopped quoting.
 */
const ACCOUNT_STATUS_TONE: Record<AccountStatus, "neutral" | "pending" | "success"> = {
  prospect: "pending",
  customer: "success",
  inactive: "neutral",
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return <Badge tone={ACCOUNT_STATUS_TONE[status] ?? "neutral"}>{ACCOUNT_STATUS_LABELS[status] ?? status}</Badge>;
}

/**
 * An invoice's condition — worked out by `invoiceStatus`, never stored.
 *
 * Clay for overdue, because it is the one that needs somebody to pick up the
 * phone; moss for paid; and nothing for a draft, which is not yet a
 * receivable and should not look like one.
 */
const INVOICE_STATUS_TONE: Record<InvoiceStatus, "neutral" | "info" | "pending" | "success" | "danger"> = {
  draft: "neutral",
  open: "info",
  part_paid: "pending",
  paid: "success",
  overdue: "danger",
  void: "neutral",
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge tone={INVOICE_STATUS_TONE[status] ?? "neutral"}>{INVOICE_STATUS_LABELS[status] ?? status}</Badge>;
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
    <section
      className={cn(
        "leaf motion-safe:animate-rise rounded-lg border shadow-[0_1px_2px_oklch(0.3_0.04_60/0.06)]",
        className,
      )}
    >
      {/* A printed page rules twice under a heading: a firm line and a
          hairline. `double-rule` is the second one. */}
      <div className="double-rule flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-serif text-[0.95rem] leading-tight font-semibold tracking-tight">{title}</h2>
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
    <div className="relative overflow-hidden px-4 py-10 text-center">
      {/* The one screen with room for decoration, and the one that most needs
          to look deliberate rather than broken. */}
      <BrandWatermark className="-top-3 left-1/2 size-28 -translate-x-1/2" />
      <p className="relative font-serif text-base font-semibold">{title}</p>
      {children && <div className="relative mx-auto mt-1 max-w-md text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

/* --------------------------------- notices ------------------------------- */

const NOTICE_STYLE = {
  error: { className: "bg-destructive/10 text-destructive border-destructive/20", Icon: AlertCircle },
  warning: { className: "bg-chart-2/15 text-chart-3 border-chart-2/25 dark:text-chart-2", Icon: AlertTriangle },
  // Slate rather than moss: green already means "this went well" on a badge,
  // and an informational line is not a result.
  info: { className: "bg-chart-4/12 text-chart-4 border-chart-4/25", Icon: Info },
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
    <div
      className={cn(
        "motion-safe:animate-settle flex items-start gap-2 rounded-md border p-2.5 text-xs",
        tone,
        className,
      )}
    >
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
