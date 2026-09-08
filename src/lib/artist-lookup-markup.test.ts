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
			'signed_out',
			'no_key'
		]) {
			expect(PANEL).toContain(`lookup.reason === '${reason}'`);
		}
		expect(PANEL).toContain('m.admin_lookup_failed_body()');
	});

	// The row went away between the page load and the click: FuzzySearch was
	// never contacted, a retry would find the same missing image, and the way
	// forward is a reload — so the panel says that and offers Close alone.
	it('tells the operator a deleted image is gone rather than reporting an outage', () => {
		expect(PANEL).toContain("lookup.reason === 'gone'");
		expect(PANEL).toContain('m.admin_lookup_gone_eyebrow()');
		expect(PANEL).toContain('m.admin_lookup_gone_body()');
		// The actions branch names the reasons that get a Settings link or a
		// retry, and 'gone' is in neither.
		const actions = PANEL.slice(PANEL.indexOf('<div class="lookup-actions">'));
		expect(actions).not.toContain("'gone'");
	});

	// A key removed mid-session never reached FuzzySearch, so it gets the copy
	// that points at Settings rather than the generic "didn't answer" line, and
	// the same Settings action a refused key gets instead of a retry.
	it('sends a removed key to Settings rather than reporting an outage', () => {
		expect(PANEL).toContain('m.admin_lookup_no_key_eyebrow()');
		expect(PANEL).toContain('m.admin_lookup_no_key_body()');
		expect(PANEL).toMatch(
			/lookup\.reason === 'key_refused' \|\| lookup\.reason === 'no_key'[\s\S]{0,200}?admin_lookup_open_settings/
		);
	});

	// The handle and the name in that sentence have to come from the same match,
	// or a two-result lookup renders "alice is already in your list as Bob".
	it('names the already-listed artist off the match that found them', () => {
		expect(PANEL).toMatch(/matchHandle\(matchForArtist\(data, existing\.id\)\)/);
		expect(PANEL).toMatch(
			/m\.admin_lookup_existing\(\{ handle: existingHandle, name: existing\?\.name \?\? '' \}\)/
		);
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

	// A piece that already has variants renders no parent select, so the button
	// would set a value nothing submits. The panel says why instead.
	it('drops "Add as a variant" where the piece cannot be one, and explains it', () => {
		expect(PANEL).toMatch(
			/\{#if !variantBlocked\}\s*\n\s*<button[\s\S]{0,200}?m\.admin_lookup_clash_add_variant\(\)/
		);
		expect(PANEL).toMatch(
			/\{#if variantBlocked\}[\s\S]{0,300}?m\.admin_lookup_clash_has_variants\(\)/
		);
		expect(EDIT).toMatch(/variantBlocked=\{data\.hasVariants\}/);
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

	// The clash branch used to offer candidates[0] outright, which picks one of
	// two same-named artists for the operator. It renders the same radio list the
	// non-clash ambiguous path does, and its button waits for a pick.
	it('asks which artist under a clash too, and waits for the answer', () => {
		expect(PANEL).toMatch(/\{#snippet ambiguousPick\(\)\}/);
		// Rendered from both branches: once under the clash, once without it.
		expect(PANEL.match(/\{@render ambiguousPick\(\)\}/g)).toHaveLength(2);
		expect(PANEL).toMatch(
			/\{#if clash\}\s*\n\s*\{#if outcome === 'ambiguous'\}\s*\n\s*\{@render ambiguousPick\(\)\}/
		);
		// The clash action row: "Use selected artist", disabled until a radio is
		// picked, ahead of the single-candidate "Use {name}" button.
		expect(PANEL).toMatch(
			/\{#if outcome === 'ambiguous'\}[\s\S]{0,300}?disabled=\{!picked\}[\s\S]{0,120}?m\.admin_lookup_use_selected\(\)[\s\S]{0,200}?\{:else if candidates\[0\]\}/
		);
	});

	it('counts the ambiguous candidates and their pieces', () => {
		expect(PANEL).toContain('count: candidates.length');
		expect(PANEL).toContain('m.admin_lookup_pieces(');
		// Asked once beside the candidates, not again per radio row.
		expect(PANEL).toMatch(/const crossSite = \$derived\(/);
		expect(PANEL).not.toMatch(/isCrossSiteAmbiguity\(data\)[\s\S]*?isCrossSiteAmbiguity\(data\)/);
	});

	// The result rows carry LookupMatch values; typing the helper as anything
	// looser needed two `as never` casts to call the label helpers back.
	it('types the result metadata line off the match itself', () => {
		expect(PANEL).toMatch(/function metaFor\(match: Pick<LookupMatch, 'band' \| 'postedAt' \| 'rating'>\)/);
		expect(PANEL).not.toMatch(/as never/);
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

	// The record of what the lookup filled is immutable: dropping the edited field
	// from it reclassified that field as untouched, and the status line then said
	// Sona "left the commissioned date as it was" about a date it had filled and
	// the operator had changed. Edited-since is tracked beside the record, off the
	// tag, and only the status line's wording changes (SONA-156 round 10).
	it('keeps the filled record immutable and tracks edited-since off the tag', () => {
		for (const [source, record, edited] of [
			[UPLOAD, 'sharedFilled', 'sharedEdited'],
			[EDIT, 'lookupFilled', 'lookupEdited']
		] as const) {
			// Nothing writes the record but the prefill and the resets.
			expect(source).not.toMatch(new RegExp(`${record} = \\{ \\.\\.\\.${record}`));
			expect(source).toMatch(
				new RegExp(
					`const ${edited} = \\$derived\\(\\{[\\s\\S]{0,300}?sourcePostUrl: ${record}\\.sourcePostUrl !== undefined && !sourceTagged`
				)
			);
			expect(source).toMatch(
				new RegExp(
					`const ${edited} = \\$derived\\(\\{[\\s\\S]{0,300}?commissionedAt: ${record}\\.commissionedAt !== undefined && !dateTagged`
				)
			);
			// And the panel is handed both halves.
			expect(source).toMatch(new RegExp(`filled=\\{${record}\\}\\s*\\n\\s*edited=\\{${edited}\\}`));
		}
	});

	// The seeded inline fields follow the same rule: a seeded field the operator
	// typed over is neither claimed nor described, and when none is left the seed
	// line goes away (SONA-156 round 10).
	it('tracks edited-since for the three seeded fields too', () => {
		// The seed record merges per field within one result, so a partial re-seed
		// cannot drop a field it did not write. It still cannot carry a PREVIOUS
		// result's seed: applyPrefill empties it before the new one is described.
		expect(EDIT).toMatch(
			/function applyPrefill\([\s\S]{0,300}?lookupSeeded = \{\};/
		);
		expect(EDIT).toMatch(
			/const lookupSeedEdited = \$derived\(\{[\s\S]{0,300}?artistName: lookupSeeded\.artistName !== undefined && !nameTagged/
		);
		// The seed writes its link to whichever social field matches the site, so
		// either tag still standing means the link is still the lookup's.
		expect(EDIT).toMatch(
			/const lookupSeedEdited = \$derived\(\{[\s\S]{0,300}?profileUrl: lookupSeeded\.profileUrl !== undefined && !twitterTagged && !furaffinityTagged/
		);
		expect(EDIT).toMatch(/seeded=\{lookupSeeded\}\s*\n\s*seedEdited=\{lookupSeedEdited\}/);
	});

	// The panel's sentences: a kept field is named, the edited one is not
	// mentioned at all, and the region is atomic so the change is heard once per
	// edited field rather than once per keystroke.
	it('has a sentence that claims only the field still attributable', () => {
		expect(PANEL).toContain("statusKind === 'url_kept'");
		expect(PANEL).toContain("statusKind === 'date_kept'");
		expect(PANEL).toContain('m.admin_lookup_status_url_kept(');
		expect(PANEL).toContain('m.admin_lookup_status_date_kept(');
		expect(PANEL).toMatch(/statusLineKind\(filled, \{ clash: !!clash, edited, urlHeld: sourceUrlHeld \}\)/);
		expect(PANEL).toMatch(/seedStatusKind\(seeded, seedEdited\)/);
		expect(PANEL).toMatch(/once per\s*\n?\s*(?:\/\/|\s)*field, not once per keystroke/);
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

// The image on the edit page already has an artist. A result that names a
// handle Sona does not hold is a suggestion, and taking it would insert a
// duplicate artist and re-credit the piece on the next save.
describe('the artist on the edit page', () => {
	it('never switches to the inline new-artist form without a click', () => {
		const applyPrefill = EDIT.match(/function applyPrefill\([\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(applyPrefill).toMatch(/lookupFilled = fields/);
		expect(applyPrefill).not.toMatch(/artistMode/);
		expect(applyPrefill).not.toMatch(/seedNewArtist/);
	});

	it('flips and seeds the form in the panel action instead', () => {
		expect(EDIT).toMatch(
			/onaddnew=\{async \(seed\) => \{[\s\S]{0,600}?artistMode = 'new';\s*\n\s*const wrote = seedNewArtist\(seed\.handle, seed\.site, seed\.linkable\);/
		);
	});

	// A second lookup used to read the first one's URL as operator-typed, fill
	// nothing, and leave a "From lookup" tag on a value from the other post.
	it('undoes the previous lookup before running another one', () => {
		expect(EDIT).toMatch(/function startLookup\(\)[\s\S]{0,400}?resetLookupPrefill\(\);/);
		const reset = EDIT.match(/function resetLookupPrefill\(\)[\s\S]*?\n\t\}/)?.[0] ?? '';
		// Only what the lookup itself wrote: the tag is the record of that.
		for (const [tag, field] of [
			['sourceTagged', 'sourcePostUrl'],
			['dateTagged', 'commissionedAt'],
			['nameTagged', 'artistName'],
			['twitterTagged', 'newTwitter'],
			['furaffinityTagged', 'newFuraffinity']
		]) {
			expect(reset).toMatch(new RegExp(`if \\(${tag}\\) ${field} = '';`));
			expect(reset).toMatch(new RegExp(`${tag} = false;`));
		}
		expect(reset).toMatch(/lookupFilled = \{\};/);
		expect(reset).toMatch(/lookupSeeded = \{\};/);
	});

	// Five of the inline form's inputs (Bluesky, Telegram, DeviantArt, Patreon,
	// Instagram) are uncontrolled, so flipping the mode back would unmount the
	// form and take anything typed in them with it. The reset leaves the mode
	// alone and only empties what the lookup itself filled.
	it('never closes the inline form the reset just emptied', () => {
		const reset = EDIT.match(/function resetLookupPrefill\(\)[\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(reset).not.toMatch(/artistMode = /);
	});

	// The inline new-artist form stays on screen while the reset empties the
	// fields the last lookup filled, so the clearing has to be spoken.
	it('announces the fields the reset cleared from an open new-artist form', () => {
		const start = EDIT.match(/function startLookup\(\)[\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(start).toMatch(
			/const clearedInline =\s*\n?\s*artistMode === 'new' && \(nameTagged \|\| twitterTagged \|\| furaffinityTagged\);/
		);
		expect(start).toMatch(
			/if \(clearedInline\) announcer\.say\(m\.admin_lookup_announce_searching_cleared\(\)\);/
		);
	});
});

describe('round 11 wiring', () => {
	// The clash sentence has two shapes now, and the page is the only thing that
	// knows whether the field holds a URL.
	it('feeds the current source URL into the clash sentence, from both pages', () => {
		expect(PANEL).toContain('sourceUrlHeld');
		expect(PANEL).toMatch(/statusLineKind\(filled, \{[\s\S]*?urlHeld: sourceUrlHeld[\s\S]*?\}\)/);
		expect(PANEL).toContain("statusKind === 'clash_kept'");
		expect(PANEL).toContain('m.admin_lookup_status_clash_kept');
		// A snapshot taken when the prefill ran, not a live read of the field: the
		// sentence describes what the lookup did once, and clearing a pasted URL
		// afterwards would otherwise flip it to "Sona left it empty".
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(/sourceUrlHeld=\{(shared|lookup)UrlHeld\}/);
			expect(source).not.toContain("sourceUrlHeld={sourcePostUrl.trim() !== ''}");
			expect(source).toMatch(/(shared|lookup)UrlHeld = sourcePostUrl\.trim\(\) !== '';/);
		}
	});

	// Nested in the status paragraph it vanished whenever that sentence did, and
	// the sentence goes away as soon as the operator edits the field the lookup
	// filled — which says nothing about whether the artist is still unapplied.
	it('renders the artist hint on its own condition, not the status line\'s', () => {
		const status = PANEL.match(/\{#if statusKind !== 'none' && prefill\}[\s\S]*?\{\/if\}/)?.[0] ?? '';
		expect(status).not.toContain('admin_lookup_status_artist_hint');
		expect(PANEL).toMatch(
			/const artistHintShown = \$derived\(\s*\n?\s*editMode && outcome === 'existing' && !appliedArtist && !!candidates\[0\]/
		);
		expect(PANEL).toMatch(
			/\{#if artistHintShown && candidates\[0\]\}\s*\n\s*<p class="lookup-status" id="lookup-artist-hint">\s*\n\s*\{m\.admin_lookup_status_artist_hint/
		);
	});

	// Proximity and matching wording only tied the hint to the button it names, so
	// an operator who tabbed straight to the action row heard "Use {name}" with
	// nothing saying the artist is not applied yet (3.3.2).
	it('describes both Use buttons with the artist hint that names them', () => {
		const describedBy = PANEL.match(
			/aria-describedby=\{artistHintShown \? 'lookup-artist-hint' : undefined\}/g
		);
		expect(describedBy).toHaveLength(2);
		// The hint's own condition gates the reference, so it never points at an
		// id that is not rendered.
		expect(PANEL).toContain('id="lookup-artist-hint"');
	});

	// A clash only exists because a prefill match produced the URL, so there is
	// no state to guess a site for — and a guess would name the wrong one.
	it('names no site in the clash body when there is no prefill match', () => {
		expect(PANEL).not.toContain("prefill ? prefill.site : 'FurAffinity'");
		expect(PANEL).toMatch(
			/\{#if prefill\}\s*\n\s*<p class="lookup-lead">\s*\n\s*\{m\.admin_lookup_clash_body/
		);
	});

	// Handed over bare, the DOM MouseEvent lands in closeSharedLookup as its
	// options bag, and focus return survives only because an event happens to
	// carry no `focus` property.
	it('calls the close handlers with no arguments', () => {
		expect(PANEL).not.toMatch(/onclick=\{onclose\}/);
		expect(PANEL.match(/onclick=\{\(\) => onclose\(\)\}/g) ?? []).toHaveLength(3);
		expect(UPLOAD).toContain('onclose={() => closeSharedLookup()}');
	});

	// A second click on the same result seeds nothing, and overwriting the record
	// with that empty seed retracted the sentence describing the FIRST click —
	// and the "they're a guess until you check them" disclosure with it — while
	// the values and their tags stayed on screen. A PARTIAL re-seed (the operator
	// cleared the name, then clicked again) is the same retraction one field
	// narrower, which is why the record merges rather than being replaced.
	it('keeps the seed record when a repeat seed writes nothing', () => {
		const seedFn = EDIT.match(/function seedNewArtist\([\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(seedFn).toMatch(/lookupSeeded = \{ \.\.\.lookupSeeded, \.\.\.seed \};/);
		expect(seedFn).not.toMatch(/^\t\tlookupSeeded = seed;$/m);
	});

	// The record survives a click that wrote nothing, so it can no longer answer
	// "did THIS click write anything" — read for the announcement, it reports the
	// first click's work as this one's and the second click says nothing at all.
	it('announces the repeat add-new click from what that click wrote', () => {
		const seedFn = EDIT.match(/function seedNewArtist\([\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(seedFn).toMatch(/\}\): NewArtistSeed \{|linkable: boolean\): NewArtistSeed \{/);
		expect(seedFn).toMatch(/\n\t\treturn seed;\n/);
		expect(EDIT).toMatch(
			/const wrote = seedNewArtist\(seed\.handle, seed\.site, seed\.linkable\);/
		);
		expect(EDIT).toContain("const seededNothing = seedStatusKind(wrote) === 'none';");
		expect(EDIT).not.toContain('seedStatusKind(lookupSeeded)');
	});

	// Left at 'new', the panel keeps offering "Add {handle} as a new artist" for
	// an artist that now exists, and the second click creates a duplicate row:
	// POST /api/artists enforces no name uniqueness on a non-registry create.
	it('folds a created artist back into the result on the upload page', () => {
		const created = UPLOAD.match(/function onArtistCreated\([\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(created).toContain('withCreatedArtist(tile.lookup.data, artist)');
		expect(created).toMatch(/tile\.lookup\.kind !== 'results'/);
		// Only an artist the LOOKUP asked for. The standalone "+ Add New Artist"
		// button opens the same dialog with no seed, and an artist created from it
		// has nothing to do with the match on screen — folded in, the panel claims
		// the handle is already in the list under that unrelated name and hides
		// the real add-new action. The flag is captured before the seed is cleared.
		expect(created).toMatch(/const fromLookup = artistSeed !== null;[\s\S]*?artistSeed = null;/);
		expect(created).toMatch(/if \(!fromLookup \|\| !tile \|\| tile\.lookup\.kind !== 'results'\) return;/);
		// Folding the artist in destroys the button the dialog captured as its
		// opener, so focus is placed deliberately rather than left on <body>
		// (2.4.3).
		expect(created).toMatch(
			/await tick\(\);\s*\n\s*\(document\.getElementById\('lookup-applied-artist'\) \?\? artistSelect\)\?\.focus\(\);/
		);
		expect(UPLOAD).toContain('bind:this={artistSelect}');
		expect(PANEL).toContain('id="lookup-applied-artist"');
		// The edit page has no equivalent: it creates the artist server-side in
		// the save action, and resetForImage clears the panel on the way back.
		expect(EDIT).not.toContain('oncreated=');
	});
});

// The announcements and the clash line name the piece each one is about; a
// swap between "this piece" and the image being edited reads as the wrong
// constraint (SONA-156 round 6).
describe('what the lookup copy names', () => {
	const en = JSON.parse(read('messages/en.json'));
	const ja = JSON.parse(read('messages/ja.json'));

	it('blames the image being edited for the variant block', () => {
		expect(en.admin_lookup_clash_has_variants).toBe(
			"The image you're editing already has variants of its own, so it can't become a variant of another piece."
		);
	});

	// "gallery", not "library": the collection has one name across the admin, and
	// the sibling clash eyebrow already uses it. And it sends the operator to All
	// Images rather than to a reload — the only page that reaches this state is
	// the edit page, whose loader 404s for the row that just went away, so a
	// reload lands on a not-found page instead of "what is there now".
	it('says the gone state names the gallery, not FuzzySearch, in both catalogs', () => {
		expect(en.admin_lookup_gone_body).toBe(
			'This image is no longer in your gallery. Go back to All Images to see what is there now.'
		);
		expect(en.admin_lookup_gone_body).not.toMatch(/FuzzySearch|library|[Rr]eload/);
		expect(en.admin_lookup_gone_body).toContain(en.admin_nav_all_images);
		expect(en.admin_lookup_gone_eyebrow).toBe('Image is gone');
		// 「画像がありません」 reads as "there is no image"; the state is that the
		// image went away after the page loaded, which is what もう carries — the
		// same nuance both bodies already have.
		expect(ja.admin_lookup_gone_eyebrow).toBe('画像はもうありません');
		expect(ja.admin_lookup_gone_body).toBeTruthy();
		expect(ja.admin_lookup_gone_body).not.toMatch(/FuzzySearch|ライブラリ|再読み込み/);
		expect(ja.admin_lookup_gone_body).toContain(ja.admin_nav_all_images);
	});

	// Both new strings say the thing STOPPED being true — the panel only renders
	// them for a key or an image that was there when the page loaded. ja carries
	// the nuance with もう, the same word the gone body uses for it.
	it('says "no longer" in both catalogs for the key that went away', () => {
		expect(en.admin_lookup_no_key_body).toBe(
			'This site no longer has a FuzzySearch key. Add one in Settings, or add the artist by hand.'
		);
		expect(ja.admin_lookup_no_key_body).toContain('キーがもうありません');
		expect(ja.admin_lookup_gone_body).toContain('もうありません');
	});

	it('says the seeded fields were left alone rather than that nothing was filled', () => {
		expect(en.admin_lookup_announce_seed_kept).toBe(
			"The new artist's fields already have values, so Sona left them alone."
		);
	});

	// The panel's own status line already says the image is on its way to
	// FuzzySearch, so this one carries only what that line does not.
	it('carries the cleared-fields announcement in both catalogs, without the searching line', () => {
		expect(en.admin_lookup_announce_searching_cleared).toBe(
			'Sona cleared the fields the last lookup filled.'
		);
		expect(en.admin_lookup_announce_searching_cleared).not.toMatch(/FuzzySearch/);
		expect(ja.admin_lookup_announce_searching_cleared).toBeTruthy();
		expect(ja.admin_lookup_announce_searching_cleared).not.toMatch(/FuzzySearch/);
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
			/function addAsVariant[\s\S]{0,600}?existingParentSelect\?\.focus\(\)/
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
	// line says nothing while the select is replaced by a name field. An operator
	// who opened the inline form by hand before the lookup switched nothing, so
	// the sentence is not theirs either.
	it('announces the flip to the inline new-artist form only when the mode changed', () => {
		expect(EDIT).toMatch(
			/const wasExisting = artistMode === 'existing';\s*\n\s*artistMode = 'new';/
		);
		expect(EDIT).toMatch(
			/wasExisting && seededNothing\) announcer\.say\(m\.admin_lookup_announce_new_form\(/
		);
	});

	// The form was already open and holds the operator's own values, so the
	// click wrote nothing anywhere and the panel's status line says nothing.
	it('says so when the click filled nothing because the fields were taken', () => {
		expect(EDIT).toMatch(
			/else if \(seededNothing && seed\.handle\)\s*\n?\s*announcer\.say\(m\.admin_lookup_announce_seed_kept\(/
		);
	});

	// Both sentences tell the operator to type the name, so that is where focus
	// lands — the announcement and the landing spot have to agree (2.4.3).
	it('lands on the name field when the seed left it empty', () => {
		expect(EDIT).toMatch(
			/if \(artistName\.trim\(\) === ''\) \{\s*\n\s*await tick\(\);\s*\n\s*artistNameInput\?\.focus\(\);/
		);
		expect(EDIT).toMatch(/bind:this=\{artistNameInput\}/);
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

	// The candidates are unioned across every confident match, so the poster the
	// "Different artist" line names is the one whose hit triggered it, not
	// whichever match the rest of the tile happens to read from.
	it('names the poster whose local artist the different-artist line is about', () => {
		expect(UPLOAD).toMatch(/function differentArtistMatch\(tile: Tile\): LookupMatch \| null/);
		// The shared SELECTION, not just a panel-applied artist: keying off
		// appliedArtist meant an artist picked from the select never warned.
		expect(UPLOAD).toMatch(
			/function differentArtistMatch[\s\S]{0,500}?const sharedId = Number\(selectedArtistId\);/
		);
		expect(UPLOAD).not.toMatch(/function differentArtistMatch[\s\S]{0,200}?!appliedArtist/);
		expect(UPLOAD).toMatch(/const differentHandle = differentMatch \? matchHandle\(differentMatch\) : '';/);
		// A triggering match that names nobody gets the unknown-poster wording
		// rather than "Different artist:  on FurAffinity".
		expect(UPLOAD).toMatch(/m\.admin_lookup_tile_different_unknown\(\{ site: differentSite \}\)/);
	});

	// closeSharedLookup reaches the tile through parentTile, which is null the
	// moment the mode is no longer 'new' — so the reset has to go first or the
	// stale clash panel resurfaces on the way back to a new group.
	it('resets the tile lookup before switching to an existing group', () => {
		expect(UPLOAD).toMatch(
			/async function addAsVariant\(clash: SourceClash\) \{[\s\S]{0,300}?closeSharedLookup\(\{ focus: false \}\);\s*\n\s*groupMode = 'existing';/
		);
	});

	it('holds the file on the tile so the bytes are what gets posted', () => {
		expect(UPLOAD).toMatch(/file: File \| null;/);
		expect(UPLOAD).toMatch(/file: error \? null : file,/);
		// Never the stored URL: the endpoint refuses a caller-supplied URL.
		expect(UPLOAD).not.toMatch(/runLookup\(\{\s*url:/);
	});

	it('re-derives the shared prefill when the parent moves or goes', () => {
		expect(UPLOAD).toMatch(/onchange=\{\(\) => onParentChanged\(i\)\}/);
		// parentIndex is submitted as the hidden field the server picks the parent
		// with, so a removal ahead of the parent has to move the index with it —
		// otherwise the saved parent is a different file than the shared artist,
		// date, source URL, and tags describe.
		expect(UPLOAD).toMatch(
			/const parentKey = tiles\[parentIndex\]\?\.key \?\? null;[\s\S]{0,120}?tiles = tiles\.filter/
		);
		expect(UPLOAD).toMatch(
			/const movedTo = parentKey === null \? -1 : tiles\.findIndex\(\(t\) => t\.key === parentKey\);/
		);
		// Only a parent that is actually gone re-derives the shared fields.
		expect(UPLOAD).toMatch(
			/if \(movedTo !== -1\) \{\s*\n\s*parentIndex = movedTo;\s*\n\s*\} else \{[\s\S]{0,300}?onParentChanged\(parentIndex\);/
		);
	});

	// Every removal goes through that bookkeeping. The declined-duplicate path
	// filtered the array by hand, so with two tiles uploading and the second
	// picked as parent, declining the first left parentIndex pointing past the
	// end: the shared panel went quiet and the save action dereferenced a tile
	// that was no longer there.
	it('removes a declined duplicate the same way the Remove button does', () => {
		const uploadOne = UPLOAD.match(/async function uploadOne\([\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(uploadOne).toContain('removeTile(tile.key);');
		expect(uploadOne).not.toMatch(/tiles = tiles\.filter/);
		// removeTile owns the revoke, so the decline path must not keep its own.
		expect(UPLOAD).toMatch(
			/function removeTile\([\s\S]{0,200}?URL\.revokeObjectURL\(tiles\[idx\]\.previewUrl\)/
		);
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
