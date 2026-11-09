import { describe, it, expect, afterAll } from 'vitest';
import adapter from '@sveltejs/adapter-cloudflare';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { healingAdapter } from '../../scripts/platform-proxy-heal.js';

// The real failure behind the CI-only e2e cascades: the workerd child under a
// dev server dies, miniflare restarts it and poisons every binding it handed
// out, and adapter-cloudflare keeps serving those dead bindings. This kills the
// real workerd under the real adapter's emulator and checks that the next
// request gets bindings that answer. It also pins the miniflare behaviour the
// heal detects (a poisoned stub throws on any property read): if an upgrade
// changes that, the first assertion here fails rather than the heal going
// quietly inert.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const persist = mkdtempSync(path.join(tmpdir(), 'sona-proxy-heal-'));
afterAll(() => rmSync(persist, { recursive: true, force: true }));

/** The workerd processes this test process spawned (miniflare's runtimes). */
function workerdChildren(): number[] {
	try {
		return execFileSync('pgrep', ['-P', String(process.pid), 'workerd'], { encoding: 'utf8' })
			.trim()
			.split('\n')
			.filter(Boolean)
			.map(Number);
	} catch {
		return []; // pgrep exits 1 when nothing matches
	}
}

async function waitFor(check: () => boolean, ms = 15_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 100));
	}
}

describe('healingAdapter against a real workerd restart', () => {
	it('gives the next request working bindings after workerd is killed', async () => {
		const base = adapter({
			platformProxy: {
				configPath: path.join(repoRoot, 'tests/e2e/wrangler.e2e.toml'),
				persist: { path: persist }
			}
		});
		const logs: string[] = [];
		const emulator = await healingAdapter(base, (m) => logs.push(m)).emulate!();
		const platform = emulator.platform!;
		const req = { config: {}, prerender: false } as never;
		const query = async (env: App.Platform['env']) =>
			(await env.DB.prepare('select 41 + 1 as n').first<{ n: number }>())?.n;

		const before = await platform(req);
		expect(await query(before.env)).toBe(42);

		const killed = workerdChildren();
		expect(killed.length).toBeGreaterThan(0);
		for (const pid of killed) process.kill(pid, 'SIGKILL');
		// miniflare starts a replacement runtime; wait until it is up.
		await waitFor(() => workerdChildren().some((pid) => !killed.includes(pid)));

		// What the unwrapped adapter keeps serving: dead stubs.
		await expect(query(before.env)).rejects.toThrow(/poisoned stub/);

		const after = await platform(req);
		expect(await query(after.env)).toBe(42);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/workerd\) restarted/);
	}, 60_000);
});
