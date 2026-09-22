import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { tokenize, type TokenKind } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/**
 * A block of JSON or a shell command, coloured, with a copy button in its
 * corner.
 *
 * Tokens are rendered as elements rather than as markup, so a response body
 * from the server is text on this page no matter what it contains — a customer
 * name with a tag in it included. A cURL command comes through `plain`, which
 * is right, since none of it is JSON.
 */

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "",
  key: "text-chart-4",
  string: "text-chart-1",
  number: "text-chart-5",
  literal: "text-chart-3 dark:text-chart-2",
  punctuation: "text-muted-foreground/70",
};

type Props = {
  code: string;
  /** Plain text — a header dump, an error — is not coloured as JSON. */
  plain?: boolean;
  className?: string;
  /** What the copy button puts on the clipboard, when not the code itself. */
  copyText?: string;
  label?: string;
};

export function CodeBlock({ code, plain = false, className, copyText: override, label }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await copyText(override ?? code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The text is on screen and selectable; a failed copy is not worth an alert.
    }
  }

  return (
    <div className={cn("group relative", className)}>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5">
        <code>
          {plain
            ? code
            : tokenize(code).map((token, index) => (
                <span key={index} className={TOKEN_CLASS[token.kind]}>
                  {token.text}
                </span>
              ))}
        </code>
      </pre>

      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label ? `Copy ${label}` : "Copy"}
        className="absolute top-2 right-2 rounded-md border bg-card/90 p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {copied ? <Check className="size-3.5 text-chart-1" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
