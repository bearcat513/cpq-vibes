import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * Lifts an overlay out of the view that opened it and onto `<body>`.
 *
 * `position: fixed` is only fixed to the window while nothing above it has a
 * transform, a filter or a `will-change` — any of those makes the ancestor the
 * containing block instead, and the overlay is then pinned to, and sized
 * against, whatever happened to be on screen. The app's entrance animations do
 * exactly that: every screen is rendered inside `animate-unfurl`, so a panel
 * rendered in place gets the height of the view's content rather than the
 * height of the window.
 *
 * Portalling sidesteps the whole class of it — a child of `<body>` has no
 * such ancestor, whatever the screen it was opened from is doing — and it is
 * the same move `Combobox` makes for the same reason.
 *
 * Server rendering has no `document` and no portals, so there the node is
 * returned where it stands; the markup is identical either way, which is what
 * `sheet.test.tsx` reads.
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}
