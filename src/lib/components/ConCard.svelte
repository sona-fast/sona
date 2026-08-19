<script lang="ts">
	import { untrack } from 'svelte';
	import { Download, Smartphone } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import {
		conCardSvg,
		conCardFileBase,
		CON_CARD_WIDTH,
		CON_CARD_HEIGHT,
		type ConCardColor,
		type ConCardHandle
	} from '$lib/con-card';

	interface Props {
		name: string;
		species: string;
		colors: ConCardColor[];
		handles: ConCardHandle[];
		/** Artist to credit on the spine, or null when the sheet has no artist row. */
		artCredit: string | null;
		/** The reference sheet, with the client loading strategy the server picked. */
		refImageSrc: { src: string; crossorigin: boolean } | null;
		connectUrl: string;
		displayDomain: string;
	}

	let { name, species, colors, handles, artCredit, refImageSrc, connectUrl, displayDomain }: Props =
		$props();

	// The mock's guidance is two handles, so that is what starts checked; the
	// rest are there to be turned on deliberately.
	const COMFORTABLE_HANDLES = 2;
	/** Downloaded at twice the layout size — a 4in card at 600dpi. */
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
	/** The art could not be fetched for embedding; the card saved without it. */
	let artFailed = $state(false);

	const chosenHandles = $derived(handles.filter((_, i) => handleOn[i]));

	const labels = $derived({
		species: m.con_card_field_species(),
		colors: m.con_card_field_colors(),
		online: m.con_card_field_online()
	});

	const shared = $derived({
		labels,
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
		title: m.con_card_title({ name })
	});

	// The preview can point straight at the sheet: it renders in the page, where
	// a same-origin href resolves. The downloads can't — see embedArt.
	const preview = $derived(
		conCardSvg({ ...shared, variant: 'light', artHref: refImageSrc?.src ?? null })
	);

	/** The sheet as a data URI, fetched once and kept. Both downloads need it:
	 *  a saved .svg is opened away from the site, and an external href is simply
	 *  not drawn when the SVG is rasterized through a canvas. */
	let artData: string | null = null;
	async function embedArt(): Promise<string | null> {
		if (!refImageSrc || artFailed) return null;
		if (artData) return artData;
		try {
			const response = await fetch(refImageSrc.src);
			if (!response.ok) throw new Error(`art ${response.status}`);
			const blob = await response.blob();
			artData = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as string);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(blob);
			});
			return artData;
		} catch {
			// A card without art still carries the QR, which is the point of it.
			artFailed = true;
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

	async function downloadPrint() {
		savingPrint = true;
		try {
			const svg = conCardSvg({ ...shared, variant: 'light', artHref: await embedArt() });
			save(
				new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
				`${conCardFileBase(name)}.svg`
			);
		} finally {
			savingPrint = false;
		}
	}

	async function savePhone() {
		savingPhone = true;
		try {
			const svg = conCardSvg({ ...shared, variant: 'dark', artHref: await embedArt() });
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
			if (!ctx) return;
			ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, 'image/png')
			);
			// PNG rather than SVG because Photos on iPhone refuses an SVG, which
			// is the whole reason this path exists alongside the print download.
			if (blob) save(blob, `${conCardFileBase(name)}.png`);
		} catch {
			artFailed = true;
		} finally {
			savingPhone = false;
		}
	}
</script>

<div class="con-card">
	<!-- Inlined rather than sourced from a blob URL so the preview repaints with
	     each toggle. conCardSvg escapes every operator value it is handed. -->
	<div class="preview">{@html preview}</div>

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
				{#each handles as handle, i (handle.label)}
					<label><input type="checkbox" bind:checked={handleOn[i]} /> {handle.label}</label>
				{/each}
			</div>
		</fieldset>

		{#if chosenHandles.length > COMFORTABLE_HANDLES}
			<p class="hint">{m.con_card_handle_hint()}</p>
		{/if}
		{#if artFailed}
			<p class="hint art-failed" role="status">{m.con_card_art_failed()}</p>
		{/if}

		<div class="actions">
			<button type="button" class="btn btn-primary" onclick={downloadPrint} disabled={savingPrint}>
				<Download size={15} />
				{savingPrint ? m.admin_saving() : m.con_card_download_print()}
			</button>
			<button type="button" class="btn btn-secondary" onclick={savePhone} disabled={savingPhone}>
				<Smartphone size={15} />
				{savingPhone ? m.admin_saving() : m.con_card_save_phone()}
			</button>
		</div>
		<p class="hint">{m.con_card_save_phone_hint()}</p>
	</div>
</div>

<style>
	.con-card {
		display: grid;
		gap: 20px;
	}
	.preview {
		max-width: 520px;
		border-radius: var(--radius-s);
		overflow: hidden;
		/* The light card is opaque white in both modes — a frame keeps it from
		   floating on a dark settings page. */
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
	}
	.preview :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}
	.controls {
		display: grid;
		gap: 12px;
	}
	/* A real fieldset for the grouping, with the row layout on an inner div —
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
</style>
