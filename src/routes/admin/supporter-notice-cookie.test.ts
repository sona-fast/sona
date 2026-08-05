import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The supporter-notice dismissal cookie (SONA-114) is a contract split across
// two files that share no import: +layout.svelte WRITES it via document.cookie
// (a .svelte layout can't share a server module constant without a client-safe
// indirection) and +layout.server.ts READS it to suppress the notice on SSR.
// Rename either side and the dismiss button silently stops sticking — no type
// error, no failing behavior test (each side still "works" alone). Same
// source-drift guard pattern as cf-analytics-scope.test.ts.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

const layoutSvelte = read('./+layout.svelte');
const layoutServer = read('./+layout.server.ts');

const COOKIE_NAME = 'supporterNoticeDismissed';

describe('supporter-notice dismissal cookie — client/server contract', () => {
	it('the server reads the exact cookie name the client writes', () => {
		expect(layoutServer).toContain(`cookies.get('${COOKIE_NAME}')`);
		expect(layoutSvelte).toContain(`${COOKIE_NAME}=`);
	});

	it('the client writes the server-built dismissValue, URI-encoded (cookies.get decodes)', () => {
		expect(layoutSvelte).toContain(
			`${COOKIE_NAME}=\${encodeURIComponent(data.supporterKeyNotice.dismissValue)}`
		);
	});

	it('the cookie is scoped to the admin area', () => {
		// Boundary-safe: narrowing the path to e.g. /admin/settings must fail this.
		expect(layoutSvelte).toMatch(/path=\/admin(?![\w/])/);
	});
});
