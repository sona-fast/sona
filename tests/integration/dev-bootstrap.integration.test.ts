import { describe, it, expect, afterEach } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import type { D1Database } from '@cloudflare/workers-types';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDevConfig } from '../../scripts/dev-bootstrap-lib.ts';

// Integration test for the local-dev self-bootstrap (issue #137). Unlike the unit
// tests (scripts/dev-bootstrap-lib.test.ts), this exercises the REAL migrateLocalD1
// shell-out and the load-bearing coupling the unit tests inject away: that the
// local D1 migrateLocalD1 writes (`wrangler d1 execute DB --local`, default
// persist) lands in exactly the dir getPlatformProxy reads at `vite dev` boot.
// That path match is bug #137's entire failure mode, and it can't be asserted
// without real wrangler + a real local D1 — so this runs only in the CI job that
// has them (see .github/workflows/ci.yml), and is kept out of the fast unit suite
// (it lives under tests/integration/, outside vitest.config.ts's include globs;
// run it locally with `npm run test:integration`).
//
// Everything happens inside a throwaway repo under the OS temp dir, and the D1 is
// read via getPlatformProxy with the CWD pointed there — so the developer's real
// dev database (.wrangler in the repo root) is never touched.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A throwaway "repo" holding only the two things the bootstrap reads. */
function makeThrowawayRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), 'sona-dev-bootstrap-int-'));
	try {
		cpSync(path.join(repoRoot, 'wrangler.toml.example'), path.join(root, 'wrangler.toml.example'));
		cpSync(path.join(repoRoot, 'drizzle'), path.join(root, 'drizzle'), { recursive: true });
	} catch (err) {
		rmSync(root, { recursive: true, force: true });
		throw err;
	}
	return root;
}

describe('dev-bootstrap integration (real wrangler + local D1)', () => {
	let root: string | undefined;
	const origCwd = process.cwd();

	afterEach(() => {
		// Always restore CWD and remove the throwaway repo (with its .wrangler state).
		process.chdir(origCwd);
		if (root) {
			rmSync(root, { recursive: true, force: true });
			root = undefined;
		}
	});

	// Open the local D1 exactly as src/svelte.config.js configures platformProxy for
	// real local dev: configPath 'wrangler.toml' (relative to CWD) and the default
	// persist dir. We chdir into the throwaway repo first, so this resolves to its
	// own .wrangler state and never the developer's real dev DB.
	async function tableExistsViaDevProxy(name: string): Promise<boolean> {
		process.chdir(root!);
		try {
			const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: 'wrangler.toml' });
			try {
				const res = await proxy.env.DB.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
				)
					.bind(name)
					.all();
				return res.results.length > 0;
			} finally {
				await proxy.dispose();
			}
		} finally {
			process.chdir(origCwd);
		}
	}

	it('migrates a local D1 that getPlatformProxy reads at the default persist path', async () => {
		root = makeThrowawayRepo();

		// Before the bootstrap there is no wrangler.toml — platformProxy can't read
		// the config to wire the DB binding. This IS the fresh-clone 500; pin the
		// assertion to that cause.
		await expect(tableExistsViaDevProxy('site_settings')).rejects.toThrow(/wrangler\.toml/i);

		// Run the REAL bootstrap: no injected migrate, so migrateLocalD1 actually
		// shells out to `wrangler d1 execute DB --local` against this throwaway repo.
		const result = bootstrapDevConfig({ repoRoot: root, env: {}, log: () => {} });
		expect(result).toBe('created');
		expect(existsSync(path.join(root, 'wrangler.toml'))).toBe(true);

		// After the bootstrap, the SAME default-persist dir the dev server reads now
		// holds the migrated schema — proving migrateLocalD1's write path and
		// getPlatformProxy's read path coincide (a --persist-to drift or binding
		// change would land the DB elsewhere and fail this).
		expect(await tableExistsViaDevProxy('site_settings')).toBe(true);
	});
});
