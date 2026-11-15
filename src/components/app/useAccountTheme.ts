import { useEffect } from "react";
import type { SessionUser } from "@/lib/api";

/**
 * The signed-in account's look, applied to a page outside the app (`/docs`,
 * `/table`) as it is to the app.
 *
 * The same three attributes `App.tsx` puts on `<html>`, for the same reason:
 * a page that flashed white against a dark app would announce that
 * it is a different page, which it is not.
 */
export function useAccountTheme(user: SessionUser | null) {
  const theme = user?.preferences.theme ?? "system";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    if (!user) return;
    document.documentElement.dataset.accent = user.preferences.accent;
    document.documentElement.dataset.font = user.preferences.font;
    document.documentElement.dataset.motion = user.preferences.motion;
  }, [user?.preferences.accent, user?.preferences.font]);
}
