import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins, following the footer-build-markup.test.ts precedent: the repo has
// no component renderer, so the accessible name of a shared control is pinned by
// reading the markup.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const copyCommandSrc = read('./CopyCommand.svelte');
const settingsSrc = read('../../routes/admin/settings/+page.svelte');

describe('CopyCommand accessible name', () => {
	it('names the button from the label prop, falling back to the generic "Copy"', () => {
		// The default is what every setup command uses; the prop exists so a page
		// with more than one copyable value can say WHICH one, since that name is
		// all a screen-reader user gets to tell the buttons apart.
		expect(copyCommandSrc).toMatch(/aria-label=\{label \?\? m\.admin_setup_copy\(\)\}/);
		expect(copyCommandSrc).toMatch(/label\?: string;/);
	});

	it('is passed a specific label by the feed-key row, which shares a page with other copy buttons', () => {
		// The settings page renders several CopyCommands; an unlabelled one here
		// would leave the screen reader announcing "Copy" four times over.
		expect(settingsSrc).toContain(
			'<CopyCommand text={feedKeyUrl} label={m.admin_settings_rss_copy()} />'
		);
	});
});
