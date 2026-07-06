import { describe, it, expect } from 'vitest';
import {
	extFromType,
	needsRename,
	pastedFileName,
	extractImageFiles,
	shouldHandleImagePaste,
	type ClipboardItemLike
} from './clipboard';

const FIXED = new Date(2026, 6, 6, 9, 8, 7); // 2026-07-06 09:08:07 (month is 0-based)
const clock = () => FIXED;

function item(kind: string, type: string, file: File | null): ClipboardItemLike {
	return { kind, type, getAsFile: () => file };
}

describe('extFromType', () => {
	it('maps known image types to friendly extensions', () => {
		expect(extFromType('image/png')).toBe('png');
		expect(extFromType('image/jpeg')).toBe('jpg');
		expect(extFromType('image/gif')).toBe('gif');
		expect(extFromType('image/webp')).toBe('webp');
	});

	it('falls back to the mime subtype, then png', () => {
		expect(extFromType('image/avif')).toBe('avif');
		expect(extFromType('image/')).toBe('png');
	});
});

describe('needsRename', () => {
	it('renames empty and generic browser names', () => {
		expect(needsRename('')).toBe(true);
		expect(needsRename('image.png')).toBe(true);
		expect(needsRename('image.jpeg')).toBe(true);
	});

	it('keeps a real filename', () => {
		expect(needsRename('my-art.png')).toBe(false);
		expect(needsRename('screenshot-2026.jpg')).toBe(false);
	});
});

describe('pastedFileName', () => {
	it('zero-pads a stamp with no index', () => {
		expect(pastedFileName(FIXED)).toBe('pasted-20260706-090807.png');
	});

	it('honors extension and index', () => {
		expect(pastedFileName(FIXED, 'jpg', 2)).toBe('pasted-20260706-090807-2.jpg');
	});
});

describe('extractImageFiles', () => {
	it('keeps only image files and renames generic ones', () => {
		const img = new File(['x'], 'image.png', { type: 'image/png' });
		const files = extractImageFiles(
			[
				item('string', 'text/plain', null),
				item('file', 'image/png', img),
				item('file', 'application/pdf', new File(['y'], 'doc.pdf', { type: 'application/pdf' }))
			],
			clock
		);
		expect(files).toHaveLength(1);
		expect(files[0].name).toBe('pasted-20260706-090807.png');
		expect(files[0].type).toBe('image/png');
	});

	it('preserves a real filename', () => {
		const img = new File(['x'], 'my-art.webp', { type: 'image/webp' });
		const files = extractImageFiles([item('file', 'image/webp', img)], clock);
		expect(files[0].name).toBe('my-art.webp');
	});

	it('disambiguates multiple generic images with an index', () => {
		const a = new File(['a'], 'image.png', { type: 'image/png' });
		const b = new File(['b'], 'image.png', { type: 'image/png' });
		const files = extractImageFiles([item('file', 'image/png', a), item('file', 'image/png', b)], clock);
		expect(files.map((f) => f.name)).toEqual([
			'pasted-20260706-090807-1.png',
			'pasted-20260706-090807-2.png'
		]);
	});

	it('drops items whose getAsFile returns null', () => {
		const files = extractImageFiles([item('file', 'image/png', null)], clock);
		expect(files).toHaveLength(0);
	});
});

describe('shouldHandleImagePaste', () => {
	it('ignores pastes with no image', () => {
		expect(shouldHandleImagePaste({ imageCount: 0, hasText: false, focusInEditable: false })).toBe(false);
	});

	it('handles an image paste anywhere when there is no competing text', () => {
		expect(shouldHandleImagePaste({ imageCount: 1, hasText: false, focusInEditable: true })).toBe(true);
		expect(shouldHandleImagePaste({ imageCount: 1, hasText: true, focusInEditable: false })).toBe(true);
	});

	it('defers to text paste inside an input when both are present', () => {
		expect(shouldHandleImagePaste({ imageCount: 1, hasText: true, focusInEditable: true })).toBe(false);
	});
});
