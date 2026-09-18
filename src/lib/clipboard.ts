/**
 * Clipboard writes for text the app already holds in memory.
 *
 * `navigator.clipboard` needs a secure context, which a dev server reached over
 * a plain-http LAN address is not, so fall back to the legacy selection trick
 * rather than leaving the copy buttons dead in that setup.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // A denied permission and an insecure origin both land here — try the fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Off-screen but still selectable; execCommand ignores hidden nodes.
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) throw new Error("The browser blocked the clipboard write.");
}

/** The name this helper had before the app was a CPQ. */
export const copyToClipboard = copyText;
