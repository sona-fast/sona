/** What a caught error is safe to log. A JSON parse failure's message quotes
 * a fragment of the body, and third-party bodies are never logged, so a
 * SyntaxError is reduced to its name. Shared by the fail-soft fetch clients
 * (entail.ts, twitter-media.ts). */
export function errorLabel(e: unknown): string {
	if (e instanceof SyntaxError) return e.name;
	return e instanceof Error ? e.message : String(e);
}
