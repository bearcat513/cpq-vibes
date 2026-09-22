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
      // The plant's own signage: signal green for settled, hazard amber for
      // waiting, alert orange for late, red for gone wrong.
      //
      // The fill is the tone at 10% and the text is the tone itself, which is
      // what the lightness of each was solved for: any heavier a fill and the
      // chip closes on its own letters, in the dark theme especially.
      //
      // These are the signal tones and not the accent, deliberately. `success`
      // used to be `primary`, which meant "paid" was whatever colour the
      // account had picked — green for the default and blue or pink for
      // anybody else. A state told by colour has to be told in the same colour
      // every time or it is not telling you anything.
      tone: {
        neutral: "border-transparent bg-muted text-muted-foreground",
        info: "border-transparent bg-chart-4/10 text-chart-4",
        pending: "border-transparent bg-hazard/10 text-hazard",
        success: "border-transparent bg-signal/10 text-signal",
        warn: "border-transparent bg-alert/10 text-alert",
        danger: "border-transparent bg-flare/10 text-flare",
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
