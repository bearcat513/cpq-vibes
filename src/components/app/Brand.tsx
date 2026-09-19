import { cn } from "@/lib/utils";

/**
 * The mark, and the lockup it sits in.
 *
 * Drawn here as an inline SVG rather than shipped as a file: it is forty lines
 * of path data, it has to take its colour from wherever it is placed — a
 * green seal on parchment, a pale leaf on bark — and an `<img>` can do neither
 * of those things. It also means the logo is in the bundle rather than behind
 * a request that can 404 on a fresh install.
 *
 * The shape is a leaf on a seal: the paper the app produces, and the thing the
 * palette is borrowed from, in one glyph that still reads at sixteen pixels.
 */

export function BrandMark({ className, animated = true }: { className?: string; animated?: boolean }) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[0.55rem] bg-primary text-primary-foreground shadow-sm",
        "size-8",
        className,
      )}
    >
      {/* A wash across the seal, so it reads as pressed rather than printed. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(120%_120%_at_25%_0%,oklch(1_0_0/0.28),transparent_60%)]"
      />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cn("relative size-[68%] origin-bottom-left", animated && "motion-safe:group-hover:animate-sway")}
      >
        <path
          d="M20.4 3.2c1 7.9-2.9 14.3-9.4 15.8-3.2.8-6-.2-7.1-2.5-1.5-3.1.4-6.8 3.8-8.9C11.3 5.4 15.7 4.2 20.4 3.2Z"
          fill="currentColor"
          opacity="0.92"
        />
        <path
          d="M3.9 20.8C7.3 15 12.4 10.4 18.9 7"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/**
 * Mark plus name.
 *
 * `tagline` is opt-in because it only fits where there is room for it: the
 * sign-in screen has a whole page, the navigation rail is fourteen rems wide
 * and would wrap "configure · price · quote" onto two lines.
 */
export function BrandLockup({
  tagline,
  className,
  markClassName,
}: {
  tagline?: string;
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("group flex items-center gap-2.5", className)}>
      <BrandMark className={markClassName} />
      <span className="min-w-0">
        <span className="block font-serif text-lg leading-none font-semibold tracking-tight">CPQ</span>
        {tagline && (
          <span className="mt-1 block text-[0.6rem] leading-none tracking-[0.16em] text-muted-foreground uppercase">
            {tagline}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * A leaf drawn faintly behind an empty state.
 *
 * An empty list is the one screen with room for decoration, and the one that
 * most needs to look deliberate rather than broken.
 */
export function BrandWatermark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("pointer-events-none absolute -top-2 right-4 size-24 text-foreground/[0.04]", className)}
    >
      <path
        d="M20.4 3.2c1 7.9-2.9 14.3-9.4 15.8-3.2.8-6-.2-7.1-2.5-1.5-3.1.4-6.8 3.8-8.9C11.3 5.4 15.7 4.2 20.4 3.2Z"
        fill="currentColor"
      />
      <path d="M3.9 20.8C7.3 15 12.4 10.4 18.9 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
