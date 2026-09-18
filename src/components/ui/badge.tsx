import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A small status pill. `tone` carries meaning rather than decoration — a quote
 * in review and a quote that was declined should not look the same at a
 * glance, which is the only reason anyone scans a list of quotes.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border-transparent bg-muted text-muted-foreground",
        info: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
        pending: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
        success: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        danger: "border-transparent bg-destructive/15 text-destructive",
        outline: "border-border text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

function Badge({ className, tone, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
