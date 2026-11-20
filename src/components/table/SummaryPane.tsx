import type { ReactNode } from "react";
import { Info, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ComputedSummary } from "@/lib/workspace";

/**
 * The record summary: the column of numbers beside a record, laid out by its
 * collection's workspace and worked out by the server as the reader. It
 * looks like the quote editor's totals panel on purpose — a heading, the
 * lines, and the one line the panel is about set apart under a rule.
 *
 * Given a height (the workspace's third pane), the heading stays and the
 * lines scroll beneath it.
 */
export function SummaryPane({
  summary,
  loading,
  preview,
  className,
  footer,
}: {
  summary: ComputedSummary | null;
  loading?: boolean;
  /** Drawn from a draft layout in the editor, not the stored one. */
  preview?: boolean;
  className?: string;
  /** A note under the lines, inside the panel's scroll. */
  footer?: ReactNode;
}) {
  const lines = summary?.lines ?? [];

  return (
    <section
      aria-label="Record summary"
      className={cn(
        "panel motion-safe:animate-rise flex flex-col overflow-hidden rounded-lg border shadow-[0_1px_2px_var(--cast)]",
        className,
      )}
    >
      <div className="seam flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <h2 className="font-display text-[0.95rem] leading-tight font-semibold tracking-tight">Summary</h2>
        {preview && <Badge tone="pending">preview</Badge>}
        {loading && <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" aria-label="Working it out" />}
        {summary && !loading && <span className="ml-auto font-mono text-[11px] text-muted-foreground">{summary.currency}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
      {lines.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          {summary ? "Nothing to summarize yet — add lines under Customize." : "Working it out…"}
        </p>
      ) : (
        <dl className={cn("px-4 py-2 transition-opacity", loading && "opacity-60")}>
          {lines.map((line, index) =>
            line.kind === "heading" ? (
              <dt
                key={line.key}
                className={cn(
                  "pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
                  index === 0 && "pt-1",
                )}
              >
                {line.label}
              </dt>
            ) : (
              <div
                key={line.key}
                className={cn(
                  "flex items-baseline justify-between gap-3 py-1 text-sm",
                  line.emphasis && "mt-1 border-t-2 border-primary pt-2",
                )}
              >
                <dt className={cn("min-w-0 truncate text-muted-foreground", line.emphasis && "font-medium text-foreground")}>
                  {line.label}
                </dt>
                <dd
                  className={cn(
                    "flex shrink-0 items-center gap-1 text-right tabular-nums",
                    line.emphasis && "font-display text-lg font-semibold",
                    line.display === "—" && "text-muted-foreground",
                  )}
                  title={line.note || undefined}
                >
                  {line.note && <Info className="size-3 text-hazard" aria-label={line.note} />}
                  {line.format === "badge" && line.display !== "—" ? <Badge tone="outline">{line.display}</Badge> : line.display}
                </dd>
              </div>
            ),
          )}
        </dl>
      )}
      {footer && <div className="px-4 pt-1 pb-3 text-[11px] text-muted-foreground">{footer}</div>}
      </div>
    </section>
  );
}
