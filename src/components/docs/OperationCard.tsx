import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2, Lock, LockOpen, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { Markdown } from "@/components/docs/Markdown";
import { MethodBadge } from "@/components/docs/MethodBadge";
import { SchemaView } from "@/components/docs/SchemaView";
import {
  anchorId,
  buildRequest,
  constraints,
  credentialVariable,
  exampleBody,
  exampleFor,
  requestUrl,
  trialCurl,
  typeLabel,
  type ApiResponse,
  type Credential,
  type OpenApiDoc,
  type Operation,
  type ParamValues,
  type Parameter,
} from "@/lib/openapiDoc";
import { cn } from "@/lib/utils";

/**
 * One endpoint: what it takes, what it answers with, and a way to call it.
 *
 * The call is the point. Everything above it — the parameters, the body, the
 * documented responses — is the document rendered; the panel at the bottom is
 * the request actually going out from this browser, with whatever credential
 * the reader gave at the top of the page. A reference that can only be read is
 * half of one.
 */

type Props = {
  doc: OpenApiDoc;
  operation: Operation;
  base: string;
  credential: Credential;
  open: boolean;
  onToggle: () => void;
  /** Takes the reader to the credential box when a call comes back 401. */
  onNeedsCredential: () => void;
};

/** What came back from a trial call, or why nothing did. */
type Result =
  | {
      kind: "sent";
      status: number;
      statusText: string;
      ms: number;
      headers: [string, string][];
      body: string;
      /** Pretty-printed rather than raw, so it is coloured as JSON. */
      json: boolean;
    }
  | { kind: "failed"; message: string };

/**
 * Why nothing came back.
 *
 * `fetch` rejects with a bare "Failed to fetch" for every reason a request
 * never left the browser, which tells a reader nothing and sounds like a bug
 * in the page. The three causes worth naming are the ones that depend on where
 * the call was aimed, so the URL is quoted back with them.
 */
function whyItFailed(error: unknown, url: string): string {
  if (error instanceof TypeError) {
    return (
      `The browser could not reach ${url}, so nothing was sent. ` +
      "That is usually the server being down, an address that is not this page's own origin " +
      "(which would need CORS), or an http call from an https page."
    );
  }
  return error instanceof Error ? error.message : "The request could not be sent.";
}

/** A parameter's own default, so the boxes start where the server would. */
function initialValues(parameters: Parameter[]): ParamValues {
  const values: ParamValues = {};
  for (const parameter of parameters) {
    const fallback = parameter.schema.default;
    if (fallback !== undefined && fallback !== null) values[parameter.name] = String(fallback);
  }
  return values;
}

/** The small caps heading the app uses over a group of controls. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </section>
  );
}

function ParameterRow({
  doc,
  parameter,
  trying,
  value,
  onChange,
}: {
  doc: OpenApiDoc;
  parameter: Parameter;
  trying: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const options = parameter.schema.enum;
  const notes = constraints(parameter.schema);
  const id = `param-${parameter.in}-${parameter.name}`;

  return (
    <div className="grid gap-2 border-t py-2.5 first:border-t-0 first:pt-0 @sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
      <div className="space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <label htmlFor={id} className="font-mono text-xs font-medium text-foreground">
            {parameter.name}
          </label>
          {parameter.required && <span className="text-[11px] font-medium text-destructive">*</span>}
          <span className="text-[11px] text-muted-foreground/80">{parameter.in}</span>
        </div>
        <p className="font-mono text-[11px] text-primary/80">{typeLabel(doc, parameter.schema)}</p>
        {notes.length > 0 && <p className="text-[11px] text-muted-foreground/80">{notes.join(" · ")}</p>}
      </div>

      <div className="space-y-1.5">
        {parameter.description && <Markdown source={parameter.description} className="text-xs" />}

        {Array.isArray(options) && (
          <p className="font-mono text-[11px] text-muted-foreground">{options.map(String).join(" | ")}</p>
        )}

        {trying && (
          <Input
            id={id}
            value={value}
            onChange={event => onChange(event.target.value)}
            placeholder={Array.isArray(options) ? options.map(String).join(" | ") : typeLabel(doc, parameter.schema)}
            className="h-8 font-mono text-xs"
          />
        )}
      </div>
    </div>
  );
}

/** The tone a status reads in: moss for good, ochre for refused, clay for broken. */
function statusTone(status: number): string {
  if (status >= 200 && status < 300) return "text-chart-1";
  if (status >= 500) return "text-destructive";
  if (status >= 400) return "text-chart-3 dark:text-chart-2";
  return "text-muted-foreground";
}

