import type { Method } from "@/lib/openapiDoc";
import { cn } from "@/lib/utils";

/**
 * The method chip every reference page has, because a wall of paths is
 * unreadable without one.
 *
 * These are the one place in the app that departs from "moss means done, clay
 * means wrong": a method is not a status, and a reader who has seen any other
 * API's docs already knows that red means delete. They are drawn in the
 * palette's own inks rather than raw Tailwind colours, so they still look like
 * this app at dusk.
 */
const METHOD_CLASS: Record<Method, string> = {
  get: "bg-chart-4/15 text-chart-4 ring-chart-4/25",
  post: "bg-chart-1/15 text-chart-1 ring-chart-1/30",
  put: "bg-chart-2/20 text-chart-3 ring-chart-2/30 dark:text-chart-2",
  patch: "bg-chart-5/15 text-chart-5 ring-chart-5/30",
  delete: "bg-destructive/12 text-destructive ring-destructive/25",
};

export function MethodBadge({ method, className }: { method: Method; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex w-16 shrink-0 justify-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide uppercase ring-1 ring-inset",
        METHOD_CLASS[method],
        className,
      )}
    >
      {method}
    </span>
  );
}
