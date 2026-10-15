import { expect, test } from '@playwright/test';

// Fails a test when any page it opens throws an uncaught error, such as a
// Svelte effect looping on its own write. The page can look fine while that
// happens, so the assertions alone wouldn't notice. Call once at the top of a
// spec; it covers pages a test opens itself, like a second tab.
export function failOnPageErrors() {
	let errors: string[] = [];
	test.beforeEach(({ page }) => {
		errors = [];
		const watch = (p: typeof page) => p.on('pageerror', (error) => errors.push(`${p.url()}: ${error.message}`));
		watch(page);
		page.context().on('page', watch);
	});
	test.afterEach(() => {
		expect(errors, 'uncaught errors in the page').toEqual([]);
	});
}
