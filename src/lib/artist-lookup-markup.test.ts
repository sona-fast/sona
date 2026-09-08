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
const ANNOUNCER = read('src/lib/components/LiveAnnouncer.svelte');

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
		expect(PANEL).toMatch(/class="lookup-panel"[\s\S]{0,200}?role="region"/);
		expect(PANEL).toMatch(/aria-label=\{m\.admin_lookup_panel_label\(\)\}/);
		expect(PANEL).toMatch(/<div class="lookup-body" role="status">/);
	});

	// A live region inserted together with its first content is commonly missed,
	// and that first content is the "lookup has started" message. The region is
	// in the DOM from the first render; the state branch is inside it.
	it('keeps the live region mounted while idle, collapsed to nothing', () => {
		expect(PANEL).toMatch(/class:idle=\{lookup\.kind === 'idle'\}/);
		expect(PANEL).toMatch(
			/<div class="lookup-body" role="status">\s*\{#if lookup\.kind !== 'idle'\}/
		);
		expect(PANEL).toMatch(/\.lookup-panel\.idle \{[^}]*padding: 0;/);
		// Not display:none — a hidden region is not one a screen reader watches.
		expect(PANEL).not.toMatch(/\.lookup-panel\.idle \{[^}]*display: none/);
	});

	// "Fu", "We", "e6", "Tw" read as truncated text next to the site's own name.
	it('marks each result row with a brand icon, not two letters of the name', () => {
		expect(PANEL).not.toContain('match.site.slice(0, 2)');
		expect(PANEL).toMatch(/class="match-site" aria-hidden="true"/);
		expect(PANEL).toContain('<FurAffinityIcon');
		expect(PANEL).toContain('<TwitterIcon');
		// Weasyl and e621 have no mark of their own; they get the neutral glyph.
		expect(PANEL).toContain('<Globe');
	});

	it('puts the searching spinner in the status line, not inside Cancel', () => {
		expect(PANEL).toMatch(/class="lookup-status searching-line">\s*<Loader2/);
		expect(PANEL).toMatch(/onclick=\{oncancel\}>\s*\{m\.admin_lookup_cancel\(\)\}/);
		// A busy indicator is still motion.
		expect(PANEL).toMatch(
			/prefers-reduced-motion: reduce\)[\s\S]{0,120}?\.searching-line :global\(\.spin\)[\s\S]{0,60}?animation: none/
		);
	});

	// The spec's third no_match action: nothing matched, so the way forward is
	// the artist by hand.
	it('offers Add New Artist when nothing matched', () => {
		expect(PANEL).toMatch(
			/lookup\.kind === 'no_match'\}[\s\S]{0,600}?m\.admin_upload_add_new_artist\(\)/
		);
		// An empty handle seeds nothing, so the dialog opens blank.
		expect(PANEL).toMatch(/onaddnew\(\{ handle: '', /);
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
		// "Uploaded {date} · {artist} · {w} × {h}", with the size dropped rather
		// than rendered blank on a row that has no width or height.
		expect(PANEL).toMatch(
			/if \(clash\.width && clash\.height\)[\s\S]{0,160}?m\.admin_lookup_clash_dimensions\(/
		);
	});

	// A disabled primary button that looks exactly like the enabled one reads as
	// broken rather than as "pick a radio first".
	it('dims the disabled action the way the rest of the admin forms do', () => {
		expect(PANEL).toMatch(
			/\.lookup-actions button:disabled \{[\s\S]{0,80}?opacity: 0\.5;[\s\S]{0,80}?cursor: not-allowed;/
		);
	});

	// With no key the lookup can never start, so the empty landmark and the gap
	// it holds open are cost with no benefit.
	it('is mounted only where a lookup can actually be started', () => {
		expect(EDIT).toMatch(/\{#if data\.lookupEnabled\}[\s\S]{0,300}?<ArtistLookupPanel/);
		expect(UPLOAD).toMatch(/\{#if data\.lookupEnabled && groupMode === 'new'\}\s*<ArtistLookupPanel/);
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
			// Editing a tagged field drops its tag — however the handler is spelled.
			expect(source).toMatch(/oninput=\{[^}]*dateTagged = false/);
			expect(source).toMatch(/oninput=\{[^}]*sourceTagged = false/);
		}
	});

	// The inline new-artist form is subject to the same never-overwrite rule:
	// the operator can type a name and paste a profile URL before the lookup.
	it('tags the inline new-artist fields the same way on the edit page', () => {
		expect(EDIT).toMatch(
			/<label class="field-label" for="artistName">[\s\S]*?<span class="lookup-tag" id="artist-name-lookup-tag">/
		);
		expect(EDIT).toMatch(/aria-describedby=\{nameTagged \? 'artist-name-lookup-tag' : undefined\}/);
		expect(EDIT).toMatch(/oninput=\{[^}]*nameTagged = false/);
		for (const field of ['twitter', 'furaffinity']) {
			expect(EDIT).toMatch(
				new RegExp(`<span class="lookup-tag" id="${field}-lookup-tag">`)
			);
			expect(EDIT).toMatch(new RegExp(`oninput=\\{[^}]*${field}Tagged = false`));
		}
		// The FurAffinity input has to be bound, or the seed reaches no field.
		expect(EDIT).toMatch(/name="furaffinity"[\s\S]{0,120}?bind:value=\{newFuraffinity\}/);
		// The seed itself goes through the shared helper, which owns the rule.
		expect(EDIT).toContain('newArtistSeed(');
		expect(EDIT).not.toMatch(/artistName = clean;/);
	});

	// SvelteKit reuses the component across a route-param change, so the seeds
	// (and every lookup flag riding with them) describe the previous image.
	it('re-seeds the edit page when a different image loads', () => {
		expect(EDIT).toMatch(/const id = data\.image\.id;[\s\S]{0,200}?resetForImage\(\)/);
		expect(EDIT).toMatch(/function resetForImage\(\)[\s\S]{0,600}?lookup = \{ kind: 'idle' \}/);
		for (const flag of ['sourceTagged', 'dateTagged', 'nameTagged', 'appliedArtist']) {
			expect(EDIT).toMatch(
				new RegExp(`function resetForImage\\(\\)[\\s\\S]{0,700}?${flag} = `)
			);
		}
	});
});

// Close, Cancel, and "Add as a variant" all destroy the button the operator is
// standing on; focus has to be moved first or the next Tab restarts at the top
// of the admin page (2.4.3).
describe('focus after the panel goes away', () => {
	it('returns focus to the control the lookup started from', () => {
		expect(UPLOAD).toMatch(/function focusLookupOrigin\(\)/);
		expect(UPLOAD).toMatch(/bind:this=\{lookupPill\}/);
		expect(UPLOAD).toMatch(/bind:this=\{tileLookupButtons\[tile\.key\]\}/);
		expect(UPLOAD).toMatch(/function closeSharedLookup[\s\S]{0,300}?focusLookupOrigin\(\)/);
		expect(EDIT).toMatch(/function closeLookup\(\)[\s\S]{0,200}?lookupPill\?\.focus\(\)/);
		expect(EDIT).toMatch(/onclose=\{closeLookup\}/);
	});

	it('lands on the select that "Add as a variant" just populated', () => {
		expect(UPLOAD).toMatch(
			/function addAsVariant[\s\S]{0,400}?existingParentSelect\?\.focus\(\)/
		);
		expect(EDIT).toMatch(/function addAsVariant[\s\S]{0,300}?parentSelect\?\.focus\(\)/);
	});

	it('gives the dialog its opener back', () => {
		expect(DIALOG).toMatch(/onDestroy\([\s\S]{0,120}?opener\?\.isConnected[\s\S]{0,60}?focus\(\)/);
	});
});

describe('the rating tag beside NSFW', () => {
	it('is a sibling of the label, and never touches the checkbox', () => {
		// The pill is a SIBLING of the label, not inside it (SONA-220). Any
		// comment between the two is prose, not part of the contract.
		expect(EDIT).toMatch(
			/<div class="nsfw-row">[\s\S]*?<\/label>[\s\S]*?<span class="rating-tag" id="lookup-rating-tag">/
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

	// The text grows with the number of sites; nowrap alone made the pill wider
	// than its column and gave the whole document a horizontal scrollbar at
	// 320px (1.4.10), and wider than its tile in the grid.
	it('lets the pill wrap rather than pushing the page sideways', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(/\.rating-tag \{[^}]*max-width: 100%/);
			expect(source).toMatch(
				/@media \(max-width: 480px\) \{[\s\S]{0,200}?\.rating-tag \{[^}]*white-space: normal/
			);
		}
		expect(UPLOAD).toMatch(/\.tile-nsfw-row \{[^}]*min-width: 0/);
		expect(UPLOAD).toMatch(/\.tile-nsfw-row \.rating-tag \{[^}]*white-space: normal/);
	});
});

describe('what a lookup says out loud', () => {
	// A variant tile's outcome renders as plain text on the tile, outside the
	// panel's live region, so nothing announced that the lookup finished.
	it('announces a tile lookup by file name, one message per outcome', () => {
		expect(UPLOAD).toMatch(/else announceTileLookup\(live\)/);
		for (const id of [
			'admin_lookup_announce_tile_match',
			'admin_lookup_announce_tile_no_match',
			'admin_lookup_announce_tile_failed'
		]) {
			expect(UPLOAD).toMatch(
				new RegExp(`announcer\\.say\\(\\s*m\\.${id}\\(|m\\.${id}\\(\\{ fileName`)
			);
		}
	});

	// The select sits above the panel and the button relabels itself in place.
	it('announces the artist the panel applied', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(
				/function useLookupArtist[\s\S]{0,400}?announcer\.say\(m\.admin_lookup_announce_using\(/
			);
			// The region has to be there before the message is. Both pages mount the
			// one component rather than each keeping their own copy of it.
			expect(source).toContain("import LiveAnnouncer from '$lib/components/LiveAnnouncer.svelte'");
			expect(source).toContain('<LiveAnnouncer {announcer} />');
		}
		// Only the node inside the region is keyed, so a repeat still reads out.
		expect(ANNOUNCER).toMatch(
			/class="sr-only" aria-live="polite">\{#key announcer\.uid\}<span>\{announcer\.text\}<\/span>/
		);
	});

	// "Add New Artist" from the no_match state seeds nothing, so the seed status
	// line says nothing while the select is replaced by a name field. A result
	// that already flipped the form and filled it must not replay that sentence.
	it('announces the flip to the inline new-artist form only when the mode changed', () => {
		expect(EDIT).toMatch(
			/const wasExisting = artistMode === 'existing';\s*\n\s*artistMode = 'new';/
		);
		expect(EDIT).toMatch(
			/wasExisting && seedStatusKind\(lookupSeeded\) === 'none'\)\s*\n?\s*announcer\.say\(m\.admin_lookup_announce_new_form\(/
		);
	});
});

describe('the two new pills', () => {
	it('carry the same focus ring the buttons around them do', () => {
		expect(UPLOAD).toMatch(
			/\.lookup-pill:focus-visible,\s*\.tile-lookup:focus-visible \{[^}]*outline: 2px solid var\(--ring\)/
		);
		expect(EDIT).toMatch(/\.lookup-pill:focus-visible \{[^}]*outline: 2px solid var\(--ring\)/);
	});

	// --muted-foreground on --secondary measures 3.96:1 in terracotta light.
	it('keeps the searching state readable', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(
				/\.lookup-pill\[aria-disabled='true'\] \{[^}]*color: var\(--foreground\)/
			);
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
		// A second click while one is in flight is ignored in startLookup —
		// however the rest of that guard's operands are ordered.
		expect(UPLOAD).toMatch(/function startLookup[\s\S]{0,300}?'searching'[\s\S]{0,20}?\) return;/);
	});

	it('derives every per-tile result field from one guarded helper', () => {
		expect(UPLOAD).toMatch(/function tileResult\(/);
		// The old shape re-derived the match (and re-guarded the state) per field.
		expect(UPLOAD).not.toMatch(/function tile(ResultLine|RatingTag|PostUrl|PostSite)\(/);
	});

	// The file name is not a poster, and "{handle} on {site}" reads as though it
	// were. tileResultText names an unknown poster instead.
	it('never puts the file name where the result line promises a handle', () => {
		expect(UPLOAD).toMatch(/const handle = matchHandle\(match\);/);
		expect(UPLOAD).not.toMatch(/matchHandle\(match\) \|\| tile\.fileName/);
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

	it('gives the prefilled social row the whole width, at the end of the grid', () => {
		expect(DIALOG).toMatch(/\.social-field\.span-full \{[^}]*grid-column: 1 \/ -1/);
		// In place it pushes its neighbour onto a row alone and leaves a hole.
		expect(DIALOG).toMatch(/\.social-field\.span-full \{[^}]*order: 1/);
	});

	// The name field autofocuses already full, so the disclosure has to be read
	// on entry rather than waiting to be tabbed past.
	it('describes the dialog with the guess lines, and the field with its mark', () => {
		expect(DIALOG).toMatch(/id="lookup-guess-lines"/);
		expect(DIALOG).toMatch(
			/aria-describedby=\{prefillSource === 'lookup' \? 'lookup-guess-lines' : undefined\}/
		);
		expect(DIALOG).toMatch(/class="prefill-mark" id="lookup-prefill-mark"/);
		for (const field of ['twitter', 'furaffinity']) {
			expect(DIALOG).toMatch(
				new RegExp(
					`bind:value=\\{${field}\\}[\\s\\S]{0,120}?aria-describedby=\\{initialSocials\\?\\.${field} \\? 'lookup-prefill-mark'`
				)
			);
		}
	});
});