/** A documented response: its example, or the shape behind it. */
function ResponseRow({ doc, response }: { doc: OpenApiDoc; response: ApiResponse }) {
  const [showSchema, setShowSchema] = useState(false);
  const [mediaIndex, setMediaIndex] = useState(0);

  const media = response.media[mediaIndex] ?? response.media[0];
  const example = media ? exampleFor(doc, media.schema) : undefined;

  return (
    <div className="space-y-2 border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cn("font-mono text-xs font-semibold", statusTone(Number(response.status)))}>
          {response.status}
        </span>
        <p className="flex-1 text-xs text-muted-foreground">{response.description}</p>

        {media && (
          <div className="flex items-center gap-1">
            {response.media.length > 1 &&
              response.media.map((entry, index) => (
                <button
                  key={entry.mediaType}
                  type="button"
                  onClick={() => setMediaIndex(index)}
                  aria-pressed={index === mediaIndex}
                  className={cn(
                    "rounded px-1.5 py-0.5 font-mono text-[11px]",
                    index === mediaIndex ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry.mediaType}
                </button>
              ))}
            <button
              type="button"
              onClick={() => setShowSchema(!showSchema)}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {showSchema ? "Example" : "Schema"}
            </button>
          </div>
        )}
      </div>

      {media &&
        (showSchema ? (
          <div className="rounded-md border bg-background/60 p-3">
            <SchemaView doc={doc} schema={media.schema} />
          </div>
        ) : (
          <CodeBlock
            code={
              media.mediaType === "application/json"
                ? JSON.stringify(example, null, 2)
                : String(example ?? media.mediaType)
            }
            label="the example response"
          />
        ))}
    </div>
  );
}

export function OperationCard({ doc, operation, base, credential, open, onToggle, onNeedsCredential }: Props) {
  const [trying, setTrying] = useState(false);
  const [values, setValues] = useState<ParamValues>(() => initialValues(operation.parameters));
  const [body, setBody] = useState(() => exampleBody(doc, operation.body));
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [showBodySchema, setShowBodySchema] = useState(false);

  const request = buildRequest(operation, { base, values, body, credential });
  const missing = operation.parameters.filter(parameter => parameter.required && !values[parameter.name]?.trim());

  async function execute() {
    setSending(true);
    setResult(null);
    const started = performance.now();

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers.map(header => [header.name, header.value])),
        ...(request.body === undefined ? {} : { body: request.body }),
        // The session cookie is httpOnly and same-origin: sending it is what
        // lets someone already signed in to the app try a call without first
        // issuing themselves a key.
        credentials: "same-origin",
      });

      const text = await response.text();
      let printed = text;
      let json = false;
      try {
        printed = JSON.stringify(JSON.parse(text), null, 2);
        json = true;
      } catch {
        // A CSV download, a PDF, or an empty body — shown as it arrived.
      }

      setResult({
        kind: "sent",
        status: response.status,
        statusText: response.statusText,
        ms: Math.round(performance.now() - started),
        headers: [...response.headers.entries()],
        body: printed,
        json,
      });

      if (response.status === 401) onNeedsCredential();
    } catch (error) {
      setResult({ kind: "failed", message: whyItFailed(error, request.url) });
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setValues(initialValues(operation.parameters));
    setBody(exampleBody(doc, operation.body));
    setResult(null);
  }

  const curl = trialCurl(request);
  const variable = credentialVariable(request);
  const command = variable ? `export ${variable}=…\n\n${curl}` : curl;

  return (
    <article
      id={anchorId(operation)}
      className="leaf @container scroll-mt-24 overflow-hidden rounded-lg border shadow-[0_1px_2px_oklch(0.3_0.04_60/0.06)]"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
      >
        <MethodBadge method={operation.method} />
        <span className="font-mono text-xs font-medium break-all text-foreground">{operation.path}</span>
        <span className="hidden flex-1 truncate text-xs text-muted-foreground @sm:block">{operation.summary}</span>

        <span
          title={operation.anonymous ? "No credential needed" : "Needs a credential"}
          className="shrink-0 text-muted-foreground/70"
        >
          {operation.anonymous ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="motion-safe:animate-unfurl space-y-5 border-t px-4 py-4">
          <p className="text-xs text-muted-foreground @sm:hidden">{operation.summary}</p>
          {operation.description && <Markdown source={operation.description} className="text-xs" />}

          {operation.parameters.length > 0 && (
            <Section title="Parameters">
              <div className="rounded-md border px-3 py-2">
                {operation.parameters.map(parameter => (
                  <ParameterRow
                    key={`${parameter.in}-${parameter.name}`}
                    doc={doc}
                    parameter={parameter}
                    trying={trying}
                    value={values[parameter.name] ?? ""}
                    onChange={value => setValues({ ...values, [parameter.name]: value })}
                  />
                ))}
              </div>
            </Section>
          )}

          {operation.body && (
            <Section title={`Request body${operation.body.required ? " · required" : ""}`}>
              {operation.body.description && <Markdown source={operation.body.description} className="text-xs" />}

              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{operation.body.mediaType}</span>
                <button
                  type="button"
                  onClick={() => setShowBodySchema(!showBodySchema)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {showBodySchema ? "Example" : "Schema"}
                </button>
              </div>

              {showBodySchema ? (
                <div className="rounded-md border bg-background/60 p-3">
                  <SchemaView doc={doc} schema={operation.body.schema} />
                </div>
              ) : trying ? (
                <Textarea
                  value={body}
                  onChange={event => setBody(event.target.value)}
                  spellCheck={false}
                  aria-label="Request body"
                  className="min-h-40 font-mono text-xs"
                />
              ) : (
                <CodeBlock code={body || "{}"} label="the example body" />
              )}
            </Section>
          )}

          {/* ------------------------------ trying ----------------------------- */}

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            {trying ? (
              <>
                <Button size="sm" onClick={() => void execute()} disabled={sending}>
                  {sending ? <Loader2 className="animate-spin" /> : <Play />}
                  {sending ? "Sending" : "Execute"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setTrying(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="ghost" onClick={reset}>
                  <RotateCcw />
                  Reset
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setTrying(true)}>
                <Play />
                Try it out
              </Button>
            )}

            {trying && missing.length > 0 && (
              <p className="text-[11px] text-chart-3 dark:text-chart-2">
                Still needs {missing.map(parameter => parameter.name).join(", ")}.
              </p>
            )}
            {trying && !operation.anonymous && credential.kind === "none" && (
              <p className="text-[11px] text-muted-foreground">
                No key set — the call goes out on your session cookie, if you have one.
              </p>
            )}
          </div>

          {trying && (
            <Section title="Request">
              <p className="font-mono text-xs break-all text-muted-foreground">
                {request.method} {requestUrl(base, operation, values)}
              </p>
              <CodeBlock code={command} plain label="the cURL command" copyText={command} />
            </Section>
          )}

          {result && (
            <Section title="Response">
              {result.kind === "failed" ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {result.message}
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                    <span className={cn("font-mono font-semibold", statusTone(result.status))}>
                      {result.status} {result.statusText}
                    </span>
                    <span className="text-muted-foreground">{result.ms} ms</span>
                  </div>

                  <CodeBlock code={result.body || "(no body)"} plain={!result.json} label="the response" />

                  <details className="text-xs">
                    <summary className="cursor-pointer rounded text-muted-foreground hover:text-foreground">
                      Response headers
                    </summary>
                    <CodeBlock
                      className="mt-2"
                      plain
                      code={result.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}
                      label="the response headers"
                    />
                  </details>
                </>
              )}
            </Section>
          )}

          {operation.responses.length > 0 && (
            <Section title="Responses">
              <div className="rounded-md border px-3 py-2">
                {operation.responses.map(response => (
                  <ResponseRow key={response.status} doc={doc} response={response} />
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </article>
  );
}
