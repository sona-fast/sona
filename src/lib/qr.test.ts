import { describe, it, expect } from 'vitest';
import { qrMatrix, qrPath, qrSvg, QR_QUIET_ZONE } from './qr';

const URL_ = 'https://sparky.ink/connect';

describe('qrMatrix', () => {
	it('produces a square matrix', () => {
		const m = qrMatrix(URL_);
		expect(m.dark).toHaveLength(m.count);
		for (const row of m.dark) expect(row).toHaveLength(m.count);
	});

	it('places the three finder patterns', () => {
		// A scanner locates the code by these. If they are missing or misplaced the
		// output is not a QR code, whatever else it looks like.
		const m = qrMatrix(URL_);
		const corners: Array<[number, number]> = [
			[0, 0],
			[0, m.count - 7],
			[m.count - 7, 0]
		];
		for (const [r0, c0] of corners) {
			// 7x7 finder: dark ring, light ring, 3x3 dark core.
			expect(m.dark[r0][c0]).toBe(true);
			expect(m.dark[r0 + 1][c0 + 1]).toBe(false);
			expect(m.dark[r0 + 3][c0 + 3]).toBe(true);
		}
	});

	it('lays down the timing pattern', () => {
		// Row 6 and column 6 alternate between the finders; scanners use them to
		// work out the module grid. (The bottom-right corner is deliberately not
		// asserted: it carries data and ECC, so its value depends on the payload
		// and the chosen mask.)
		const m = qrMatrix(URL_);
		for (let i = 8; i < m.count - 8; i++) {
			expect(m.dark[6][i]).toBe(i % 2 === 0);
			expect(m.dark[i][6]).toBe(i % 2 === 0);
		}
	});

	it('grows the matrix for a longer payload', () => {
		const short = qrMatrix('https://a.ink/connect');
		const long = qrMatrix(`https://a-much-longer-domain-name.example/connect?${'x'.repeat(200)}`);
		expect(long.count).toBeGreaterThan(short.count);
	});

	it('is deterministic', () => {
		expect(qrMatrix(URL_)).toEqual(qrMatrix(URL_));
	});

	it('refuses an empty payload rather than encoding nothing', () => {
		expect(() => qrMatrix('')).toThrow();
	});
});

describe('qrPath', () => {
	it('emits one square per dark module', () => {
		const m = qrMatrix(URL_);
		const darkCount = m.dark.flat().filter(Boolean).length;
		expect(qrPath(m).match(/M/g) ?? []).toHaveLength(darkCount);
	});
});

describe('qrSvg', () => {
	it('reserves the quiet zone on every side', () => {
		// Without the margin, scanners fail against a busy background.
		const m = qrMatrix(URL_);
		const svg = qrSvg(URL_);
		const side = m.count + QR_QUIET_ZONE * 2;
		expect(svg.viewBox).toBe(`0 0 ${side} ${side}`);
		expect(svg.translate).toBe(QR_QUIET_ZONE);
	});
});
