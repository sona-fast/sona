import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LOOKUP_RESULT_THREW } from './artist-lookup';

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
			expect(source).toMatch(/class:hint-warn=\{(isPrivate|sendingPrivate)\}/);
			// Both pages read the checkbox the operator can tick right now. Derived
			// from the saved row instead, the edit page said nothing about sending a
			// private file until the save had already happened.
			expect(source).toMatch(
				/<input type="checkbox" name="published" bind:checked=\{isPrivate\} \/>/
			);
		}
		// Nothing is saved on the upload page, so the checkbox is the whole story
		// there. On the edit page the stored row hides the file too, so unticking
		// Private on a row that is still unpublished must not drop the hint.
		expect(UPLOAD).toMatch(/class:hint-warn=\{isPrivate\}/);
		expect(EDIT).toMatch(/class:hint-warn=\{sendingPrivate\}/);
		expect(EDIT).toContain('const sendingPrivate = $derived(!data.image.published || isPrivate)');
		expect(EDIT).not.toContain('const isPrivate = $derived(!data.image.published)');
		// The component is reused across a route-param change, so the tick has to
		// go back to the next image's own state.
		expect(EDIT).toMatch(/function resetForImage\(\)[\s\S]{0,900}?isPrivate = !data\.image\.published;/);
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

	// The keyed each built the post identity a third way, by bare concatenation,
	// while the two dedupes it renders the output of used two others.
	it('keys the match list on the shared post identity', () => {
		expect(PANEL).toMatch(/\{#each data\.matches as match \(matchKey\(match\)\)\}/);
		expect(PANEL).not.toMatch(/match\.site \+ match\.siteId/);
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

	// Under a clash the row rendered only the plain "Use {name}" button, so
	// clicking it moved the select and the live region while the button itself
	// never changed — a sighted operator had nothing saying it applied.
	it('swaps the Use button to "Using" under a clash too, from one snippet', () => {
		expect(PANEL).toMatch(
			/\{#snippet useArtistAction\(artist: \{ id: number; name: string \}, primary: boolean\)\}\s*\n\s*\{#if appliedArtist && appliedArtist\.id === artist\.id\}/
		);
		const rendered = PANEL.match(/\{@render useArtistAction\([^)]+\)\}/g);
		// Every row that applies an artist: the clash row secondary, the plain
		// existing row primary, and the name-match row under the 'new' outcome —
		// that last one rendered its own button, so it never swapped to "Using"
		// and it had no landing spot for the focus the swap destroys.
		expect(rendered).toEqual([
			'{@render useArtistAction(candidates[0], false)}',
			'{@render useArtistAction(candidates[0], true)}',
			'{@render useArtistAction(nameHits[0], true)}'
		]);
		// No hand-rolled Use button left beside the snippet's own.
		expect(PANEL).not.toMatch(/onclick=\{\(\) => onuseartist\(nameHits\[0\]\)\}/);
		// Two applied buttons in the source, one per snippet, and the outcome they
		// render under is exclusive: useArtistAction under 'existing' or 'new',
		// useSelectedAction under 'ambiguous'. So the id stays unique in the DOM.
		expect(PANEL.match(/id="lookup-applied-artist"/g)).toHaveLength(2);
	});

	// The ambiguous row's Use button was the last one applying an artist without
	// swapping to "Using" and without a landing spot, so a sighted operator saw
	// nothing change and focus fell to <body> when the swap destroyed it.
	it('applies the picked artist through the same two branches as the other rows', () => {
		expect(PANEL).toMatch(
			/\{#snippet useSelectedAction\(primary: boolean\)\}\s*\n\s*\{#if appliedArtist && pickedArtist && appliedArtist\.id === pickedArtist\.id\}/
		);
		// The applied branch names the artist the radio list picked and carries the
		// landing spot; the unapplied one keeps the label and the disabled gate.
		expect(PANEL).toMatch(
			/\{#snippet useSelectedAction[\s\S]{0,400}?id="lookup-applied-artist"[\s\S]{0,200}?m\.admin_lookup_using_artist\(\{ name: pickedArtist\.name \}\)/
		);
		expect(PANEL).toMatch(
			/\{#snippet useSelectedAction[\s\S]{0,900}?disabled=\{!picked\}[\s\S]{0,300}?document\.getElementById\('lookup-applied-artist'\)\?\.focus\(\)/
		);
		// Rendered from both ambiguous branches, under the clash and without it.
		expect(PANEL.match(/\{@render useSelectedAction\([^)]+\)\}/g)).toEqual([
			'{@render useSelectedAction(false)}',
			'{@render useSelectedAction(true)}'
		]);
		// The pick is read from one derived, so the button and the click agree on
		// which candidate the radio names.
		expect(PANEL).toMatch(
			/const pickedArtist = \$derived\(candidates\.find\(\(c\) => String\(c\.id\) === picked\) \?\? null\)/
		);
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
		expect(UPLOAD).toMatch(/privateNotice=\{sharedSentPrivate && lookupSentFile\(/);
		// And on a variant tile whose lookup ran while Private was checked.
		expect(UPLOAD).toMatch(/tile\.sentPrivate && lookupSentFile\(tile\.lookup\)/);
		// The notice describes a send that already happened, so both pages read
		// the state as it was when the request fired. Read live, a tick made after
		// the click claimed the published file that went out was private.
		expect(UPLOAD).toMatch(
			/function startLookup\(key: number\)[\s\S]{0,600}?tile\.sentPrivate = isPrivate;/
		);
		expect(UPLOAD).toContain('const sharedSentPrivate = $derived(parentTile?.sentPrivate ?? false)');
		expect(EDIT).toMatch(/privateNotice=\{sentPrivate && lookupSentFile\(/);
		expect(EDIT).toMatch(
			/function startLookup\(\)[\s\S]{0,600}?sentPrivate = sendingPrivate;/
		);
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
			/\{#if outcome === 'ambiguous'\}\s*\n\s*\{@render useSelectedAction\(false\)\}\s*\n\s*\{:else if candidates\[0\]\}/
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
		// The record is handed over only in the mode its fields are mounted in;
		// the pair itself stays together.
		expect(EDIT).toMatch(
			/seeded=\{artistMode === 'new' \? lookupSeeded : \{\}\}\s*\n\s*seedEdited=\{lookupSeedEdited\}/
		);
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
		for (const flag of [
			'sourceTagged',
			'dateTagged',
			'nameTagged',
			'appliedArtist',
			'sentPrivate',
			// Kept, the reference line reported the PREVIOUS image's clearing.
			'referenceCleared'
		]) {
			expect(EDIT).toMatch(
				new RegExp(`function resetForImage\\(\\)[\\s\\S]{0,900}?${flag} = `)
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
			/onaddnew=\{async \(seed\) => \{[\s\S]{0,600}?artistMode = 'new';[\s\S]{0,300}?const wrote = seedNewArtist\(seed\.handle, seed\.site, seed\.linkable\);/
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
		// One reference, in the snippet both action rows render.
		expect(describedBy).toHaveLength(1);
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

	// Use, then "Add as a new artist instead": the save posts artistId=new and
	// creates somebody, while the panel still read "Using {name}" about the
	// artist the operator had just moved off. And the other way round, Use
	// unmounts the inline fields the seed sentence is about, which went on
	// saying Sona had filled a name and a link that were no longer on screen.
	// Both sentences are gated on the mode rather than cleared: cleared, a flip
	// back to the inline form showed Sona's values with no "From lookup" tag and
	// nothing said about where they came from (3.3.2).
	it('shows each panel sentence only in the mode its fields are in', () => {
		// Read off the mode, so the toggle above the form closes the same way the
		// panel's action does rather than needing its own clear.
		expect(EDIT).toMatch(
			/appliedArtist=\{artistMode === 'existing' \? appliedArtist : null\}/
		);
		expect(EDIT).toMatch(/seeded=\{artistMode === 'new' \? lookupSeeded : \{\}\}/);
		const use = EDIT.match(/function useLookupArtist\([\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(use).toMatch(/appliedArtist = artist;/);
		// The record and the tags survive the click, so the fields, their tags,
		// and the sentence come back together when the operator flips back.
		expect(use).not.toMatch(/lookupSeeded = \{\}/);
		expect(use).not.toMatch(/nameTagged = false/);
		expect(use).not.toMatch(/twitterTagged = false/);
		expect(use).not.toMatch(/furaffinityTagged = false/);
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
		expect(created).toMatch(/if \(!fromLookup \|\| !tile \|\| tile\.lookup\.kind !== 'results'\) \{/);
		// Folding the artist in destroys the button the dialog captured as its
		// opener, so focus is placed deliberately rather than left on <body>
		// (2.4.3).
		expect(created).toMatch(
			/await tick\(\);\s*\n\s*\(document\.getElementById\('lookup-applied-artist'\) \?\? artistSelect\)\?\.focus\(\);/
		);
		expect(UPLOAD).toContain('bind:this={artistSelect}');
		expect(PANEL).toContain('id="lookup-applied-artist"');
		// Which tile the artist belongs to is decided when the dialog OPENS. The
		// dialog is a plain overlay with no focus trap, so the Parent radio behind
		// it stays reachable from the keyboard; read back at close, `parentTile`
		// would credit a tile the handle has nothing to do with and leave the
		// seed's own tile still offering to add the artist — a second click there
		// creating the duplicate this whole path exists to prevent. Carried inside
		// the seed so the key and the seed are cleared by the same assignment.
		expect(UPLOAD).toMatch(/artistSeed = seed\.handle \? \{ \.\.\.seed, tileKey: parentTile\?\.key \?\? null \} : null;/);
		expect(created).toMatch(/const seedKey = artistSeed\?\.tileKey \?\? null;/);
		expect(created).toMatch(
			/const tile = seedKey === null \? null : \(tiles\.find\(\(t\) => t\.key === seedKey\) \?\? null\);/
		);
		expect(created).not.toMatch(/const tile = parentTile;/);
		// Removed while the dialog was open, that tile takes the dialog's opener
		// with it, so focus has to be placed rather than left on <body> (2.4.3).
		expect(created).toMatch(
			/if \(fromLookup && !tile\) \{\s*\n\s*await tick\(\);\s*\n\s*artistSelect\?\.focus\(\);/
		);
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

	// The tile announcement joins its outcome and its private disclosure through
	// a message key so each locale owns the separator. Nothing read the ja value,
	// so the ASCII space this replaced could have come back unnoticed.
	it('leaves the separator between the two announcement parts to the locale', () => {
		expect(en.admin_lookup_announce_tile_with_notice).toBe('{outcome} {disclosure}');
		expect(ja.admin_lookup_announce_tile_with_notice).toBe('{outcome}{disclosure}');
	});

	// One sentence per shape of refill, so the announcement never says "the
	// shared fields" about a single field. Nothing read the ja side, so a
	// missing translation or two identical sentences would have gone unnoticed.
	it('names the refilled shared fields in both catalogs', () => {
		expect(ja.admin_lookup_announce_shared_refilled).toBeTruthy();
		expect(ja.admin_lookup_announce_shared_refilled_source).toContain('投稿元URL');
		expect(ja.admin_lookup_announce_shared_refilled_date).toContain('制作依頼日');
		for (const catalog of [en, ja]) {
			const sentences = [
				catalog.admin_lookup_announce_shared_refilled,
				catalog.admin_lookup_announce_shared_refilled_source,
				catalog.admin_lookup_announce_shared_refilled_date
			];
			expect(new Set(sentences).size).toBe(3);
		}
	});

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

	// The hint is the Use button's own aria-describedby, so restating the label
	// ("Use {name} sets the artist.") both stutters when spoken and garden-paths
	// on screen, where "Use {name}" reads as an imperative first. It says what
	// the control does instead. "change" was wrong for an image with no artist.
	it('says what the Use button does rather than restating its label', () => {
		expect(en.admin_lookup_status_artist_hint).toBe('Sets the artist to {name}.');
		expect(en.admin_lookup_status_artist_hint).not.toMatch(/Choose|change/);
		// The label itself ("Use {name}") is not repeated in its own description.
		expect(en.admin_lookup_status_artist_hint).not.toMatch(/Use \{name\}/);
		expect(ja.admin_lookup_status_artist_hint).toContain('{name}');
		expect(ja.admin_lookup_status_artist_hint).not.toContain('変える');
		// Same in ja: no quoted copy of the button label 「{name}を使う」.
		expect(ja.admin_lookup_status_artist_hint).not.toContain('を使う');
		// The hint and the announcement the same click produces describe one
		// operation, so they mark its case the same way and differ only in
		// ます/ました — the particles flipped between the two before.
		expect(ja.admin_lookup_status_artist_hint).toBe('アーティストに{name}を設定します。');
		expect(ja.admin_lookup_announce_using).toBe('アーティストに{name}を設定しました。');
	});

	// One "Remove file" per tile told a screen-reader user nothing about WHICH
	// file the button removes (2.4.6, 4.1.2).
	it('names the file in every tile Remove button, in both catalogs', () => {
		expect(en.admin_variant_remove_file).toBe('Remove {fileName}');
		expect(ja.admin_variant_remove_file).toContain('{fileName}');
	});

	it('says the seeded fields were left alone rather than that nothing was filled', () => {
		expect(en.admin_lookup_announce_seed_kept).toBe(
			"The new artist's fields already have values, so Sona left them alone."
		);
	});

	// The handle-less click had nothing to leave alone, so it gets a line about
	// the form rather than one about fields it never touched.
	it('carries the already-open line in both catalogs, claiming no filled field', () => {
		expect(en.admin_lookup_announce_form_already_open).toBe(
			'The new artist form is already open.'
		);
		expect(en.admin_lookup_announce_form_already_open).not.toMatch(/values|left them alone/);
		expect(ja.admin_lookup_announce_form_already_open).toBeTruthy();
		expect(ja.admin_lookup_announce_form_already_open).not.toContain('値');
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
			/function addAsVariant[\s\S]{0,1000}?existingParentSelect\?\.focus\(\)/
		);
		expect(EDIT).toMatch(/function addAsVariant[\s\S]{0,1000}?parentSelect\?\.focus\(\)/);
	});

	// That select is a focus destination carrying an option this page never
	// loaded, so it has to say what it is. The fieldset legend names the group,
	// not the field (4.1.2, 3.3.2); the edit page's own parent select is
	// labelled "Variant of" and this one now matches it — same wrapping
	// label/span shape, so it also picks up the page's field-label styling.
	it('names the upload page parent select the way the edit page names its own', () => {
		expect(UPLOAD).toMatch(
			/<label>\s*\n\s*<span>\{m\.admin_field_variant_of\(\)\}<\/span>\s*\n\s*<select[\s\S]{0,200}?bind:this=\{existingParentSelect\}/
		);
		expect(EDIT).toMatch(
			/<span>\{m\.admin_field_variant_of\(\)\}<\/span>\s*\n\s*<select[\s\S]{0,120}?name="parentImageId"/
		);
	});

	// The options were built at page load. A clash piece uploaded in another tab
	// since then matches none of them, so the select fell back to blank with the
	// panel already closed and the save stored no parent at all.
	it('carries a clash the page did not load with into the parent select', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(
				/const parentOptions = \$derived\(\[\.\.\.data\.parentCandidates, \.\.\.extraParents\]\)/
			);
			expect(source).toMatch(
				/if \(!parentOptions\.some\(\(c\) => c\.id === clash\.imageId\)\) \{\s*\n\s*extraParents = \[\.\.\.extraParents, \{ id: clash\.imageId, title: clash\.title \}\];/
			);
			// The select renders the merged list, or the synthetic option is unreachable.
			expect(source).toMatch(/\{#each parentOptions as candidate\}/);
			expect(source).not.toMatch(/\{#each data\.parentCandidates as candidate\}/);
		}
		// Moving to another image in the same tab drops the previous image's extras
		// along with every other lookup seed.
		expect(EDIT).toMatch(/function resetForImage\(\)[\s\S]{0,600}?extraParents = \[\];/);
		// Same on the upload page, where a second lookup replaces the shared
		// prefill: the first clash's piece stops being on offer unless the operator
		// chose it, and dropping a chosen one would blank the select instead.
		expect(UPLOAD).toMatch(
			/function resetSharedPrefill\(\)[\s\S]{0,900}?extraParents = extraParents\.filter\(\(c\) => String\(c\.id\) === existingParentId\);/
		);
		// And on the edit page's own repeat lookup, which resetForImage does not
		// cover: it only runs on a move to another image.
		expect(EDIT).toMatch(
			/function resetLookupPrefill\(\)[\s\S]{0,1400}?extraParents = extraParents\.filter\(\(c\) => String\(c\.id\) === selectedParentId\);/
		);
	});

	// Same shape one control over: an artist created in another tab after the
	// page loaded comes back as a candidate with no option to select, so "Use
	// {name}" confirmed an artist the select could not hold and `required`
	// refused the save.
	it('carries an artist the page did not load with into the artist select', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(
				/function useLookupArtist[\s\S]{0,900}?if \(!artistList\.some\(\(a\) => a\.id === artist\.id\)\) \{\s*\n\s*artistList = \[\.\.\.artistList, artist\]/
			);
			// The select renders the mutable list, or the appended option is
			// unreachable.
			expect(source).toMatch(/\{#each artistList as artist\}/);
			expect(source).not.toMatch(/\{#each data\.artists as artist\}/);
		}
		// A move to another image re-seeds the list from that image's own load.
		expect(EDIT).toMatch(
			/function resetForImage\(\)[\s\S]{0,600}?artistList = data\.artists\.map\(/
		);
	});

	// A snapshot of the role taken when the request fired let a late result from
	// the former parent write its post URL and date into the shared fields after
	// another tile's Parent radio had claimed them. The role is read at resolve;
	// the group-mode round trip that the snapshot was covering is closed by the
	// "new" radio re-deriving the shared fields from the parent tile.
	it('applies the shared prefill by the role the tile has when the result lands', () => {
		expect(UPLOAD).toMatch(
			/function startLookup\(key: number\)[\s\S]{0,900}?if \(isParent\(key\)\) resetSharedPrefill\(\);/
		);
		expect(UPLOAD).toMatch(/if \(isParent\(key\)\) applyShared\(next\);/);
		expect(UPLOAD).not.toMatch(/wasParent/);
		expect(UPLOAD).toMatch(/groupMode = 'new';\s*\n\s*returnToNewSet\(\);/);
		// Only re-derive from a parent that still HAS a result: with the panel
		// closed its lookup is idle and the fields it filled are still on screen,
		// and an unconditional re-derivation cleared them and applied nothing.
		expect(UPLOAD).toMatch(
			/function returnToNewSet\(\)[\s\S]{0,400}?if \(tiles\[parentIndex\]\?\.lookup\.kind !== 'results'\) return;/
		);
		// The panel and its status region are mounted by the same mode swap, so a
		// refill lands in a region inserted with its first content. Say it — but
		// only when a field was really written. applyShared skips a field the
		// operator typed over, so an operator who typed over both heard that Sona
		// filled them while nothing had changed.
		expect(UPLOAD).toMatch(
			/function applyShared\(next: LookupState\): \{ sourcePostUrl: boolean; commissionedAt: boolean \}/
		);
		// One field written is one field named: the plural sentence over a single
		// refill told the operator both had changed.
		expect(UPLOAD).toMatch(
			/function returnToNewSet\(\)[\s\S]{0,900}?const wrote = onParentChanged\(parentIndex\);[\s\S]{0,120}?if \(wrote\.sourcePostUrl && wrote\.commissionedAt\) \{[\s\S]{0,120}?m\.admin_lookup_announce_shared_refilled\(\)/
		);
		expect(UPLOAD).toMatch(
			/\} else if \(wrote\.sourcePostUrl\) \{\s*\n\s*announcer\.say\(m\.admin_lookup_announce_shared_refilled_source\(\)\);\s*\n\s*\} else if \(wrote\.commissionedAt\) \{\s*\n\s*announcer\.say\(m\.admin_lookup_announce_shared_refilled_date\(\)\);/
		);
		// An artist the select still holds stays applied across that round trip —
		// held by the round trip itself, not by the reset. A reset that spared a
		// still-selected artist also spared it on a SECOND lookup, whose result
		// names somebody else, leaving "Using {name}" over an unrelated match.
		expect(UPLOAD).toMatch(
			/function resetSharedPrefill\(\)[\s\S]{0,900}?\n\t\tappliedArtist = null;/
		);
		expect(UPLOAD).not.toMatch(/if \(!appliedArtist \|\| Number\(selectedArtistId\) !== appliedArtist\.id\)/);
		expect(UPLOAD).toMatch(
			/function returnToNewSet\(\)[\s\S]{0,600}?const held = appliedArtist;\s*\n\s*const wrote = onParentChanged\(parentIndex\);\s*\n\s*if \(held && Number\(selectedArtistId\) === held\.id\) appliedArtist = held;/
		);
	});

	// The Remove button lives inside the tile it removes, so activating it from
	// the keyboard dropped focus on <body> and the next Tab restarted at the top
	// of the page (2.4.3). Every tile's button also read "Remove file" (2.4.6).
	it('lands on a neighbouring Remove button after removing a tile', () => {
		expect(UPLOAD).toMatch(/bind:this=\{tileRemoveButtons\[tile\.key\]\}/);
		expect(UPLOAD).toMatch(
			/async function removeTileFromButton[\s\S]{0,400}?await tick\(\);\s*\n\s*const neighbour = tiles\[idx\] \?\? tiles\[idx - 1\] \?\? null;\s*\n\s*\(neighbour \? tileRemoveButtons\[neighbour\.key\] : dropzone\)\?\.focus\(\)/
		);
		expect(UPLOAD).toMatch(/onclick=\{\(\) => removeTileFromButton\(tile\.key\)\}/);
		// The empty grid leaves the dropzone as the only control to land on.
		expect(UPLOAD).toMatch(/class="dropzone"\s*\n\s*bind:this=\{dropzone\}/);
		// The file name is in the accessible name, the way the tile lookup button
		// already carries it.
		expect(UPLOAD).toMatch(
			/aria-label=\{m\.admin_variant_remove_file\(\{ fileName: tile\.fileName \}\)\}/
		);
		// The declined-duplicate path keeps calling removeTile directly: focus is
		// on the file input or the dropzone there, and neither goes away.
		expect(UPLOAD).toContain('removeTile(tile.key);');
		// Both records are keyed by tile, and a key is never reused: the removed
		// tile's entries go with its abort rather than sitting there unreadable.
		expect(UPLOAD).toMatch(
			/function removeTile\([\s\S]{0,600}?lookupAborts\.delete\(key\);[\s\S]{0,300}?delete tileLookupButtons\[key\];\s*\n\s*delete tileRemoveButtons\[key\];/
		);
	});

	it('gives the dialog its opener back', () => {
		expect(DIALOG).toMatch(/onDestroy\([\s\S]{0,120}?opener\?\.isConnected[\s\S]{0,60}?focus\(\)/);
	});

	// "Use {name}" and "Using {name}" are two branches of the same snippet, so
	// applying destroys the button the operator is standing on. It lives in the
	// panel, so both pages and both action rows get the landing spot (2.4.3).
	it('lands on the applied button after Use, from the panel itself', () => {
		expect(PANEL).toMatch(
			/onclick=\{async \(\) => \{\s*\n\s*onuseartist\(artist\);[\s\S]{0,500}?await tick\(\);\s*\n\s*document\.getElementById\('lookup-applied-artist'\)\?\.focus\(\);/
		);
		expect(PANEL).toMatch(/import \{ tick \} from 'svelte';/);
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

	// The tile's private notice is a plain paragraph outside any live region, so
	// the outcome message is the only thing that can carry the disclosure.
	it('says the private disclosure with a variant tile outcome', () => {
		expect(UPLOAD).toMatch(
			/function announceTileLookup[\s\S]{0,900}?tile\.sentPrivate && lookupSentFile\(tile\.lookup\)[\s\S]{0,300}?m\.admin_lookup_private_notice\(\)/
		);
		// The two parts join through a message key, not an ASCII space in the
		// code: ja runs them together and only the catalog can say so.
		expect(UPLOAD).toMatch(
			/m\.admin_lookup_announce_tile_with_notice\(\{\s*outcome: line,\s*disclosure: m\.admin_lookup_private_notice\(\)\s*\}\)/
		);
		expect(UPLOAD).not.toMatch(/\$\{line\} \$\{m\.admin_lookup_private_notice/);
	});

	// Both group-mode radios share a name, or arrow keys do not move between
	// them and the pair reads as two unrelated controls.
	it('groups the group-mode radios under one name', () => {
		expect(UPLOAD.match(/name="groupMode"/g) ?? []).toHaveLength(2);
	});

	// The select sits above the panel and the button relabels itself in place.
	it('announces the artist the panel applied', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(
				/function useLookupArtist[\s\S]{0,1300}?announcer\.say\(m\.admin_lookup_announce_using\(/
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
	// Every repeat click is still answered, including the no_match one that
	// carries no handle, and the unlinked one that carries a handle but no
	// profile URL — but not with the same sentence: fewer fields were ever
	// available to fill there, so "left them alone" would name fields the click
	// never touched, with the FurAffinity field sitting empty.
	it('says so when the click filled nothing because the fields were taken', () => {
		expect(EDIT).toMatch(
			/else if \(seededNothing && seed\.handle && seed\.linkable && artistName\.trim\(\) !== ''\)\s*\n?\s*announcer\.say\(m\.admin_lookup_announce_seed_kept\(/
		);
		// The unlinked seed (linkable false) never offered a profile URL, so it
		// falls through to the already-open line rather than claiming a link
		// field was left alone.
		expect(EDIT).not.toMatch(
			/else if \(seededNothing && seed\.handle && artistName\.trim\(\) !== ''\)/
		);
		// The handle-less click keeps an answer of its own, which is what the
		// earlier name-field-only condition was carrying.
		expect(EDIT).toMatch(
			/else if \(seededNothing && artistName\.trim\(\) !== ''\)\s*\n?\s*announcer\.say\(m\.admin_lookup_announce_form_already_open\(/
		);
		// The condition this replaced answered no click at all when the handle was
		// empty, whatever the name field held.
		expect(EDIT).not.toContain('else if (seededNothing && seed.handle)');
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

	// The tile Remove ring is offset onto the tile's own image, where no single
	// colour clears 3:1 against every photo, so it carries a second near-white
	// edge as well (1.4.11).
	it('draws two edges on the tile Remove ring', () => {
		expect(UPLOAD).toMatch(
			/\.tile-remove:focus-visible \{[^}]*outline: 2px solid var\(--ring\);[^}]*box-shadow: 0 0 0 1px rgba\(255, 255, 255, 0\.9\)/
		);
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

	// runLookup resolves on every path it has, so nothing here rejects — but a
	// throw in the code that applies the result would leave the panel on
	// "searching" for the rest of the page's life, with no retry and an
	// unhandled rejection in the console. Both pages catch it into the same
	// failed state, and the "sent" flag says the file went, because by then the
	// request had.
	it('lands a throw while applying a result in the failed state', () => {
		for (const source of [UPLOAD, EDIT]) {
			expect(source).toMatch(
				/\.catch\(\(\) => \{[\s\S]{0,400}?kind: 'failed', reason: 'unavailable', sent[\s\S]{0,120}?console\.error\(LOOKUP_RESULT_THREW\)/
			);
			// Imported, not spelled out at the log site.
			expect(source).toMatch(/LOOKUP_RESULT_THREW,\n/);
		}
		// The upload callback runs for every settled kind, including a too_large
		// the browser refused to send. Rewriting that as sent would put a private
		// notice on a file that never left, so the catch keeps the settled state's
		// own flag and only assumes the file went when it captured nothing.
		expect(UPLOAD).toMatch(/\.then\(\(next\) => \{\s*\n\s*settled = next;/);
		expect(UPLOAD).toMatch(
			/const sent = settled\?\.kind === 'failed' \? settled\.sent : true;\s*\n\s*live\.lookup = \{ kind: 'failed', reason: 'unavailable', sent \};/
		);
		// The state is written to the tile BEFORE it is announced, so a throw out
		// of the announcement is not "nothing arrived": rewriting it as failed
		// would discard matches that did come back and tell the operator
		// FuzzySearch never answered. A failure is synthesised only when nothing
		// was applied.
		expect(UPLOAD).toMatch(/live\.lookup = next;\s*\n\s*applied = true;/);
		expect(UPLOAD).toMatch(
			/if \(!applied\) \{\s*\n\s*const sent = settled\?\.kind === 'failed'/
		);
		// The catch tells its own lookup from a cancelled one by the abort
		// bookkeeping, so the success path clears that last — cleared first, a
		// throw above it would read as a cancel and the catch would do nothing.
		expect(UPLOAD).toMatch(
			/else announceTileLookup\(live\);[\s\S]{0,200}?lookupAborts\.delete\(key\);\s*\n\s*\}\)/
		);
		expect(EDIT).toMatch(/applyPrefill\(next\);[\s\S]{0,200}?lookupAbort = null;\s*\n\s*\}\)/);
		// One constant, shared, carrying nothing from the result.
		expect(LOOKUP_RESULT_THREW).toBe('artist lookup: applying the result threw');
	});

	// The failed state a variant tile lands in is plain text outside any live
	// region, so the catch has to speak it (4.1.3) — the parent's failure is
	// already inside the panel's status region. Said through announcer.say, not
	// announceTileLookup, which is one of the callers that could have thrown,
	// and wrapped so a second throw cannot escape the catch.
	it('announces a variant tile failure from the catch', () => {
		expect(UPLOAD).toMatch(
			/if \(!isParent\(key\)\) \{\s*\n\s*try \{\s*\n\s*if \(!applied\) \{\s*\n\s*announcer\.say\(m\.admin_lookup_announce_tile_failed\(\{ fileName: live\.fileName \}\)\);/
		);
		// When the result stands, what the catch says is that result — announcing
		// a failure over matches the tile is showing would contradict the screen.
		// Through the normal path first, since only some of what it does threw,
		// and down to the plain outcome line if the path itself is what threw.
		expect(UPLOAD).toMatch(
			/\} else \{\s*\n\s*try \{\s*\n\s*announceTileLookup\(live\);\s*\n\s*\} catch \{\s*\n\s*announcer\.say\(tileLookupOutcome\(live\)\);/
		);
		// The outcome line is its own function so the fallback can reach it
		// without the private-disclosure wrapping that may be what threw.
		expect(UPLOAD).toMatch(/function tileLookupOutcome\(tile: Tile\): string \{/);
		expect(UPLOAD).toMatch(/let line = tileLookupOutcome\(tile\);/);
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
