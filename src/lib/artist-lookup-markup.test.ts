import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source pins for the "Look up artist" UI (SONA-156). Nothing renders Svelte
// under the pure-TS vitest setup, so the wiring these components depend on is
// asserted against the source instead — the same shape the other *markup*
// tests in this repo use. The Playwright spec (tests/e2e/artist-lookup.spec.ts)
// covers whether the states actually swap in a browser.

const read = (path: string) => readFileSync(path, 'utf8');
const UPLOAD = read('src/routes/admin/upload/+page.svelte');
const EDIT = read('src/routes/admin/images/[id]/edit/+page.svelte');
const PANEL = read('src/lib/components/ArtistLookupPanel.svelte');
const DIALOG = read('src/lib/components/NewArtistDialog.svelte');

describe('lookup button and its disclosure hint', () => {
	it('offers the button only when a key is configured, on both pages', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(/\{#if data\.lookupEnabled/);
			expect(source).toContain('m.admin_lookup_button()');
			// The no-key branch points at the settings tab that holds the key.
			expect(source).toContain('m.admin_lookup_no_key_pre()');
			expect(source).toContain('/admin/settings?tab=connections');
		}
	});

	it('describes the pill with the disclosure line, in both its variants', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(/class="lookup-pill"[\s\S]*?aria-describedby="lookup-hint"/);
			expect(source).toMatch(/id="lookup-hint"/);
			expect(source).toContain('m.admin_lookup_hint()');
			expect(source).toContain('m.admin_lookup_hint_private()');
			// The warn variant is a class swap on the same line, not a second one.
			expect(source).toMatch(/class:hint-warn=\{isPrivate\}/);
		}
	});

	it('explains the per-tile split on the upload page, in both its variants', () => {
		expect(UPLOAD).toContain('m.admin_lookup_hint_multi()');
		// The multi-tile hint names FuzzySearch and has its own private wording;
		// the warn class swap alone was claiming a disclosure that wasn't there.
		expect(UPLOAD).toContain('m.admin_lookup_hint_multi_private()');
	});

	it('describes each per-tile button with that same hint', () => {
		expect(UPLOAD).toMatch(/class="tile-lookup"[\s\S]*?aria-describedby="lookup-hint"/);
	});
});

describe('the panel', () => {
	it('is a labelled region whose body is a live status', () => {
		expect(PANEL).toMatch(/class="lookup-panel" role="region" aria-label=\{m\.admin_lookup_panel_label\(\)\}/);
		expect(PANEL).toMatch(/<div class="lookup-body" role="status">/);
	});

	it('opens result links safely in a new tab', () => {
		// Third-party post URLs: never hand the opener over.
		expect(PANEL).toMatch(/href=\{match\.postUrl\}\s+target="_blank"\s+rel="noopener noreferrer"/);
		expect(PANEL).toContain('m.admin_lookup_view_post_site(');
		expect(UPLOAD).toMatch(/href=\{result\.postUrl\}\s+target="_blank"\s+rel="noopener noreferrer"/);
	});

	it('covers every failure state the endpoint can report', () => {
		for (const reason of [
			'rate_limited',
			'key_refused',
			'too_large',
			'invalid_image',
			'signed_out'
		]) {
			expect(PANEL).toContain(`lookup.reason === '${reason}'`);
		}
		expect(PANEL).toContain('m.admin_lookup_failed_body()');
	});

	it('offers each outcome its own action', () => {
		expect(PANEL).toContain('m.admin_lookup_use_artist(');
		expect(PANEL).toContain('m.admin_lookup_using_artist(');
		expect(PANEL).toContain('m.admin_lookup_use_selected()');
		expect(PANEL).toContain('m.admin_lookup_add_new(');
		expect(PANEL).toContain('m.admin_lookup_add_instead()');
		expect(PANEL).toContain('m.admin_lookup_clash_add_variant()');
		// The ambiguity radios are a fieldset with a hidden legend.
		expect(PANEL).toMatch(/<fieldset class="pick-list">\s*<legend class="sr-only">/);
	});

	it('names the private-image disclosure after the lookup, in warn', () => {
		expect(PANEL).toContain('m.admin_lookup_private_notice()');
		expect(PANEL).toMatch(/\.private-notice \{[^}]*var\(--status-warn\)/);
	});

	// The file has already gone out on a failure too, so both pages key the
	// notice off lookupSentFile rather than off a result (SONA-156 round 1).
	it('shows the notice whenever the file actually went out', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(/privateNotice=\{isPrivate && lookupSentFile\(/);
		}
		// And on a variant tile whose lookup ran while Private was checked.
		expect(UPLOAD).toMatch(/isPrivate && lookupSentFile\(tile\.lookup\)/);
	});

	it('shows the clash thumbnail row with the piece it points at', () => {
		expect(PANEL).toMatch(/class="clash-thumb"[\s\S]*?alt=""/);
		expect(PANEL).toContain('m.admin_lookup_clash_uploaded(');
	});

	it('counts the ambiguous candidates and their pieces', () => {
		expect(PANEL).toContain('count: candidates.length');
		expect(PANEL).toContain('m.admin_lookup_pieces(');
	});
});

