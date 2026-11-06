import { describe, it, expect } from 'vitest';
import { navCurrent } from './nav';

describe('navCurrent', () => {
	it('marks Gallery as the page only on /gallery itself', () => {
		expect(navCurrent('/gallery', '/gallery')).toBe('page');
	});

	it('marks Gallery as the current section on its tabs and their detail pages', () => {
		for (const path of [
			'/gallery/some-piece',
			'/gallery/fursuit/12',
			'/stickers',
			'/stickers/pack',
			'/stickers/pack/3',
			'/vr',
			'/vr/avatar'
		]) {
			expect(navCurrent('/gallery', path), path).toBe('true');
		}
	});

	it('leaves Gallery unmarked elsewhere, including on lookalike paths', () => {
		for (const path of ['/', '/about', '/collections', '/collections/c', '/galleryx', '/vrchat', '/stickersheet']) {
			expect(navCurrent('/gallery', path), path).toBeUndefined();
		}
	});

	it('marks the other items by their own path', () => {
		expect(navCurrent('/about', '/about')).toBe('page');
		expect(navCurrent('/collections', '/collections/c')).toBe('true');
		expect(navCurrent('/about', '/gallery')).toBeUndefined();
	});

	it('marks Home only on the homepage', () => {
		expect(navCurrent('/', '/')).toBe('page');
		expect(navCurrent('/', '/gallery')).toBeUndefined();
	});
});
