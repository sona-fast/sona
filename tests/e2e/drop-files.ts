import { expect, type Page } from '@playwright/test';

// Shared drag-and-drop steps for the admin upload-zone specs (SONA-216). The
// browser can't be driven to drag a real file in, so both specs build a
// DataTransfer inside the page and dispatch the events the drop attachment
// listens for.

/**
 * Dispatch a `drop` carrying `files` on the first element matching `selector`,
 * and report whether a handler cancelled it.
 *
 * The events are `cancelable` because preventDefault is the whole point: it is
 * the only thing standing between a dropped file and the browser navigating the
 * tab to it. A dispatched (untrusted) DragEvent never navigates on its own, so
 * the return value is how a swallow-only target can be asserted at all.
 */
export function dropOn(page: Page, selector: string, files: { name: string; type: string }[]) {
	return page.evaluate(
		({ selector, files }) => {
			const dt = new DataTransfer();
			for (const f of files)
				dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], f.name, { type: f.type }));
			return !document.querySelector(selector)!.dispatchEvent(
				new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
			);
		},
		{ selector, files }
	);
}

/** Dispatch a `dragover` on the first element matching `selector`. */
export function dragOver(page: Page, selector: string) {
	return page.evaluate((selector) => {
		document.querySelector(selector)!.dispatchEvent(
			new DragEvent('dragover', {
				dataTransfer: new DataTransfer(),
				bubbles: true,
				cancelable: true
			})
		);
	}, selector);
}

/**
 * A dragover must both set the class and repaint the zone. The class is set
 * imperatively and matched by a `:global()` rule, so assert the painted border
 * changed too — the class landing alone would pass with the rule deleted.
 */
export async function expectDragOverHighlight(page: Page, selector: string) {
	const zone = page.locator(selector);
	const resting = await zone.evaluate((el) => getComputedStyle(el).borderColor);
	await dragOver(page, selector);
	await expect(zone).toHaveClass(/drag-over/);
	await expect.poll(() => zone.evaluate((el) => getComputedStyle(el).borderColor)).not.toBe(resting);
}
