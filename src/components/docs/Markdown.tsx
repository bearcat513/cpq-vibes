import { Fragment } from "react";
import { parseMarkdown, type Block, type Span } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/**
 * A description out of the OpenAPI document, rendered.
 *
 * Spans arrive already parsed, so every one of them lands as a React element
 * and nothing in a description can reach the page as markup. A heading is
 * drawn a size smaller than its level asks for: these sit inside a panel,
 * under the page's own headings, and are not competing with them.
 */

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <Fragment key={index}>
          {span.kind === "code" ? (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{span.text}</code>
          ) : span.kind === "strong" ? (
            <strong className="font-semibold text-foreground">{span.text}</strong>
          ) : span.kind === "link" ? (
            <a
              href={span.href}
              className="text-primary underline underline-offset-2 hover:no-underline"
              rel="noreferrer noopener"
            >
              {span.text}
            </a>
          ) : (
            span.text
          )}
        </Fragment>
      ))}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h3 key={index} className="mt-4 mb-1 font-serif text-sm font-semibold text-foreground first:mt-0">
              <Spans spans={block.spans} />
            </h3>
          );
        }

        if (block.kind === "list") {
          return (
            <ul key={index} className="my-1.5 list-disc space-y-1 pl-4 marker:text-muted-foreground/60">
              {block.items.map((item, position) => (
                <li key={position}>
                  <Spans spans={item} />
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={index} className="my-1.5 first:mt-0 last:mb-0">
            <Spans spans={block.spans} />
          </p>
        );
      })}
    </>
  );
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  if (!source.trim()) return null;
  return (
    <div className={cn("text-sm leading-relaxed text-muted-foreground", className)}>
      <Blocks blocks={parseMarkdown(source)} />
    </div>
  );
}
