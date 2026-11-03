import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startNavigationTransition, wantsNavigationTransition } from './view-transition';

// Collects unhandled rejections for the length of a test, so a test fails when
// the helper leaves one of the transition's promises without a handler.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
	unhandled.length = 0;
	process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
	process.off('unhandledRejection', onUnhandled);
});

async function settle() {
	// Two macrotask turns: long enough for Node to report an unhandled rejection.
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
}

function rejecting(reason: string) {
	return Promise.reject(new Error(reason));
}

describe('startNavigationTransition', () => {
	it('returns nothing without the View Transitions API, so navigation runs at once', () => {
		expect(startNavigationTransition({}, Promise.resolve())).toBeUndefined();
	});

	it('resolves once the update callback starts, before the navigation completes', async () => {
		let runUpdate: (() => Promise<void>) | undefined;
		let finishNavigation: () => void = () => {};
		const complete = new Promise<void>((r) => (finishNavigation = r));
		const doc = {
			startViewTransition(update: () => Promise<void>) {
				runUpdate = update;
				return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() };
			}
		};
		let resolved = false;
		const started = startNavigationTransition(doc, complete)!.then(() => (resolved = true));
		await settle();
		expect(resolved).toBe(false);

		const updating = runUpdate!();
		await started;
		expect(resolved).toBe(true);
		finishNavigation();
		await updating;
	});

	it('leaves no unhandled rejection when the transition times out or the navigation fails', async () => {
		const doc = {
			startViewTransition(update: () => Promise<void>) {
				void update().catch(() => {});
				return {
					ready: rejecting('Transition was aborted because of timeout in DOM update'),
					finished: rejecting('navigation failed'),
					updateCallbackDone: rejecting('navigation failed')
				};
			}
		};
		await startNavigationTransition(doc, Promise.resolve());
		await settle();
		expect(unhandled).toEqual([]);
	});

	it('navigates without the transition when starting one throws', async () => {
		const doc = {
			startViewTransition(): never {
				throw new TypeError('Illegal invocation');
			}
		};
		await expect(startNavigationTransition(doc, Promise.resolve())).resolves.toBeUndefined();
	});
});

describe('wantsNavigationTransition', () => {
	const at = (href: string) => ({ url: new URL(href, 'https://sona.test') });

	it('skips a goto or link that changes only the query, so a filter or sort does not fade the whole page', () => {
		expect(wantsNavigationTransition(at('/gallery'), at('/gallery?sort=oldest'), 'goto')).toBe(false);
		expect(wantsNavigationTransition(at('/gallery?tag=a'), at('/gallery?tag=b&page=2'), 'link')).toBe(false);
		expect(wantsNavigationTransition(at('/stickers/pack'), at('/stickers/pack?emoji=x'), 'goto')).toBe(false);
	});

	it('keeps the transition between pages, including two pieces on the same route', () => {
		expect(wantsNavigationTransition(at('/gallery'), at('/gallery/parent-piece'), 'link')).toBe(true);
		expect(wantsNavigationTransition(at('/gallery/parent-piece'), at('/gallery/variant-piece'), 'goto')).toBe(true);
		expect(wantsNavigationTransition(at('/gallery?tag=a'), at('/'), 'link')).toBe(true);
	});

	it('keeps it for Back, Forward, and a navigation to the same URL', () => {
		// Back landing mid navigation runs a popstate from a URL to itself.
		expect(wantsNavigationTransition(at('/admin/commissions/new'), at('/admin/commissions/new'), 'popstate')).toBe(true);
		expect(wantsNavigationTransition(at('/gallery?tag=a'), at('/gallery?tag=b'), 'popstate')).toBe(true);
		expect(wantsNavigationTransition(at('/gallery?tag=a'), at('/gallery?tag=a'), 'goto')).toBe(true);
	});

	it('keeps it when either end is unknown', () => {
		expect(wantsNavigationTransition(null, at('/gallery'), 'goto')).toBe(true);
		expect(wantsNavigationTransition(at('/gallery'), null, 'goto')).toBe(true);
	});
});
