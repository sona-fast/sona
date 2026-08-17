import { afterEach, describe, it, expect, vi } from 'vitest';
import { downloadFile, parseStickerSetName, stickerSetUrl, isTelegramEnabled } from './telegram';

// parseStickerSetName is the trust boundary for what we send to the Bot API: it
// must extract a clean [A-Za-z0-9_] set name from whatever the admin pastes and
// reject anything else (no path traversal / injection into the API URL).

describe('parseStickerSetName', () => {
	it('extracts the name from a full addstickers URL', () => {
		expect(parseStickerSetName('https://t.me/addstickers/ExamplePack99')).toBe('ExamplePack99');
	});

	it('extracts from a scheme-less t.me link', () => {
		expect(parseStickerSetName('t.me/addstickers/MyPack_2')).toBe('MyPack_2');
	});

	it('accepts a bare set name', () => {
		expect(parseStickerSetName('JustTheName')).toBe('JustTheName');
	});

	it('tolerates a trailing slash and surrounding whitespace', () => {
		expect(parseStickerSetName('  https://t.me/addstickers/Foo/  ')).toBe('Foo');
	});

	it('rejects input with no valid set-name token', () => {
		expect(parseStickerSetName('https://example.com/')).toBeNull();
		expect(parseStickerSetName('   ')).toBeNull();
		expect(parseStickerSetName('!!!')).toBeNull();
	});
});

describe('stickerSetUrl', () => {
	it('builds the canonical addstickers link', () => {
		expect(stickerSetUrl('ExamplePack99')).toBe('https://t.me/addstickers/ExamplePack99');
	});
});

describe('isTelegramEnabled', () => {
	it('gates on the bot token presence', () => {
		expect(isTelegramEnabled(undefined)).toBe(false);
		expect(isTelegramEnabled({} as never)).toBe(false);
		expect(isTelegramEnabled({ TELEGRAM_BOT_TOKEN: '' } as never)).toBe(false);
		expect(isTelegramEnabled({ TELEGRAM_BOT_TOKEN: '123:abc' } as never)).toBe(true);
	});
});

describe('downloadFile', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects a file CDN body over the 10 MiB remote cap (not the 64 MiB upload cap)', async () => {
		// Remote bodies stay on the old 10 MiB bound, decoupled from the raised
		// local MAX_BUFFER_BYTES — one over must throw, never buffer up to 64 MiB.
		const big = new Uint8Array(10 * 1024 * 1024 + 1);
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				// getFile resolves the file_id to a path…
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ ok: true, result: { file_path: 'stickers/file_0.webp' } }))
				)
				// …then the file CDN answers with an oversized body.
				.mockResolvedValueOnce(new Response(big))
		);

		await expect(downloadFile({ TELEGRAM_BOT_TOKEN: '123:abc' }, 'file-id')).rejects.toThrow(
			/buffer cap/
		);
	});
});
