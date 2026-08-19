// Scan/compare logic behind scripts/check-lockfile-security.mjs, split out so
// the rules are unit-testable against synthetic lock objects (see the sibling
// .test.ts) instead of only against the committed package-lock.json.
// Dependency-free on purpose: the guard runs before `npm ci` in CI.

/**
 * @typedef {{ name?: string, version?: string, link?: boolean }} LockEntry
 * @typedef {{ lockfileVersion?: number, packages?: Record<string, LockEntry> }} Lockfile
 * @typedef {{ path: string, name: string, version: string, floor: string }} Offender
 * @typedef {{ path: string, name: string }} Unreadable
 */

// Every resolved entry for these packages must be at or above the floor,
// wherever in the tree it sits — a nested copy is just as exploitable.
/** @type {Record<string, string>} */
export const FLOORS = {
	cookie: '0.7.0',
	esbuild: '0.25.0',
	nanoid: '3.3.18',
	undici: '7.29.0'
};

/**
 * Splits a version into its numeric release segments and its prerelease tag.
 * Build metadata (`+build`) carries no ordering, so it is dropped.
 *
 * @param {string} version
 * @returns {{ nums: number[], prerelease: string }}
 */
function parse(version) {
	const core = String(version).split('+')[0];
	const dash = core.indexOf('-');
	const release = dash === -1 ? core : core.slice(0, dash);
	return {
		// Strict digits only: Number() would happily read '1e3', '0x9' or
		// 'Infinity' as a huge number and wave the entry through.
		nums: release.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : NaN)),
		prerelease: dash === -1 ? '' : core.slice(dash + 1)
	};
}

/**
 * A floor is our own constant, so a malformed one is a bug in this file rather
 * than untrusted input — but it must fail loudly instead of comparing as
 * unparseable, which would let every real version pass.
 *
 * @param {Record<string, string>} floors
 */
function assertFloors(floors) {
	for (const [name, floor] of Object.entries(floors)) {
		if (typeof floor !== 'string' || !/^\d+(\.\d+)*$/.test(floor)) {
			throw new Error(`Invalid security floor for ${name}: ${floor}`);
		}
	}
}

assertFloors(FLOORS);

/**
 * -1/0/1 comparison of dotted versions. A version we can't parse sorts BELOW
 * everything (fail closed) rather than being waved through as "greater", and a
 * prerelease sorts below its own bare release (semver: 0.25.0-beta < 0.25.0).
 * Ordering *between* two prereleases is lexical, so only approximately semver —
 * all the floors need is the below-release/above-release distinction.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compare(a, b) {
	const x = parse(a);
	const y = parse(b);
	const xBad = x.nums.some(Number.isNaN);
	const yBad = y.nums.some(Number.isNaN);
	if (xBad || yBad) return xBad && yBad ? 0 : xBad ? -1 : 1;
	for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
		const diff = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	if (x.prerelease === y.prerelease) return 0;
	if (!x.prerelease) return 1;
	if (!y.prerelease) return -1;
	return x.prerelease < y.prerelease ? -1 : 1;
}

/**
 * The scan reads `packages`, the flat resolved map npm writes from
 * lockfileVersion 2 on. An npm 6 (v1) lock has only the nested `dependencies`
 * tree, so scanning it would find nothing and report a clean run over a
 * lockfile that may well carry the vulnerable versions. Refuse it instead.
 *
 * npm always writes the root "" entry, so a packages map without one is
 * truncated or hand-edited rather than merely dependency-free — same refusal.
 *
 * @param {Lockfile} lock
 */
function assertLockShape(lock) {
	const version = lock?.lockfileVersion;
	const packages = lock?.packages;
	if ((typeof version === 'number' && version < 2) || typeof packages !== 'object' || !packages) {
		throw new Error(
			`package-lock.json is lockfileVersion ${version ?? 'unknown'} (or has no packages map); ` +
				`regenerate it with npm >= 8.3 so the security overrides apply.`
		);
	}
	if (!packages['']) {
		throw new Error(
			`package-lock.json has no root "" entry in its packages map, so it is truncated or ` +
				`corrupt; regenerate it with npm >= 8.3 so the security overrides apply.`
		);
	}
}

/**
 * Walks every entry in a parsed lockfile once, collecting the ones below their
 * floor, the ones we can't read a version off at all, and which floor packages
 * were never seen. A floor package with no entry is reported, not judged — the
 * caller decides what `missing` means.
 *
 * @param {Lockfile} lock
 * @param {Record<string, string>} [floors]
 * @returns {{ offenders: Offender[], checked: number, missing: string[], unreadable: Unreadable[] }}
 */
export function scanLockfile(lock, floors = FLOORS) {
	assertFloors(floors);
	assertLockShape(lock);
	const packages = lock.packages;
	const offenders = [];
	const unreadable = [];
	// `name` wins over the path tail so an aliased install (a different
	// directory name for the same package) is still matched against its floor.
	const seen = new Set();
	let checked = 0;
	for (const [path, entry] of Object.entries(packages)) {
		// A link entry points at a workspace/local dir and carries no version by
		// design; the real entry it points at is in the map too.
		if (entry.link === true) continue;
		const name = entry.name ?? path.split('node_modules/').pop() ?? '';
		const floor = floors[name];
		if (!floor) continue;
		seen.add(name);
		// A floor package we can't read a version off is unscannable, not clean:
		// treat it like an offender rather than letting it pass as "missing".
		if (!entry.version) {
			unreadable.push({ path: path || '(root)', name });
			continue;
		}
		checked++;
		if (compare(entry.version, floor) < 0) {
			offenders.push({
				path: path || '(root)',
				name,
				version: entry.version,
				floor
			});
		}
	}
	return {
		offenders,
		checked,
		missing: Object.keys(floors).filter((name) => !seen.has(name)),
		unreadable
	};
}
