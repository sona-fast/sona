import { describe, it, expect, vi } from 'vitest';
import { bindingsPoisoned, healingAdapter } from './platform-proxy-heal.js';

// A stand-in for what miniflare hands out: a stub that answers property reads
// until the runtime under it restarts, then throws on every read. That is the
// behaviour tests/integration/platform-proxy-heal.integration.test.ts pins
// against the real runtime.
function stub() {
	const state = { poisoned: false };
	const proxy = new Proxy(
		{},
		{
			get(_t, prop) {
				if (state.poisoned)
					throw new Error(
						'Attempted to use poisoned stub. Stubs to runtime objects must be re-created after calling `Miniflare#setOptions()` or `Miniflare#dispose()`.'
					);
				return prop === 'query' ? () => 'rows' : undefined;
			}
		}
	);
	return { proxy, state };
}

/** An adapter shaped like adapter-cloudflare's: each emulate() call returns an
 * emulator that builds one platform lazily and caches it. */
function fakeAdapter() {
	const built: ReturnType<typeof stub>[] = [];
	const adapter = {
		name: 'fake',
		adapt: async () => {},
		emulate: vi.fn(() => {
			let platform: { env: Record<string, unknown> } | undefined;
			return {
				platform: async ({ prerender }: { prerender: boolean }) => {
					if (!platform) {
						await new Promise((r) => setTimeout(r, 5));
						const db = stub();
						built.push(db);
						platform ??= { env: { DB: db.proxy, ADMIN_PASSWORD: 'x' } };
					}
					if (prerender) {
						return {
							env: new Proxy(
								{},
								{
									get() {
										throw new Error('Cannot access platform.env.DB in a prerenderable route');
									}
								}
							)
						};
					}
					return platform;
				}
			};
		})
	};
	return { adapter, built };
}

const req = { config: {}, prerender: false };

describe('bindingsPoisoned', () => {
	it('is false for working bindings and plain vars', () => {
		expect(bindingsPoisoned({ DB: stub().proxy, NAME: 'sona', N: 3, NONE: null })).toBe(false);
	});

	it('is true once any binding throws the poisoned-stub error', () => {
		const db = stub();
		db.state.poisoned = true;
		expect(bindingsPoisoned({ OK: stub().proxy, DB: db.proxy })).toBe(true);
	});

	it('is false for a binding that throws some other error', () => {
		const odd = new Proxy(
			{},
			{
				get() {
					throw new Error('something else');
				}
			}
		);
		expect(bindingsPoisoned({ ODD: odd })).toBe(false);
	});
});

describe('healingAdapter', () => {
	it('hands requests working bindings again after the runtime restarts', async () => {
		const { adapter, built } = fakeAdapter();
		const log = vi.fn();
		const emulator = await healingAdapter(adapter as never, log).emulate!();

		const first = await emulator.platform(req as never);
		expect((first.env.DB as { query: () => string }).query()).toBe('rows');

		built[0].state.poisoned = true;
		const after = await emulator.platform(req as never);
		expect((after.env.DB as { query: () => string }).query()).toBe('rows');
		expect(after.env.ADMIN_PASSWORD).toBe('x');
	});

	it('says on the log that the runtime restarted', async () => {
		const { adapter, built } = fakeAdapter();
		const log = vi.fn();
		const emulator = await healingAdapter(adapter as never, log).emulate!();
		await emulator.platform(req as never);
		expect(log).not.toHaveBeenCalled();

		built[0].state.poisoned = true;
		await emulator.platform(req as never);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][0]).toMatch(/workerd\) restarted/);
		expect(log.mock.calls[0][0]).toMatch(/restart 1,/);
	});

	it('builds one replacement however many requests find the bindings dead at once', async () => {
		const { adapter, built } = fakeAdapter();
		const emulator = await healingAdapter(adapter as never, () => {}).emulate!();
		await emulator.platform(req as never);
		built[0].state.poisoned = true;

		const all = await Promise.all(Array.from({ length: 8 }, () => emulator.platform(req as never)));
		for (const p of all) expect((p.env.DB as { query: () => string }).query()).toBe('rows');
		expect(built).toHaveLength(2);
	});

	it('builds one platform for concurrent first requests and none for healthy ones after', async () => {
		const { adapter, built } = fakeAdapter();
		const emulator = await healingAdapter(adapter as never, () => {}).emulate!();
		await Promise.all(Array.from({ length: 5 }, () => emulator.platform(req as never)));
		for (let i = 0; i < 20; i++) await emulator.platform(req as never);
		expect(built).toHaveLength(1);
	});

	it('returns the prerender platform untouched, though its env throws on every read', async () => {
		const { adapter, built } = fakeAdapter();
		const log = vi.fn();
		const emulator = await healingAdapter(adapter as never, log).emulate!();
		const p = await emulator.platform({ config: {}, prerender: true } as never);
		expect(() => (p.env as Record<string, unknown>).DB).toThrow(/prerenderable/);
		expect(log).not.toHaveBeenCalled();
		expect(built).toHaveLength(1);
	});

	it('lets a later request retry when the first platform build fails', async () => {
		let calls = 0;
		const env = { DB: stub().proxy };
		const adapter = {
			name: 'flaky',
			adapt: async () => {},
			emulate: () => ({
				platform: async () => {
					calls += 1;
					if (calls === 1) throw new Error('runtime not ready');
					return { env };
				}
			})
		};
		const emulator = await healingAdapter(adapter as never, () => {}).emulate!();
		await expect(emulator.platform(req as never)).rejects.toThrow('runtime not ready');
		const p = await emulator.platform(req as never);
		expect(p.env).toBe(env);
	});

	it('leaves an adapter without emulate as it is', () => {
		const plain = { name: 'plain', adapt: async () => {} };
		expect(healingAdapter(plain as never)).toBe(plain);
	});
});
