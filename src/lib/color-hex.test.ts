import { describe, it, expect } from 'vitest';
import { normalizeHex, rgbToHex } from './color-hex';

describe('normalizeHex', () => {
	it('keeps a canonical #RRGGBB (uppercased)', () => {
		expect(normalizeHex('#3A6EA5')).toBe('#3A6EA5');
		expect(normalizeHex('#dd5131')).toBe('#DD5131');
	});

	it('accepts 6-digit hex without the leading #', () => {
		expect(normalizeHex('dd5131')).toBe('#DD5131');
	});

	it('expands 3-digit hex, with or without the #', () => {
		expect(normalizeHex('#abc')).toBe('#AABBCC');
		expect(normalizeHex('f80')).toBe('#FF8800');
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeHex('  #dd5131  ')).toBe('#DD5131');
	});

	it('rejects invalid input', () => {
		expect(normalizeHex('')).toBeNull();
		expect(normalizeHex('#')).toBeNull();
		expect(normalizeHex('xyz')).toBeNull();
		expect(normalizeHex('#ab')).toBeNull();
		expect(normalizeHex('#abcd')).toBeNull(); // 4-digit (RGBA shorthand) not accepted
		expect(normalizeHex('#abcde')).toBeNull();
		expect(normalizeHex('#aabbccdd')).toBeNull(); // 8-digit RGBA not accepted
		expect(normalizeHex('##aabbcc')).toBeNull();
		expect(normalizeHex('rgb(1,2,3)')).toBeNull();
	});
});

describe('rgbToHex', () => {
	it('formats an r/g/b triple as uppercase #RRGGBB', () => {
		expect(rgbToHex(221, 81, 49)).toBe('#DD5131');
		expect(rgbToHex(0, 0, 0)).toBe('#000000');
		expect(rgbToHex(255, 255, 255)).toBe('#FFFFFF');
	});

	it('zero-pads low components', () => {
		expect(rgbToHex(1, 2, 3)).toBe('#010203');
	});

	it('clamps out-of-range components', () => {
		expect(rgbToHex(-5, 300, 128)).toBe('#00FF80');
	});
});
