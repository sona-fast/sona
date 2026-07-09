import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the download-count client wiring against the page source (same spirit
// as lcp-image.test.ts). The bytes go straight from the browser to the storage
// provider, so this beacon is the ONLY place a press can be observed — and it is
// pure client wiring no server test can cover. Drop `onclick={countDownload}` or
// `keepalive: true` and download counting silently dies with the whole suite
// green, so both are pinned here.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('gallery download beacon wiring', () => {
	it('wires countDownload onto the <a download> button', () => {
		// The download anchor must carry the onclick handler.
		const anchor = pageSrc.match(/<a[^>]*\bdownload\b[^>]*>/)?.[0];
		expect(anchor).toBeDefined();
		expect(anchor).toContain('onclick={countDownload}');
		expect(anchor).toContain('href={image.imageUrl}');
	});

	it('countDownload POSTs the metrics beacon with keepalive so it outlives navigation', () => {
		const fn = pageSrc.match(/function countDownload\(\)\s*\{[\s\S]*?\n\t\}/)?.[0];
		expect(fn).toBeDefined();
		expect(fn).toContain("fetch('/api/metrics/download'");
		expect(fn).toContain("method: 'POST'");
		expect(fn).toContain('keepalive: true');
		// Failure must be swallowed — a failed count must never cost the download.
		expect(fn).toContain('.catch(');
	});
});
