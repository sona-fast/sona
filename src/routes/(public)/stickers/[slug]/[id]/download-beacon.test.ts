import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the sticker-detail download-count wiring against the page source (same
// pattern as gallery/[slug]/download-beacon.test.ts). The download bytes stream
// through the endpoint, but the COUNT rides this client beacon — drop
// `onDownload={countDownload}` or `keepalive: true` and download counting
// silently dies with the whole suite green, so both are pinned here.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('sticker detail download beacon wiring', () => {
	it('wires countDownload into DownloadMenu via onDownload', () => {
		const component = pageSrc.match(/<DownloadMenu[\s\S]*?\/>/)?.[0];
		expect(component).toBeDefined();
		expect(component).toContain('onDownload={countDownload}');
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
