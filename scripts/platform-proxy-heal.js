// Keeps `vite dev` working after the local Workers runtime restarts.
//
// In dev, adapter-cloudflare's emulate() builds platform.env once, through
// wrangler's getPlatformProxy, and hands the same bindings to every request
// for the life of the server. Those bindings are stubs into a workerd child
// process. When that process dies, miniflare starts a new one, but it also
// poisons every stub it handed out: from then on any use of platform.env.DB or
// platform.env.IMAGES throws "Attempted to use poisoned stub", for every
// request, until the dev server is restarted. Nothing is logged. A form action
// answers 500 and a page that reads the database renders without its data.
//
// The e2e suite hit exactly that on CI: a seeded server that had passed tests
// for ten minutes failed every admin login from then on (the login page renders
// without the database, its POST does not), or drew its pages as though the
// seeded rows were gone. They were not gone: the restarted runtime reads the
// same persist dir. Only the stubs were dead.
//
// healingAdapter wraps the adapter so the dev server notices poisoned bindings
// on the next request, says so on stderr, and asks the adapter for a new
// emulator, which builds a new platform proxy against the running runtime.
// Production builds never call emulate(), so this changes nothing outside dev.
// The adapter keeps the old proxy to itself, so it can't be disposed: its
// restarted workerd sits idle beside the new one until the dev server exits.
// Nothing sends it requests, so it never opens the persisted databases.
//
// What killed the runtime is a separate question, and the log line exists so
// it gets asked: a heal keeps the run going, it does not make the crash fine.

/** The message miniflare throws from a stub it poisoned after a restart. */
const POISONED = 'poisoned stub';

/** True when a runtime restart has poisoned the bindings in `env`. Plain
 * values (vars) are never stubs; a poisoned stub throws on ANY property read,
 * so one read per binding is enough and costs nothing on a healthy one.
 * @param {Record<string, unknown> | undefined} env */
export function bindingsPoisoned(env) {
	for (const key of Object.keys(env ?? {})) {
		const binding = /** @type {Record<string, unknown>} */ (env)[key];
		if (binding === null || typeof binding !== 'object') continue;
		try {
			void /** @type {Record<symbol, unknown>} */ (binding)[Symbol.toStringTag];
		} catch (error) {
			if (error instanceof Error && error.message.includes(POISONED)) return true;
		}
	}
	return false;
}

/**
 * @template {import('@sveltejs/kit').Adapter} A
 * @param {A} adapter
 * @param {(message: string) => void} [log] stderr by default, which Playwright
 *   prints from its webServers; it drops their stdout.
 * @returns {A}
 */
export function healingAdapter(adapter, log = (message) => console.error(message)) {
	const emulate = adapter.emulate;
	if (!emulate) return adapter;

	/** One emulator from the adapter. The adapter builds its platform proxy on
	 * the first platform() call and caches it, but calls that race in before it
	 * resolves each build their own, so the first build is shared here. */
	const generation = () => {
		const emulator = Promise.resolve(emulate.call(adapter));
		/** @type {Promise<unknown> | undefined} */
		let built;
		/** @param {any} opts */
		return async (opts) => {
			const e = await emulator;
			if (!e.platform) return undefined;
			built ??= Promise.resolve(e.platform({ ...opts, prerender: false }));
			await built;
			return e.platform(opts);
		};
	};

	return {
		...adapter,
		emulate() {
			let current = generation();
			let restarts = 0;
			return {
				async platform(opts) {
					const used = current;
					const platform = await used(opts);
					// A prerender platform's env throws on every read by design.
					if (opts?.prerender || !bindingsPoisoned(platform?.env)) return platform;
					// Requests in flight when the runtime died all land here; only the
					// first replaces the emulator, the rest use its replacement.
					if (current === used) {
						restarts += 1;
						log(
							`[platform-proxy-heal] The local Workers runtime (workerd) restarted under this dev server ` +
								`and its platform bindings stopped working. Rebuilt them (restart ${restarts}, ` +
								`${new Date().toISOString()}). Something killed or crashed workerd; on CI, check the ` +
								`runner's memory.`
						);
						current = generation();
					}
					return current(opts);
				}
			};
		}
	};
}
