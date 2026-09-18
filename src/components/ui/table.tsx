import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The data table used by every list in the app.
 *
 * `Td`/`Th` take `numeric`, which right-aligns and switches to tabular
 * figures. Money in a proportional font does not line up column-wise, and a
 * column of prices that does not line up is a column nobody can scan.
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

const Thead = ({ className, ...props }: React.ComponentProps<"thead">) => (
  <thead className={cn("[&_tr]:border-b", className)} {...props} />
);

const Tbody = ({ className, ...props }: React.ComponentProps<"tbody">) => (
  <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
);

const Tr = ({ className, ...props }: React.ComponentProps<"tr">) => (
  <tr className={cn("border-b transition-colors hover:bg-muted/40", className)} {...props} />
);

const Th = ({ className, numeric, ...props }: React.ComponentProps<"th"> & { numeric?: boolean }) => (
  <th
    className={cn(
      "px-3 py-2 text-left align-middle text-xs font-medium tracking-wide text-muted-foreground uppercase",
      numeric && "text-right",
      className,
    )}
    {...props}
  />
);

const Td = ({ className, numeric, ...props }: React.ComponentProps<"td"> & { numeric?: boolean }) => (
  <td
    className={cn("px-3 py-2 align-middle", numeric && "text-right tabular-nums", className)}
    {...props}
  />
);

export { Table, Tbody, Td, Th, Thead, Tr };
