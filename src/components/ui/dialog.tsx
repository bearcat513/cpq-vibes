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
  /** Tailwind max-width for the panel. Wide for editors, narrow for prompts. */
  className?: string;
};

/**
 * A modal, hand-rolled rather than pulled from a library.
 *
 * It needs three behaviours — a backdrop click, Escape, and a focus trap's
 * worth of `aria-modal` — and all three are a few lines. The dependency would
 * be larger than the component.
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
      onClick={event => event.target === event.currentTarget && onClose()}
    >
      <div
        className={cn("my-auto w-full max-w-md rounded-lg border bg-background shadow-lg", className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
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
  );
}
