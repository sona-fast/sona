import qrcode from 'qrcode-generator';

/**
 * QR encoding for the convention handoff.
 *
 * Wraps qrcode-generator (MIT, no dependencies) in the one shape this codebase
 * renders: an SVG path, inlined into markup. The module matrix is qrSvg's own
 * intermediate step; it stays exported because the structure a scanner actually
 * needs (finder patterns, timing row and column) is assertable on the matrix and
 * invisible in the path string the tests would otherwise have to parse. Nothing
 * outside the tests consumes it: the PNG export rasterizes the whole card SVG
 * through a canvas rather than drawing modules itself.
 *
 * Error correction is 'M' (~15% recoverable). The codes here get printed on a
 * card that lives in a badge holder and scanned in bad hall lighting, so some
 * tolerance for scuffing is worth the extra modules.
 */
const ERROR_CORRECTION = 'M' as const;

/**
 * The payload as one character per UTF-8 byte.
 *
 * qrcode-generator's byte mode takes the low byte of every code unit, so a
 * non-ASCII payload would encode as its own mojibake rather than fail. An
 * internationalized domain reaches us already punycoded, but a path or a query
 * string does not have to.
 */
function utf8Payload(text: string): string {
	return String.fromCharCode(...new TextEncoder().encode(text));
}

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
	qr.addData(utf8Payload(text));
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
