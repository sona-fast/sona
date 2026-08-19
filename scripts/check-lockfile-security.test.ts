import { describe, it, expect } from 'vitest';
import { FLOORS, compare, scanLockfile } from './check-lockfile-security-lib.mjs';

// The guard is what stands between an old-npm lockfile regen and a silent
// downgrade of cookie/esbuild/nanoid, so its two rules — how versions compare
// and which lockfile entries get compared — are pinned here against synthetic
// lock objects rather than only against the committed package-lock.json.

const entry = (version: string, name?: string) => (name ? { name, version } : { version });

describe('compare', () => {
	const cases: Array<[string, string, number]> = [
		['0.7.0', '0.7.0', 0],
		['0.6.0', '0.7.0', -1],
		['0.7.1', '0.7.0', 1],
		['3.3.9', '3.3.18', -1],
		// Prerelease sorts below its own bare release.
		['0.25.0-beta', '0.25.0', -1],
		['0.25.1-beta', '0.25.0', 1],
		['0.25.0-beta', '0.25.0-beta', 0],
		// Build metadata carries no ordering and must not be compared.
		['3.3.7+build', '3.3.18', -1],
		['3.3.18+build', '3.3.18', 0],
		// Unparseable sorts below everything (fail closed).
		['0.x.0', '0.7.0', -1],
		['0.7.0', 'not-a-version', 1],
		// Number()-parseable but not decimal digits: still unparseable, so it
		// sorts below rather than reading as 1000 / 9 / infinity.
		['1e3', '0.7.0', -1],
		['0x9.0.0', '0.7.0', -1],
		['Infinity', '0.7.0', -1]
	];
	it.each(cases)('compare(%s, %s) === %i', (a, b, expected) => {
		expect(compare(a, b)).toBe(expected);
	});
});

describe('floor validation', () => {
	it.each(Object.entries(FLOORS))('FLOORS.%s (%s) is a dotted numeric version', (_name, floor) => {
		expect(floor).toMatch(/^\d+(\.\d+)*$/);
	});

	it.each(['latest', '^8.17.1', '', '0.x.0'])('throws on a floor of %s', (floor) => {
		expect(() =>
			scanLockfile({ packages: { 'node_modules/ws': entry('8.18.0') } }, { ws: floor })
		).toThrow(/Invalid security floor/);
	});
});

describe('scanLockfile', () => {
	it('flags a nested entry below its floor', () => {
		const { offenders } = scanLockfile({
			packages: {
				'node_modules/cookie': entry('0.7.2'),
				'node_modules/youch/node_modules/cookie': entry('0.6.0')
			}
		});
		expect(offenders).toEqual([
			{
				path: 'node_modules/youch/node_modules/cookie',
				name: 'cookie',
				version: '0.6.0',
				floor: '0.7.0'
			}
		]);
	});

	it('passes an entry exactly at the floor', () => {
		const { offenders, checked } = scanLockfile({
			packages: { 'node_modules/cookie': entry(FLOORS.cookie) }
		});
		expect(offenders).toEqual([]);
		expect(checked).toBe(1);
	});

	it.each([
		['0.25.0-beta', 'esbuild'],
		['3.3.7+build', 'nanoid'],
		['0.x.0', 'cookie']
	])('flags %s of %s', (version, name) => {
		const { offenders } = scanLockfile({
			packages: { [`node_modules/${name}`]: entry(version) }
		});
		expect(offenders.map((o) => o.version)).toEqual([version]);
	});

	it('reports a floor package that has no entry at all', () => {
		const { missing } = scanLockfile({
			packages: { 'node_modules/cookie': entry('0.7.2') }
		});
		expect(missing).toEqual(['esbuild', 'nanoid']);
	});

	it('matches an aliased entry by its name field, not the path tail', () => {
		const { offenders } = scanLockfile({
			packages: { 'node_modules/cookie-alias': entry('0.6.0', 'cookie') }
		});
		expect(offenders).toEqual([
			{ path: 'node_modules/cookie-alias', name: 'cookie', version: '0.6.0', floor: '0.7.0' }
		]);
	});

	it('ignores entries with no resolved version', () => {
		const { offenders, checked, missing } = scanLockfile({
			packages: { 'node_modules/cookie': {} }
		});
		expect(offenders).toEqual([]);
		expect(checked).toBe(0);
		expect(missing).toContain('cookie');
	});
});
