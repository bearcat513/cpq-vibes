import { shortcutCaps, isMacPlatform } from "@/lib/commands";
import { cn } from "@/lib/utils";

/**
 * A shortcut, printed as key caps: ⌘ K on a Mac, Ctrl K elsewhere, G Q for a
 * sequence. `aria-hidden` by default, because a screen reader announcing
 * "command K" beside every command is noise — pass `label` where the keys are
 * the information rather than decoration.
 */
export function Kbd({ keys, className, label }: { keys: readonly string[]; className?: string; label?: boolean }) {
  if (!keys.length) return null;
  const caps = shortcutCaps(keys, isMacPlatform());
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label ? caps.join(" ") : undefined}
    >
      {caps.map((cap, index) => (
        <kbd
          key={`${index}-${cap}`}
          className="inline-grid h-5 min-w-5 place-items-center rounded-sm border border-b-2 bg-muted/60 px-1 font-sans text-[10px] font-medium text-muted-foreground"
        >
          {cap}
        </kbd>
      ))}
    </span>
  );
}