describe('the "From lookup" tag', () => {
	it('sits after the label as a sibling, described rather than named', () => {
		for (const source of [UPLOAD, EDIT]) {
			// The label wraps its own text only: a tag inside it would join the
			// input's accessible name (SONA-220).
			expect(source).toMatch(
				/<label class="field-label" for="commissionedAt">[\s\S]*?<span class="lookup-tag" id="commissioned-lookup-tag">/
			);
			expect(source).toMatch(
				/<label class="field-label" for="sourcePostUrl">[\s\S]*?<span class="lookup-tag" id="source-lookup-tag">/
			);
			expect(source).toMatch(/aria-describedby=\{dateTagged \? 'commissioned-lookup-tag' : undefined\}/);
			expect(source).toMatch(/aria-describedby=\{sourceTagged \? 'source-lookup-tag' : undefined\}/);
			// Editing a tagged field drops its tag.
			expect(source).toMatch(/oninput=\{\(\) => \(dateTagged = false\)\}/);
			expect(source).toMatch(/oninput=\{\(\) => \(sourceTagged = false\)\}/);
		}
	});
});

describe('the rating tag beside NSFW', () => {
	it('is a sibling of the label, and never touches the checkbox', () => {
		expect(EDIT).toMatch(
			/<div class="nsfw-row">[\s\S]*?<\/label>\s*<!--[\s\S]*?-->\s*\{#if ratingTagText\}\s*<span class="rating-tag" id="lookup-rating-tag">/
		);
		expect(EDIT).toMatch(/aria-describedby=\{ratingTagText \? 'lookup-rating-tag' : undefined\}/);
		expect(UPLOAD).toMatch(/aria-describedby=\{sharedRatingTag \? 'shared-rating-tag' : undefined\}/);
		expect(UPLOAD).toMatch(/aria-describedby=\{tileTag \? `tile-rating-\$\{tile\.key\}` : undefined\}/);
		// No page ever writes to the nsfw checkbox from a lookup.
		for (const source of [UPLOAD, EDIT]) {
			expect(source).not.toMatch(/nsfw\s*=\s*(true|strictest|rating)/);
		}
	});

	it('keeps the tag on one line and lets the row wrap instead', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(/\.rating-tag \{[^}]*white-space: nowrap;/);
			expect(source).toMatch(/\.nsfw-row[\s\S]{0,80}\{[^}]*flex-wrap: wrap;/);
		}
	});
});

describe('the upload page grid', () => {
	it('gives every per-tile control a file name a screen reader can tell apart', () => {
		expect(UPLOAD).toContain('m.admin_lookup_button_for({ fileName: tile.fileName })');
		expect(UPLOAD).toContain('m.admin_lookup_nsfw_for_file({ fileName: tile.fileName })');
		expect(UPLOAD).toContain('m.admin_lookup_nsfw_for_parent()');
		expect(UPLOAD).toContain('m.admin_lookup_parent_radio({ fileName: tile.fileName })');
	});

	it('marks a busy tile button rather than disabling it', () => {
		expect(UPLOAD).toMatch(/aria-busy=\{tile\.lookup\.kind === 'searching'\}/);
		// A second click while one is in flight is ignored in startLookup.
		expect(UPLOAD).toMatch(/function startLookup[\s\S]{0,200}?kind === 'searching'\) return;/);
	});

	it('derives every per-tile result field from one guarded helper', () => {
		expect(UPLOAD).toMatch(/function tileResult\(/);
		// The old shape re-derived the match (and re-guarded the state) per field.
		expect(UPLOAD).not.toMatch(/function tile(ResultLine|RatingTag|PostUrl|PostSite)\(/);
	});

	it('holds the file on the tile so the bytes are what gets posted', () => {
		expect(UPLOAD).toMatch(/file: File \| null;/);
		expect(UPLOAD).toMatch(/file: error \? null : file,/);
		// Never the stored URL: the endpoint refuses a caller-supplied URL.
		expect(UPLOAD).not.toMatch(/runLookup\(\{\s*url:/);
	});

	it('re-derives the shared prefill when the parent moves or goes', () => {
		expect(UPLOAD).toMatch(/onchange=\{\(\) => onParentChanged\(i\)\}/);
		expect(UPLOAD).toMatch(/if \(wasParent\) onParentChanged\(parentIndex\);/);
	});
});

describe('the new-artist dialog prefill', () => {
	it('says the values are a guess before they are published', () => {
		expect(DIALOG).toContain('m.admin_lookup_guess_line_site(');
		expect(DIALOG).toContain('m.admin_lookup_guess_line_name()');
		expect(DIALOG).toContain('m.admin_lookup_guess_line_registry()');
	});

	it('searches the registry once on open for a seeded name', () => {
		expect(DIALOG).toMatch(/if \(prefillSource === 'lookup'\) onNameInput\(\);/);
	});

	// Seeds, not bindings: read once through untrack so a later prop change
	// cannot overwrite what the operator typed (and so svelte-check is quiet).
	it('reads each seed prop once', () => {
		for (const prop of ['initialName', 'initialSocials?.twitter', 'initialSocials?.furaffinity']) {
			expect(DIALOG).toContain(`$state(untrack(() => ${prop}`);
		}
	});

	it('gives the prefilled social row the whole width', () => {
		expect(DIALOG).toMatch(/\.social-field\.span-full \{[^}]*grid-column: 1 \/ -1/);
	});
});
