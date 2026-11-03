import type { Page } from '@playwright/test';

// Probes for "the page updated in place": a filter change must not load a new
// document or fade the whole page with a View Transition. Shared by the
// gallery and sticker filter specs.

type Probe = { __marker?: string; __transitions: number };

/** Count whole-page View Transitions from the first script on. Call before
 *  the page's first goto. */
export async function countViewTransitions(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as Probe;
		w.__transitions = 0;
		const start = document.startViewTransition?.bind(document);
		if (start) {
			document.startViewTransition = ((cb: never) => {
				w.__transitions++;
				return start(cb);
			}) as typeof document.startViewTransition;
		}
	});
}

/** Tag the current window. A document load replaces the window, and the tag
 *  with it. */
export async function markWindow(page: Page) {
	await page.evaluate(() => {
		(window as unknown as Probe).__marker = 'still here';
	});
}

/** Whether the window markWindow tagged is still the one loaded, and how many
 *  View Transitions have started since the page loaded. */
export function inPlaceState(page: Page) {
	return page.evaluate(() => {
		const w = window as unknown as Probe;
		return { sameWindow: w.__marker === 'still here', transitions: w.__transitions };
	});
}
