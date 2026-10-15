import { expect, test } from '@playwright/test';

// Skipped for now: src/routes/+layout.svelte starts a View Transition on every
// client navigation (onNavigate → document.startViewTransition) and leaves the
// transition's promises unhandled, so a DOM update that times out on a loaded
// machine rejects as an uncaught page error, whatever page is under test. A
// separate PR off main handles that rejection in the root layout; once the
// stack picks it up, delete this constant and its one use below.
const LAYOUT_TRANSITION_TIMEOUT = /^Transition was aborted because of timeout in DOM update/;

// Fails a test when any page it opens throws an uncaught error, such as a
// Svelte effect looping on its own write. The page can look fine while that
// happens, so the assertions alone wouldn't notice. Call once at the top of a
// spec; it covers pages a test opens itself, like a second tab.
export function failOnPageErrors() {
	let errors: string[] = [];
	test.beforeEach(({ page }) => {
		errors = [];
		const watch = (p: typeof page) =>
			p.on('pageerror', (error) => {
				if (!LAYOUT_TRANSITION_TIMEOUT.test(error.message)) errors.push(`${p.url()}: ${error.message}`);
			});
		watch(page);
		page.context().on('page', watch);
	});
	test.afterEach(() => {
		expect(errors, 'uncaught errors in the page').toEqual([]);
	});
}
