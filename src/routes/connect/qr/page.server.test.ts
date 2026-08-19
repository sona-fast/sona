import { describe, it, expect } from 'vitest';
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
});
