import { describe, it, expect, afterEach } from 'vitest';
import { startNavigationTransition } from './view-transition';

// Collects unhandled rejections for the length of a test, so a test fails when
// the helper leaves one of the transition's promises without a handler.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterEach(() => {
	unhandled.length = 0;
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
				throw new DOMException('hidden document', 'InvalidStateError');
			}
		};
		await expect(startNavigationTransition(doc, Promise.resolve())).resolves.toBeUndefined();
	});
});
