import { describe, it, expect } from 'vitest';
import { loupeCenterX } from './loupe-position';

const LOUPE = 120; // matches RefSheetPicker's loupe CSS size

describe('loupeCenterX', () => {
	it('centers on the pointer when there is room', () => {
		expect(loupeCenterX(300, 600, LOUPE, false)).toBe(300);
	});

	it('clamps to the canvas edges', () => {
		expect(loupeCenterX(3, 600, LOUPE, false)).toBe(64); // LOUPE/2 + 4
		expect(loupeCenterX(599, 600, LOUPE, false)).toBe(536);
	});

	it('touch near the top edge shifts the loupe to the right of the finger', () => {
		// shift = LOUPE/2 + 44 = 104 — clear of the contact point, not under it
		expect(loupeCenterX(300, 600, LOUPE, true)).toBe(404);
	});

	it('touch near the top-right corner shifts left instead', () => {
		expect(loupeCenterX(550, 600, LOUPE, true)).toBe(446);
	});

	it('never leaves the canvas even when neither side fully fits', () => {
		expect(loupeCenterX(100, 220, LOUPE, true)).toBe(64);
	});
});
