<script lang="ts">
	import { Check, Pipette, X } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import { extractPalette } from '$lib/palette-extract';
	import { MAX_SONA_COLORS, paletteHas } from '$lib/palette-merge';
	import { rgbToHex } from '$lib/color-hex';
	import { focusTrap } from '$lib/focus-trap';
	import { loupeCenterX } from '$lib/loupe-position';

	interface Slot {
		name: string;
		hex: string;
	}
	interface Props {
		src: string;
		crossorigin: boolean;
		/** Existing palette colors — pickable targets alongside the "new color" slot. */
		slots: Slot[];
		onpick: (slot: number | 'new', hex: string) => void;
		/** "Add all" — append the current suggestions to the palette (the parent
		 *  dedupes against its live palette state). */
		onaddall: (hexes: string[]) => void;
		onclose: () => void;
	}

	let { src, crossorigin, slots, onpick, onaddall, onclose }: Props = $props();

	let canvas = $state<HTMLCanvasElement>();
	let loupeCanvas = $state<HTMLCanvasElement>();
	let activeSlot = $state<number | 'new'>('new');
	let suggestions = $state<string[]>([]);
	let loadError = $state(false);
	let hover = $state<{ hex: string; r: number; g: number; b: number; x: number; y: number; touch: boolean; below: boolean } | null>(null);

	// Palette-aware pick state: slots ARE the live palette (the parent passes
	// its colors), so duplicate/full checks derive straight from them.
	const paletteHexes = $derived(slots.map((s) => s.hex));
	const paletteFull = $derived(slots.length >= MAX_SONA_COLORS);
	// Transient "Already in your palette" cue for a duplicate New-color pick.
	let dupHint = $state(false);
	let dupHintTimer: ReturnType<typeof setTimeout> | undefined;
	function showDupHint() {
		dupHint = true;
		clearTimeout(dupHintTimer);
		dupHintTimer = setTimeout(() => (dupHint = false), 2500);
	}
	$effect(() => () => clearTimeout(dupHintTimer));

	// All picks (loupe commit + suggestion pills) route through here: a pick
	// aimed at the "New color" slot is dropped when the hex is already in the
	// palette (dedupe cue) or the palette is full (the persistent full hint
	// explains why); overwriting an existing slot stays unrestricted.
	function pick(hex: string) {
		if (activeSlot === 'new') {
			if (paletteFull) return;
			if (paletteHas(paletteHexes, hex)) {
				showDupHint();
				return;
			}
		}
		onpick(activeSlot, hex);
	}

	const LOUPE = 120; // loupe canvas CSS size
	const ZOOM = 8; // CSS px shown per working-image pixel in the loupe
	// Long-side cap for the offscreen sampling canvas: bounds decode/memory cost
	// for full-res originals (UploadThing/proxy paths serve the raw file). Picks
	// are exact pixels of this ≤1600px working image.
	const MAX_SAMPLE = 1600;
	// Approximate CSS height of the loupe column below the glass (gap + readout);
	// used only to decide when to flip the loupe below the pointer.
	const READOUT_H = 40;

	// The sampling source: an offscreen size-capped copy of the sheet. sample()
	// reads THIS, never the display canvas (which is scaled to the layout width
	// and would blend pixels).
	let sampleCanvas: HTMLCanvasElement | null = null;
	let sampleCtx: CanvasRenderingContext2D | null = null;
	let loupeCtx: CanvasRenderingContext2D | null = null;

	// Load the sheet with the strategy the server computed (see ref-image.ts).
	$effect(() => {
		const img = new Image();
		if (crossorigin) img.crossOrigin = 'anonymous';
		img.onload = () => draw(img);
		img.onerror = () => (loadError = true);
		img.src = src;
	});

	// Size the loupe's backing store once (dpr-scaled), and cache its context.
	$effect(() => {
		if (!loupeCanvas) return;
		const dpr = window.devicePixelRatio || 1;
		loupeCanvas.width = LOUPE * dpr;
		loupeCanvas.height = LOUPE * dpr;
		loupeCtx = loupeCanvas.getContext('2d');
		if (loupeCtx) loupeCtx.imageSmoothingEnabled = false;
	});

	function draw(img: HTMLImageElement) {
		if (!canvas) return;
		// Working image: cap the long side at MAX_SAMPLE so a huge original never
		// costs full-res decode/readback. Everything downstream (display, loupe,
		// suggestions, picks) reads from this copy.
		const scale = Math.min(1, MAX_SAMPLE / Math.max(img.naturalWidth, img.naturalHeight));
		const sw = Math.max(1, Math.round(img.naturalWidth * scale));
		const sh = Math.max(1, Math.round(img.naturalHeight * scale));
		sampleCanvas = document.createElement('canvas');
		sampleCanvas.width = sw;
		sampleCanvas.height = sh;
		sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
		if (!sampleCtx) return;
		sampleCtx.drawImage(img, 0, 0, sw, sh);

		// Display canvas: a dpr-scaled view of the working image at layout width.
		const dpr = window.devicePixelRatio || 1;
		const cssW = canvas.parentElement?.clientWidth || 600;
		const cssH = Math.max(1, Math.round((cssW * sh) / sw));
		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);
		canvas.style.height = `${cssH}px`;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.drawImage(sampleCanvas, 0, 0, canvas.width, canvas.height);

		// Auto-palette suggestions from a downscaled copy (fast, plenty for the
		// flat color regions of a ref sheet).
		try {
			const s = Math.min(1, 256 / Math.max(sw, sh));
			const off = document.createElement('canvas');
			off.width = Math.max(1, Math.round(sw * s));
			off.height = Math.max(1, Math.round(sh * s));
			const octx = off.getContext('2d');
			if (!octx) return;
			octx.drawImage(sampleCanvas, 0, 0, off.width, off.height);
			suggestions = extractPalette(octx.getImageData(0, 0, off.width, off.height));
		} catch {
			// Tainted canvas (CORS) — no pixel access, so the picker can't work.
			loadError = true;
		}
	}

	// rAF-coalesce pointer sampling: pointermove fires faster than frames, and
	// every sample costs a getImageData + loupe draw.
	let pendingSample: PointerEvent | null = null;
	let sampleRaf = 0;
	function queueSample(e: PointerEvent) {
		pendingSample = e;
		if (sampleRaf) return;
		sampleRaf = requestAnimationFrame(() => {
			sampleRaf = 0;
			if (pendingSample) sample(pendingSample);
			pendingSample = null;
		});
	}
	function clearHover() {
		pendingSample = null;
		hover = null;
	}
	$effect(() => () => cancelAnimationFrame(sampleRaf));

	function sample(e: PointerEvent) {
		if (!canvas || !sampleCanvas || !sampleCtx || loadError) return;
		const rect = canvas.getBoundingClientRect();
		// Map display coords → working-image coords (exact pixels of the ≤1600px
		// sampling canvas; the display canvas is only a scaled view of it).
		const px = Math.min(
			sampleCanvas.width - 1,
			Math.max(0, Math.round(((e.clientX - rect.left) * sampleCanvas.width) / rect.width))
		);
		const py = Math.min(
			sampleCanvas.height - 1,
			Math.max(0, Math.round(((e.clientY - rect.top) * sampleCanvas.height) / rect.height))
		);
		let d: Uint8ClampedArray;
		try {
			d = sampleCtx.getImageData(px, py, 1, 1).data;
		} catch {
			loadError = true;
			return;
		}
		// Keep the loupe inside the canvas: clamp it horizontally, and flip it
		// below the pointer when there's no room above (near the top edge). On
		// touch a below-flip would sit right under the finger, so loupeCenterX
		// shifts it to whichever side of the contact point has room instead.
		const touch = e.pointerType === 'touch';
		const y = e.clientY - rect.top;
		const below = y < LOUPE + READOUT_H + (touch ? 56 : 16);
		hover = {
			hex: rgbToHex(d[0], d[1], d[2]),
			r: d[0],
			g: d[1],
			b: d[2],
			x: loupeCenterX(e.clientX - rect.left, rect.width, LOUPE, touch && below),
			y,
			touch,
			below
		};
		drawLoupe(px, py);
	}

	function drawLoupe(px: number, py: number) {
		if (!sampleCanvas || !loupeCanvas || !loupeCtx) return;
		const srcSize = LOUPE / ZOOM; // working-image pixels shown across the glass
		loupeCtx.drawImage(
			sampleCanvas,
			px - srcSize / 2,
			py - srcSize / 2,
			srcSize,
			srcSize,
			0,
			0,
			loupeCanvas.width,
			loupeCanvas.height
		);
	}

	function commit(e: PointerEvent) {
		sample(e);
		if (hover) pick(hover.hex);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="backdrop" onclick={onclose}>
	<!-- Escape/Tab are handled at the window level while open (see focusTrap); this
	     stops backdrop clicks from leaking through to the panel. -->
	<div class="modal" use:focusTrap={onclose} role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="refpicker-title" onclick={(e) => e.stopPropagation()}>
		<div class="modal-head">
			<h2 id="refpicker-title">{m.admin_ref_picker_title()}</h2>
			<button class="modal-close" aria-label={m.admin_close()} onclick={onclose}><X size={18} /></button>
		</div>
		<p class="modal-sub"><Pipette size={15} />{m.admin_ref_picker_sub()}</p>
		<div class="modal-body">
			<div class="slot-row" role="group" aria-label={m.admin_ref_picker_apply_to()}>
				<span class="slot-label">{m.admin_ref_picker_apply_to()}</span>
				{#each slots as slot, i}
					<button type="button" class="slot-chip" class:active={activeSlot === i} aria-pressed={activeSlot === i} onclick={() => (activeSlot = i)}>
						{#if activeSlot === i}<Check size={13} />{/if}<span class="dot" style="background:{slot.hex}"></span>{slot.name}
					</button>
				{/each}
				<button type="button" class="slot-chip" class:active={activeSlot === 'new'} aria-pressed={activeSlot === 'new'} disabled={paletteFull} onclick={() => (activeSlot = 'new')}>
					{#if activeSlot === 'new'}<Check size={13} />{/if}{m.admin_ref_picker_slot_new()}
				</button>
				<!-- Live feedback: the persistent full hint, or the transient duplicate
				     cue after a New-color pick that's already in the palette. -->
				<span class="slot-hint" role="status">
					{#if paletteFull}{m.admin_settings_sona_palette_full({ max: MAX_SONA_COLORS })}{:else if dupHint}{m.admin_ref_picker_already_in_palette()}{/if}
				</span>
			</div>

			{#if loadError}
				<p class="load-error">{m.admin_ref_picker_load_error()}</p>
			{:else}
				<div class="canvas-wrap">
					<canvas
						bind:this={canvas}
						aria-describedby="refpicker-canvas-desc"
						onpointermove={queueSample}
						onpointerdown={queueSample}
						onpointerup={commit}
						onpointerleave={clearHover}
						onpointercancel={clearHover}
					></canvas>
					<!-- Loupe stays mounted (drawLoupe needs the bound canvas before the
					     first hover); it's display:none until there's a sample. On touch it
					     sits higher so the finger doesn't occlude it. -->
					<div
						class="loupe"
						class:touch={hover?.touch}
						class:below={hover?.below}
						style="left:{hover?.x ?? 0}px; top:{hover?.y ?? 0}px; display:{hover ? 'flex' : 'none'}"
						aria-hidden="true"
					>
						<div class="loupe-glass">
							<canvas bind:this={loupeCanvas} style="width:{LOUPE}px; height:{LOUPE}px"></canvas>
							<span class="crosshair"></span>
						</div>
						<div class="readout">
							<span class="dot" style="background:{hover?.hex}"></span>
							<code>{hover?.hex}</code>
							<span class="rgb">{hover?.r}, {hover?.g}, {hover?.b}</span>
						</div>
					</div>
				</div>
				<p id="refpicker-canvas-desc" class="sr-only">{m.admin_ref_picker_canvas_desc()}</p>

				{#if suggestions.length > 0}
					<div class="suggestions">
						<div class="suggestion-head">
							<span class="slot-label">{m.admin_ref_picker_suggestions()}</span>
							<button
								type="button"
								class="add-all"
								aria-label={m.admin_ref_picker_add_all_label()}
								disabled={paletteFull}
								onclick={() => onaddall(suggestions)}
							>
								{m.admin_ref_picker_add_all()}
							</button>
						</div>
						<div class="suggestion-row">
							{#each suggestions as hex (hex)}
								<!-- Already-in-palette pills stay focusable (the aria-label says why;
								     they can still overwrite an existing slot) but read as done: dimmed
								     with the same check glyph as the slot chips. -->
								{@const added = paletteHas(paletteHexes, hex)}
								<button
									type="button"
									class="suggestion"
									class:added
									title={hex}
									aria-label={added
										? m.admin_ref_picker_suggestion_added_label({ hex })
										: m.admin_ref_picker_suggestion_label({ hex })}
									onclick={() => pick(hex)}
								>
									{#if added}<Check size={13} />{/if}
									<span class="suggestion-fill" style="background:{hex}"></span>
									<code>{hex}</code>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			{/if}

			<div class="picker-actions">
				<button type="button" class="btn btn-secondary" onclick={onclose}>{m.admin_ref_picker_done()}</button>
			</div>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 24px;
	}
	.modal {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		width: 100%;
		max-width: 680px;
		max-height: calc(100% - 48px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 22px 24px 0;
	}
	.modal-head h2 {
		font-size: 18px;
	}
	.modal-close {
		background: none;
		border: none;
		color: var(--muted-foreground);
		display: flex;
		padding: 4px;
		border-radius: var(--radius-xs);
		cursor: pointer;
	}
	.modal-close:hover {
		color: var(--foreground);
	}
	.modal-sub {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 24px 16px;
		font-size: 12.5px;
		color: var(--muted-foreground);
		border-bottom: 1px solid var(--border);
	}
	.modal-sub :global(svg) {
		flex-shrink: 0;
		color: var(--primary);
	}
	.modal-body {
		padding: 22px 24px 24px;
		overflow-y: auto;
		/* iOS Safari: an eyedropper drag or long-press must never start text
		   selection (chip labels, hex readouts) or the copy callout. Everything
		   in here is pick-a-color UI — nothing is selectable-by-design (no text
		   inputs live inside this modal). */
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	.slot-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 14px;
	}
	.slot-label {
		font-size: 13px;
		font-weight: 500;
		margin-right: 4px;
	}
	.slot-chip {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 5px 11px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: none;
		color: var(--foreground);
		font-size: 13px;
		cursor: pointer;
	}
	/* The selected chip is signaled by more than border color alone (WCAG 1.4.1):
	   a primary-tinted fill + the leading check glyph. */
	.slot-chip.active {
		border-color: var(--primary, var(--foreground));
		background: color-mix(in srgb, var(--primary, var(--foreground)) 14%, transparent);
	}
	.slot-chip :global(svg) {
		flex: none;
		color: var(--primary, var(--foreground));
	}
	.slot-chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	/* Palette-full / already-in-palette feedback (also an aria-live region). */
	.slot-hint {
		font-size: 12.5px;
		color: var(--muted-foreground);
	}
	.dot {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--foreground) 20%, transparent);
		flex: none;
	}

	.canvas-wrap {
		position: relative;
	}
	.canvas-wrap canvas {
		display: block;
		width: 100%;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		cursor: crosshair;
		touch-action: none;
	}

	.loupe {
		position: absolute;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		/* Above the pointer — the hand/finger sits below it. */
		transform: translate(-50%, calc(-100% - 16px));
		pointer-events: none;
		z-index: 1;
	}
	/* On touch the finger occludes far more — lift the loupe higher. */
	.loupe.touch {
		transform: translate(-50%, calc(-100% - 56px));
	}
	/* Near the top edge there's no room above — flip the loupe below the pointer
	   (sample() sets `below`; horizontal clamping also happens there). */
	.loupe.below {
		transform: translate(-50%, 24px);
	}
	/* Touch + below would land under the finger: sample() shifts x to the side
	   of the contact point (loupeCenterX), and the glass tops out at the touch y
	   so it stays inside the canvas. */
	.loupe.below.touch {
		transform: translate(-50%, 0);
	}
	.loupe-glass {
		position: relative;
		border: 2px solid var(--foreground);
		border-radius: 50%;
		overflow: hidden;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		background: var(--card);
	}
	.loupe-glass canvas {
		display: block;
		border: none;
		border-radius: 0;
	}
	.crosshair {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 10px;
		height: 10px;
		transform: translate(-50%, -50%);
		border: 1px solid var(--foreground);
		outline: 1px solid var(--background);
		pointer-events: none;
	}
	.readout {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--card);
		font-size: 12px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	}
	.readout code {
		font-family: var(--font-primary);
		font-weight: 600;
	}
	.readout .rgb {
		color: var(--muted-foreground);
	}

	.suggestions {
		margin-top: 16px;
	}
	.suggestion-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	/* Pill-shaped like the suggestion chips below it. */
	.add-all {
		padding: 5px 11px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: none;
		color: var(--foreground);
		font-size: 12.5px;
		cursor: pointer;
	}
	.add-all:hover {
		border-color: var(--primary, var(--foreground));
	}
	.add-all:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.suggestion-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}
	.suggestion {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 5px 10px 5px 5px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: none;
		color: var(--foreground);
		cursor: pointer;
	}
	.suggestion:hover {
		border-color: var(--primary, var(--foreground));
	}
	/* Same check treatment as the active slot chip; dimmed = already added. */
	.suggestion.added {
		opacity: 0.55;
	}
	.suggestion :global(svg) {
		flex: none;
		color: var(--primary, var(--foreground));
	}
	.suggestion-fill {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--foreground) 20%, transparent);
	}
	.suggestion code {
		font-family: var(--font-primary);
		font-size: 12px;
	}

	.load-error {
		font-size: 13px;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		padding: 14px;
		line-height: 1.5;
	}

	.picker-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 18px;
	}

</style>
