import { test, expect, type Page, type Request } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';

// The entry form's "Add {handle} as a new artist" (SONA-236). The New Artist
// dialog it opens starts with the handle as the name and Keep private ticked,
// and the dialog promises not to share a private artist with the registry. So
// while Keep private is ticked the name must not go out as a registry search,
// not even the one a prefilled name would run on open; unticking it searches
// for the name once.
//
// Runs on the registry-sync project (playwright.config.ts): the only server with
// the registry turned on, without which the dialog never searches at all, so a
// "no search" there would prove nothing. Its wrangler.e2e-registry.toml opens
// the commission ledger's early-access gate for the entry form. The registry
// interceptor answers as a healthy, empty registry, and nothing is created.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-registry.toml (throwaway value).
const PASSWORD = 'e2e-admin-password';
// English text of admin_lookup_guess_line_registry (messages/en.json). It
// promises a registry match can replace the guess, so it must not show while
// Keep private has the registry search off.
const REGISTRY_GUESS_LINE = 'Picking a registry match replaces what Sona filled.';
// Longer than the dialog's 250 ms search debounce, so a search that was going to
// fire has fired.
const PAST_DEBOUNCE_MS = 1_000;

/** Pastes `value` into the link field, which looks the link up on paste. */
async function paste(input: ReturnType<Page['getByLabel']>, value: string) {
	await input.evaluate((el, v) => {
		const field = el as HTMLInputElement;
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, v);
		field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: v }));
	}, value);
}

/** Opens a fresh entry form and pastes a link to `handle`, which no artist holds. */
async function offerAdd(page: Page, link: string, handle: string) {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions/new');
	await waitForHydration(page);
	await paste(page.getByLabel('Link to where you asked'), link);
	const addHandle = page.locator('.lookup').getByRole('button', { name: `Add ${handle} as a new artist` });
	await expect(addHandle).toBeVisible();
	return addHandle;
}

test('Add {handle} searches the registry only after Keep private is unticked', async ({ page }, testInfo) => {
	// Unique per run, so a rerun against a reused DB still finds no artist.
	const handle = `prv${Date.now() % 1e9}`;
	const addHandle = await offerAdd(page, `https://x.com/${handle}/status/1`, handle);

	const searches: Request[] = [];
	page.on('request', (req) => {
		if (new URL(req.url()).pathname === '/api/registry/search') searches.push(req);
	});

	await addHandle.click();
	const dialog = page.getByRole('dialog', { name: 'New Artist' });
	await expect(dialog.getByLabel('Artist Name')).toHaveValue(handle);
	const keepPrivate = dialog.getByLabel('Keep private');
	await expect(keepPrivate).toBeChecked();
	// The guess lines render for a pasted link, so a missing registry line below
	// is the gate, not the whole block being absent.
	const guessLines = dialog.locator('#lookup-guess-lines');
	await expect(guessLines).toContainText('from the link you pasted');
	await expect(guessLines.getByText(REGISTRY_GUESS_LINE)).toHaveCount(0);
	await page.waitForTimeout(PAST_DEBOUNCE_MS);
	expect(searches.map((r) => r.url())).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath('add-handle-private-no-search.png') });

	await keepPrivate.uncheck();
	await expect(guessLines.getByText(REGISTRY_GUESS_LINE)).toBeVisible();
	await expect.poll(() => searches.map((r) => new URL(r.url()).searchParams.get('q'))).toEqual([handle]);
	// Exactly one: the untick doesn't search twice, nor again after the debounce.
	await page.waitForTimeout(PAST_DEBOUNCE_MS);
	expect(searches.map((r) => new URL(r.url()).searchParams.get('q'))).toEqual([handle]);
	await page.screenshot({ path: testInfo.outputPath('add-handle-unticked-searched.png') });

	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
});

test('a wrapped Add {handle} label stays left-aligned with its icon on the first line', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	// Longer than any x.com handle can be, so the label wraps on a phone.
	const handle = `wrap-${Date.now()}-long-artist-name`;
	const addHandle = await offerAdd(page, `https://www.furaffinity.net/user/${handle}/`, handle);

	const box = await addHandle.evaluate((btn) => {
		const text = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!;
		const range = document.createRange();
		range.selectNodeContents(text);
		// One rect per line box; the first and last lines' left edges.
		const lines = [...range.getClientRects()];
		const icon = btn.querySelector('svg')!.getBoundingClientRect();
		const first = lines[0];
		return {
			lines: new Set(lines.map((r) => Math.round(r.top))).size,
			firstLeft: first.left,
			lastLeft: lines[lines.length - 1].left,
			firstMid: first.top + first.height / 2,
			iconMid: icon.top + icon.height / 2
		};
	});
	await page.screenshot({ path: testInfo.outputPath('add-handle-wrapped-390.png') });
	expect(box.lines).toBeGreaterThan(1);
	// Left-aligned: every line starts at the same edge, not centered.
	expect(Math.abs(box.lastLeft - box.firstLeft)).toBeLessThan(1);
	// The icon sits beside the first line, not centered on the whole block.
	expect(Math.abs(box.iconMid - box.firstMid)).toBeLessThan(3);
});
