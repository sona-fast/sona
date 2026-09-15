<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import { CloudUpload, Check, FileBox, Loader2, Plus, Search, X } from 'lucide-svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import TagSuggestions from '$lib/components/TagSuggestions.svelte';
	import TagRatingNote from '$lib/components/TagRatingNote.svelte';
	import ArtistLookupPanel from '$lib/components/ArtistLookupPanel.svelte';
	import LiveAnnouncer from '$lib/components/LiveAnnouncer.svelte';
	import { Announcer } from '$lib/live-announcer.svelte';
	import {
		LOOKUP_RESULT_THREW,
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
		sentAfterApplyThrew,
		withCreatedArtist,
		type LookupFailReason,
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
	import type { EntailRating } from '$lib/tag-suggestions';
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

	// The Tags field is bound so the suggestion control can write accepted tags
	// back into it; it still submits through its own name attribute, unchanged.
	// The Source Post URL the control reads is the lookup's own binding, declared
	// with the rest of the shared fields below.
	let tagsValue = $state('');
	// Set by the suggestion control while its hint is refusing this URL, so a
	// screen reader user who tabs to the field finds the refusal on it.
	let sourceDescribedBy = $state<string | undefined>(undefined);
	// entail.dev's rating for the last suggestion, shown beside the NSFW box. A
	// suggestion never checks that box; `nsfw` only moves when the operator does.
	let suggestedRating = $state<EntailRating | null>(null);
	let nsfw = $state(false);
	let nsfwInput = $state<HTMLInputElement | null>(null);

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
		// What the Private box read when this tile's request fired. The notice
		// describes a send that already happened, so reading the box live let a
		// tick made afterwards claim a file that went out published, and an untick
		// hide a true notice about a private one.
		sentPrivate: boolean;
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
	// Parent options the page did not load with, added by "Add as a variant" for a
	// clash piece that postdates this page. Same shape as data.parentCandidates.
	let extraParents = $state<{ id: number; title: string }[]>([]);
	const parentOptions = $derived([...data.parentCandidates, ...extraParents]);

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
				// Declined: the tile goes the same way the Remove button sends it.
				// Filtering the array by hand skipped the parent bookkeeping —
				// parentIndex kept pointing past the end, the shared panel went quiet,
				// and the save action dereferenced a tile that was no longer there.
				removeTile(tile.key);
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
				lookup: { kind: 'idle' },
				sentPrivate: false
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
		// Both focus-target records are keyed by tile as well, and a key is never
		// reused, so an entry for a removed tile is dead weight nothing can read
		// again. Dropped after the flush that unmounts the tile, not here:
		// Svelte writes null back into a bind:this slot when its element goes, so
		// a delete now is undone a moment later and the record still grows one
		// dead entry per removed tile.
		void tick().then(() => {
			delete tileLookupButtons[key];
			delete tileRemoveButtons[key];
		});
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
			// re-derive them from whichever tile the radio landed on. Only in the
			// new-set mode, where a tile really is the parent. In 'existing' no
			// tile owns the shared fields and the panel is not even rendered, so
			// re-deriving would clear a lookup-tagged source URL and date that
			// survived the flip out of 'new' and write nothing back, erasing them
			// with none of the announcement returnToNewSet makes. The flip back
			// to 'new' goes through returnToNewSet, which re-derives them there.
			if (groupMode !== 'existing') onParentChanged(parentIndex);
		}
	}

	/** Remove driven from the tile's own button, which the removal destroys.
	 * Focus lands on the Remove button of the tile that slid into its place, else
	 * the one before it, else the dropzone the empty grid leaves behind (2.4.3).
	 * The declined-duplicate path calls removeTile directly: focus is on the file
	 * input or the dropzone there, and neither goes away. */
	async function removeTileFromButton(key: number) {
		const idx = tiles.findIndex((t) => t.key === key);
		if (idx === -1) return;
		removeTile(key);
		await tick();
		const neighbour = tiles[idx] ?? tiles[idx - 1] ?? null;
		(neighbour ? tileRemoveButtons[neighbour.key] : dropzone)?.focus();
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

	async function onArtistCreated(artist: { id: number; name: string }) {
		// Which button opened the dialog, captured before the seed is cleared
		// below. The panel's "Add {handle} as a new artist" seeds it; the
		// standalone "+ Add New Artist" button above the panel does not, and an
		// artist created from that one has nothing to do with the match on screen
		// — credited to it, the panel would claim the handle "is already in your
		// artist list as <unrelated name>" and drop the real add-new action.
		const fromLookup = artistSeed !== null;
		// The tile the seed came from, also captured before the clear below.
		const seedKey = artistSeed?.tileKey ?? null;
		artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		// The option values are numbers, and the select binding compares with
		// Object.is — a stringified id would match no option and select nothing.
		selectedArtistId = artist.id;
		appliedArtist = artist;
		showNewArtist = false;
		artistSeed = null;
		// The result now names a local artist, so the panel stops offering to add
		// one. Left alone it would still read "Add {handle} as a new artist", and a
		// second click would create the same artist again.
		// The seed's own tile, not whichever one is parent now: with no focus trap
		// on the dialog, the Parent radio can be moved while it is open, and
		// folding into the new parent would credit an unrelated result while
		// leaving the seed's tile still offering to add the artist.
		const tile = seedKey === null ? null : (tiles.find((t) => t.key === seedKey) ?? null);
		if (!fromLookup || !tile || tile.lookup.kind !== 'results') {
			// That tile can also be removed while the dialog is open, taking the
			// button the dialog would have restored focus to with it (2.4.3). The
			// tile surviving is not enough either: a lookup cancelled back to idle
			// or retried into searching unmounts the same add-new button, so the
			// opener is gone there too and focus falls to <body> with the next Tab
			// restarting at the top of the page. There is nothing to fold in either
			// case; land on the tile's own lookup button while it exists, else on
			// the select holding the new artist.
			if (fromLookup) {
				await tick();
				const button = tile ? tileLookupButtons[tile.key] : null;
				(button ?? artistSelect)?.focus();
			}
			return;
		}
		tile.lookup = { ...tile.lookup, data: withCreatedArtist(tile.lookup.data, artist) };
		// That swap destroys the button the dialog captured as its opener, so its
		// onDestroy has nothing connected to restore focus to and the operator
		// lands on <body> with the next Tab restarting at the top of the page
		// (2.4.3). Land on the button that replaced it, or on the select holding
		// the new artist when the result went ambiguous instead.
		await tick();
		// The panel renders the parent tile's lookup, so that button is the seed
		// tile's only while the seed tile is still the parent. Move the Parent
		// radio while the dialog is open and the id belongs to another tile's
		// result, which would send focus to an unrelated part of the page; land on
		// the seed tile's own lookup button there instead.
		if (!isParent(tile.key)) {
			// Focus lands on the seed tile's own lookup button, which is nowhere near
			// the select the artist went into and carries no trace of the creation,
			// so the same sentence "Use X" gives on click has to be spoken here.
			// Moved first: a throw while formatting that sentence would otherwise
			// skip the focus call and leave the operator on <body> (2.4.3), and the
			// live region still mutates on the flush after this.
			(tileLookupButtons[tile.key] ?? artistSelect)?.focus();
			announcer.say(m.admin_lookup_announce_using({ name: artist.name }));
			return;
		}
		(document.getElementById('lookup-applied-artist') ?? artistSelect)?.focus();
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
	// The source field can carry two descriptions at once: the tag-suggestions
	// hint that points at it, and the "From lookup" tag (SONA-220 + SONA-156).
	const sourceFieldDescribedBy = $derived(
		[sourceDescribedBy, sourceTagged ? 'source-lookup-tag' : undefined].filter(Boolean).join(' ') ||
			undefined
	);
	let dateTagged = $state(false);
	// What the last shared prefill actually wrote, for the panel's status line.
	// Never edited afterwards: it is the record of what the lookup did, and a
	// field the operator types over stops being attributable through the flags
	// below instead (SONA-156). The tag is that record — it goes up with the
	// prefill and comes off on the first keystroke.
	let sharedFilled = $state<LookupFields>({});
	// Held-ness of the source post URL at the moment the prefill ran, beside the
	// record of what it wrote. Read live, the clash sentence flips as the
	// operator types: clearing a pasted URL afterwards would make the panel say
	// Sona left the field empty, which the operator did, not Sona.
	let sharedUrlHeld = $state(false);
	const sharedEdited = $derived({
		sourcePostUrl: sharedFilled.sourcePostUrl !== undefined && !sourceTagged,
		commissionedAt: sharedFilled.commissionedAt !== undefined && !dateTagged
	});
	// The artist this result put in the select, so "Use X" can read back as
	// "Using X" and revert when the operator changes the select by hand.
	let appliedArtist = $state<{ id: number; name: string } | null>(null);
	// What the New Artist dialog opens prefilled with, when a lookup opened it.
	// `tileKey` is the tile whose result offered the handle, carried inside the
	// seed so the two are cleared together and can never drift apart.
	let artistSeed = $state<{
		handle: string;
		site: LookupSite;
		linkable: boolean;
		tileKey: number | null;
	} | null>(null);
	// Per-tile aborts. Not $state — nothing renders them.
	const lookupAborts = new Map<number, AbortController>();
	// Closing or cancelling the panel destroys the button the operator is
	// standing on, so focus has to be moved deliberately first (2.4.3). The
	// origin is the parent tile's own button in a set, the fieldset pill alone.
	let lookupPill = $state<HTMLButtonElement | null>(null);
	let existingParentSelect = $state<HTMLSelectElement | null>(null);
	let artistSelect = $state<HTMLSelectElement | null>(null);
	// $state so `bind:this` into it is a reactive write (Svelte warns otherwise).
	const tileLookupButtons = $state<Record<number, HTMLButtonElement | null>>({});
	// Each tile's Remove button sits inside the tile it removes, so activating one
	// from the keyboard would drop focus to <body> (2.4.3). These are where focus
	// goes instead — the neighbour that took the removed tile's place.
	const tileRemoveButtons = $state<Record<number, HTMLButtonElement | null>>({});
	// The last tile's removal replaces the whole grid with the dropzone, which is
	// then the only control left to land on.
	let dropzone = $state<HTMLDivElement | null>(null);

	const parentTile = $derived(groupMode === 'new' ? (tiles[parentIndex] ?? null) : null);
	const sharedLookup = $derived<LookupState>(parentTile?.lookup ?? { kind: 'idle' });
	const sharedSentPrivate = $derived(parentTile?.sentPrivate ?? false);
	const sharedRating = $derived(
		sharedLookup.kind === 'results' ? strictestRating(sharedLookup.data.matches) : null
	);
	const sharedRatingTag = $derived(ratingTag(sharedRating, { parent: tiles.length > 1 }));
	// Two rating pills can sit beside the one NSFW box, so it points at whichever
	// of them is on screen (SONA-156 + SONA-220).
	const nsfwDescribedBy = $derived(
		[sharedRatingTag ? 'shared-rating-tag' : undefined, suggestedRating ? 'tags-rating' : undefined]
			.filter(Boolean)
			.join(' ') || undefined
	);
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
		tile.sentPrivate = isPrivate;
		// The fields the last prefill wrote are NOT emptied here. Blanking the
		// source post URL for the length of the round trip tears down everything
		// downstream of it — the suggestion control drops its standing chips and
		// its rating the moment that field changes (SONA-220) — and a lookup that
		// comes back with the same post, or fails outright, then has nothing to
		// put back. They are replaced where the result lands instead, and only
		// when the result names a different post. What the panel says about the
		// LAST result does go now: it is about a search that is over.
		if (isParent(key)) resetSharedResult();
		// What runLookup settled on, so the catch below can keep this lookup's own
		// answer to "did the file leave the browser" instead of assuming it did.
		let settled: LookupState | null = null;
		// Whether that answer reached the tile. The callback writes the state
		// before it announces it, so a throw out of the announcement must not be
		// read as "nothing arrived" and rewrite matches away.
		let applied = false;
		void runLookup({ file: tile.file }, { signal: controller.signal })
			.then(async (next) => {
				settled = next;
				// Cancelled, or the tile was removed while the request was out.
				if (lookupAborts.get(key) !== controller) return;
				const live = tiles.find((t) => t.key === key);
				if (!live) {
					lookupAborts.delete(key);
					return;
				}
				live.lookup = next;
				applied = true;
				// The role as it is NOW, not as it was when the request fired. Ticking
				// another tile's Parent radio mid-lookup re-points the shared fields at
				// that tile, and a late result from the tile that used to be the parent
				// would otherwise write its post URL and date under a panel showing the
				// new one. Going the other way, a tile promoted to parent mid-lookup
				// applies its result instead of showing it over empty fields. The
				// group-mode round trip that made this a snapshot is handled where it
				// happens: the "new" radio re-derives from the parent tile.
				if (isParent(key)) applyShared(next);
				else {
					// Focus first, then the announcement — the same order the created
					// artist takes above. A failure that unmounts the button takes the
					// focus standing on it (2.4.3), and moving focus in the same frame
					// the polite region mutates can cost the queued sentence; a throw
					// out of the announcement would skip the focus call entirely. The
					// await is the tick the replacement control needs to exist; for a
					// failure that keeps its button, and for every other outcome, this
					// resolves without touching focus.
					await moveFocusOffTileButton(key, live);
					// A variant tile's outcome renders as plain text on the tile, outside
					// the panel's live region — say it out loud, naming the file, or a
					// screen-reader user has no way to know the lookup finished (4.1.3).
					announceTileLookup(live);
				}
				// Cleared last, so a throw anywhere above still reads as this
				// lookup's in the catch below rather than as a cancelled one. Only
				// if the entry is still this request's: the focus handoff above
				// awaits a tick, and a lookup started again in that window owns the
				// slot — deleting it there would leave the newer one uncancellable.
				if (lookupAborts.get(key) === controller) lookupAborts.delete(key);
			})
			// runLookup itself resolves on every path, so only a throw in the
			// callback above lands here. Without this the tile would sit on
			// "searching" for the rest of the page's life, with nothing to retry
			// from. A failure is synthesised only when nothing was applied: the
			// state goes on the tile before it is announced, so a throw while
			// announcing would otherwise discard matches that did arrive and tell
			// the operator FuzzySearch never answered. What that synthesised failure
			// discloses about the file having left the browser is
			// sentAfterApplyThrew's call, off the state the request settled on.
			.catch(() => {
				if (lookupAborts.get(key) !== controller) return;
				lookupAborts.delete(key);
				const live = tiles.find((t) => t.key === key);
				if (!live) return;
				if (!applied) {
					const sent = sentAfterApplyThrew(settled);
					live.lookup = { kind: 'failed', reason: 'unavailable', sent };
				}
				console.error(LOOKUP_RESULT_THREW);
				// A variant tile's outcome is plain text outside any live region, so
				// without this the tile silently stops searching (4.1.3). Said from
				// the state the tile has now settled on — the result that stands, or
				// the failure synthesised above — so the announcement matches what
				// the tile shows instead of reporting a failure over matches. Through
				// the composer rather than announceTileLookup, which is one of the
				// things that could have thrown, and guarded: on a second throw the
				// constant is logged and nothing is said, rather than escaping into
				// another unhandled rejection.
				if (!isParent(key)) {
					try {
						announcer.say(tileLookupLine(live));
					} catch {
						console.error(LOOKUP_RESULT_THREW);
					}
				}
			});
	}

	/** What a tile's lookup has to say, as one sentence naming the file: the
	 * match, the no-match, or the failure the tile is showing, with the private
	 * disclosure when one is due. Composed rather than said, so the catch below
	 * can announce the state a tile actually settled on without going back
	 * through anything that already threw. */
	/** The panel's own eyebrow for a failure reason, so a variant tile names the
	 * failure the same way the panel does instead of calling every one of them a
	 * lookup failure. `invalid_image` and `unavailable` share the panel's plain
	 * "Lookup failed", the way its own branch does. */
	function tileFailureLabel(reason: LookupFailReason): string {
		switch (reason) {
			case 'rate_limited':
				return m.admin_lookup_paused_eyebrow();
			case 'key_refused':
				return m.admin_lookup_refused_eyebrow();
			case 'too_large':
				return m.admin_lookup_too_large_eyebrow();
			case 'no_key':
				return m.admin_lookup_no_key_eyebrow();
			case 'gone':
				return m.admin_lookup_gone_eyebrow();
			case 'signed_out':
				return m.admin_lookup_signed_out_eyebrow();
			default:
				return m.admin_lookup_failed_eyebrow();
		}
	}

	/** The panel's sentence for a failure reason — the part that carries the
	 * remedy (Settings, signing in again, a different file), which the eyebrow
	 * alone cannot. Shown on the tile and spoken, for the same reason. */
	function tileFailureBody(reason: LookupFailReason): string {
		switch (reason) {
			case 'rate_limited':
				return m.admin_lookup_paused_body();
			case 'key_refused':
				return m.admin_lookup_refused_body();
			case 'too_large':
				return m.admin_lookup_too_large_body();
			case 'invalid_image':
				return m.admin_lookup_invalid_body();
			case 'no_key':
				return m.admin_lookup_no_key_body();
			case 'gone':
				return m.admin_lookup_gone_body();
			case 'signed_out':
				return m.admin_lookup_signed_out_body();
			default:
				return m.admin_lookup_failed_body();
		}
	}

	/** The reasons the tile keeps Try again for. A deleted image and a file
	 * FuzzySearch would not read hit the same wall on a second click, so the tile
	 * stops offering one. Everything else is here because the operator can go and
	 * fix it: an expired session ends in a sign-in elsewhere, and a missing or
	 * refused key ends in Settings, which the tile now opens in a new tab — the
	 * key is read per request, so the click that comes back works. The panel gets
	 * to a usable state through its Close; a variant tile whose button went away
	 * has nothing left to click at all. A retry that was too early re-renders
	 * what is already there. */
	function tileCanRetry(reason: LookupFailReason): boolean {
		return reason !== 'too_large' && reason !== 'invalid_image' && reason !== 'gone';
	}

	/** Such a failure unmounts the button the operator is standing on — it is the
	 * one they clicked to start the lookup — so focus has to be moved deliberately
	 * or it falls to <body> and the next Tab restarts at the top of the page
	 * (2.4.3). It lands on the artist select, which is where "add the artist by
	 * hand" happens: the three reasons that get here have no remedy on the tile. */
	async function moveFocusOffTileButton(key: number, tile: Tile) {
		if (tile.lookup.kind !== 'failed' || tileCanRetry(tile.lookup.reason)) return;
		if (document.activeElement !== tileLookupButtons[key]) return;
		// The replacement only exists after the DOM catches up with the state the
		// caller just wrote.
		await tick();
		artistSelect?.focus();
	}

	function tileLookupLine(tile: Tile): string {
		const fileName = tile.fileName;
		let line: string;
		if (tile.lookup.kind === 'failed') {
			// The reason, not a bare "lookup failed": spoken is the only way a
			// screen-reader operator learns the key went away or the session
			// expired, and a generic failure invites a retry that cannot work.
			line = m.admin_lookup_announce_tile_failure({
				fileName,
				reason: tileFailureBody(tile.lookup.reason)
			});
		} else {
			const result = tileResult(tile);
			line = result
				? m.admin_lookup_announce_tile_match({ fileName, result: result.spoken })
				: m.admin_lookup_announce_tile_no_match({ fileName });
		}
		// The tile's private notice is a plain paragraph outside any live region,
		// so this is the only way the disclosure reaches a screen-reader operator.
		// Both halves of the same test the rendered notice uses: the file went out
		// (lookupSentFile of the state the tile settled on) AND Private was ticked
		// when it went. Off sentPrivate alone, a client-refused too_large would be
		// spoken as a private send of a file that never left the browser.
		if (tile.sentPrivate && lookupSentFile(tile.lookup)) {
			// One key holding both parts, not a concatenation: the separator between
			// them is the locale's business (ja runs them together, en takes a space).
			line = m.admin_lookup_announce_tile_with_notice({
				outcome: line,
				disclosure: m.admin_lookup_private_notice()
			});
		}
		return line;
	}

	function announceTileLookup(tile: Tile) {
		announcer.say(tileLookupLine(tile));
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
		sharedUrlHeld = false;
		resetSharedResult();
	}

	/** What the last result put on the page OUTSIDE the two shared fields. A new
	 * search invalidates all of it the moment it starts, because none of it is
	 * recoverable from the result that is on its way. The fields are the
	 * exception and are handled by applyShared when that result lands. */
	function resetSharedResult() {
		// A second lookup's panel is about a new result, and an artist applied
		// from the last one is not applied to it: cleared here, the way the edit
		// page's resetLookupPrefill does. The group-mode round trip, which shows
		// the SAME result again, holds this across the reset itself.
		appliedArtist = null;
		// A clash carried into the select belongs to the lookup that found it, so
		// a second lookup must not leave the first one's piece on offer. The one
		// the operator actually chose stays: dropping it would silently blank the
		// select and save no parent, which is what carrying it in prevented.
		extraParents = extraParents.filter((c) => String(c.id) === existingParentId);
	}

	/** Which of the two shared fields this call actually wrote. A result whose
	 * fields the operator has typed over writes neither, and a caller that speaks
	 * about the refill has to know that before it claims one happened. */
	function applyShared(next: LookupState): { sourcePostUrl: boolean; commissionedAt: boolean } {
		const wrote = { sourcePostUrl: false, commissionedAt: false };
		// A failure, or a search cancelled back to idle, leaves both fields exactly
		// as they are: there is no new post to describe them, and what the last
		// lookup wrote is still the best thing the page knows.
		if (next.kind !== 'results') return wrote;
		// A field the LAST prefill wrote and the operator has not typed over since
		// is still the lookup's to replace, so this result reads it as empty and
		// fills it. Only the tag can tell the two apart, which is why the value is
		// kept until here rather than blanked when the search started.
		const ownSource = sourceTagged ? '' : sourcePostUrl;
		const ownDate = dateTagged ? '' : commissionedAt;
		sharedUrlHeld = ownSource.trim() !== '';
		const fields = prefillForResult(next.data, {
			sourcePostUrl: ownSource,
			commissionedAt: ownDate
		});
		sharedFilled = fields;
		if (fields.sourcePostUrl !== undefined) {
			// Written only when it is really different. Re-assigning the same URL
			// still counts as a change to everything watching the field, and the
			// suggestion control answers one by dropping the chips and the rating it
			// is holding — for a second lookup that landed on the same post.
			if (sourcePostUrl !== fields.sourcePostUrl) sourcePostUrl = fields.sourcePostUrl;
			sourceTagged = true;
			wrote.sourcePostUrl = true;
		} else if (sourceTagged) {
			// This result has no post to offer — no match, or a clash whose URL
			// belongs to another piece — so the last one's URL goes now. Deferred to
			// here rather than done at the start: until the result was in, there was
			// no way to know it would not be refilled.
			sourcePostUrl = '';
			sourceTagged = false;
		}
		if (fields.commissionedAt !== undefined) {
			if (commissionedAt !== fields.commissionedAt) commissionedAt = fields.commissionedAt;
			dateTagged = true;
			wrote.commissionedAt = true;
		} else if (dateTagged) {
			commissionedAt = '';
			dateTagged = false;
		}
		return wrote;
	}

	/** Back to a new set. Only re-derive when the parent tile still HAS a result:
	 * closing the panel leaves the lookup idle while the fields it filled stay on
	 * screen, and an unconditional re-derivation cleared both tagged fields and
	 * then applied nothing, erasing them with no notice. The panel and its status
	 * region are mounted by this same mode swap, so a region inserted together
	 * with its first content is commonly missed — say the refill out loud, but
	 * only when a field was really written, and name the field when only one of
	 * them was. The operator who typed over both fields keeps what they typed,
	 * and hearing that Sona filled them would be a false report of a change that
	 * did not happen. */
	function returnToNewSet() {
		if (tiles[parentIndex]?.lookup.kind !== 'results') return;
		// "Using {name}" is about the SELECT, not about the result that put the
		// artist there. The re-derivation behind this round trip clears it, and
		// the button relabelled itself back to "Use {name}" over a select that
		// still held that artist. Only this round trip restores it: the operator
		// changing the select, or a new result, is a real reason to drop it.
		const held = appliedArtist;
		const wrote = onParentChanged(parentIndex);
		if (held && Number(selectedArtistId) === held.id) appliedArtist = held;
		if (wrote.sourcePostUrl && wrote.commissionedAt) {
			announcer.say(m.admin_lookup_announce_shared_refilled());
		} else if (wrote.sourcePostUrl) {
			announcer.say(m.admin_lookup_announce_shared_refilled_source());
		} else if (wrote.commissionedAt) {
			announcer.say(m.admin_lookup_announce_shared_refilled_date());
		}
	}

	/** The parent moved: the shared fields describe whatever the parent is now. */
	function onParentChanged(index: number) {
		parentIndex = index;
		resetSharedPrefill();
		const tile = tiles[parentIndex];
		return tile ? applyShared(tile.lookup) : { sourcePostUrl: false, commissionedAt: false };
	}

	function useLookupArtist(artist: { id: number; name: string }) {
		// The options were built when the page loaded. An artist created in another
		// tab since then comes back as a candidate with no option of their own, so
		// the button would flip to "Using {name}" over an empty select and the save
		// would be refused by `required`. Carry them in, the way the dialog does.
		// Unlike a clash parent carried into the variant select, this option stays
		// through the next lookup: an artist is a global record, so once it is known
		// it belongs in the list, while a clash is one result's finding about this
		// image.
		if (!artistList.some((a) => a.id === artist.id)) {
			artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		}
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
		// The tile is captured HERE rather than read back when the dialog closes:
		// the dialog has no focus trap, so the Parent radio behind it can still be
		// reached from the keyboard, and the result the created artist belongs to
		// is the one that offered the handle, not whichever tile is parent later.
		artistSeed = seed.handle ? { ...seed, tileKey: parentTile?.key ?? null } : null;
		showNewArtist = true;
	}

	async function addAsVariant(clash: SourceClash) {
		// Reset the tile's lookup FIRST: closeSharedLookup reaches the tile through
		// parentTile, which is null the moment the mode is no longer 'new', and a
		// clash panel left behind resurfaces on the way back to a new group.
		closeSharedLookup({ focus: false });
		groupMode = 'existing';
		// The options were built when the page loaded. A clash piece uploaded in
		// another tab since then has none, so the select would fall back to blank
		// with the panel already closed: the operator asked for a variant and would
		// silently save none. Carry the clash in as its own option first.
		if (!parentOptions.some((c) => c.id === clash.imageId)) {
			extraParents = [...extraParents, { id: clash.imageId, title: clash.title }];
		}
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
		// The pill renders for a single file only, so in a group it is null and
		// the select is the last resort — the same one moveFocusOffTileButton
		// falls back to.
		(button ?? lookupPill ?? artistSelect)?.focus();
	}

	/** Every caller passes the options bag explicitly or calls this with nothing:
	 * handed to a callback prop bare, a DOM MouseEvent lands here as `options`,
	 * and focus return survives only because an event has no `focus` property. */
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
			bind:this={dropzone}
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
						<!-- The file name rides in the accessible name so a screen reader can
						     tell the grid's Remove buttons apart (2.4.6, 4.1.2). -->
						<button
							type="button"
							class="tile-remove"
							bind:this={tileRemoveButtons[tile.key]}
							aria-label={m.admin_variant_remove_file({ fileName: tile.fileName })}
							onclick={() => removeTileFromButton(tile.key)}
						>
							<X size={14} />
						</button>
					</div>
					<div class="tile-meta">{tile.width} x {tile.height} &bull; {formatSize(tile.fileSize)}</div>
					{#if data.lookupEnabled && isGroup && tile.status === 'done'}
						{#if tile.lookup.kind === 'failed' && !isParent(tile.key)}
							<!-- The reason on the tile's own lines, whether or not a retry
							     can fix it: composed into the button label instead, it wrapped
							     to a second line starting with the separator. Two lines here
							     also keep the tile saying what the announcement says. Variant
							     tiles only: the parent's failure is reported by the shared
							     panel, which carries the same reason and the same actions, and
							     the parent's button is where the panel's Close sends focus
							     back to (2.4.3), so it has to stay mounted and unchanged. -->
							<p class="tile-lookup-failed" id="tile-fail-label-{tile.key}">
								{tileFailureLabel(tile.lookup.reason)}
							</p>
							<p class="tile-lookup-reason" id="tile-fail-reason-{tile.key}">
								{tileFailureBody(tile.lookup.reason)}
							</p>
						{/if}
						{#if tile.lookup.kind === 'failed' && !isParent(tile.key) && (tile.lookup.reason === 'no_key' || tile.lookup.reason === 'key_refused')}
							<!-- The remedy sits beside the retry rather than replacing it: the
							     key is read per request, so once it is saved the click that
							     comes back works. Replacing the button left the tile with no
							     control at all once this link opened in a new tab. A new tab,
							     like the other lookup links: navigating this page away would
							     drop the batch — the tiles, their labels, the shared fields —
							     with no way back to it. -->
							<a
								class="tile-settings-link"
								href="/admin/settings?tab=connections"
								target="_blank"
								rel="noopener noreferrer"
								>{m.admin_lookup_open_settings()}<span class="sr-only"
									>{' '}{m.link_opens_new_tab()}</span
								></a
							>
						{/if}
						{#if !(tile.lookup.kind === 'failed' && !tileCanRetry(tile.lookup.reason) && !isParent(tile.key))}
							<!-- One lookup per tile: the parent's result fills the shared
							     fields, a variant's only rates that variant. The file name
							     rides in the accessible name so a screen reader can tell the
							     grid's buttons apart. A failure names itself on the lines
							     above and leaves this button a plain Try again; on the parent
							     it is the panel that reports the failure, so the button is
							     unchanged by one. The reason lines describe the button while
							     it is standing under them, so a screen-reader operator coming
							     back to the tile hears what went wrong, not just "Try again". The
							     lookup hint stays in the description behind the reason, so the
							     retry still discloses that it sends the file out. -->
							<button
								type="button"
								class="tile-lookup"
								bind:this={tileLookupButtons[tile.key]}
								aria-busy={tile.lookup.kind === 'searching'}
								aria-describedby={tile.lookup.kind === 'failed' && !isParent(tile.key)
									? `tile-fail-label-${tile.key} tile-fail-reason-${tile.key} lookup-hint`
									: 'lookup-hint'}
								onclick={() => startLookup(tile.key)}
							>
								<Search size={12} aria-hidden="true" />
								{#if tile.lookup.kind === 'searching'}{m.admin_lookup_tile_searching()}
								{:else if tile.lookup.kind === 'results' || tile.lookup.kind === 'no_match'}{m.admin_lookup_tile_done()}
								{:else if tile.lookup.kind === 'failed' && !isParent(tile.key)}{m.admin_lookup_try_again()}
								{:else}{m.admin_lookup_button()}{/if}
								<span class="sr-only">{m.admin_lookup_button_for({ fileName: tile.fileName })}</span>
							</button>
						{/if}
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
							     parent. Read from the tile's own snapshot, not the live box. -->
							{#if tile.sentPrivate && lookupSentFile(tile.lookup)}
								<p class="tile-private-notice">{m.admin_lookup_private_notice()}</p>
							{/if}
							<!-- The placeholder disappears the moment the operator types, so it
							     cannot be the field's name; the aria-label names the field and
							     the file it belongs to, the way the tile's other controls do. -->
							<input
								type="text"
								class="input tile-label"
								name="label_{i}"
								aria-label={m.admin_variant_label_for({ fileName: tile.fileName })}
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
				<!-- Back to a new set: the shared fields belong to the parent tile
				     again, so re-derive them from whatever its lookup found. A lookup
				     that resolved while the mode was "existing" filled nothing, and
				     without this the operator returned to a results panel sitting over
				     empty fields. -->
				<input
					type="radio"
					name="groupMode"
					checked={groupMode === 'new'}
					onchange={() => {
						groupMode = 'new';
						returnToNewSet();
					}}
				/>
				<span>{tiles.length > 1 ? m.admin_variant_group_new() : m.admin_variant_group_single()}</span>
			</label>
			<label class="radio-label">
				<input
					type="radio"
					name="groupMode"
					checked={groupMode === 'existing'}
					onchange={() => (groupMode = 'existing')}
				/>
				<span>{m.admin_variant_group_existing()}</span>
			</label>
			{#if groupMode === 'existing'}
				<!-- Named like the edit page's own parent select: the legend names the
				     group, not this field, and "Add as a variant" now pushes an option
				     in and lands focus here, so a screen reader would otherwise read
				     the clash title with nothing saying what holds it (4.1.2, 3.3.2). -->
				<label>
					<span>{m.admin_field_variant_of()}</span>
					<select
						class="input"
						bind:this={existingParentSelect}
						bind:value={existingParentId}
						required
					>
						<option value="">{m.admin_variant_pick_parent()}</option>
						{#each parentOptions as candidate}
							<option value={String(candidate.id)}>{candidate.title}</option>
						{/each}
					</select>
				</label>
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
				bind:this={artistSelect}
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
				<!-- The third Settings remedy, and a new tab for the same reason as the
				     other two: this page holds a batch that a same-tab navigation
				     would discard. -->
				{m.admin_lookup_no_key_pre()}<a
					class="link"
					href="/admin/settings?tab=connections"
					target="_blank"
					rel="noopener noreferrer"
					>{m.admin_lookup_no_key_link()}<span class="sr-only"
						>{' '}{m.link_opens_new_tab()}</span
					></a
				>{m.admin_lookup_no_key_post()}
			</small>
		{/if}
		{#if data.lookupEnabled && groupMode === 'new'}
			<ArtistLookupPanel
				lookup={sharedLookup}
				fileName={tiles.length > 1 ? (parentTile?.fileName ?? '') : ''}
				filled={sharedFilled}
				edited={sharedEdited}
				sourceUrlHeld={sharedUrlHeld}
				{appliedArtist}
				privateNotice={sharedSentPrivate && lookupSentFile(sharedLookup)}
				onclose={() => closeSharedLookup()}
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

	<label>
		<span>{m.admin_field_collection()}</span>
		<select class="input" name="collectionId">
			<option value="">{m.admin_upload_no_collection()}</option>
			{#each data.collections as collection}
				<option value={collection.id}>{collection.name}</option>
			{/each}
		</select>
	</label>

	<!-- Tags takes a full-width row of its own so the "Suggest tags" pill sits
	     beside the input and the accepted tags are readable without truncation.
	     The control draws the existing-tags hint under the field, as this form
	     did before it. -->
	<TagSuggestions
		bind:value={tagsValue}
		bind:rating={suggestedRating}
		bind:sourceDescribedBy
		sourceUrl={sourcePostUrl}
		existingTags={data.tags.map((t) => t.name)}
		placeholder={m.admin_upload_tags_placeholder()}
		multiTile={tiles.length > 1}
	/>

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
			aria-describedby={dateTagged ? 'commissioned-hint commissioned-lookup-tag' : 'commissioned-hint'}
		/>
		<!-- The hint was inside the wrapping label before this restructure, which
		     put it in the input's accessible name. Out here it is a plain sibling,
		     so it is referenced instead — otherwise a screen reader never gets it
		     (1.3.1). The lookup tag joins it when there is one. -->
		<small class="hint" id="commissioned-hint">{m.admin_hint_commissioned_date()}</small>
	</div>

	<!-- One checkbox, two ratings beside it: FuzzySearch's from the artist lookup
	     (SONA-156) and entail.dev's from the tag suggestion (SONA-220). Neither
	     ever ticks it; both sit outside the label so a screen reader doesn't read
	     a classifier's guess as part of the checkbox's own name. -->
	<div class="nsfw-row tag-check-row">
		<label class="checkbox-label">
			<input
				type="checkbox"
				name="nsfw"
				bind:checked={nsfw}
				bind:this={nsfwInput}
				aria-describedby={nsfwDescribedBy}
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
		<TagRatingNote rating={suggestedRating} id="tags-rating" bind:nsfw checkbox={nsfwInput} />
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
			aria-describedby={sourceFieldDescribedBy}
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

	/* Not a .btn, and app.css has no bare button:focus-visible rule, so removing
	   a tile would land focus on the next Remove wearing only the user-agent
	   ring — over an arbitrary image, on a chip that is 60% black (2.4.7). The
	   offset puts the outline on the image itself, where no single colour clears
	   3:1 against every photo, so the box-shadow draws a second, near-white edge
	   inside it: one of the two always separates from what is behind it (1.4.11). */
	.tile-remove:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
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

	.tile-result,
	.tile-lookup-failed,
	.tile-lookup-reason {
		font-size: 12px;
		color: var(--muted-foreground);
		margin: 0;
		line-height: 1.4;
	}

	.tile-result-warn,
	.tile-lookup-failed {
		color: var(--status-warn);
	}

	.tile-post-link,
	.tile-settings-link {
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
	   sits beside it. The row wraps a pill to its own line when it no longer
	   fits. */
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

	/* The text grows with the number of sites, so the pill wraps inside whatever
	   holds it rather than spilling out: the tile is ~170px wide, and the shared
	   row is beside a second pill and a button once a suggestion has run. Kept
	   on one line the pill cannot shrink at all, which pushed the document into
	   a sideways scroll on a narrow phone. */
	.rating-tag {
		font-family: var(--font-primary);
		font-size: 11px;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		padding: 1px 8px;
		white-space: normal;
		overflow-wrap: anywhere;
		max-width: 100%;
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

		.form-actions {
			flex-direction: column-reverse;
		}

		.form-actions .btn {
			width: 100%;
		}
	}
</style>
