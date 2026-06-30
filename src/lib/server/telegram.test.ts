import { describe, it, expect } from 'vitest';
import { parseStickerSetName, stickerSetUrl, isTelegramEnabled } from './telegram';

// parseStickerSetName is the trust boundary for what we send to the Bot API: it
// must extract a clean [A-Za-z0-9_] set name from whatever the admin pastes and
// reject anything else (no path traversal / injection into the API URL).

describe('parseStickerSetName', () => {
	it('extracts the name from a full addstickers URL', () => {
		expect(parseStickerSetName('https://t.me/addstickers/Sparky84453')).toBe('Sparky84453');
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
		expect(stickerSetUrl('Sparky84453')).toBe('https://t.me/addstickers/Sparky84453');
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
