// Horizontal placement of the ref-sheet eyedropper loupe (RefSheetPicker).
// Pure math so the touch/top-edge side-offset behavior is unit-testable.
//
// Normally the loupe centers over the pointer, clamped inside the canvas. When
// a TOUCH pointer is near the top edge the loupe flips below the pointer — but
// straight below sits under the finger, so it shifts to whichever side of the
// contact point has room (right preferred, left otherwise, always clamped).

const EDGE = 4; // keep the glass this far inside the canvas edges
const FINGER_CLEAR = 44; // clearance past the contact point so the glass clears the fingertip

export function loupeCenterX(
	rawX: number,
	canvasWidth: number,
	loupeSize: number,
	sideOffset: boolean
): number {
	const min = loupeSize / 2 + EDGE;
	const max = canvasWidth - loupeSize / 2 - EDGE;
	if (sideOffset) {
		const shift = loupeSize / 2 + FINGER_CLEAR;
		if (rawX + shift <= max) return rawX + shift;
		return Math.max(min, rawX - shift);
	}
	return Math.max(min, Math.min(max, rawX));
}
