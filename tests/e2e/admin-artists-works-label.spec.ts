import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// The Works label on /admin/artists may wrap only after a "· ". Latin text stays
// whole through the NBSPs worksLabel() puts inside each segment; CJK breaks
// between any two characters, so for ja the `.works-label { word-break:
// keep-all }` rule does it. Seeded Avatar Artist has one image and one VR avatar
// credit (tests/e2e/fixtures/seed.sql), so the label has two segments.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('the ja Works label never breaks between a number and its counter', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto('/admin/artists?q=Avatar');

	const label = page.locator('td.artwork-count .works-label');
	await expect(label).toHaveText(/作品\s1件\s·\sVRアバター\s1体/);
	// min-content takes every break the page's rules allow, so a break inside a
	// segment can't hide behind a column that happens to be wide enough.
	await page.addStyleTag({ content: '.works-label { display: inline-block; width: min-content; }' });

	// Line tops of each "· "-separated segment, measured per character.
	const lines = await label.evaluate((el) => {
		const text = el.textContent ?? '';
		const node = el.firstChild as Text;
		const range = document.createRange();
		let start = 0;
		return text.split('· ').map((segment) => {
			const tops = new Set<number>();
			for (let c = start; c < start + segment.length; c++) {
				if (/\s/.test(text[c])) continue;
				range.setStart(node, c);
				range.setEnd(node, c + 1);
				for (const r of range.getClientRects()) tops.add(Math.round(r.top));
			}
			start += segment.length + 2;
			return [...tops];
		});
	});
	// Precondition: the label wrapped at every "· ", so the check below is live.
	expect(new Set(lines.flat()).size).toBe(lines.length);
	for (const tops of lines) expect(tops).toHaveLength(1);
});
