import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A checkbox that reads as a toggle. A real `<input type="checkbox">`
 * underneath, so it is keyboard-operable and announced correctly without any
 * ARIA of its own.
 */
function Switch({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <label className={cn("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center", className)}>
      <input type="checkbox" className="peer sr-only" {...props} />
      <span className="h-5 w-9 rounded-full bg-input transition-colors peer-checked:bg-primary peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 peer-disabled:opacity-50" />
      <span className="pointer-events-none absolute left-0.5 size-4 rounded-full bg-background shadow transition-transform peer-checked:translate-x-4" />
    </label>
  );
}

export { Switch };
