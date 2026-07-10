import { describe, it, expect } from 'vitest';
import { avatarHue, avatarColor, avatarInitials } from './avatar-color';

// Independent contrast math (mirrors theme-contrast.test.ts) so the assertions
// below don't lean on the module's own luminance helper.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = h / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const m = l - c / 2;
	return [r + m, g + m, b + m];
}

function lin(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminanceFromChannels([r, g, b]: [number, number, number]): number {
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function hexLuminance(hex: string): number {
	const n = parseInt(hex.slice(1), 16);
	return luminanceFromChannels([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
}

function contrast(a: number, b: number): number {
	const [hi, lo] = [a, b].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

// hsl(H, 65%, 45%) — parse H back out of the bg string for the contrast check.
function bgLuminance(bg: string): number {
	const h = Number(bg.match(/hsl\((\d+)/)![1]);
	return luminanceFromChannels(hslToRgb(h, 0.65, 0.45));
}

describe('avatarHue', () => {
	it('is deterministic — same name always yields the same hue', () => {
		expect(avatarHue('Boltie')).toBe(avatarHue('Boltie'));
		expect(avatarColor('Boltie')).toEqual(avatarColor('Boltie'));
	});

	it('ignores surrounding whitespace', () => {
		expect(avatarHue('  Luna Paws  ')).toBe(avatarHue('Luna Paws'));
	});

	it('spreads obviously different names to different hues', () => {
		expect(avatarHue('Ember')).not.toBe(avatarHue('Luna'));
		expect(avatarHue('A')).not.toBe(avatarHue('B'));
	});

	it('stays within [0, 360)', () => {
		for (const name of ['', 'x', 'Zaps', 'a very long artist name here']) {
			const h = avatarHue(name);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
		}
	});
});

describe('avatarColor contrast (WCAG AA)', () => {
	// The whole point of the fixed S/L + luminance-picked text: text is legible on
	// the chip for EVERY hue the hash can produce, on any theme (chip colors are
	// theme-independent constants).
	it('text meets 4.5:1 on the chip for all 360 hues', () => {
		for (let h = 0; h < 360; h++) {
			const bg = `hsl(${h}, 65%, 45%)`;
			const fg = luminanceFromChannels(hslToRgb(h, 0.65, 0.45)) <= 0.18 ? '#ffffff' : '#000000';
			expect(contrast(hexLuminance(fg), bgLuminance(bg))).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("picks the fg avatarColor() actually returns for a sampled name", () => {
		const { bg, fg } = avatarColor('Sparky');
		expect(contrast(hexLuminance(fg), bgLuminance(bg))).toBeGreaterThanOrEqual(4.5);
	});
});

describe('avatarInitials', () => {
	it('takes up to two initials, uppercased', () => {
		expect(avatarInitials('Luna Paws')).toBe('LP');
		expect(avatarInitials('boltie')).toBe('B');
		expect(avatarInitials('a b c')).toBe('AB');
	});
});
