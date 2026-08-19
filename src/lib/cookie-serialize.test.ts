import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	SESSION_COOKIE,
	VIEWER_TZ_COOKIE,
	THEME_MODE_COOKIE,
	RESET_TOKEN_COOKIE
} from './config';

// SvelteKit's `cookies` API is a thin wrapper over the `cookie` package, and
// that package tightens name/value validation across majors (0.7 started
// throwing on input 0.6 accepted). A bump that rejects one of our names, or
// changes how a value survives the round trip, breaks admin login — this makes
// `npm test` say so instead of an e2e run.
//
// Resolve `cookie` the way SvelteKit does rather than through our own
// devDependency, so the copy under test is the one kit actually loads even if
// npm later nests a second one under it.
const require_ = createRequire(import.meta.url);
const kitDir = dirname(require_.resolve('@sveltejs/kit/package.json'));
const { serialize, parse } = (await import(
	pathToFileURL(require_.resolve('cookie', { paths: [kitDir] })).href
)) as typeof import('cookie');

const NAMES = [
	SESSION_COOKIE,
	// SESSION_COOKIE is the __Host- name under vitest (dev=false), so the dev
	// name is the one no constant reaches here.
	'sona_admin_session',
	VIEWER_TZ_COOKIE,
	THEME_MODE_COOKIE,
	RESET_TOKEN_COOKIE
];

const PATHS = ['/', '/admin', '/admin/reset'];

describe('cookie serializer', () => {
	it.each(NAMES)('round-trips %s through parse', (name) => {
		const value = 'a-value_with.chars';
		expect(parse(serialize(name, value, { path: '/' }))[name]).toBe(value);
	});

	it.each(PATHS)('serializes on path %s', (path) => {
		expect(() =>
			serialize(SESSION_COOKIE, 'value', {
				path,
				httpOnly: true,
				secure: true,
				sameSite: 'lax'
			})
		).not.toThrow();
	});

	it('round-trips values needing percent-encoding', () => {
		// Reset tokens and IANA zone names carry characters (=, /) that the
		// serializer has to encode and parse has to give back verbatim.
		const value = 'America/Los_Angeles=';
		const jar = parse(serialize(RESET_TOKEN_COOKIE, value, { path: '/admin/reset' }));
		expect(jar[RESET_TOKEN_COOKIE]).toBe(value);
	});
});
