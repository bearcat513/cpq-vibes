import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A small status pill. `tone` carries meaning rather than decoration — a quote
 * in review and a quote that was declined should not look the same at a
 * glance, which is the only reason anyone scans a list of quotes.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-200 [&_svg]:size-3",
  {
    variants: {
      // Tones out of the same wood as the rest of the palette: moss for
      // settled, ochre for waiting, clay for gone wrong, lichen for in hand.
      tone: {
        neutral: "border-transparent bg-muted text-muted-foreground",
        info: "border-transparent bg-chart-4/15 text-chart-4 dark:text-chart-4",
        pending: "border-transparent bg-chart-2/20 text-chart-3 dark:text-chart-2",
        success: "border-transparent bg-primary/15 text-primary",
        danger: "border-transparent bg-destructive/15 text-destructive",
        outline: "border-border/80 text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

function Badge({ className, tone, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
