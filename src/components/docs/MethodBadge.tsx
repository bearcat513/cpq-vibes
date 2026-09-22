import type { Method } from "@/lib/openapiDoc";
import { cn } from "@/lib/utils";

/**
 * The method chip every reference page has, because a wall of paths is
 * unreadable without one.
 *
 * These are the one place in the app that departs from "signal green means
 * done, alert orange means late": a method is not a status, and a reader who
 * has seen any other API's docs already knows that red means delete. They are
 * drawn in the palette's own colours rather than raw Tailwind ones, so they
 * still look like this app on the night shift.
 */
const METHOD_CLASS: Record<Method, string> = {
  get: "bg-chart-4/10 text-chart-4 ring-chart-4/25",
  post: "bg-chart-1/10 text-chart-1 ring-chart-1/30",
  put: "bg-hazard/10 text-hazard ring-hazard/30",
  patch: "bg-chart-5/10 text-chart-5 ring-chart-5/30",
  delete: "bg-flare/10 text-flare ring-flare/25",
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
