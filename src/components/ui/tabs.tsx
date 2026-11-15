import * as React from "react";

import { cn } from "@/lib/utils";

export type TabItem<T extends string> = {
  id: T;
  label: string;
  icon?: React.ReactNode;
};

type TabsProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  items: TabItem<T>[];
  /** Names the tab list for a screen reader: "Settings". */
  "aria-label": string;
  /** Prefixes the ids that tie each tab to its panel; unique per page. */
  idPrefix: string;
  className?: string;
  /** Anything to show at the far end of the strip — a save indicator, say. */
  trailing?: React.ReactNode;
};

/**
 * A strip of tabs, built to the WAI-ARIA tabs pattern: one tab in the tab
 * order at a time, arrows move between them, Home and End jump to the ends,
 * and moving selects (automatic activation — every panel here is already on
 * the page, so there is nothing to wait for).
 *
 * The strip scrolls sideways rather than wrapping when it runs out of room,
 * so a phone gets one line of tabs, not a second row that looks like a
 * second level.
 */
function Tabs<T extends string>({ value, onValueChange, items, idPrefix, className, trailing, ...rest }: TabsProps<T>) {
  const refs = React.useRef(new Map<T, HTMLButtonElement>());

  const move = (event: React.KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = items[next]!;
    onValueChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div data-slot="tabs" className={cn("panel flex items-stretch rounded-lg border", className)}>
      <div role="tablist" aria-label={rest["aria-label"]} className="flex min-w-0 flex-1 overflow-x-auto">
        {items.map((item, index) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              ref={element => {
                if (element) refs.current.set(item.id, element);
                else refs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(item.id)}
              onKeyDown={event => move(event, index)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 px-3.5 py-2.5 text-sm whitespace-nowrap outline-none",
                "transition-colors focus-visible:bg-accent/60 [&_svg]:size-4 [&_svg]:shrink-0",
                // The selected tab is marked by a bar along the strip's edge —
                // the same scribed line the nav uses for where you are.
                "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
                selected
                  ? "font-medium text-foreground after:bg-primary"
                  : "text-muted-foreground hover:text-foreground after:bg-transparent",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
      {trailing && <div className="hidden shrink-0 items-center px-3 sm:flex">{trailing}</div>}
    </div>
  );
}

/** The panel a tab controls. Only the selected one is rendered. */
function TabPanel({
  idPrefix,
  id,
  className,
  children,
}: {
  idPrefix: string;
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      tabIndex={0}
      className={cn("space-y-4 outline-none", className)}
    >
      {children}
    </div>
  );
}

export { Tabs, TabPanel };
