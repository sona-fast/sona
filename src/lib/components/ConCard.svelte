<script lang="ts">
	import { untrack } from 'svelte';
	import { Download, Smartphone } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import {
		conCardFaceSvg,
		conCardPrintSheetSvg,
		conCardFileBase,
		CON_CARD_WIDTH,
		CON_CARD_HEIGHT,
		type ConCardColor,
		type ConCardHandle
	} from '$lib/con-card';
	import { SOCIAL_PLATFORM_NAMES } from '$lib/social-label';

	interface Props {
		name: string;
		species: string;
		colors: ConCardColor[];
		handles: ConCardHandle[];
		/** Artist to credit on the back, or null when the sheet has no artist row. */
		artCredit: string | null;
		/** The persona's face for the front, in a form the page can fetch. */
		avatarSrc: string | null;
		connectUrl: string;
		displayDomain: string;
	}

	let { name, species, colors, handles, artCredit, avatarSrc, connectUrl, displayDomain }: Props =
		$props();

	// The mock's guidance is two handles, so that is what starts checked; the
	// rest are there to be turned on deliberately.
	const COMFORTABLE_HANDLES = 2;
	/** Rasterized at twice the layout size, which is a badge at 800dpi. */
	const RASTER_SCALE = 2;

	// Read once: the page's data doesn't change under the component, and a prop
	// change must never reset a box the operator has just unticked.
	const initial = untrack(() => ({
		species: !!species,
		colors: colors.length > 0,
		credit: !!artCredit,
		handles: handles.map((_, i) => i < COMFORTABLE_HANDLES)
	}));
	let includeSpecies = $state(initial.species);
	let includeColors = $state(initial.colors);
	let includeCredit = $state(initial.credit);
	let handleOn = $state(initial.handles);

	let savingPrint = $state(false);
	let savingPhone = $state(false);
	let savingFront = $state(false);
	/** The avatar could not be fetched for embedding; the card still saves, with
	 *  the name's initial in the ring instead. Only ever the avatar: a card that
	 *  did not save at all is rasterFailed, and saying "saved" there would be a
	 *  lie the operator acts on. */
	let avatarFailed = $state(false);
	/** The raster path itself failed (the SVG would not load into an image, the
	 *  canvas gave no context, or the encode produced no blob): nothing was
	 *  saved. */
	let rasterFailed = $state(false);

	const chosenHandles = $derived(handles.filter((_, i) => handleOn[i]));

	const shared = $derived({
		name,
		species: includeSpecies ? species : null,
		colors: includeColors ? colors : [],
		handles: chosenHandles,
		artCredit:
			includeCredit && artCredit
				? m.con_card_art_credit({ artist: artCredit, domain: displayDomain })
				: null,
		connectUrl,
		displayDomain,
		madeWith: m.con_card_made_with()
	});

	// What each face is actually carrying right now, appended to its accessible
	// name. The preview is a picture: without this a screen reader hears "front of
	// the con card" whichever boxes are ticked, which is the one thing this
	// control exists to change. Read off `shared`, so a toggle can never disagree
	// with the list. Concatenated with no separator of its own: the suffix message
	// carries its own leading punctuation, which closes the title as a sentence in
	// English and opens a parenthetical in Japanese, where nothing goes between.
	function withFields(title: string, fields: string[]): string {
		const listed = fields.filter(Boolean);
		if (listed.length === 0) return title;
		return `${title}${m.con_card_title_fields({ fields: listed.join(m.con_card_field_join()) })}`;
	}

	// The preview can point straight at the avatar: it renders in the page, where
	// the URL resolves. The downloads can't, which is what embedAvatar is for.
	const previewFront = $derived(
		conCardFaceSvg('front', {
			...shared,
			variant: 'light',
			avatarHref: avatarSrc,
			title: withFields(m.con_card_title_front({ name }), [
				shared.species ? m.con_card_field_species() : '',
				shared.colors.length ? m.con_card_field_colors() : ''
			])
		})
	);
	const previewBack = $derived(
		conCardFaceSvg('back', {
			...shared,
			variant: 'light',
			title: withFields(m.con_card_title_back({ name }), [
				shared.handles.length ? m.con_card_handles() : '',
				shared.artCredit ? m.con_card_include_credit() : ''
			])
		})
	);

	/** The avatar as a data URI, fetched once and kept. Every path that draws the
	 *  front needs it: a saved .svg is opened away from the site, and an external
	 *  href is simply not drawn when the SVG is rasterized through a canvas. */
	let avatarData: string | null = null;
	async function embedAvatar(): Promise<string | null> {
		if (!avatarSrc || avatarFailed) return null;
		if (avatarData) return avatarData;
		try {
			const response = await fetch(avatarSrc);
			if (!response.ok) throw new Error(`avatar ${response.status}`);
			const blob = await response.blob();
			avatarData = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as string);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(blob);
			});
			return avatarData;
		} catch {
			// The front still carries the colours and the name, and the back, which
			// is the half that does the work, does not touch the avatar at all.
			avatarFailed = true;
			return null;
		}
	}

	function save(blob: Blob, filename: string) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		// Firefox only follows the download of an anchor in the document.
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	/** One face through a canvas, because Photos on iPhone refuses an SVG. Throws
	 *  on every way the raster can come up empty. A silent return would leave the
	 *  operator with no file and no message. */
	async function savePng(svg: string, filename: string) {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('svg raster'));
			image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
		});
		const canvas = document.createElement('canvas');
		canvas.width = CON_CARD_WIDTH * RASTER_SCALE;
		canvas.height = CON_CARD_HEIGHT * RASTER_SCALE;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no canvas context');
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!blob) throw new Error('png encode');
		save(blob, filename);
	}

	// All three save paths share one state machine: clear both flags on the way in
	// so each press reports on itself, and route every failure to rasterFailed.
	// avatarFailed resets too, so a fetch that failed once on bad wifi is retried
	// on the next press; avatarData is NOT cleared, so a success stays one fetch.
	async function downloadPrint() {
		if (savingPrint) return;
		savingPrint = true;
		rasterFailed = false;
		avatarFailed = false;
		try {
			// One sheet with both faces, so the operator prints once and cuts twice.
			const svg = conCardPrintSheetSvg({
				...shared,
				avatarHref: await embedAvatar(),
				title: m.con_card_title({ name })
			});
			save(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${conCardFileBase(name)}.svg`);
		} catch {
			// Building the sheet or handing it to the browser threw: no file reached
			// the disk, and the avatar is not what failed (embedAvatar swallows its
			// own failure and returns null).
			rasterFailed = true;
		} finally {
			savingPrint = false;
		}
	}

	async function savePhone() {
		if (savingPhone) return;
		savingPhone = true;
		rasterFailed = false;
		avatarFailed = false;
		try {
			// The back alone: at a con the phone has one job, and the front adds
			// nothing to a screen the person holding it is already looking at.
			const svg = conCardFaceSvg('back', {
				...shared,
				variant: 'dark',
				title: m.con_card_title_back({ name })
			});
			await savePng(svg, `${conCardFileBase(name)}-back.png`);
		} catch {
			// Nothing reached the phone. The avatar is not implicated: the back does
			// not draw one.
			rasterFailed = true;
		} finally {
			savingPhone = false;
		}
	}

	async function saveFront() {
		if (savingFront) return;
		savingFront = true;
		rasterFailed = false;
		avatarFailed = false;
		try {
			const svg = conCardFaceSvg('front', {
				...shared,
				variant: 'dark',
				avatarHref: await embedAvatar(),
				title: m.con_card_title_front({ name })
			});
			await savePng(svg, `${conCardFileBase(name)}-front.png`);
		} catch {
			// A raster failure, never an avatar one: embedAvatar swallows its own
			// failure and returns null, and the card saves without it.
			rasterFailed = true;
		} finally {
			savingFront = false;
		}
	}
</script>

<div class="con-card">
	<!-- Inlined rather than sourced from a blob URL so the preview repaints with
	     each toggle. conCardFaceSvg escapes every operator value it is handed. -->
	<div class="preview">
		<figure>
			<figcaption>{m.con_card_face_front()}</figcaption>
			<div class="face">{@html previewFront}</div>
		</figure>
		<figure>
			<figcaption>{m.con_card_face_back()}</figcaption>
			<div class="face">{@html previewBack}</div>
		</figure>
	</div>

	<div class="controls">
		<fieldset class="includes">
			<legend>{m.con_card_include()}</legend>
			<div class="boxes">
				{#if species}
					<label><input type="checkbox" bind:checked={includeSpecies} /> {m.con_card_field_species()}</label>
				{/if}
				{#if colors.length}
					<label><input type="checkbox" bind:checked={includeColors} /> {m.con_card_field_colors()}</label>
				{/if}
				{#if artCredit}
					<label><input type="checkbox" bind:checked={includeCredit} /> {m.con_card_include_credit()}</label>
				{/if}
			</div>
		</fieldset>

		<!-- Their own group, per the mock: a handle row carries the account the card
		     will print, which the include boxes above do not. -->
		{#if handles.length}
			<fieldset class="includes handles">
				<legend>{m.con_card_handles()}</legend>
				<div class="rows">
					{#each handles as handle, i (handle.platform)}
						<label class="handle-row">
							<input type="checkbox" bind:checked={handleOn[i]} />
							<span>{SOCIAL_PLATFORM_NAMES[handle.platform]}</span>
							<span class="handle-value">{handle.value}</span>
						</label>
					{/each}
				</div>
			</fieldset>
		{/if}

		<!-- Always in the DOM, empty until something has to be said: a live region
		     created together with its text is not reliably announced. The handle hint
		     shares it with the two failures because all three are the same moment for
		     the operator: something about the card just changed under them. The two
		     failures come first: a save that just went wrong outranks advice about a
		     crowded card, and the region is read in DOM order. -->
		<p class="status-line" role="status">
			{#if avatarFailed}<span class="hint art-failed">{m.con_card_art_failed()}</span>{/if}
			{#if rasterFailed}<span class="hint art-failed">{m.con_card_save_failed()}</span>{/if}
			{#if chosenHandles.length > COMFORTABLE_HANDLES}<span class="hint">{m.con_card_handle_hint()}</span>{/if}
		</p>

		<div class="actions">
			<!-- aria-busy rather than disabled: a control that vanishes from the tab
			     order mid-press drops the focus the operator was holding. Re-entry is
			     guarded in the handlers instead. -->
			<button type="button" class="btn btn-secondary" onclick={downloadPrint} aria-busy={savingPrint}>
				<Download size={15} />
				{savingPrint ? m.admin_saving() : m.con_card_download_print()}
			</button>
			<button type="button" class="btn btn-primary" onclick={savePhone} aria-busy={savingPhone}>
				<Smartphone size={15} />
				{savingPhone ? m.admin_saving() : m.con_card_save_phone()}
			</button>
		</div>
		<p class="hint">{m.con_card_save_phone_hint()}</p>
		<!-- Secondary on purpose: the back is the useful save, and the front is
		     here for whoever wants it behind a lock screen. -->
		<button type="button" class="link-action" onclick={saveFront} aria-busy={savingFront}>
			{savingFront ? m.admin_saving() : m.con_card_save_front()}
		</button>
	</div>
</div>

<style>
	.con-card {
		display: grid;
		gap: 20px;
		/* The settings section's explainer sits right above, and the previews are
		   the loudest thing on the tab. The gap belongs to the card rather than to
		   the paragraph: the same explainer style is used everywhere else on the
		   page, where nothing needs the extra room. */
		margin-top: 16px;
	}
	.preview {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
	}
	.preview figure {
		margin: 0;
		/* Shrinks rather than wraps: on a 320px phone the two faces have to stay
		   side by side, which is how a two-sided card reads at all. The basis is
		   what the pair costs at that width, gap included. */
		flex: 1 1 130px;
		max-width: 200px;
	}
	.preview figcaption {
		margin-bottom: 6px;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.face {
		border-radius: var(--radius-s);
		overflow: hidden;
		/* The light card is opaque white in both modes; a frame keeps it from
		   floating on a dark settings page. */
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
		/* Same opt-out as .nsfw-badge: in forced-colors every fill in the preview
		   would collapse to the system pair, and the card would read as one solid
		   block rather than as the thing about to come out of a printer. */
		forced-color-adjust: none;
	}
	.face :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}
	.controls {
		display: grid;
		gap: 12px;
		justify-items: start;
	}
	/* A real fieldset for the grouping, with the row layout on an inner div:
	   a <legend> in a flex container is laid out by its own rules. */
	.includes {
		border: none;
		padding: 0;
		margin: 0;
	}
	.includes legend {
		padding: 0;
		margin-bottom: 8px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.boxes {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		align-items: center;
	}
	.includes label {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 14px;
		cursor: pointer;
	}
	/* .controls packs its children to the start, which leaves the hover wash
	   narrower than the column it sits in. Claim the width so the wash lines up
	   with the controls above it. */
	.handles {
		justify-self: stretch;
	}
	/* One handle per row, so the account the card will print sits beside the
	   platform it belongs to rather than being guessed from a checkbox. */
	.handles .rows {
		display: grid;
		gap: 8px;
		min-width: 260px;
	}
	.handles .handle-row {
		display: grid;
		grid-template-columns: auto auto 1fr;
		align-items: center;
		gap: 7px;
		/* The row is the click target, so it gets a hover of its own. The inline
		   padding is paid back as a negative margin: the wash reaches past the text
		   on both sides without the row moving when it appears. */
		margin-inline: -8px;
		padding-inline: 8px;
		border-radius: var(--radius-s);
	}
	/* A tint of the text colour rather than --secondary: the wash stays a wash at
	   any theme, instead of landing on a surface the muted handle text was never
	   checked against. */
	.handles .handle-row:hover {
		background: color-mix(in srgb, var(--foreground) 8%, transparent);
	}
	/* The handle is muted while it sits still, and full strength under the
	   pointer, per the SONA-124 chip: the row lifting means this row. */
	.handles .handle-row:hover .handle-value {
		color: var(--foreground);
	}
	.handle-value {
		justify-self: end;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.actions .btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}
	/* On a phone the two buttons wrap to a ragged pair of half-rows. Stack them
	   full width instead, and put "save to phone" on top: it is the save that
	   matters, and on a phone it is the one being pressed. `order` only, so below
	   520px the visual order and the tab order disagree: tabbing still runs print
	   then phone, matching the DOM. Accepted: these are two independent buttons
	   rather than a sequence, so neither one is a step toward the other and
	   arriving at them in the other order costs nothing. */
	@media (max-width: 520px) {
		.actions {
			display: grid;
			grid-template-columns: 1fr;
			/* .controls packs its children to the start, so the row has to claim the
			   width before the buttons can fill it. */
			justify-self: stretch;
		}
		.actions .btn {
			justify-content: center;
		}
		.actions .btn-primary {
			order: -1;
		}
	}
	.hint {
		margin: 0;
		font-size: 13px;
		color: var(--muted-foreground);
	}
	.art-failed {
		color: var(--destructive);
	}
	/* Empty most of the time, and it stays in the layout that way: the region has
	   to exist before the message does. */
	.status-line {
		display: grid;
		gap: 4px;
		margin: 0;
	}
	/* --link, not --muted-foreground: this is an action, and sharing the hint's
	   colour left the third download reading as a footnote to the sentence above
	   it. The vertical padding is for the thumb, since this flow is used one
	   handed on a con floor. */
	.link-action {
		background: none;
		border: none;
		padding: 6px 0;
		font: inherit;
		font-size: 13px;
		color: var(--link);
		text-decoration: underline;
		cursor: pointer;
	}
	.link-action:hover {
		color: var(--foreground);
	}
</style>
