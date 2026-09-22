import { cn } from "@/lib/utils";

/**
 * The mark, and the lockup it sits in.
 *
 * Drawn here as an inline SVG rather than shipped as a file: it is twenty
 * lines of path data, it has to take its colour from wherever it is placed —
 * a bright plate on painted steel, a pale one on the dark rail — and an
 * `<img>` can do neither of those things. It also means the logo is in the
 * bundle rather than behind a request that can 404 on a fresh install.
 *
 * The shape is a bolt head with its bore knocked through: the smallest thing
 * in the building that holds two others together, which is the job, in one
 * glyph that still reads at sixteen pixels. It turns when pointed at, because
 * that is what a nut does.
 */

export function BrandMark({ className, animated = true }: { className?: string; animated?: boolean }) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[0.3rem] bg-primary text-primary-foreground shadow-sm",
        "size-8",
        className,
      )}
    >
      {/* Light catching the top edge, so the plate reads as machined rather
          than filled. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(120%_120%_at_25%_0%,oklch(1_0_0/0.28),transparent_60%)]"
      />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cn("relative size-[72%] origin-center", animated && "motion-safe:group-hover:animate-tilt")}
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M12 1.7 21.3 7.05v10.7L12 23.1 2.7 17.75V7.05L12 1.7Zm0 6.05a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5Z"
          fill="currentColor"
          opacity="0.94"
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
        <span className="block font-display text-lg leading-none font-semibold tracking-tight">CPQ</span>
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
 * The mark drawn faintly behind an empty state.
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
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 1.7 21.3 7.05v10.7L12 23.1 2.7 17.75V7.05L12 1.7Zm0 6.05a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
