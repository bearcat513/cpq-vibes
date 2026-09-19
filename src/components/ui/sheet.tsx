import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Widen it for a form that genuinely needs the room. */
  className?: string;
};

/**
 * A form panel that slides in from the right and owns the full height of the
 * window.
 *
 * This is where every editor in the app lives. A centred modal fights the work
 * it is used for: it covers the list you were reading, it cannot be as tall as
 * the screen, and a long form inside one scrolls in a box floating over
 * another scrollable box. A side panel leaves the record you came from visible
 * beside it, and gets the whole column height for free.
 *
 * ## Why the body is a container
 *
 * The panel is a fraction of the window, so a form inside it cannot size
 * itself against the viewport: `sm:grid-cols-4` would still be four columns in
 * a 500px panel on a wide screen. The scroll area is a `@container`, so the
 * forms use container queries (`@md:grid-cols-2`) and lay themselves out
 * against the panel they are actually in.
 *
 * ## What still belongs in a modal
 *
 * Anything meant to be *read* rather than filled in — a rendered proposal, a
 * PDF preview — stays a wide `Dialog`. A document squeezed into a third of the
 * screen is a document nobody can check.
 */
export function Sheet({ title, description, onClose, children, footer, className }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    // The page behind must not scroll under the panel.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* The backdrop dims the page and is the other way out of the panel. */}
      <div
        className="animate-in fade-in absolute inset-0 bg-[oklch(0.22_0.03_60/0.45)] backdrop-blur-[1px] duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "leaf relative flex h-full w-full flex-col border-l shadow-[-24px_0_48px_-24px_oklch(0.25_0.04_60/0.35)]",
          // A third of the window on a desktop, with a floor so it stays
          // usable on a laptop, and the whole width on a phone where 35% of
          // the screen is not a form.
          "sm:w-[35%] sm:min-w-[26rem]",
          "animate-in slide-in-from-right-4 fade-in duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          className,
        )}
      >
        <header className="double-rule bg-card/60 flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-serif text-[0.95rem] font-semibold tracking-tight">{title}</h2>
            {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </header>

        {/* The only scrolling region: the header and footer stay put. */}
        <div className="@container min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">{footer}</footer>
        )}
      </aside>
    </div>
  );
}
