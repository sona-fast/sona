import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeDimensions } from './probe-dimensions';

// Unit pins for THE dimension probe (SP4, R3-T2): the video/image branch
// split, the resolve-not-reject error contract, and the object-URL lifecycle.
// Browser globals are faked via vi.stubGlobal per the model-route tests'
// pattern — the fake elements fire their callbacks on a microtask after src
// is assigned, like a real async decode.

type Outcome = { width: number; height: number } | 'error';

// A media-element fake: assigning src schedules the success or error callback.
// The video shape carries videoWidth/videoHeight + onloadedmetadata; the image
// shape naturalWidth/naturalHeight + onload.
function fakeElement(outcome: Outcome, kind: 'video' | 'image') {
	const el: Record<string, unknown> = { preload: '' };
	Object.defineProperty(el, 'src', {
		set() {
			queueMicrotask(() => {
				if (outcome === 'error') {
					(el.onerror as () => void)?.();
				} else if (kind === 'video') {
					el.videoWidth = outcome.width;
					el.videoHeight = outcome.height;
					(el.onloadedmetadata as () => void)?.();
				} else {
					el.naturalWidth = outcome.width;
					el.naturalHeight = outcome.height;
					(el.onload as () => void)?.();
				}
			});
		}
	});
	return el;
}

// Stubs URL (createObjectURL/revokeObjectURL), document.createElement and
// Image so both probe branches run under Node. Returns the spies.
function stubMediaGlobals(outcome: Outcome) {
	const createObjectURL = vi.fn(() => 'blob:probe-test');
	const revokeObjectURL = vi.fn();
	// Extending the real URL keeps `new URL(...)` intact for everything else.
	vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
	const createElement = vi.fn((tag: string) => {
		if (tag !== 'video') throw new Error(`unexpected createElement('${tag}')`);
		return fakeElement(outcome, 'video');
	});
	vi.stubGlobal('document', { createElement });
	vi.stubGlobal(
		'Image',
		class {
			constructor() {
				// eslint-disable-next-line @typescript-eslint/no-constructor-return
				return fakeElement(outcome, 'image');
			}
		}
	);
	return { createObjectURL, revokeObjectURL, createElement };
}

describe('probeDimensions (SONA-124 R3-T2)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('probes video/* files through a <video> metadata load', async () => {
		const { createObjectURL, createElement } = stubMediaGlobals({ width: 640, height: 360 });
		const file = new File(['x'], 'clip.webm', { type: 'video/webm' });
		await expect(probeDimensions(file)).resolves.toEqual({ width: 640, height: 360 });
		expect(createElement).toHaveBeenCalledWith('video');
		expect(createObjectURL).toHaveBeenCalledWith(file);
	});

	it('probes image files through an Image load', async () => {
		const { createElement } = stubMediaGlobals({ width: 1920, height: 1080 });
		const file = new File(['x'], 'shot.png', { type: 'image/png' });
		await expect(probeDimensions(file)).resolves.toEqual({ width: 1920, height: 1080 });
		// The image branch never touches document.createElement.
		expect(createElement).not.toHaveBeenCalled();
	});

	it('resolves { null, null } on undecodable input instead of rejecting', async () => {
		// Dimensions are best-effort metadata, not a validation gate.
		stubMediaGlobals('error');
		await expect(
			probeDimensions(new File(['x'], 'bad.png', { type: 'image/png' }))
		).resolves.toEqual({ width: null, height: null });
		await expect(
			probeDimensions(new File(['x'], 'bad.webm', { type: 'video/webm' }))
		).resolves.toEqual({ width: null, height: null });
	});

	it('revokes the object URL on every path (success and error, both branches)', async () => {
		for (const outcome of [{ width: 10, height: 10 }, 'error'] as const) {
			for (const type of ['image/png', 'video/webm']) {
				const { createObjectURL, revokeObjectURL } = stubMediaGlobals(outcome);
				await probeDimensions(new File(['x'], 'f', { type }));
				expect(createObjectURL).toHaveBeenCalledTimes(1);
				expect(revokeObjectURL).toHaveBeenCalledWith('blob:probe-test');
				vi.unstubAllGlobals();
			}
		}
	});
});
