import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Portal } from "@/components/ui/portal";
import { cn } from "@/lib/utils";

type Props = {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Tailwind max-width for the panel. Wide for editors, narrow for prompts. */
  className?: string;
};

/**
 * A modal, hand-rolled rather than pulled from a library.
 *
 * It needs three behaviours — a backdrop click, Escape, and a focus trap's
 * worth of `aria-modal` — and all three are a few lines. The dependency would
 * be larger than the component.
 *
 * It is portalled onto `<body>` for the same reason `Sheet` is: a `fixed`
 * backdrop under a transformed ancestor covers that ancestor rather than the
 * window, and a modal that only dims part of the page is not a modal.
 */
export function Dialog({ title, description, onClose, children, footer, className }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    // The page behind a modal should not scroll under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <Portal>
      <div
        className="animate-in fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--scrim)] p-4 backdrop-blur-[1px] duration-200 sm:items-center"
        onClick={event => event.target === event.currentTarget && onClose()}
      >
        <div
          className={cn(
            "panel animate-in zoom-in-95 slide-in-from-bottom-2 my-auto w-full max-w-md rounded-xl border shadow-2xl duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]",
            className,
          )}
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <div className="seam flex items-start justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate font-display text-[0.95rem] font-semibold tracking-tight">{title}</h2>
              {description && <p className="text-xs text-muted-foreground">{description}</p>}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>

          <div className="px-4 py-3">{children}</div>

          {footer && <div className="flex items-center justify-end gap-2 border-t px-4 py-3">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}
