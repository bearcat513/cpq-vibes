/**
 * A request, written out as a cURL command someone can paste into a terminal
 * or a CI job.
 *
 * Kept pure and away from React so the command can be asserted exactly. The
 * request is modelled first and rendered second, because the reference page
 * shows the method and URL on their own before showing the whole command.
 */

/** The header an API key travels in. Matches API_KEY_HEADER on the server. */
export const API_KEY_HEADER = "X-API-Key";

/** The shell variable a copied command reads the key from. */
export const API_KEY_VARIABLE = "CPQ_API_KEY";

/** The same, for a raw PocketBase user token. */
export const TOKEN_VARIABLE = "CPQ_TOKEN";

export type CurlRequest = {
  method: string;
  /** Absolute, so the command works from anywhere. */
  url: string;
  headers: { name: string; value: string }[];
  /** Pretty-printed JSON where there is a body; absent where there is none. */
  body?: string;
};

/**
 * Wraps a value in single quotes for the shell.
 *
 * A customer name, a note or a rule message can contain an apostrophe, which
 * would end the quoted run and leave a command that does something else
 * entirely, so the usual `'\''` dance closes and reopens around each one.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The request as a cURL command, one flag per line.
 *
 * A value beginning `$` is double-quoted, alone among the arguments, because
 * it is the one place a shell expansion is wanted rather than escaped.
 */
export function toCurl(request: CurlRequest): string {
  const lines = [`curl -X ${request.method} ${shellQuote(request.url)}`];

  for (const header of request.headers) {
    const literal = `${header.name}: ${header.value}`;
    lines.push(header.value.startsWith("$") ? `  -H "${literal}"` : `  -H ${shellQuote(literal)}`);
  }

  if (request.body !== undefined) lines.push(`  -d ${shellQuote(request.body)}`);

  return lines.join(" \\\n");
}
