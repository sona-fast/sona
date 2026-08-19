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

	// The preview can point straight at the avatar: it renders in the page, where
	// the URL resolves. The downloads can't, which is what embedAvatar is for.
	const previewFront = $derived(
		conCardFaceSvg('front', {
			...shared,
			variant: 'light',
			avatarHref: avatarSrc,
			title: m.con_card_title_front({ name })
		})
	);
	const previewBack = $derived(
		conCardFaceSvg('back', {
			...shared,
			variant: 'light',
			title: m.con_card_title_back({ name })
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

	async function downloadPrint() {
		if (savingPrint) return;
		savingPrint = true;
		try {
			// One sheet with both faces, so the operator prints once and cuts twice.
			const svg = conCardPrintSheetSvg({
				...shared,
				avatarHref: await embedAvatar(),
				title: m.con_card_title({ name })
			});
			save(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${conCardFileBase(name)}.svg`);
		} finally {
			savingPrint = false;
		}
	}

	async function savePhone() {
		if (savingPhone) return;
		savingPhone = true;
		rasterFailed = false;
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

		{#if chosenHandles.length > COMFORTABLE_HANDLES}
			<p class="hint">{m.con_card_handle_hint()}</p>
		{/if}
		<!-- Always in the DOM, empty until something fails: a live region created
		     together with its text is not reliably announced. Both failures share it
		     because they are the same moment for the operator. -->
		<p class="status-line" role="status">
			{#if avatarFailed}<span class="hint art-failed">{m.con_card_art_failed()}</span>{/if}
			{#if rasterFailed}<span class="hint art-failed">{m.con_card_save_failed()}</span>{/if}
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
	}
	.preview {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
	}
	.preview figure {
		margin: 0;
		/* Shrinks rather than wraps: on a 390px phone the two faces have to stay
		   side by side, which is how a two-sided card reads at all. */
		flex: 1 1 150px;
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
	.link-action {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 13px;
		color: var(--muted-foreground);
		text-decoration: underline;
		cursor: pointer;
	}
	.link-action:hover {
		color: var(--foreground);
	}
</style>
