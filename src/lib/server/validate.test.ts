import { describe, it, expect } from 'vitest';
import { normalizeHttpsUrl, sanitizeUrl } from './validate';

describe('sanitizeUrl', () => {
	it('passes a root-relative storage path through unchanged', () => {
		// The /img/<key> form storage falls back to with no public CDN URL. Must
		// stay relative — prefixing https:// would point it at an external host.
		expect(sanitizeUrl('/img/abc123.png')).toBe('/img/abc123.png');
	});

	// A control character after the leading slash hid a protocol-relative URL from
	// the '//' and '/\' guards: '/<TAB>/evil.example' looked root-relative, was
	// returned verbatim, and a browser then stripped the tab and resolved it to
	// https://evil.example/ — a same-origin-looking link pointing off-site.
	//
	// Note what is NOT claimed here: sanitizeUrl is not an open-redirect guard. It
	// sanitizes owner-supplied artist and social links, which are allowed to be
	// external, so '//evil.example' legitimately comes back as an absolute URL to
	// that host. The property under test is narrower — a control character must not
	// buy input the same-origin ROOT-RELATIVE treatment the /img/<key> branch
	// grants, and must not change the outcome at all.
	for (const [name, ctrl] of [
		['TAB', '\t'],
		['LF', '\n'],
		['CR', '\r'],
		// NUL is not whitespace, so it is the case that pins the strip-before-trim
		// order: a leading one used to survive trim() and leave the spaces after it
		// in place, walking the padded value past the protocol check.
		['NUL', '\u0000']
	] as const) {
		it(`a ${name} cannot smuggle a protocol-relative URL past the guards`, () => {
			const out = sanitizeUrl(`/${ctrl}/evil.example`);
			// Not returned as a root-relative path, which is what the bug produced.
			expect(out?.startsWith('/')).toBe(false);
			// No control character survives into the stored value.
			expect(out).not.toMatch(/[\u0000-\u001F\u007F]/);
			// And the same answer as the character-free equivalent: the control
			// character bought the input nothing.
			expect(out).toBe(sanitizeUrl('//evil.example'));
		});

		it(`a ${name} does not corrupt a legitimate root-relative path`, () => {
			// Dropped from the middle of a key; the path stays same-origin.
			expect(sanitizeUrl(`/img/abc${ctrl}123.png`)).toBe('/img/abc123.png');
		});

		it(`a leading ${name} before whitespace does not hide a dangerous protocol`, () => {
			// Order-of-operations guard: the strip has to run before the trim, or a
			// non-whitespace control character leaves the padding for the protocol
			// check to choke on and the value comes back as 'https://   javascript:…'.
			expect(sanitizeUrl(`${ctrl}   javascript:alert(1)`)).toBeNull();
			expect(sanitizeUrl(`  ${ctrl}  data:text/html,<script>`)).toBeNull();
		});
	}

	it('blocks a javascript: URL split by a control character', () => {
		// Hardening cover, not a fixed bug: 'java<TAB>script:' did dodge the
		// startsWith, but the value it fell through to was 'https://java<TAB>script:
		// alert(1)', which the URL parser rejects outright — so the link was inert
		// either way. Kept so the protocol check keeps seeing the collapsed string.
		expect(sanitizeUrl('java\tscript:alert(1)')).toBeNull();
	});

	it('blocks the plain dangerous protocols', () => {
		expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
		expect(sanitizeUrl('data:text/html,<script>')).toBeNull();
		expect(sanitizeUrl('vbscript:msgbox')).toBeNull();
	});

	it('keeps an absolute http(s) URL and adds https to a bare host', () => {
		expect(sanitizeUrl('https://taro.surf')).toBe('https://taro.surf');
		expect(sanitizeUrl('http://taro.surf')).toBe('http://taro.surf');
		expect(sanitizeUrl('taro.surf')).toBe('https://taro.surf');
	});

	it('returns null for empty input', () => {
		expect(sanitizeUrl('')).toBeNull();
		expect(sanitizeUrl(null)).toBeNull();
		expect(sanitizeUrl(undefined)).toBeNull();
		expect(sanitizeUrl('   ')).toBeNull();
	});
});

describe('normalizeHttpsUrl', () => {
	it('keeps a valid absolute https URL', () => {
		expect(normalizeHttpsUrl('https://taro.surf')).toBe('https://taro.surf');
	});

	it('strips a trailing slash', () => {
		expect(normalizeHttpsUrl('https://taro.surf/')).toBe('https://taro.surf');
		expect(normalizeHttpsUrl('https://taro.surf/path/')).toBe('https://taro.surf/path');
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeHttpsUrl('  https://taro.surf  ')).toBe('https://taro.surf');
	});

	it('rejects a non-https (http) URL', () => {
		expect(normalizeHttpsUrl('http://taro.surf')).toBeNull();
	});

	it('rejects a bare host with no scheme', () => {
		expect(normalizeHttpsUrl('taro.surf')).toBeNull();
	});

	it('rejects a malformed URL', () => {
		// e.g. the value ensureUrlScheme('bad domain!!') produces before validation.
		expect(normalizeHttpsUrl('https://bad domain!!')).toBeNull();
	});

	it('returns null for empty / whitespace / nullish input', () => {
		expect(normalizeHttpsUrl('')).toBeNull();
		expect(normalizeHttpsUrl('   ')).toBeNull();
		expect(normalizeHttpsUrl(null)).toBeNull();
		expect(normalizeHttpsUrl(undefined)).toBeNull();
	});
});
