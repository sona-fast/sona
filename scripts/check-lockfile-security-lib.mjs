// Scan/compare logic behind scripts/check-lockfile-security.mjs, split out so
// the rules are unit-testable against synthetic lock objects (see the sibling
// .test.ts) instead of only against the committed package-lock.json.
// Dependency-free on purpose: the guard runs before `npm ci` in CI.

/**
 * @typedef {{ name?: string, version?: string }} LockEntry
 * @typedef {{ packages?: Record<string, LockEntry> }} Lockfile
 * @typedef {{ path: string, name: string, version: string, floor: string }} Offender
 */

// Every resolved entry for these packages must be at or above the floor,
// wherever in the tree it sits — a nested copy is just as exploitable.
/** @type {Record<string, string>} */
export const FLOORS = {
	cookie: '0.7.0',
	esbuild: '0.25.0',
	nanoid: '3.3.18'
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
		nums: release.split('.').map(Number),
		prerelease: dash === -1 ? '' : core.slice(dash + 1)
	};
}

/**
 * -1/0/1 comparison of dotted versions. A version we can't parse sorts BELOW
 * everything (fail closed) rather than being waved through as "greater", and a
 * prerelease sorts below its own bare release (semver: 0.25.0-beta < 0.25.0).
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
 * Walks every entry in a parsed lockfile once, collecting the ones below their
 * floor and which floor packages were never seen at all.
 *
 * @param {Lockfile} lock
 * @param {Record<string, string>} [floors]
 * @returns {{ offenders: Offender[], checked: number, missing: string[] }}
 */
export function scanLockfile(lock, floors = FLOORS) {
	const packages = lock.packages ?? {};
	const offenders = [];
	// `name` wins over the path tail so an aliased install (a different
	// directory name for the same package) is still matched against its floor.
	const seen = new Set();
	let checked = 0;
	for (const [path, entry] of Object.entries(packages)) {
		const name = entry.name ?? path.split('node_modules/').pop() ?? '';
		const floor = floors[name];
		if (!floor || !entry.version) continue;
		seen.add(name);
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
		missing: Object.keys(floors).filter((name) => !seen.has(name))
	};
}
