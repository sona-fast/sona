<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import { CloudUpload, Check, FileBox, Loader2, Plus, Search, X } from 'lucide-svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import ArtistLookupPanel from '$lib/components/ArtistLookupPanel.svelte';
	import LiveAnnouncer from '$lib/components/LiveAnnouncer.svelte';
	import { Announcer } from '$lib/live-announcer.svelte';
	import {
		matchHandle,
		pickPrefillMatch,
		prefillForResult,
		profileUrlFor,
		ratingTag,
		runLookup,
		siteLabel,
		strictestRating,
		tileResultText,
		candidateArtists,
		lookupSentFile,
		type LookupFields,
		type LookupMatch,
		type LookupSite,
		type LookupState,
		type SourceClash
	} from '$lib/artist-lookup';
	import { extractImageFiles, isTextEditable, shouldHandleImagePaste } from '$lib/clipboard';
	import { dropFiles, partitionByAccept, swallowStrayFileDrop } from '$lib/drop-files';
	import { GALLERY_ACCEPT, MAX_BUFFER_BYTES } from '$lib/config';
	import { toast } from '$lib/toast.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	// A newly created artist (via the New Artist dialog) is appended here so it
	// appears in the select without a reload. `data.artists` is left untouched.
	let artistList = $state<{ id: number; name: string }[]>(
		data.artists.map((a) => ({ id: a.id, name: a.name }))
	);
	let selectedArtistId = $state<string | number>('');
	let showNewArtist = $state(false);
	let saving = $state(false);
	// Two identical batches say the same thing, so the region is keyed on a
	// counter rather than on the text — see `$lib/live-announcer.svelte`.
	const announcer = new Announcer();
	let fileInput: HTMLInputElement;

	type Tile = {
		key: number;
		fileName: string;
		previewUrl: string;
		url: string;
		width: number;
		height: number;
		fileSize: number;
		status: 'uploading' | 'done' | 'error';
		error: string;
		label: string;
		nsfw: boolean;
		// The bytes, kept for "Look up artist" (SONA-156): the lookup endpoint
		// never accepts a URL from the client, so the file itself is what gets
		// posted. Held for the tile's whole life and released with it: a lookup
		// can be asked for at any point before the form is saved, and repeated.
		// A dropped or picked file is a handle to something on disk, but a PASTED
		// one is a blob the page is holding in memory — so the cost of keeping it
		// is real, and dropping it early would cost the operator a lookup they
		// can still ask for. Release it only where the code can tell no further
		// lookup is possible.
		file: File | null;
		lookup: LookupState;
	};
	let tiles = $state<Tile[]>([]);
	let tileKey = 0;
	// Two drops can overlap: a second batch starts while the first is still
	// uploading. Only the last batch in flight writes the terminal announcement,
	// so neither closes the other out, and it carries any error either of them
	// hit. Not $state — nothing renders them.
	let inFlightBatches = 0;
	let batchHadErrors = false;
	let parentIndex = $state(0);
	// 'new' = the set becomes a new piece (one tile is the parent);
	// 'existing' = every file becomes a variant of an already-uploaded piece.
	let groupMode = $state<'new' | 'existing'>('new');
	let existingParentId = $state('');

	const isUploading = $derived(tiles.some((t) => t.status === 'uploading'));
	const allUploaded = $derived(tiles.length > 0 && tiles.every((t) => t.status === 'done'));
	const isGroup = $derived(tiles.length > 1 || groupMode === 'existing');

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				resolve({ width: img.naturalWidth, height: img.naturalHeight });
				URL.revokeObjectURL(img.src);
			};
			img.onerror = () => {
				resolve({ width: 0, height: 0 });
				URL.revokeObjectURL(img.src);
			};
			img.src = URL.createObjectURL(file);
		});
	}

	async function uploadOne(tile: Tile, file: File) {
		try {
			const checkRes = await fetch('/api/check-duplicate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileName: file.name, fileSize: file.size })
			});
			if (!checkRes.ok) throw new Error(m.admin_upload_failed_status({ status: checkRes.status }));
			// Same guard as the upload parse below: a non-JSON 2xx must not put a
			// parser's message on the tile.
			let exists: unknown;
			try {
				({ exists } = await checkRes.json());
			} catch {
				throw new Error(m.admin_upload_failed());
			}

			if (exists && !confirm(m.admin_upload_duplicate_confirm({ fileName: file.name }))) {
				// Declined: the tile goes, and so does the preview it was holding.
				if (tile.previewUrl) URL.revokeObjectURL(tile.previewUrl);
				tiles = tiles.filter((t) => t.key !== tile.key);
				return;
			}

			const fd = new FormData();
			fd.append('file', file);
			const uploadRes = await fetch('/api/upload', { method: 'POST', body: fd });
			// 422 is the one failure the operator can act on: the file's metadata
			// could not be stripped, and a re-export fixes it (SONA-170).
			if (!uploadRes.ok) {
				throw new Error(
					uploadRes.status === 422
						? m.admin_upload_error_unscrubbable()
						: m.admin_upload_failed_status({ status: uploadRes.status })
				);
			}
			// A 2xx the form cannot read a url out of is a failure too (same check
			// as the other two forms), not a tile pointing at nothing. That covers
			// a non-JSON body (a proxy interstitial) as well as a JSON one without
			// a usable url; either way the tile gets the localized message, not a
			// parser's.
			let body: { url?: unknown };
			try {
				body = await uploadRes.json();
			} catch {
				throw new Error(m.admin_upload_failed());
			}
			const { url } = body;
			if (typeof url !== 'string' || !url) throw new Error(m.admin_upload_failed());
			tile.url = url;
			tile.status = 'done';
		} catch (e) {
			tile.error = e instanceof Error ? e.message : m.admin_upload_failed();
			tile.status = 'error';
		}
	}

	// `rejected` holds files the accept string refused — from a drop, which the
	// attribute never constrains, or from a picker the operator switched to "All
	// files". They get a tile like an oversized file does (same slot accounting,
	// same way to dismiss) but never a dimension probe or a POST.
	async function handleFiles(files: FileList | File[], rejected: File[] = []) {
		const incoming = [
			...Array.from(files).map((file) => ({ file, badType: false })),
			...rejected.map((file) => ({ file, badType: true }))
		];
		const room = Math.max(0, data.maxVariantSet - tiles.length);
		const fileArray = incoming.slice(0, room);
		const skipped = incoming.length - fileArray.length;
		if (skipped > 0) {
			toast.info(m.admin_upload_over_limit({ count: skipped, max: data.maxVariantSet }));
		}
		if (fileArray.length === 0) return;

		// Pass 1 (synchronous): create a tile for EVERY file before any await, so
		// tiles.length reflects the whole batch at once — `room` above can't
		// over-admit a second drop that lands while this batch is still
		// uploading, and the announcement below counts tiles that really exist.
		const batch: { key: number; file: File }[] = [];
		// Every tile this call creates, in the batch or not: the terminal
		// announcement reports on all of them, so a file refused before the batch
		// opened can't be closed out as a clean finish.
		const created: number[] = [];
		for (const { file, badType } of fileArray) {
			// The two ways a file fails before it is ever sent: a type the server
			// refuses, and a size over the server's cap (which could only come back
			// as a 413, so fail it here instead of firing a doomed POST). One
			// expression drives the status, the message, and the batch below.
			const error = badType
				? m.admin_upload_error_bad_type()
				: file.size > MAX_BUFFER_BYTES
					? m.admin_upload_error_too_large({ max: formatSize(MAX_BUFFER_BYTES) })
					: '';
			const tile: Tile = {
				key: tileKey++,
				fileName: file.name,
				// A refused file gets no object URL. A wrong-type one handed to <img>
				// can only paint the broken-image glyph, and an oversized one would
				// make the browser decode a huge image for a tile that already
				// failed. Both show the resting surface and a file icon instead.
				previewUrl: error ? '' : URL.createObjectURL(file),
				url: '',
				width: 0,
				height: 0,
				fileSize: file.size,
				status: error ? 'error' : 'uploading',
				error,
				label: '',
				nsfw: false,
				// A refused file is never looked up either, so it holds no bytes.
				file: error ? null : file,
				lookup: { kind: 'idle' }
			};
			tiles = [...tiles, tile];
			created.push(tile.key);
			// A failed tile never enters the batch: no dimension probe (pass 2 would
			// decode a >64 MB image for a tile that already failed) and no doomed
			// POST. Its tile keeps 0×0 dims — it can't be saved anyway.
			if (!error) batch.push({ key: tile.key, file });
		}

		// Every file that did not enter the batch is counted, wrong-type or
		// oversized alike, so the opening announcement covers every tile this call
		// created; the mixed case is its own message so each locale can punctuate
		// the two sentences its own way.
		const notUploaded = fileArray.length - batch.length;
		announcer.say(
			batch.length > 0 && notUploaded > 0
				? m.admin_upload_images_added_and_rejected({ added: batch.length, rejected: notUploaded })
				: batch.length > 0
					? m.admin_upload_images_added({ count: batch.length })
					: m.admin_upload_images_rejected({ count: notUploaded })
		);

		// Tiles the batch dropped — a declined duplicate, a removal mid-upload —
		// are simply gone, so only survivors can report an error.
		const createdAnError = () =>
			created.some((key) => tiles.find((t) => t.key === key)?.status === 'error');

		if (batch.length === 0) {
			// Nothing to upload, so no batch opens and no "finished" follows the
			// counts above — but a batch already in flight must not close out clean
			// when this call just put an error tile on the screen.
			if (inFlightBatches > 0 && createdAnError()) batchHadErrors = true;
			return;
		}
		// Pass 2: probe dimensions and upload. Uploads run one at a time WITHIN
		// this batch (matching VrAvatarForm's media flow) so a full batch can't
		// fire eight concurrent POSTs; a second drop mid-batch starts its own
		// loop, so the guarantee is per-invocation, not global. Each tile still
		// shows its own status. Mutate the tile via the `tiles` state proxy
		// (not the pass-1 local) so updates stay reactive.
		inFlightBatches++;
		try {
			for (const { key, file } of batch) {
				const dims = await getImageDimensions(file);
				const tile = tiles.find((t) => t.key === key);
				if (!tile) continue; // removed while the batch was still working
				tile.width = dims.width;
				tile.height = dims.height;
				await uploadOne(tile, file);
			}
		} finally {
			// The per-tile outcome is only visible as an icon or a line of text on
			// the tile, so close the batch out in the live region too (mirroring the
			// VR media flow). EVERY tile this call created counts, not just the
			// uploaded ones — a file refused before the batch opened went wrong too,
			// and calling that "finished" would be a lie.
			if (createdAnError()) batchHadErrors = true;
			inFlightBatches--;
			if (inFlightBatches === 0) {
				announcer.say(batchHadErrors ? m.admin_upload_batch_issues() : m.admin_upload_batch_done());
				batchHadErrors = false;
			}
		}
	}

	function removeTile(key: number) {
		const idx = tiles.findIndex((t) => t.key === key);
		if (idx === -1) return;
		// A wrong-type tile never got an object URL to revoke.
		if (tiles[idx].previewUrl) URL.revokeObjectURL(tiles[idx].previewUrl);
		// A lookup still in flight for this tile has nowhere to land, and its
		// result is discarded with the tile.
		lookupAborts.get(key)?.abort();
		lookupAborts.delete(key);
		// The parent is a tile, not a position: removing anything before it shifts
		// every later tile down one, and parentIndex rides along to the server as
		// the hidden field that picks the parent piece. Left stale, the saved
		// parent would be a different file while the shared artist, date, source
		// URL, and tags still describe the old one.
		const parentKey = tiles[parentIndex]?.key ?? null;
		tiles = tiles.filter((t) => t.key !== key);
		const movedTo = parentKey === null ? -1 : tiles.findIndex((t) => t.key === parentKey);
		if (movedTo !== -1) {
			parentIndex = movedTo;
		} else {
			if (parentIndex >= tiles.length) parentIndex = 0;
			// The parent itself is gone: the shared fields described it, so
			// re-derive them from whichever tile the radio landed on.
			onParentChanged(parentIndex);
		}
	}

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) {
			// `accept` is a filter the OS dialog can override ("All files"), so a
			// picked SVG can arrive here; partition it the same way a drop is.
			const { accepted, rejected } = partitionByAccept([...input.files], GALLERY_ACCEPT);
			handleFiles(accepted, rejected);
			input.value = '';
		}
	}

	function isEditable(el: EventTarget | null): boolean {
		return el instanceof HTMLElement && isTextEditable(el);
	}

	function handlePaste(e: ClipboardEvent) {
		// The New Artist dialog owns the clipboard while open (its name field
		// autofocuses); don't create tiles behind the modal.
		if (showNewArtist) return;
		// A save in flight is already sending these tiles; the drop zone and the
		// picker are disabled for the same reason, so paste can't be the one way in.
		if (saving) return;
		const dt = e.clipboardData;
		if (!dt) return;
		const files = extractImageFiles(dt.items);
		if (
			!shouldHandleImagePaste({
				imageCount: files.length,
				focusInEditable: isEditable(e.target)
			})
		)
			return;
		e.preventDefault();
		// Clipboard images skip the accept filter the same way a drop does — a
		// pasted SVG is a file /api/upload refuses — so partition them too.
		const { accepted, rejected } = partitionByAccept(files, GALLERY_ACCEPT);
		handleFiles(accepted, rejected);
	}

	function onArtistCreated(artist: { id: number; name: string }) {
		artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		// The option values are numbers, and the select binding compares with
		// Object.is — a stringified id would match no option and select nothing.
		selectedArtistId = artist.id;
		appliedArtist = artist;
		showNewArtist = false;
		artistSeed = null;
	}

	// ---- Artist lookup (SONA-156) -------------------------------------------
	// One lookup per tile. The parent tile's result drives the shared fields
	// below the grid; a variant's result only rates that variant, because the
	// shared fields describe the piece and a variant is the same piece.

	// The two shared fields a lookup may fill. Controlled (they were plain
	// uncontrolled inputs) so a result can write them and so an edit can drop the
	// "From lookup" tag.
	let sourcePostUrl = $state('');
	let commissionedAt = $state('');
	let sourceTagged = $state(false);
	let dateTagged = $state(false);
	// What the last shared prefill actually wrote, for the panel's status line.
	// Never edited afterwards: it is the record of what the lookup did, and a
	// field the operator types over stops being attributable through the flags
	// below instead (SONA-156). The tag is that record — it goes up with the
	// prefill and comes off on the first keystroke.
	let sharedFilled = $state<LookupFields>({});
	const sharedEdited = $derived({
		sourcePostUrl: sharedFilled.sourcePostUrl !== undefined && !sourceTagged,
		commissionedAt: sharedFilled.commissionedAt !== undefined && !dateTagged
	});
	// The artist this result put in the select, so "Use X" can read back as
	// "Using X" and revert when the operator changes the select by hand.
	let appliedArtist = $state<{ id: number; name: string } | null>(null);
	// What the New Artist dialog opens prefilled with, when a lookup opened it.
	let artistSeed = $state<{ handle: string; site: LookupSite; linkable: boolean } | null>(null);
	// Per-tile aborts. Not $state — nothing renders them.
	const lookupAborts = new Map<number, AbortController>();
	// Closing or cancelling the panel destroys the button the operator is
	// standing on, so focus has to be moved deliberately first (2.4.3). The
	// origin is the parent tile's own button in a set, the fieldset pill alone.
	let lookupPill = $state<HTMLButtonElement | null>(null);
	let existingParentSelect = $state<HTMLSelectElement | null>(null);
	// $state so `bind:this` into it is a reactive write (Svelte warns otherwise).
	const tileLookupButtons = $state<Record<number, HTMLButtonElement | null>>({});

	const parentTile = $derived(groupMode === 'new' ? (tiles[parentIndex] ?? null) : null);
	const sharedLookup = $derived<LookupState>(parentTile?.lookup ?? { kind: 'idle' });
	const sharedRating = $derived(
		sharedLookup.kind === 'results' ? strictestRating(sharedLookup.data.matches) : null
	);
	const sharedRatingTag = $derived(ratingTag(sharedRating, { parent: tiles.length > 1 }));
	// Private is the checkbox's inverse ("Private" checked = not published), so
	// the warn hint and the panel notice both key off it directly.
	let isPrivate = $state(false);

	function startLookup(key: number) {
		const tile = tiles.find((t) => t.key === key);
		if (!tile || !tile.file || tile.lookup.kind === 'searching') return;
		lookupAborts.get(key)?.abort();
		const controller = new AbortController();
		lookupAborts.set(key, controller);
		tile.lookup = { kind: 'searching' };
		if (isParent(key)) resetSharedPrefill();
		void runLookup({ file: tile.file }, { signal: controller.signal }).then((next) => {
			// Cancelled, or the tile was removed while the request was out.
			if (lookupAborts.get(key) !== controller) return;
			lookupAborts.delete(key);
			const live = tiles.find((t) => t.key === key);
			if (!live) return;
			live.lookup = next;
			if (isParent(key)) applyShared(next);
			// A variant tile's outcome renders as plain text on the tile, outside
			// the panel's live region — say it out loud, naming the file, or a
			// screen-reader user has no way to know the lookup finished (4.1.3).
			else announceTileLookup(live);
		});
	}

	function announceTileLookup(tile: Tile) {
		const fileName = tile.fileName;
		if (tile.lookup.kind === 'failed') {
			announcer.say(m.admin_lookup_announce_tile_failed({ fileName }));
			return;
		}
		const result = tileResult(tile);
		announcer.say(
			result
				? m.admin_lookup_announce_tile_match({ fileName, result: result.spoken })
				: m.admin_lookup_announce_tile_no_match({ fileName })
		);
	}

	function isParent(key: number): boolean {
		return groupMode === 'new' && tiles[parentIndex]?.key === key;
	}

	function cancelLookup(key: number) {
		lookupAborts.get(key)?.abort();
		lookupAborts.delete(key);
		const tile = tiles.find((t) => t.key === key);
		if (tile) tile.lookup = { kind: 'idle' };
	}

	/** Undo what a previous shared prefill wrote, but only where the operator has
	 * not typed over it since — the tag is the record of that. */
	function resetSharedPrefill() {
		if (sourceTagged) sourcePostUrl = '';
		if (dateTagged) commissionedAt = '';
		sourceTagged = false;
		dateTagged = false;
		sharedFilled = {};
		appliedArtist = null;
	}

	function applyShared(next: LookupState) {
		if (next.kind !== 'results') return;
		const fields = prefillForResult(next.data, { sourcePostUrl, commissionedAt });
		sharedFilled = fields;
		if (fields.sourcePostUrl !== undefined) {
			sourcePostUrl = fields.sourcePostUrl;
			sourceTagged = true;
		}
		if (fields.commissionedAt !== undefined) {
			commissionedAt = fields.commissionedAt;
			dateTagged = true;
		}
	}

	/** The parent moved: the shared fields describe whatever the parent is now. */
	function onParentChanged(index: number) {
		parentIndex = index;
		resetSharedPrefill();
		const tile = tiles[parentIndex];
		if (tile) applyShared(tile.lookup);
	}

	function useLookupArtist(artist: { id: number; name: string }) {
		// The option values are numbers, and the select binding compares with
		// Object.is — a stringified id would match no option and select nothing.
		selectedArtistId = artist.id;
		appliedArtist = artist;
		// The select sits above the panel and the button relabels itself in place,
		// so nothing else tells a screen-reader user the artist was applied.
		announcer.say(m.admin_lookup_announce_using({ name: artist.name }));
	}

	function openLookupDialog(seed: { handle: string; site: LookupSite; linkable: boolean }) {
		// The no_match action carries no handle: that is a plain "Add New Artist",
		// with nothing for the dialog's guess disclosure to be about.
		artistSeed = seed.handle ? seed : null;
		showNewArtist = true;
	}

	async function addAsVariant(clash: SourceClash) {
		// Reset the tile's lookup FIRST: closeSharedLookup reaches the tile through
		// parentTile, which is null the moment the mode is no longer 'new', and a
		// clash panel left behind resurfaces on the way back to a new group.
		closeSharedLookup({ focus: false });
		groupMode = 'existing';
		existingParentId = String(clash.imageId);
		// This click unmounts both the panel and the fieldset pill, so the landing
		// spot is the select it just populated.
		await tick();
		existingParentSelect?.focus();
	}

	/** The control a shared lookup was started from — where focus goes back to
	 * when the panel it opened is closed or cancelled (2.4.3). */
	function focusLookupOrigin() {
		const tile = parentTile;
		const button = tile ? tileLookupButtons[tile.key] : null;
		(button ?? lookupPill)?.focus();
	}

	function closeSharedLookup(options: { focus?: boolean } = {}) {
		const tile = parentTile;
		if (tile) tile.lookup = { kind: 'idle' };
		if (options.focus !== false) focusLookupOrigin();
	}

	/** A variant tile whose confident match names a different local artist than
	 * the shared one — worth flagging rather than silently rating. Returns the
	 * match whose local-artist hit triggered it, because that is the poster the
	 * line names: the candidates are unioned across every confident match, so
	 * the trigger is not necessarily the prefill match. */
	function differentArtistMatch(tile: Tile): LookupMatch | null {
		if (tile.lookup.kind !== 'results') return null;
		// The shared SELECTION, not just a panel-applied one: appliedArtist is set
		// by the panel's Use button and by a created artist, so keying off it meant
		// an artist the operator picked from the select by hand never warned.
		// Number('') is 0, which is the unselected case.
		const sharedId = Number(selectedArtistId);
		if (!sharedId) return null;
		const data = tile.lookup.data;
		const own = candidateArtists(data);
		if (own.length === 0 || own.some((a) => a.id === sharedId)) return null;
		return (
			data.matches.find(
				(match, index) =>
					(match.band === 'exact' || match.band === 'strong') &&
					data.localArtists.some((hit) => hit.matchIndex === index && hit.artists.length > 0)
			) ?? null
		);
	}

	/** Everything a variant tile shows from its own result. One guard and one
	 * match fallback (the closest confident match, else the first row) rather
	 * than the same pair re-derived per field. Null when there is nothing to
	 * show. */
	function tileResult(tile: Tile) {
		if (tile.lookup.kind !== 'results') return null;
		const matches = tile.lookup.data.matches;
		const match = pickPrefillMatch(matches) ?? matches[0];
		if (!match) return null;
		// No fallback to the file name: a match that names no handle is an unknown
		// poster, and tileResultText says so.
		const handle = matchHandle(match);
		// The different-artist line names the poster whose local artist triggered
		// it, which is not always the match the rest of the tile reads from.
		const differentMatch = differentArtistMatch(tile);
		const different = differentMatch !== null;
		// The visible line and the spoken one come from the same parts, so the
		// middle dot never reaches the live region and never dangles. The
		// different-artist line carries no band, so it reads the same either way.
		const differentHandle = differentMatch ? matchHandle(differentMatch) : '';
		const differentSite = siteLabel(differentMatch ? differentMatch.site : match.site);
		const differentLine = differentHandle
			? m.admin_lookup_tile_different({ handle: differentHandle, site: differentSite })
			: m.admin_lookup_tile_different_unknown({ site: differentSite });
		const text = different
			? { line: differentLine, spoken: differentLine }
			: tileResultText(handle, match.site, match.band);
		return {
			different,
			line: text.line,
			spoken: text.spoken,
			postUrl: match.postUrl,
			site: match.site,
			ratingTag: ratingTag(strictestRating(matches))
		};
	}
