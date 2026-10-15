import { expect, test } from '@playwright/test';

// Fails a test when any page it opens throws an uncaught error, such as a
// Svelte effect looping on its own write. The page can look fine while that
// happens, so the assertions alone wouldn't notice. Call once at the top of a
// spec; it covers pages a test opens itself, like a second tab.
// Not counted: the root layout's View Transition on a client navigation rejects
// when the new page's DOM update takes too long, and it leaves that rejection
// unhandled. It shows up only on a loaded machine (a full run boots fourteen
// dev servers), it says nothing about the page under test, and it's the
// layout's to fix, not each spec's.
const IGNORED = [/^Transition was aborted because of timeout in DOM update/];

export function failOnPageErrors() {
	let errors: string[] = [];
	test.beforeEach(({ page }) => {
		errors = [];
		const watch = (p: typeof page) =>
			p.on('pageerror', (error) => {
				if (!IGNORED.some((re) => re.test(error.message))) errors.push(`${p.url()}: ${error.message}`);
			});
		watch(page);
		page.context().on('page', watch);
	});
	test.afterEach(() => {
		expect(errors, 'uncaught errors in the page').toEqual([]);
	});
}
