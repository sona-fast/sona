import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from './+page.server';
import { qrMatrix } from '$lib/qr';

type QrData = {
	qr: { path: string; viewBox: string; translate: number };
	connectUrl: string;
	displayUrl: string;
};

function loadAt(href: string): QrData {
	return load({ url: new URL(href) } as never) as QrData;
}

describe('/connect/qr', () => {
	it('encodes the fork’s /connect URL, not this page', () => {
		const data = loadAt('https://sparky.ink/connect/qr');
		expect(data.connectUrl).toBe('https://sparky.ink/connect');
		expect(data.connectUrl).not.toContain('/qr');
	});

	// The card's QR is only safe to print because /connect is never gated. If this
	// ever encodes a gateable route, every printed card dies with a lapsed key.
	it('never encodes an admin or gated path', () => {
		const data = loadAt('https://sparky.ink/connect/qr');
		expect(data.connectUrl).not.toContain('/admin');
	});

	it('renders a scannable path with the quiet zone applied', () => {
		const data = loadAt('https://sparky.ink/connect/qr');
		const side = qrMatrix('https://sparky.ink/connect').count + data.qr.translate * 2;
		expect(data.qr.viewBox).toBe(`0 0 ${side} ${side}`);
		expect(data.qr.path.length).toBeGreaterThan(0);
		expect(data.qr.translate).toBeGreaterThan(0);
	});

	it('shows the host and path without the scheme, for reading aloud', () => {
		expect(loadAt('https://sparky.ink/connect/qr').displayUrl).toBe('sparky.ink/connect');
	});

	// Forks run on their own domains, and one of them is on a port in local dev.
	it('follows the requesting origin rather than a hardcoded host', () => {
		expect(loadAt('https://akito.dog/connect/qr').connectUrl).toBe('https://akito.dog/connect');
		expect(loadAt('http://localhost:5173/connect/qr').displayUrl).toBe('localhost:5173/connect');
	});

	// This route exists because admin fails closed on a D1 outage. If it ever
	// needs a database it has lost its reason to be a separate page.
	it('does not touch the database', () => {
		const data = load({ url: new URL('https://sparky.ink/connect/qr') } as never);
		expect(data).toBeTruthy();
	});

	// The (paths) group's layout reads settings from D1, and /admin validates its
	// session against it. Either group would put the round trip this page exists
	// to avoid back in front of it.
	it('sits outside every route group', () => {
		expect(new URL('.', import.meta.url).pathname).not.toMatch(/\/\([^)]*\)\//);
	});
});

describe('/connect/qr markup', () => {
	// Source-pin, per the con-card-markup.test.ts precedent: nothing renders this
	// page under the pure-TS vitest setup, and both fixes below fail silently:
	// one only at 200% zoom, the other only in a screen reader.
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

	it('stays reachable when the plate is taller than the viewport', () => {
		// Fixed, full-viewport and centered: at 200% zoom, or on a phone held
		// landscape, plain centering pushes the typed-URL fallback off both ends
		// with nothing to scroll.
		expect(source).toMatch(/justify-content: safe center;/);
		expect(source).toMatch(/overflow: auto;/);
	});

	it('names the code as a QR code, not as a bare URL', () => {
		expect(source).toMatch(/aria-label=\{m\.con_qr_svg_label\(\{ url: data\.displayUrl \}\)\}/);
	});

	it('paints its text in a system font, without waiting on the webfont chain', () => {
		expect(source).toMatch(/font-family:\s*\n?\s*system-ui/);
		// Nothing on the page re-opts into the branded family.
		expect(source).not.toContain('var(--font-primary)');
	});
});
