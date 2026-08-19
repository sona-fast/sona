import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FLOORS, compare, scanLockfile } from './check-lockfile-security-lib.mjs';

// The guard is what stands between an old-npm lockfile regen and a silent
// downgrade of cookie/esbuild/nanoid/undici, so its two rules — how versions
// compare and which lockfile entries get compared — are pinned here against
// synthetic lock objects rather than only against the committed
// package-lock.json.

const entry = (version: string, name?: string) => (name ? { name, version } : { version });
// npm always writes the root "" entry, and the scan now refuses a map without
// one, so every synthetic lock carries it.
const packages = (entries: Record<string, unknown>) => ({ '': { name: 'sona' }, ...entries });

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
			scanLockfile({ packages: packages({ 'node_modules/ws': entry('8.18.0') }) }, { ws: floor })
		).toThrow(/Invalid security floor/);
	});
});

describe('scanLockfile', () => {
	it('flags a nested entry below its floor', () => {
		const { offenders } = scanLockfile({
			packages: packages({
				'node_modules/cookie': entry('0.7.2'),
				'node_modules/youch/node_modules/cookie': entry('0.6.0')
			})
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
			packages: packages({ 'node_modules/cookie': entry(FLOORS.cookie) })
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
			packages: packages({ [`node_modules/${name}`]: entry(version) })
		});
		expect(offenders.map((o) => o.version)).toEqual([version]);
	});

	it('reports a floor package that has no entry at all', () => {
		const { missing } = scanLockfile({
			packages: packages({ 'node_modules/cookie': entry('0.7.2') })
		});
		expect(missing).toEqual(['esbuild', 'nanoid', 'undici']);
	});

	it('matches an aliased entry by its name field, not the path tail', () => {
		const { offenders } = scanLockfile({
			packages: packages({ 'node_modules/cookie-alias': entry('0.6.0', 'cookie') })
		});
		expect(offenders).toEqual([
			{ path: 'node_modules/cookie-alias', name: 'cookie', version: '0.6.0', floor: '0.7.0' }
		]);
	});

	// A lockfileVersion 1 lock (npm 6) carries only the nested `dependencies`
	// tree, so scanning `packages` would report a clean run over a lock that can
	// hold cookie 0.6.0. It has to fail loudly rather than silently check zero.
	it('throws on a lockfileVersion 1 lock', () => {
		expect(() =>
			scanLockfile({
				lockfileVersion: 1,
				dependencies: { cookie: { version: '0.6.0' } }
			} as never)
		).toThrow(/lockfileVersion 1 .*regenerate it with npm >= 8\.3/s);
	});

	it('throws on a lock with no packages map', () => {
		expect(() => scanLockfile({ lockfileVersion: 3 } as never)).toThrow(
			/has no packages map.*regenerate it with npm >= 8\.3/s
		);
	});

	// npm always writes the root "" entry, so a map without one is truncated —
	// scanning it would report clean over a lockfile we never really read.
	it('throws on a packages map with no root "" entry', () => {
		expect(() =>
			scanLockfile({ lockfileVersion: 3, packages: { 'node_modules/cookie': entry('0.7.2') } })
		).toThrow(/no root "" entry/);
	});

	it('throws on an empty packages map', () => {
		expect(() => scanLockfile({ lockfileVersion: 3, packages: {} })).toThrow(/no root "" entry/);
	});

	// A floor entry we can't read a version off is unscannable, not absent: it
	// has to fail the run rather than fall into the warn-only `missing` bucket.
	it('reports a versionless floor entry as unreadable, not missing', () => {
		const { offenders, checked, missing, unreadable } = scanLockfile({
			packages: packages({ 'node_modules/cookie': {} })
		});
		expect(offenders).toEqual([]);
		expect(checked).toBe(0);
		expect(unreadable).toEqual([{ path: 'node_modules/cookie', name: 'cookie' }]);
		expect(missing).not.toContain('cookie');
	});

	// A link entry points at a local/workspace dir and carries no version by
	// design, so it must not trip the unreadable bucket.
	it('skips a versionless link entry', () => {
		const { unreadable, missing } = scanLockfile({
			packages: packages({ 'node_modules/cookie': { link: true, resolved: 'packages/cookie' } })
		});
		expect(unreadable).toEqual([]);
		expect(missing).toContain('cookie');
	});
});

// FLOORS only describes what package.json's `overrides` actually pin. Let the
// two drift and the guard either checks a floor npm isn't enforcing or misses
// one it is.
describe('FLOORS matches package.json overrides', () => {
	const overrides: Record<string, string> = JSON.parse(
		readFileSync(
			join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'),
			'utf-8'
		)
	).overrides;
	// A plain key ("pkg": "^1.2.3") pins a version without naming a floor, so it
	// can't be checked against FLOORS — every security override is written as a
	// "pkg@<floor" range instead.
	const rangeKeys = Object.keys(overrides).filter((key) => key.includes('@<'));

	it('writes every override as a floor range', () => {
		expect(rangeKeys).toHaveLength(Object.keys(overrides).length);
		expect(rangeKeys).toHaveLength(Object.keys(FLOORS).length);
	});

	it.each(rangeKeys)('override %s has a matching FLOORS entry', (key) => {
		const [name, floor] = key.split('@<');
		expect(FLOORS[name]).toBe(floor);
	});

	it.each(Object.entries(FLOORS))('FLOORS.%s (%s) has a matching override key', (name, floor) => {
		expect(rangeKeys).toContain(`${name}@<${floor}`);
	});
});
