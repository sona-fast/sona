import qrcode from 'qrcode-generator';

/**
 * QR encoding for the convention handoff.
 *
 * Wraps qrcode-generator (MIT, no dependencies) in the two shapes this codebase
 * needs: an SVG path for server-rendered markup, and a module matrix for drawing
 * into a canvas when the con card is exported as a PNG.
 *
 * Error correction is 'M' (~15% recoverable). The codes here get printed on a
 * card that lives in a badge holder and scanned in bad hall lighting, so some
 * tolerance for scuffing is worth the extra modules.
 */
const ERROR_CORRECTION = 'M' as const;

export interface QrMatrix {
	/** Modules per side, excluding the quiet zone. */
	count: number;
	/** Row-major; true is a dark module. */
	dark: boolean[][];
}

export function qrMatrix(text: string): QrMatrix {
	if (!text) throw new Error('qrMatrix: nothing to encode');
	// Type 0 lets the library pick the smallest version that fits the payload.
	const qr = qrcode(0, ERROR_CORRECTION);
	qr.addData(text);
	qr.make();

	const count = qr.getModuleCount();
	const dark: boolean[][] = [];
	for (let row = 0; row < count; row++) {
		const line: boolean[] = [];
		for (let col = 0; col < count; col++) line.push(qr.isDark(row, col));
		dark.push(line);
	}
	return { count, dark };
}

/**
 * One SVG path covering every dark module, as 1x1 squares in module units.
 *
 * A single path rather than a rect per module: a URL-sized code is a few hundred
 * modules, and one path keeps the markup small enough to inline comfortably.
 * Pair with viewBox="0 0 {count + 2 * quietZone} ..." and translate by the quiet
 * zone. Scanners need that margin; without it the code is unreliable against a
 * busy background.
 */
export function qrPath(matrix: QrMatrix): string {
	const parts: string[] = [];
	for (let row = 0; row < matrix.count; row++) {
		for (let col = 0; col < matrix.count; col++) {
			if (matrix.dark[row][col]) parts.push(`M${col} ${row}h1v1h-1z`);
		}
	}
	return parts.join('');
}

/** The quiet zone the QR spec asks for, in modules. */
export const QR_QUIET_ZONE = 4;

/** Everything a template needs to render the code inline. */
export function qrSvg(text: string): { path: string; viewBox: string; translate: number } {
	const matrix = qrMatrix(text);
	const side = matrix.count + QR_QUIET_ZONE * 2;
	return {
		path: qrPath(matrix),
		viewBox: `0 0 ${side} ${side}`,
		translate: QR_QUIET_ZONE
	};
}