</script>

<svelte:window onpaste={handlePaste} ondragover={swallowStrayFileDrop} ondrop={swallowStrayFileDrop} />

<LiveAnnouncer {announcer} />

<div class="page-header">
	<h1>{m.admin_upload_title()}</h1>
</div>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

<form method="POST" use:enhance={() => {
	saving = true;
	return async ({ update }) => {
		await update();
		saving = false;
	};
}} class="upload-form">
	<input type="hidden" name="count" value={tiles.length} />
	{#if groupMode === 'new'}
		<input type="hidden" name="parentIndex" value={parentIndex} />
	{:else}
		<input type="hidden" name="existingParentId" value={existingParentId} />
	{/if}
	{#each tiles as tile, i (tile.key)}
		<input type="hidden" name="imageUrl_{i}" value={tile.url} />
		<input type="hidden" name="width_{i}" value={tile.width} />
		<input type="hidden" name="height_{i}" value={tile.height} />
		<input type="hidden" name="fileSize_{i}" value={tile.fileSize} />
	{/each}

	{#if tiles.length === 0}
		<div
			class="dropzone"
			class:disabled={saving}
			{@attach dropFiles({ accept: GALLERY_ACCEPT, onFiles: handleFiles, disabled: () => saving })}
			onclick={() => { if (!saving) fileInput?.click(); }}
			role="button"
			tabindex="0"
			aria-disabled={saving}
			onkeydown={(e) => {
				if (saving) return;
				if (e.key === 'Enter' || e.key === ' ') {
					// Space on a role="button" scrolls the page unless it's cancelled.
					if (e.key === ' ') e.preventDefault();
					fileInput?.click();
				}
			}}
		>
			<CloudUpload size={40} />
			<p>{m.admin_upload_dropzone_multi({ max: data.maxVariantSet })}</p>
			<p class="dropzone-hint">{m.admin_upload_formats()}</p>
		</div>
	{:else}
		<div
			class="tile-grid"
			{@attach dropFiles({
				accept: GALLERY_ACCEPT,
				onFiles: handleFiles,
				disabled: () => saving,
				// This zone wraps the variant label inputs, so a text drag has to
				// reach them instead of being cancelled on the way.
				passThroughNonFileDrags: true
			})}
		>
			{#each tiles as tile, i (tile.key)}
				<div class="tile" class:tile-error={tile.status === 'error'} class:tile-parent={isGroup && groupMode === 'new' && parentIndex === i}>
					<div class="tile-preview">
						{#if tile.previewUrl}
							<img src={tile.previewUrl} alt={tile.fileName} />
						{:else}
							<!-- A refused file has no preview to show; the icon stands in
							     for it and carries the file name the img alt used to. -->
							<div class="tile-placeholder" role="img" aria-label={tile.fileName}>
								<FileBox size={36} />
							</div>
						{/if}
						<div class="tile-status">
							{#if tile.status === 'uploading'}
								<Loader2 size={16} class="spin" />
							{:else if tile.status === 'done'}
								<Check size={16} />
							{:else}
								<!-- .error-text only tunes its wrapping — the status band already
								     supplies the color; the class doubles as a test hook. -->
								<span class="error-text">{tile.error}</span>
							{/if}
						</div>
						<button type="button" class="tile-remove" aria-label={m.admin_variant_remove_file()} onclick={() => removeTile(tile.key)}>
							<X size={14} />
						</button>
					</div>
					<div class="tile-meta">{tile.width} x {tile.height} &bull; {formatSize(tile.fileSize)}</div>
					{#if data.lookupEnabled && isGroup && tile.status === 'done'}
						<!-- One lookup per tile: the parent's result fills the shared
						     fields, a variant's only rates that variant. The file name
						     rides in the accessible name so a screen reader can tell the
						     grid's buttons apart. -->
						<button
							type="button"
							class="tile-lookup"
							bind:this={tileLookupButtons[tile.key]}
							aria-busy={tile.lookup.kind === 'searching'}
							aria-describedby="lookup-hint"
							onclick={() => startLookup(tile.key)}
						>
							<Search size={12} aria-hidden="true" />
							{#if tile.lookup.kind === 'searching'}{m.admin_lookup_tile_searching()}
							{:else if tile.lookup.kind === 'results' || tile.lookup.kind === 'no_match'}{m.admin_lookup_tile_done()}
							{:else if tile.lookup.kind === 'failed'}{m.admin_lookup_tile_failed()}
							{:else}{m.admin_lookup_button()}{/if}
							<span class="sr-only">{m.admin_lookup_button_for({ fileName: tile.fileName })}</span>
						</button>
					{/if}
					{#if isGroup}
						{#if groupMode === 'new'}
							<label class="tile-parent-pick">
								<input
									type="radio"
									name="parentPick"
									checked={parentIndex === i}
									aria-label={m.admin_lookup_parent_radio({ fileName: tile.fileName })}
									onchange={() => onParentChanged(i)}
								/>
								<span>{m.admin_variant_parent_radio()}</span>
							</label>
						{/if}
						{#if groupMode === 'existing' || parentIndex !== i}
							{@const result = tileResult(tile)}
							{#if result}
								<p class="tile-result" class:tile-result-warn={result.different}>{result.line}</p>
								<a class="tile-post-link" href={result.postUrl} target="_blank" rel="noopener noreferrer">
									{m.admin_lookup_view_post()}<span class="sr-only"
										>{m.admin_lookup_view_post_site({ site: siteLabel(result.site) })}</span
									>
								</a>
							{/if}
							<!-- The file went to FuzzySearch while the shared Private box was
							     checked: say so on the tile the way the panel says it for the
							     parent. -->
							{#if isPrivate && lookupSentFile(tile.lookup)}
								<p class="tile-private-notice">{m.admin_lookup_private_notice()}</p>
							{/if}
							<input
								type="text"
								class="input tile-label"
								name="label_{i}"
								placeholder={m.admin_variant_label_placeholder()}
								bind:value={tile.label}
							/>
							{@const tileTag = result?.ratingTag ?? null}
							<!-- The pill is a SIBLING of the label, not inside it: inside, it
							     would join the checkbox's accessible name and a click on it
							     would toggle the box (SONA-220). -->
							<div class="tile-nsfw-row">
								<label class="tile-nsfw">
									<input
										type="checkbox"
										name="nsfw_{i}"
										bind:checked={tile.nsfw}
										aria-describedby={tileTag ? `tile-rating-${tile.key}` : undefined}
									/>
									<span
										>{m.admin_field_mark_nsfw()}<span class="sr-only"
											>{m.admin_lookup_nsfw_for_file({ fileName: tile.fileName })}</span
										></span
									>
								</label>
								{#if tileTag}
									<span class="rating-tag" id="tile-rating-{tile.key}">{tileTag}</span>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			{/each}
			{#if tiles.length < data.maxVariantSet}
				<!-- aria-disabled rather than `disabled`, matching the dropzone: a
				     native disabled button loses focus the moment the save starts,
				     dropping the keyboard user back on <body>. The click guard is what
				     actually refuses. -->
				<button type="button" class="tile tile-add" aria-disabled={saving} onclick={() => { if (!saving) fileInput?.click(); }}>
					<Plus size={20} />
					<span>{m.admin_variant_add_files()}</span>
				</button>
			{/if}
		</div>
	{/if}

	<input
		type="file"
		accept={GALLERY_ACCEPT}
		multiple
		bind:this={fileInput}
		onchange={handleFileSelect}
		disabled={saving}
		style="display: none"
	/>

	{#if tiles.length > 0}
		<fieldset class="group-section">
			<legend>{m.admin_variant_group_legend()}</legend>
			<label class="radio-label">
				<input type="radio" checked={groupMode === 'new'} onchange={() => (groupMode = 'new')} />
				<span>{tiles.length > 1 ? m.admin_variant_group_new() : m.admin_variant_group_single()}</span>
			</label>
			<label class="radio-label">
				<input type="radio" checked={groupMode === 'existing'} onchange={() => (groupMode = 'existing')} />
				<span>{m.admin_variant_group_existing()}</span>
			</label>
			{#if groupMode === 'existing'}
				<select class="input" bind:this={existingParentSelect} bind:value={existingParentId} required>
					<option value="">{m.admin_variant_pick_parent()}</option>
					{#each data.parentCandidates as candidate}
						<option value={String(candidate.id)}>{candidate.title}</option>
					{/each}
				</select>
			{/if}
		</fieldset>
	{/if}

	<h2>{m.admin_upload_image_details()}</h2>

	{#if groupMode === 'new'}
		<label>
			<span>{m.admin_field_title()}</span>
			<input type="text" class="input" placeholder={m.admin_upload_title_placeholder()} name="title" required />
			{#if tiles.length > 1}
				<small class="hint">{m.admin_variant_title_hint()}</small>
			{/if}
		</label>
	{/if}

	<fieldset class="artist-section">
		<legend>{m.admin_field_artist()}</legend>
		<label>
			<span>{m.admin_field_artist()}</span>
			<select
				class="input"
				name="artistId"
				bind:value={selectedArtistId}
				onchange={() => (appliedArtist = null)}
				required
			>
				<option value="">{m.admin_upload_select_artist()}</option>
				{#each artistList as artist}
					<option value={artist.id}>{artist.name}</option>
				{/each}
			</select>
		</label>
		<div class="artist-actions">
			{#if data.lookupEnabled && !isGroup && tiles.length === 1 && tiles[0].status === 'done'}
				<button
					type="button"
					class="lookup-pill"
					bind:this={lookupPill}
					aria-describedby="lookup-hint"
					aria-disabled={sharedLookup.kind === 'searching'}
					onclick={() => startLookup(tiles[0].key)}
				>
					<Search size={14} aria-hidden="true" /> {m.admin_lookup_button()}
				</button>
			{/if}
			<button type="button" class="add-artist-btn" onclick={() => { artistSeed = null; showNewArtist = true; }}>
				<Plus size={14} /> {m.admin_upload_add_new_artist()}
			</button>
		</div>
		{#if data.lookupEnabled}
			<small class="hint" class:hint-warn={isPrivate} id="lookup-hint">
				{#if isGroup && isPrivate}{m.admin_lookup_hint_multi_private()}
				{:else if isGroup}{m.admin_lookup_hint_multi()}
				{:else if isPrivate}{m.admin_lookup_hint_private()}
				{:else}{m.admin_lookup_hint()}{/if}
			</small>
		{:else}
			<small class="hint" id="lookup-hint">
				{m.admin_lookup_no_key_pre()}<a class="link" href="/admin/settings?tab=connections"
					>{m.admin_lookup_no_key_link()}</a
				>{m.admin_lookup_no_key_post()}
			</small>
		{/if}
		{#if data.lookupEnabled && groupMode === 'new'}
			<ArtistLookupPanel
				lookup={sharedLookup}
				fileName={tiles.length > 1 ? (parentTile?.fileName ?? '') : ''}
				filled={sharedFilled}
				edited={sharedEdited}
				{appliedArtist}
				privateNotice={isPrivate && lookupSentFile(sharedLookup)}
				onclose={closeSharedLookup}
				onretry={() => parentTile && startLookup(parentTile.key)}
				oncancel={() => {
					if (parentTile) cancelLookup(parentTile.key);
					// Cancel destroys itself; land back on the control that started it.
					focusLookupOrigin();
				}}
				onuseartist={useLookupArtist}
				onaddnew={openLookupDialog}
				onaddvariant={addAsVariant}
			/>
		{/if}
	</fieldset>

	<div class="row">
		<label class="flex-1">
			<span>{m.admin_field_collection()}</span>
			<select class="input" name="collectionId">
				<option value="">{m.admin_upload_no_collection()}</option>
				{#each data.collections as collection}
					<option value={collection.id}>{collection.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex-1">
			<span>{m.admin_field_tags()}</span>
			<input type="text" class="input" placeholder={m.admin_upload_tags_placeholder()} name="tags" />
			{#if data.tags.length > 0}
				<small class="hint">{m.admin_upload_existing_tags({ tags: data.tags.map((t) => t.name).join(', ') })}</small>
			{/if}
		</label>
	</div>

	{#if data.characters.length > 0}
		<div class="field">
			<span class="field-label">{m.gallery_featured_characters()}</span>
			<div class="character-chips">
				{#each data.characters as char}
					<label class="chip">
						<input type="checkbox" name="char-{char.id}" onchange={(e) => {
							const el = document.querySelector('input[name="characters"]') as HTMLInputElement;
							const current = new Set(el.value.split(',').filter(Boolean));
							if (e.currentTarget.checked) current.add(String(char.id));
							else current.delete(String(char.id));
							el.value = Array.from(current).join(',');
						}} />
						<span>{char.name}</span>
						{#if char.ownerName}<span class="chip-owner">({char.ownerName})</span>{/if}
					</label>
				{/each}
			</div>
			<input type="hidden" name="characters" value="" />
		</div>
	{/if}

	<!-- The label wraps only its own text; the "From lookup" pill sits after it
	     as a sibling and is referenced with aria-describedby, so the input's
	     accessible name stays the field name (SONA-220). -->
	<div class="field">
		<div class="label-row">
			<label class="field-label" for="commissionedAt">{m.admin_field_commissioned_date()}</label>
			{#if dateTagged}
				<span class="lookup-tag" id="commissioned-lookup-tag">{m.admin_lookup_from_lookup()}</span>
			{/if}
		</div>
		<input
			id="commissionedAt"
			type="date"
			class="input"
			name="commissionedAt"
			bind:value={commissionedAt}
			oninput={() => {
				// The panel's status line reads the filled record through this tag: a
				// field typed over stops being the lookup's, and the sentence then
				// neither claims it nor says it was left alone.
				dateTagged = false;
			}}
			aria-describedby={dateTagged ? 'commissioned-lookup-tag' : undefined}
		/>
		<small class="hint">{m.admin_hint_commissioned_date()}</small>
	</div>

	<div class="nsfw-row">
		<label class="checkbox-label">
			<input
				type="checkbox"
				name="nsfw"
				aria-describedby={sharedRatingTag ? 'shared-rating-tag' : undefined}
			/>
			<span
				>{m.admin_field_mark_nsfw()}{#if tiles.length > 1}<span class="sr-only"
						>{m.admin_lookup_nsfw_for_parent()}</span
					>{/if}</span
			>
		</label>
		<!-- Never checked by a lookup: the rating is what the sites said, and the
		     call about this gallery stays the operator's. -->
		{#if sharedRatingTag}
			<span class="rating-tag" id="shared-rating-tag">{sharedRatingTag}</span>
		{/if}
	</div>

	<label class="checkbox-label">
		<input type="checkbox" name="published" bind:checked={isPrivate} />
		<span>{m.admin_field_private()} <span class="checkbox-helper">{m.admin_field_private_hint()}</span></span>
	</label>

	{#if data.ownerCharacter}
		<label class="checkbox-label">
			<input type="checkbox" name="useAsReference" />
			<span>{m.admin_image_reference_set({ name: data.ownerCharacter.name })}{#if data.ownerCharacter.hasReference} <span class="checkbox-helper">{m.admin_image_reference_replaces()}</span>{/if}</span>
		</label>
	{/if}

	<div class="field">
		<div class="label-row">
			<label class="field-label" for="sourcePostUrl">{m.admin_field_source_url()}</label>
			{#if sourceTagged}
				<span class="lookup-tag" id="source-lookup-tag">{m.admin_lookup_from_lookup()}</span>
			{/if}
		</div>
		<input
			id="sourcePostUrl"
			type="url"
			class="input"
			placeholder={m.admin_upload_source_placeholder()}
			name="sourcePostUrl"
			bind:value={sourcePostUrl}
			oninput={() => {
				sourceTagged = false;
			}}
			aria-describedby={sourceTagged ? 'source-lookup-tag' : undefined}
		/>
	</div>

	<div class="form-actions">
		<a href="/admin/images" class="btn btn-secondary">{m.admin_cancel()}</a>
		<button type="submit" class="btn btn-primary" disabled={!allUploaded || isUploading || saving}>
			{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}{m.admin_upload_submit()}{/if}
		</button>
	</div>
</form>

{#if showNewArtist}
	<NewArtistDialog
		registryEnabled={data.registryEnabled}
		initialName={artistSeed?.handle ?? ''}
		initialSocials={artistSeed && artistSeed.linkable
			? {
					[artistSeed.site === 'Twitter' ? 'twitter' : 'furaffinity']:
						profileUrlFor(artistSeed.site, artistSeed.handle) ?? ''
				}
			: undefined}
		prefillSource={artistSeed ? 'lookup' : undefined}
		prefillSite={artistSeed && artistSeed.linkable ? siteLabel(artistSeed.site) : ''}
		oncreated={onArtistCreated}
		oncancel={() => { showNewArtist = false; artistSeed = null; }}
	/>
{/if}

<style>

	.page-header {
		margin-bottom: 24px;
	}

	h1 {
		font-size: 24px;
	}

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.upload-form {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 800px;
	}

	.upload-form h2 {
		font-size: 18px;
	}

	.dropzone {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 48px;
		border: 2px dashed var(--border);
		border-radius: var(--radius-s);
		text-align: center;
		color: var(--muted-foreground);
		font-size: 14px;
		cursor: pointer;
		transition: border-color 0.15s, background-color 0.15s;
	}

	.dropzone:hover {
		border-color: var(--primary);
		background-color: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	/* Highlight while a file is dragged over the zone (SONA-216) — :global
	   because the drop attachment sets the class imperatively, so Svelte can't
	   see it in the markup. Same treatment as the VR and sticker zones. */
	.dropzone:global(.drag-over) {
		border-color: var(--primary);
		background-color: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	/* No pointer-events: none — the attachment has to receive dragover/drop to
	   preventDefault, or a drop while the save is in flight navigates away from
	   the form. The zone only shows this state when every tile was removed
	   after submitting; it still refuses the drop either way. */
	.dropzone.disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	/* Keeping pointer events also keeps :hover alive, so hold the resting look
	   while the zone is busy rather than inviting a click it won't take. */
	.dropzone.disabled:hover {
		border-color: var(--border);
		background-color: transparent;
	}

	.tile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 12px;
		/* A transparent resting border reserves the space the drag-over highlight
		   paints into, so dragging over the grid doesn't shift the tiles. */
		border: 2px dashed transparent;
		border-radius: var(--radius-s);
		transition: border-color 0.15s, background-color 0.15s;
	}

	.tile-grid:global(.drag-over) {
		border-color: var(--primary);
		background-color: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	/* While the whole grid is the drop target, the add tile's own dashed border
	   sits 12px inside the grid's and reads as a second, competing zone. */
	.tile-grid:global(.drag-over) .tile-add {
		border-color: transparent;
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--card);
	}

	.tile-parent {
		border-color: var(--primary);
	}

	.tile-error {
		border-color: var(--destructive);
	}

	/* The two error bands are tinted differently (a placeholder tile mixes in
	   --destructive, an image tile keeps the black band for contrast over
	   artwork), so give both the same destructive edge to read as one treatment. */
	.tile-error .tile-status {
		border-top: 2px solid var(--destructive);
	}

	.tile-preview {
		position: relative;
		aspect-ratio: 1;
		border-radius: var(--radius-xs);
		overflow: hidden;
		background: var(--secondary);
	}

	/* A placeholder tile has no picture for the band to sit over, and its error
	   line runs to four lines in ja — as an overlay the band covered the icon.
	   Stack the two in normal flow instead, so the band takes the height it needs
	   and the icon keeps what's left. Scoped by :has() so an <img> tile is
	   untouched: there the band still floats over the picture. */
	.tile-preview:has(.tile-placeholder) {
		display: flex;
		flex-direction: column;
	}

	/* The band is also tinted toward --destructive here so the failure reads
	   without parsing the text. Only here: the backdrop is the known tile
	   surface, where white on this mix measures 6.3:1 to 7.4:1 across the six
	   themes. Over an image preview the backdrop is the artwork, and on a white
	   one the same mix falls to 4.2:1 — under AA, and worse than the plain black
	   band's 5.7:1 — so image tiles keep the black band. */
	.tile-preview:has(.tile-placeholder) .tile-status {
		position: static;
		margin-top: auto;
		background: color-mix(in srgb, var(--destructive) 55%, rgba(0, 0, 0, 0.6));
	}

	.tile-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* Stand-in for a refused file, which gets no object URL to preview. Takes the
	   height the band above leaves rather than the whole preview box. */
	.tile-placeholder {
		display: flex;
		flex: 1;
		min-height: 0;
		align-items: center;
		justify-content: center;
		width: 100%;
		color: var(--muted-foreground);
	}

	.tile-status {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 4px;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		font-size: 11px;
	}

	/* Error text wraps to several lines in a narrow tile; even it out rather than
	   leaving a one-word last line. */
	.error-text {
		text-wrap: pretty;
	}

	.tile-remove {
		position: absolute;
		top: 6px;
		right: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		border-radius: var(--radius-pill);
		background: rgba(0, 0, 0, 0.6);
		color: white;
		cursor: pointer;
	}

	.tile-remove:hover {
		background: var(--destructive);
		color: var(--destructive-foreground);
	}

	.tile-meta {
		font-size: 11px;
		color: var(--muted-foreground);
		word-break: break-all;
	}

	.tile-parent-pick,
	.tile-nsfw {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted-foreground);
		cursor: pointer;
	}

	.tile-parent-pick input,
	.tile-nsfw input {
		width: 14px;
		height: 14px;
	}

	.tile-parent .tile-parent-pick {
		color: var(--primary);
		font-weight: 500;
	}

	.tile-label {
		font-size: 12px;
		padding: 6px 8px;
	}

	.tile-add {
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 160px;
		border-style: dashed;
		background: none;
		color: var(--muted-foreground);
		font-size: 13px;
		font-family: var(--font-primary);
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
	}

	.tile-add:hover {
		border-color: var(--primary);
		color: var(--primary);
	}

	/* Mirrors .dropzone.disabled — the other way into the picker has to read as
	   unavailable while the save is in flight, not just refuse the click. */
	.tile-add[aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}

	/* aria-disabled leaves the button hoverable, so undo exactly what :hover
	   above sets and hold the resting look. */
	.tile-add[aria-disabled='true']:hover {
		border-color: var(--border);
		color: var(--muted-foreground);
	}

	.group-section {
		gap: 10px;
	}

	.radio-label {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		cursor: pointer;
	}

	.radio-label input {
		width: 15px;
		height: 15px;
	}

	.dropzone-hint {
		font-size: 12px;
		color: var(--muted-foreground);
		word-break: break-all;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label > span {
		font-size: 14px;
		font-weight: 500;
	}

	.hint {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	legend {
		font-size: 14px;
		font-weight: 500;
		padding: 0 8px;
	}

	.add-artist-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: none;
		color: var(--foreground);
		font-size: 13px;
		font-family: var(--font-primary);
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
	}

	.add-artist-btn:hover {
		border-color: var(--primary);
		color: var(--primary);
	}

	.row {
		display: flex;
		gap: 16px;
	}

	.flex-1 {
		flex: 1;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* Artist lookup (SONA-156) */
	.artist-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}

	.lookup-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--foreground);
		font-size: 13px;
		font-family: inherit;
		cursor: pointer;
	}

	/* aria-disabled, not `disabled`: a keyboard user mid-lookup keeps the focus
	   they had. The click guard in startLookup is what actually refuses. The
	   fill is --secondary, so the text is --foreground: the --muted-foreground
	   pairing measures 3.96:1 in terracotta light (SONA-124 found the same). */
	.lookup-pill[aria-disabled='true'] {
		background: var(--secondary);
		color: var(--foreground);
		cursor: default;
	}

	/* Neither pill is a .btn, so app.css's focus ring doesn't reach them. */
	.lookup-pill:focus-visible,
	.tile-lookup:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.hint-warn {
		color: var(--status-warn);
	}

	.tile-lookup {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--link);
		font-size: 12px;
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}

	.tile-result {
		font-size: 12px;
		color: var(--muted-foreground);
		margin: 0;
		line-height: 1.4;
	}

	.tile-result-warn {
		color: var(--status-warn);
	}

	.tile-post-link {
		font-size: 12px;
		color: var(--link);
	}

	.tile-private-notice {
		font-size: 12px;
		color: var(--status-warn);
		margin: 0;
		line-height: 1.4;
	}

	.label-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.lookup-tag {
		font-family: var(--font-primary);
		font-size: 11px;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		padding: 1px 8px;
		white-space: nowrap;
	}

	/* The rating never changes the checkbox — it reports what the sites said and
	   sits beside it. nowrap so the sentence stays one unit, and the row wraps
	   the whole pill to its own line when it no longer fits. */
	.nsfw-row,
	.tile-nsfw-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	/* A grid child's default min-width is its content, so a long pill would
	   push the tile — and the document — wider than the viewport. */
	.tile-nsfw-row {
		min-width: 0;
	}

	.rating-tag {
		font-family: var(--font-primary);
		font-size: 11px;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		padding: 1px 8px;
		white-space: nowrap;
		max-width: 100%;
	}

	/* The tile is ~170px wide and the text grows with the number of sites, so
	   the pill wraps inside the tile rather than spilling out of it. */
	.tile-nsfw-row .rating-tag {
		white-space: normal;
		overflow-wrap: anywhere;
	}

	/* Same story for the shared row once the column itself is narrow: one line
	   of pill is worth less than a page that doesn't scroll sideways. */
	@media (max-width: 480px) {
		.rating-tag {
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}

	.field-label {
		font-size: 14px;
		font-weight: 500;
	}

	.character-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.chip {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		font-size: 13px;
		cursor: pointer;
		transition: background 0.15s;
	}

	.chip:has(input:checked) {
		background: var(--primary);
		color: var(--primary-foreground);
	}

	.chip input {
		display: none;
	}

	.chip-owner {
		color: var(--muted-foreground);
		font-size: 11px;
	}

	.chip:has(input:checked) .chip-owner {
		color: var(--primary-foreground);
		opacity: 0.7;
	}

	.checkbox-label {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}

	.checkbox-label input {
		width: 16px;
		height: 16px;
	}

	.checkbox-helper {
		color: var(--muted-foreground);
		font-size: 12px;
		margin-left: 4px;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding-top: 8px;
	}

	.form-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 768px) {
		.page-header {
			display: none;
		}

		.dropzone {
			padding: 32px 16px;
		}

		.tile-grid {
			grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		}

		.row {
			flex-direction: column;
		}

		.form-actions {
			flex-direction: column-reverse;
		}

		.form-actions .btn {
			width: 100%;
		}
	}
</style>
