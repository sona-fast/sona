<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { flip } from 'svelte/animate';
	import { ArrowLeft, BookOpen, Check, Loader2, GripVertical, Plus, X, UploadCloud, FileBox, Trash2, ImagePlus, UserPlus } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import { cdnImage, rawFallback, THUMB_WIDTH } from '$lib';
	import { toast } from '$lib/toast.svelte';
	import { DragReorder } from '$lib/drag-reorder.svelte';
	import { dropFiles } from '$lib/drop-files';
	import { probeDimensions } from '$lib/probe-dimensions';
	import { MAX_BUFFER_BYTES } from '$lib/config';
	import { MAX_VR_MODEL_BYTES, creditRoleLabel, formatBytes, modelFileError, modelFormatLabel, namePlaceholderCharacter, platformLabel } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	interface AvatarInit {
		name: string;
		slug: string;
		characterId: number;
		description: string | null;
		externalUrl: string | null;
		license: string | null;
		permissionSource: string | null;
		downloadable: boolean;
		nsfw: boolean;
		published: boolean;
		posterImageId: number | null;
		modelUrl: string | null;
		modelFormat: string | null;
		modelSizeBytes: number | null;
	}
	interface CreditInit {
		artistId: number;
		role: string;
		roleLabel: string | null;
	}
	interface MediaInit {
		url: string;
		kind: string;
		width: number | null;
		height: number | null;
	}
	interface Props {
		heading: string;
		submitLabel: string;
		artists: { id: number; name: string }[];
		characters: { id: number; name: string; isOwner: boolean }[];
		/** Gallery images for the poster picker (same source as the collections
		 * cover picker). nsfw feeds the inherited-NSFW hint under the preview
		 * (SONA-159). */
		images: { id: number; imageUrl: string; thumbnailUrl: string | null; title: string; nsfw: boolean }[];
		/** Existing avatar for edit mode; omit for create. */
		avatar?: AvatarInit | null;
		credits?: CreditInit[];
		/** Existing showcase media rows for edit mode, in display order. */
		media?: MediaInit[];
		platforms?: string[];
		form?: { error?: string } | null;
		/** Whether the shared registry is connected (admin layout load) — enables
		 * the registry search inside NewArtistDialog, matching the gallery and
		 * sticker flows. */
		registryEnabled?: boolean;
	}

	let { heading, submitLabel, artists, characters, images, avatar = null, credits = [], media = [], platforms = [], form = null, registryEnabled = false }: Props = $props();


	// Same select + NewArtistDialog pairing the gallery upload and sticker forms
	// use: a locally-sorted copy of the artist list so a just-created artist
	// appears without a reload, and the dialog carries the registry search when
	// the registry is connected.
	let artistList = $state([...artists].sort((a, b) => a.name.localeCompare(b.name)));
	let showNewArtist = $state(false);
	// The row whose select prompted the dialog — the created artist fills THAT
	// row (no surprise appended rows; the affordance lives at the point of need,
	// beside each select, per the upload page's add-artist precedent).
	let newArtistTargetUid = $state<number | null>(null);
	function openNewArtist(uid: number) {
		newArtistTargetUid = uid;
		showNewArtist = true;
	}
	function onArtistCreated(artist: { id: number; name: string }) {
		artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		const target = creditEntries.find((c) => c.uid === newArtistTargetUid);
		if (target) target.artistId = String(artist.id);
		showNewArtist = false;
		newArtistTargetUid = null;
	}

	const isEdit = avatar !== null;

	// --- Name + slug. The slug auto-suggests from the name until the admin
	// touches it (then their spelling wins) — same base cleanup as the
	// collections slug, without the random suffix (this one is user-visible).
	let name = $state(avatar?.name ?? '');
	let slug = $state(avatar?.slug ?? '');
	let slugTouched = $state(isEdit);
	function suggestSlug(v: string): string {
		return v
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 60);
	}
	function onNameInput() {
		if (!slugTouched) slug = suggestSlug(name);
	}

	let characterId = $state(avatar ? String(avatar.characterId) : '');
	const placeholderCharacter = $derived(namePlaceholderCharacter(characters, characterId));
	let license = $state(avatar?.license ?? '');
	let downloadable = $state(avatar?.downloadable ?? false);
	let nsfw = $state(avatar?.nsfw ?? false);
	let published = $state(avatar?.published ?? false);
	let saving = $state(false);

	// --- Platforms: checkbox chips over the schema enum.
	const PLATFORMS = ['vrchat', 'resonite', 'chilloutvr', 'neosvr', 'vseeface', 'warudo', 'other'];
	let selectedPlatforms = $state<Set<string>>(new Set(platforms));
	function togglePlatform(p: string) {
		const next = new Set(selectedPlatforms);
		if (next.has(p)) next.delete(p);
		else next.add(p);
		selectedPlatforms = next;
	}

	// --- Credits editor: ordered rows (array order = stored position), reordered
	// with the same pointer-capture drag handle as the sticker pack form.
	interface CreditEntry {
		uid: number;
		artistId: string;
		role: string;
		roleLabel: string;
	}
	let nextUid = 0;
	let creditEntries = $state<CreditEntry[]>(
		credits.map((c) => ({
			uid: nextUid++,
			artistId: String(c.artistId),
			role: c.role,
			roleLabel: c.roleLabel ?? ''
		}))
	);
	const ROLES = ['base', 'modeler', 'rigger', 'texture', 'shader', 'other'];
	function addCredit() {
		creditEntries = [...creditEntries, { uid: nextUid++, artistId: '', role: 'base', roleLabel: '' }];
	}
	function removeCredit(i: number) {
		creditEntries = creditEntries.filter((_, idx) => idx !== i);
	}

	// Shared reorder behavior (pointer drag + arrow keys + live announcement) —
	// same helper as the sticker pack form's row reorder.
	const creditReorder = new DragReorder({
		count: () => creditEntries.length,
		move: (from, to) => {
			const next = [...creditEntries];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			creditEntries = next;
		}
	});

	// --- Showcase media (mock vr-avatar detail's media strip): ordered images +
	// short clips, uploaded through /api/upload (buffered — its 64 MB cap is the
	// intended bound for showcase stills and short clips) into the vr-media/
	// partition. Kind derives from the file's content type; dimensions are
	// probed client-side like the existing image flows.
	interface MediaEntry {
		uid: number;
		url: string;
		kind: 'image' | 'video';
		width: number | null;
		height: number | null;
	}
	let mediaEntries = $state<MediaEntry[]>(
		media.map((item) => ({
			uid: nextUid++,
			url: item.url,
			kind: item.kind === 'video' ? 'video' : 'image',
			width: item.width,
			height: item.height
		}))
	);
	let mediaUploading = $state(false);
	// Per-file failure reporting (R2-D10): a multi-file pick may partially
	// succeed, and one collapsed error beside freshly-added rows read as if
	// everything failed — each failure names its file instead. uid keys the
	// {#each}: two same-named files failing for the same reason are distinct
	// rows, so a name+reason key would collide.
	let mediaErrorUid = 0;
	let mediaErrors = $state<
		{ uid: number; name: string; reason: 'too-large' | 'bad-type' | 'failed' }[]
	>([]);
	// Upload start/done announcements for the media section's live region
	// (R2-A10) — visually the dropzone label + rows already show both.
	let mediaStatus = $state('');

	const mediaReorder = new DragReorder({
		count: () => mediaEntries.length,
		move: (from, to) => {
			const next = [...mediaEntries];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			mediaEntries = next;
		}
	});

	function removeMedia(i: number) {
		// Row removal only; the save action disposes of the stored file.
		mediaEntries = mediaEntries.filter((_, idx) => idx !== i);
	}

	// MIME types only: /api/upload validates the declared type and reads an empty
	// one as application/octet-stream, so accepting a bare .png here would upload
	// the whole file just to collect a 415.
	const MEDIA_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/avif,video/webm';
	// /api/upload's buffered cap — the shared constant, not a hardcoded twin.
	const MAX_MEDIA_BYTES = MAX_BUFFER_BYTES;

	function onMediaPicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (!files.length) return;
		uploadMedia(files);
	}

	// Shared by the file input and the drop attachment. `rejected` only ever
	// arrives from a drop — the input's accept attribute filters the picker, a
	// drop skips it — and those files are reported without being uploaded.
	async function uploadMedia(files: File[], rejected: File[] = []) {
		mediaErrors = rejected.map((file) => ({
			uid: mediaErrorUid++,
			name: file.name,
			reason: 'bad-type' as const
		}));
		if (!files.length) return;
		mediaUploading = true;
		mediaStatus = m.admin_upload_uploading();
		try {
			for (const file of files) {
				if (file.size > MAX_MEDIA_BYTES) {
					mediaErrors = [...mediaErrors, { uid: mediaErrorUid++, name: file.name, reason: 'too-large' }];
					continue;
				}
				const fd = new FormData();
				fd.append('file', file);
				fd.append('folder', 'vr-media');
				let res: Response;
				try {
					res = await fetch('/api/upload', { method: 'POST', body: fd });
				} catch {
					mediaErrors = [...mediaErrors, { uid: mediaErrorUid++, name: file.name, reason: 'failed' }];
					continue;
				}
				if (!res.ok) {
					mediaErrors = [
						...mediaErrors,
						{
							uid: mediaErrorUid++,
							name: file.name,
							reason: res.status === 413 ? 'too-large' : res.status === 415 ? 'bad-type' : 'failed'
						}
					];
					continue;
				}
				// Per-file guard: a malformed response body or probe failure records
				// that file's error and lets the rest of the batch continue.
				try {
					const { url } = (await res.json()) as { url: string };
					const { width, height } = await probeDimensions(file);
					mediaEntries = [
						...mediaEntries,
						{
							uid: nextUid++,
							url,
							kind: file.type.startsWith('video/') ? 'video' : 'image',
							width,
							height
						}
					];
				} catch {
					mediaErrors = [...mediaErrors, { uid: mediaErrorUid++, name: file.name, reason: 'failed' }];
				}
			}
		} finally {
			mediaUploading = false;
			mediaStatus =
				mediaErrors.length > 0 ? m.admin_vr_media_upload_issues() : m.admin_vr_media_upload_done();
		}
	}

	// --- Poster picker: pick from the gallery, like the collections cover grid
	// (stores the image ID here — vr_avatars.poster_image_id, SET NULL on image
	// delete — rather than the URL).
	let posterImageId = $state<number | null>(avatar?.posterImageId ?? null);
	const posterImage = $derived(images.find((img) => img.id === posterImageId) ?? null);
	let removePosterButton = $state<HTMLButtonElement>();
	let posterGrid = $state<HTMLDivElement>();
	async function pickPoster(id: number) {
		posterImageId = id;
		// Picking swaps the grid for the preview, unmounting the focused option —
		// hand focus to the Remove button instead of dropping it on <body>.
		await tick();
		removePosterButton?.focus();
	}
	async function removePoster() {
		posterImageId = null;
		// Same class of bug in the other direction (R2-A8): removing unmounts the
		// preview + this button — hand focus to the first option in the returning
		// grid.
		await tick();
		posterGrid?.querySelector<HTMLButtonElement>('.poster-option')?.focus();
	}

	// --- Model upload (mock vr-model-upload): dropzone → progress → stored card,
	// plus the two error states. The endpoint streams the raw body, so the file
	// goes up via XHR (progress events) with its name in the query string.
	let modelUrl = $state(avatar?.modelUrl ?? '');
	let modelFormat = $state(avatar?.modelFormat ?? '');
	let modelSizeBytes = $state<number | null>(avatar?.modelSizeBytes ?? null);
	let modelFilename = $state(avatar?.modelUrl ? (avatar.modelUrl.split('/').pop() ?? '') : '');

	// Shared by the file inputs and the drop attachment, so a drop accepts
	// exactly what the picker offers.
	const MODEL_ACCEPT = '.vrm,.fbx';

	let uploading = $state(false);
	let uploadLoaded = $state(0);
	let uploadTotal = $state(0);
	let uploadError = $state<'too-large' | 'bad-type' | 'failed' | null>(null);
	// Bumped on every error so {#key} remounts the role="alert" banner: setting
	// uploadError to the value it already holds would otherwise announce nothing.
	let uploadErrorUid = $state(0);
	function setUploadError(kind: 'too-large' | 'bad-type' | 'failed') {
		uploadError = kind;
		uploadErrorUid++;
	}
	let errorFileSize = $state(0);

	// Live-region text for the model upload, throttled to 10% steps so a screen
	// reader isn't flooded per progress event; the region below stays ALWAYS
	// mounted (mirrors the viewer's loading announcement, R2-A6).
	const uploadAnnouncement = $derived.by(() => {
		if (!uploading) return '';
		const stepped =
			uploadTotal > 0 ? Math.floor(((uploadLoaded / uploadTotal) * 100) / 10) * 10 : 0;
		return m.admin_vr_upload_progress({
			loaded: formatBytes(Math.round((stepped / 100) * uploadTotal)),
			total: formatBytes(uploadTotal)
		});
	});

	function onModelPicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		uploadModel(file);
	}

	// Drops route here too. A drop of several files takes the first one: the
	// avatar has a single model.
	function onModelDropped(files: File[], rejected: File[]) {
		if (files.length) uploadModel(files[0]);
		// Wrong extension: the same banner modelFileError would raise, no request.
		else if (rejected.length) setUploadError('bad-type');
	}

	function uploadModel(file: File) {
		uploadError = null;
		// Client-side mirror of the server guards ($lib/vr modelFileError), for
		// instant feedback — the endpoint re-checks all of it.
		const fileError = modelFileError(file);
		if (fileError) {
			if (fileError === 'too-large') errorFileSize = file.size;
			setUploadError(fileError);
			return;
		}
		uploading = true;
		uploadLoaded = 0;
		uploadTotal = file.size;
		const xhr = new XMLHttpRequest();
		xhr.open('POST', `/api/admin/vr-model?filename=${encodeURIComponent(file.name)}`);
		xhr.setRequestHeader('content-type', 'application/octet-stream');
		xhr.upload.onprogress = (ev) => {
			uploadLoaded = ev.loaded;
			if (ev.lengthComputable) uploadTotal = ev.total;
		};
		xhr.onload = () => {
			uploading = false;
			if (xhr.status === 200) {
				try {
					const res = JSON.parse(xhr.responseText) as { url: string; size: number; format: string };
					modelUrl = res.url;
					modelFormat = res.format;
					modelSizeBytes = res.size;
					modelFilename = file.name;
					return;
				} catch {
					// fall through to the generic error
				}
			}
			if (xhr.status === 413) {
				errorFileSize = file.size;
				setUploadError('too-large');
			} else if (xhr.status === 415) {
				setUploadError('bad-type');
			} else {
				setUploadError('failed');
			}
		};
		xhr.onerror = () => {
			uploading = false;
			setUploadError('failed');
		};
		xhr.send(file);
	}
	function removeModel() {
		// Clears the fields only; the save action disposes of a replaced/removed
		// stored file (and the orphan sweep backstops an abandoned upload).
		modelUrl = '';
		modelFormat = '';
		modelSizeBytes = null;
		modelFilename = '';
		uploadError = null;
	}

	// --- Delete (edit mode): confirm dialog naming the model file + size freed.
	let confirmingDelete = $state(false);
	let deleting = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
	const deleteMessage = $derived(
		avatar?.modelUrl
			? m.admin_vr_delete_message_model({
					name: avatar.name,
					file: avatar.modelUrl.split('/').pop() ?? '',
					size: formatBytes(avatar.modelSizeBytes)
				})
			: m.admin_vr_delete_message({ name: avatar?.name ?? '' })
	);
</script>

<a class="back-link" href="/admin/vr"><ArrowLeft size={16} /> {m.admin_vr_back()}</a>
<div class="page-header">
	<h1>{heading}</h1>
</div>

{#if form?.error}
	<div class="banner err">{form.error}</div>
{/if}

<form
	method="POST"
	action={isEdit ? '?/save' : undefined}
	class="form"
	use:enhance={() => {
		saving = true;
		return async ({ update, result }) => {
			// On success the action redirects, which enhance follows; only failures stay here.
			await update({ reset: false });
			saving = false;
			if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? m.admin_vr_save_failed());
			else if (result.type === 'error') toast.error(m.admin_something_wrong());
		};
	}}
>
	<section class="section">
		<h2>{m.admin_vr_section_details()}</h2>
		<div class="fields">
			<label>
				<span>{m.admin_vr_field_name()}</span>
				<input type="text" class="input" name="name" bind:value={name} oninput={onNameInput} required placeholder={m.admin_vr_name_placeholder({ name: placeholderCharacter })} />
			</label>
			<label>
				<span>{m.admin_vr_field_slug()}</span>
				<input type="text" class="input" name="slug" bind:value={slug} oninput={() => (slugTouched = true)} required pattern="[a-z0-9\-]+" />
				<small class="field-hint">/vr/{slug || '…'}</small>
			</label>
			<label>
				<span>{m.admin_vr_field_character()}</span>
				<select class="input" name="characterId" bind:value={characterId} required>
					<option value="">{m.admin_vr_select_character()}</option>
					{#each characters as c}
						<option value={String(c.id)}>{c.name}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>{m.admin_vr_field_description()}</span>
				<textarea class="input" name="description" rows="3">{avatar?.description ?? ''}</textarea>
			</label>
			<!-- fieldset/legend: the checkboxes are one programmatic group, so a
			     screen reader announces "Platforms" with each chip. -->
			<fieldset class="chip-field">
				<legend class="field-label">{m.admin_vr_field_platforms()}</legend>
				<div class="platform-chips">
					{#each PLATFORMS as p}
						<label class="platform-chip" class:on={selectedPlatforms.has(p)}>
							<input
								type="checkbox"
								name="platforms"
								value={p}
								checked={selectedPlatforms.has(p)}
								onchange={() => togglePlatform(p)}
							/>
							{platformLabel(p) ?? m.vr_platform_other()}
						</label>
					{/each}
				</div>
			</fieldset>
		</div>
	</section>

	<section class="section">
		<h2>{m.vr_credits()}</h2>
		{#if creditEntries.length === 0}
			<p class="muted">{m.admin_vr_no_credits()}</p>
		{/if}
		<!-- Always-mounted live region for the reorder announcements. -->
		<span class="sr-only" aria-live="polite">{creditReorder.announcement}</span>
		<div class="credit-list">
			{#each creditEntries as credit, i (credit.uid)}
				<div
					class="credit-row"
					class:dragging={creditReorder.dragIndex === i}
					class:drop-target={creditReorder.overIndex === i && creditReorder.dragIndex !== null && creditReorder.dragIndex !== i}
					animate:flip={{ duration: 200 }}
					data-reorder-index={i}
				>
					<button
						type="button"
						class="drag-handle"
						aria-label={m.admin_pack_drag_reorder()}
						title={m.admin_pack_drag_reorder()}
						onpointerdown={(e) => creditReorder.handlePointerDown(i, e)}
						onpointermove={(e) => creditReorder.handlePointerMove(e)}
						onpointerup={() => creditReorder.handlePointerUp()}
						onpointercancel={() => creditReorder.reset()}
						onkeydown={(e) => creditReorder.handleKeydown(i, e)}
					>
						<GripVertical size={16} />
					</button>
					<div class="credit-fields">
						<label>
							<span>{m.admin_field_artist()}</span>
							<div class="artist-pick">
								<select class="input sm" name="credit[{i}][artistId]" bind:value={credit.artistId} required>
									<option value="">{m.admin_upload_select_artist()}</option>
									{#each artistList as a}
										<option value={String(a.id)}>{a.name}</option>
									{/each}
								</select>
								<button
									type="button"
									class="new-artist-btn"
									aria-label={m.admin_vr_new_artist_aria({ position: i + 1 })}
									title={m.admin_pack_new_artist()}
									onclick={() => openNewArtist(credit.uid)}
								>
									<UserPlus size={14} aria-hidden="true" />
								</button>
							</div>
						</label>
						<label>
							<span>{m.admin_vr_field_role()}</span>
							<select class="input sm" name="credit[{i}][role]" bind:value={credit.role}>
								{#each ROLES as role}
									<option value={role}>{creditRoleLabel(role)}</option>
								{/each}
							</select>
						</label>
						{#if credit.role === 'other'}
							<label>
								<span>{m.admin_vr_field_role_label()}</span>
								<input
									type="text"
									class="input sm"
									name="credit[{i}][roleLabel]"
									bind:value={credit.roleLabel}
									required
									placeholder={m.admin_vr_role_label_placeholder()}
								/>
							</label>
						{/if}
					</div>
					<!-- Position in the name: several rows would otherwise all announce
					     the identical "Remove credit" (R2-A9). -->
					<button type="button" class="remove-btn" onclick={() => removeCredit(i)} aria-label={m.admin_vr_remove_credit({ position: i + 1 })}>
						<X size={16} />
					</button>
				</div>
			{/each}
		</div>
		<button type="button" class="add-credit-btn" onclick={addCredit}><Plus size={14} /> {m.admin_vr_add_credit()}</button>
	</section>

	<section class="section">
		<h2>{m.admin_vr_field_model()}</h2>
		<!-- Always-mounted live region (a region inserted together with its first
		     content is often not announced); text updates in 10% steps. -->
		<span class="sr-only" role="status">{uploadAnnouncement}</span>
		{#if uploading}
			<!-- Swallow-only drop target: this bar takes the zone's place while the
			     upload runs, and with nothing preventing the default a second drop
			     here navigates the tab to the file and loses the form. Attached to
			     the bar rather than the whole section so the live zone's own
			     dropEffect isn't overridden as the event bubbles. -->
			<div
				class="upload-progress"
				{@attach dropFiles({ accept: MODEL_ACCEPT, onFiles: () => {}, disabled: () => true })}
			>
				<div class="progress-bar">
					<div class="progress-fill" style="width: {uploadTotal > 0 ? (uploadLoaded / uploadTotal) * 100 : 0}%"></div>
				</div>
				<span class="progress-text" aria-hidden="true">
					{m.admin_vr_upload_progress({ loaded: formatBytes(uploadLoaded), total: formatBytes(uploadTotal) })}
				</span>
			</div>
		{:else if modelUrl}
			<div class="model-card">
				<FileBox size={20} />
				<div class="model-info">
					<span class="model-name">{modelFilename || modelUrl.split('/').pop()}</span>
					<span class="model-meta">{modelFormatLabel(modelFormat)} · {formatBytes(modelSizeBytes)}</span>
				</div>
				<div class="model-actions">
					<label
						class="btn-sm"
						{@attach dropFiles({ accept: MODEL_ACCEPT, onFiles: onModelDropped })}
					>
						{m.admin_vr_upload_replace()}
						<input type="file" accept={MODEL_ACCEPT} onchange={onModelPicked} class="sr-file" aria-describedby="vr-model-hint" />
					</label>
					<button type="button" class="btn-sm" onclick={removeModel}>{m.admin_vr_upload_remove()}</button>
				</div>
			</div>
			{#if modelUrl !== (avatar?.modelUrl ?? '')}
				<!-- The orphan sweep reclaims files no row references after ~1h — a
				     form left open unsaved for hours would lose the upload. -->
				<p class="field-hint">{m.admin_vr_upload_unsaved()}</p>
			{/if}
		{:else}
			<!-- The whole zone is the label for the hidden file input. -->
			<label class="upload-zone" {@attach dropFiles({ accept: MODEL_ACCEPT, onFiles: onModelDropped })}>
				<UploadCloud size={22} />
				<span>{m.admin_vr_dropzone({ max: formatBytes(MAX_VR_MODEL_BYTES) })}</span>
				<input type="file" accept={MODEL_ACCEPT} onchange={onModelPicked} class="sr-file" aria-describedby="vr-model-hint" />
			</label>
		{/if}
		{#if uploadError}
			{#key uploadErrorUid}
				<div class="banner err" role="alert">
					{#if uploadError === 'too-large'}
						{m.admin_vr_error_too_large({ size: formatBytes(errorFileSize), max: formatBytes(MAX_VR_MODEL_BYTES) })}
					{:else if uploadError === 'bad-type'}
						{m.admin_vr_error_bad_type()}
					{:else}
						{m.admin_vr_error_upload_failed()}
					{/if}
				</div>
			{/key}
		{/if}
		<!-- The hint keeps its id — the file inputs' aria-describedby points at
		     it. The guide link opens a new tab so a half-filled form isn't lost. -->
		<div class="model-hint-group">
			<p class="field-hint" id="vr-model-hint">{m.admin_vr_model_hint()}</p>
			<a class="guide-link" href="/admin/vr/guide" target="_blank" rel="noopener">
				<BookOpen size={15} aria-hidden="true" />
				{m.admin_vr_guide_link()}<span class="sr-only">{' '}{m.link_opens_new_tab()}</span>
			</a>
		</div>
		<input type="hidden" name="modelUrl" value={modelUrl} />
		<input type="hidden" name="modelFormat" value={modelFormat} />
		<input type="hidden" name="modelSizeBytes" value={modelSizeBytes ?? ''} />

		<div class="fields">
			<label>
				<span>{m.admin_vr_field_external_url()}</span>
				<input type="text" class="input" name="externalUrl" value={avatar?.externalUrl ?? ''} placeholder="https://hub.vroid.com/…" />
			</label>
			<label>
				<span>{m.vr_license()}</span>
				<select class="input" name="license" bind:value={license}>
					<option value="">{m.admin_vr_license_none()}</option>
					<option value="personal-use">{m.vr_license_personal_use()}</option>
					<option value="cc-by">{m.vr_license_cc_by()}</option>
					<option value="base-tos">{m.vr_license_base_tos()}</option>
					<option value="all-rights-reserved">{m.vr_license_all_rights_reserved()}</option>
				</select>
			</label>
			<label>
				<span>{m.admin_vr_field_permission_source()}</span>
				<input type="text" class="input" name="permissionSource" value={avatar?.permissionSource ?? ''} placeholder={m.admin_vr_permission_placeholder()} />
			</label>
		</div>
	</section>

	<!-- Poster BEFORE showcase media, matching the public page's hierarchy: the
	     poster is the primary render, the strip sits under it (DS6). -->
	<section class="section">
		<h2>{m.admin_vr_field_poster()}</h2>
		<div class="poster-section">
			<input type="hidden" name="posterImageId" value={posterImageId ?? ''} />
			{#if posterImage}
				<div class="poster-preview">
					<!-- Width 200 everywhere a gallery row is thumbnailed (the public
					     gallery grid and the admin image list both use it): the same
					     width is the same transform URL, so these reuse variants those
					     pages already generated instead of spending new Image
					     Transformations. rawFallback covers off-zone sources, whose
					     transform 403s (UploadThing forks). -->
					<img
						src={cdnImage(posterImage.thumbnailUrl || posterImage.imageUrl, THUMB_WIDTH)}
						use:rawFallback={posterImage.thumbnailUrl || posterImage.imageUrl}
						alt={posterImage.title}
					/>
					<button type="button" class="remove-poster" bind:this={removePosterButton} onclick={removePoster}>
						<X size={14} /> {m.admin_vr_poster_remove()}
					</button>
				</div>
				{#if posterImage.nsfw && !nsfw}
					<!-- The public pages inherit the poster's NSFW flag (see /vr loaders);
					     without this line the operator only finds out from the list chip
					     (SONA-159). Only for poster-ONLY inheritance — with the switch
					     below on, the hint's "switch is off" claim would be wrong
					     (matches the list's nsfwFromPoster). -->
					<p class="field-hint">{m.admin_vr_poster_nsfw_hint()}</p>
				{/if}
			{:else if images.length > 0}
				<p class="field-hint">{m.admin_vr_poster_hint()}</p>
				<div class="poster-grid" bind:this={posterGrid}>
					{#each images as img (img.id)}
						<button
							type="button"
							class="poster-option"
							class:selected={posterImageId === img.id}
							onclick={() => pickPoster(img.id)}
						>
							<!-- Same shared width as the preview above. Raw originals here
							     meant 100+ multi-MB files per page: Firefox paints a
							     partially-downloaded image as its decoded top rows, so the
							     cells showed image tops for as long as the download ran. -->
							<img
								src={cdnImage(img.thumbnailUrl || img.imageUrl, THUMB_WIDTH)}
								use:rawFallback={img.thumbnailUrl || img.imageUrl}
								alt={img.title}
								loading="lazy"
							/>
						</button>
					{/each}
				</div>
			{:else}
				<p class="field-hint">{m.admin_vr_poster_empty()}</p>
			{/if}
		</div>
	</section>

	<section class="section">
		<h2>{m.admin_vr_section_media()}</h2>
		<p class="field-hint">{m.admin_vr_media_hint()}</p>
		<!-- Always-mounted live regions: reorder announcements, and the upload
		     start/done status (R2-A10). -->
		<span class="sr-only" aria-live="polite">{mediaReorder.announcement}</span>
		<span class="sr-only" role="status">{mediaStatus}</span>
		{#if mediaEntries.length > 0}
			<div class="media-list">
				{#each mediaEntries as item, i (item.uid)}
					<div
						class="media-row"
						class:dragging={mediaReorder.dragIndex === i}
						class:drop-target={mediaReorder.overIndex === i && mediaReorder.dragIndex !== null && mediaReorder.dragIndex !== i}
						animate:flip={{ duration: 200 }}
						data-reorder-index={i}
					>
						<button
							type="button"
							class="drag-handle"
							aria-label={m.admin_pack_drag_reorder()}
							title={m.admin_pack_drag_reorder()}
							onpointerdown={(e) => mediaReorder.handlePointerDown(i, e)}
							onpointermove={(e) => mediaReorder.handlePointerMove(e)}
							onpointerup={() => mediaReorder.handlePointerUp()}
							onpointercancel={() => mediaReorder.reset()}
							onkeydown={(e) => mediaReorder.handleKeydown(i, e)}
						>
							<GripVertical size={16} />
						</button>
						<div class="media-thumb">
							{#if item.kind === 'video'}
								<video src={item.url} muted playsinline preload="metadata"></video>
							{:else}
								<img src={item.url} alt="" loading="lazy" />
							{/if}
						</div>
						<span class="media-meta">
							{item.kind === 'video' ? m.admin_vr_media_kind_video() : m.admin_vr_media_kind_image()}{item.width && item.height
								? ` · ${item.width}×${item.height}`
								: ''}
						</span>
						<input type="hidden" name="media[{i}][url]" value={item.url} />
						<input type="hidden" name="media[{i}][kind]" value={item.kind} />
						<input type="hidden" name="media[{i}][width]" value={item.width ?? ''} />
						<input type="hidden" name="media[{i}][height]" value={item.height ?? ''} />
						<button type="button" class="remove-btn" onclick={() => removeMedia(i)} aria-label={m.admin_vr_media_remove({ position: i + 1 })}>
							<X size={16} />
						</button>
					</div>
				{/each}
			</div>
		{/if}
		<label
			class="upload-zone media-zone"
			class:disabled={mediaUploading}
			{@attach dropFiles({
				accept: MEDIA_ACCEPT,
				onFiles: uploadMedia,
				disabled: () => mediaUploading
			})}
		>
			<ImagePlus size={20} />
			<span>{mediaUploading ? m.admin_upload_uploading() : m.admin_vr_media_dropzone({ max: formatBytes(MAX_MEDIA_BYTES) })}</span>
			<input
				type="file"
				accept={MEDIA_ACCEPT}
				multiple
				onchange={onMediaPicked}
				disabled={mediaUploading}
				class="sr-file"
			/>
		</label>
		{#if mediaErrors.length > 0}
			<div class="banner err" role="alert">
				<!-- One line per failed file: a multi-pick can partially succeed, and
				     an unnamed error beside fresh rows misreads as total failure. -->
				{#each mediaErrors as err (err.uid)}
					<p class="banner-line">
						<strong>{err.name}</strong> —
						{#if err.reason === 'too-large'}
							{m.admin_vr_media_error_too_large({ max: formatBytes(MAX_MEDIA_BYTES) })}
						{:else if err.reason === 'bad-type'}
							{m.admin_vr_media_error_bad_type()}
						{:else}
							{m.admin_vr_media_error_failed()}
						{/if}
					</p>
				{/each}
			</div>
		{/if}
	</section>

	<section class="section">
		<h2>{m.admin_vr_section_visibility()}</h2>
		<!-- The switch text sits OUTSIDE the label element, so each checkbox names
		     itself via aria-labelledby/-describedby — without it the switches are
		     announced as unnamed checkboxes. -->
		<div class="switch-rows">
			<div class="switch-row">
				<label class="switch-label">
					<input
						type="checkbox"
						name="downloadable"
						value="1"
						bind:checked={downloadable}
						class="sr-checkbox"
						aria-labelledby="vr-switch-downloadable"
						aria-describedby="vr-switch-downloadable-state vr-switch-downloadable-hint"
					/>
					<span class="switch-visual"></span>
				</label>
				<div class="switch-text">
					<strong id="vr-switch-downloadable">{m.admin_vr_switch_downloadable()}</strong>
					<span id="vr-switch-downloadable-state">{downloadable ? m.admin_vr_switch_downloadable_on() : m.admin_vr_switch_downloadable_off()}</span>
				</div>
			</div>
			<!-- Keep this hint immediately after the downloadable switch-row: its
			     aria-describedby binds it to that checkbox, and a row inserted
			     between them would visually attach it to the wrong switch. -->
			<p class="field-hint switch-hint" id="vr-switch-downloadable-hint">{m.admin_vr_downloadable_hint()}</p>
			<div class="switch-row">
				<label class="switch-label">
					<input
						type="checkbox"
						name="nsfw"
						value="1"
						bind:checked={nsfw}
						class="sr-checkbox"
						aria-labelledby="vr-switch-nsfw"
						aria-describedby="vr-switch-nsfw-state"
					/>
					<span class="switch-visual"></span>
				</label>
				<div class="switch-text">
					<strong id="vr-switch-nsfw">{m.admin_vr_switch_nsfw()}</strong>
					<span id="vr-switch-nsfw-state">{nsfw ? m.admin_vr_switch_nsfw_on() : m.admin_vr_switch_nsfw_off()}</span>
				</div>
			</div>
			<div class="switch-row">
				<label class="switch-label">
					<input
						type="checkbox"
						name="published"
						value="1"
						bind:checked={published}
						class="sr-checkbox"
						aria-labelledby="vr-switch-published"
						aria-describedby="vr-switch-published-state"
					/>
					<span class="switch-visual"></span>
				</label>
				<div class="switch-text">
					<strong id="vr-switch-published">{m.admin_vr_switch_published()}</strong>
					<span id="vr-switch-published-state">{published ? m.admin_vr_switch_published_on() : m.admin_vr_switch_published_off()}</span>
				</div>
			</div>
		</div>
	</section>

	<div class="save-bar">
		<div class="save-actions">
			<a href="/admin/vr" class="btn btn-outline">{m.admin_cancel()}</a>
			<!-- Also locked while an upload is in flight: submitting then would
			     save without the pending modelUrl/media row, and the just-stored
			     file — referenced by nothing — gets reaped by the orphan sweep. -->
			<button type="submit" class="btn btn-primary" disabled={saving || uploading || mediaUploading}>
				{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}<Check size={16} /> {submitLabel}{/if}
			</button>
		</div>
	</div>
</form>

{#if isEdit}
	<form
		method="POST"
		action="?/delete"
		bind:this={deleteForm}
		style="display:none"
		use:enhance={() => {
			deleting = true;
			return async ({ update, result }) => {
				await update({ reset: false });
				deleting = false;
				if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? m.admin_vr_delete_failed());
				else if (result.type === 'error') toast.error(m.admin_something_wrong());
			};
		}}
	></form>
	<div class="danger-row">
		<button type="button" class="btn btn-destructive-outline" disabled={deleting} onclick={() => (confirmingDelete = true)}>
			{#if deleting}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
			{m.admin_vr_delete()}
		</button>
	</div>

	{#if confirmingDelete}
		<ConfirmDialog
			title={m.admin_vr_delete_title()}
			message={deleteMessage}
			confirmLabel={m.admin_vr_delete()}
			onconfirm={() => { confirmingDelete = false; deleteForm?.requestSubmit(); }}
			oncancel={() => (confirmingDelete = false)}
		/>
	{/if}
{/if}

{#if showNewArtist}
	<NewArtistDialog
		registryEnabled={registryEnabled}
		oncreated={onArtistCreated}
		oncancel={() => (showNewArtist = false)}
	/>
{/if}

<style>
	.artist-pick {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.artist-pick select {
		flex: 1;
		min-width: 0;
	}

	.new-artist-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		flex: none;
		border-radius: var(--radius-s);
		border: 1px solid var(--input);
		background: none;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.new-artist-btn:hover {
		color: var(--foreground);
		border-color: var(--ring);
	}

	.new-artist-btn:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 1px;
	}

	.back-link {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
		color: var(--muted-foreground); margin-bottom: 16px; text-decoration: none;
	}
	.back-link:hover { color: var(--foreground); }
	.page-header { margin-bottom: 24px; }
	.page-header h1 { font-size: 22px; margin: 0 0 4px; }
	.banner { padding: 12px 16px; border-radius: var(--radius-s); font-size: 13px; margin-bottom: 16px; }
	/* Destructive 12% tint carries the severity, --foreground carries the text:
	   a hardcoded #f87171 was 1.92:1 on light themes (R2-A5), and --destructive
	   over its own tint composites below 4.5:1 on three light themes (R3-A2 —
	   asserted in theme-contrast.test.ts against the composite surface). */
	.banner.err { background: color-mix(in srgb, var(--destructive) 12%, transparent); color: var(--foreground); }
	/* Inside a section the flex gap already spaces siblings; the banner's own
	   margin would stack on it (32px above the model hint reads as a section
	   boundary). The form-level banner above the form keeps its margin. */
	.section > .banner { margin-bottom: 0; }
	.banner-line { margin: 0; overflow-wrap: anywhere; }
	.banner-line + .banner-line { margin-top: 6px; }
	.form { display: flex; flex-direction: column; gap: 32px; max-width: 700px; }
	.section { display: flex; flex-direction: column; gap: 16px; }
	h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
	.fields { display: flex; flex-direction: column; gap: 14px; }
	label { display: flex; flex-direction: column; gap: 4px; }
	label span { font-size: 12px; color: var(--muted-foreground); }
	.field-hint { font-size: 11px; color: var(--muted-foreground); }
	.field-label { font-size: 12px; color: var(--muted-foreground); }
	.muted { color: var(--muted-foreground); font-size: 13px; }
	.input.sm { font-size: 12px; padding: 5px 8px; }

	.chip-field { display: flex; flex-direction: column; gap: 6px; border: none; padding: 0; margin: 0; }
	.chip-field legend { padding: 0; margin-bottom: 6px; }
	.platform-chips { display: flex; flex-wrap: wrap; gap: 8px; }
	.platform-chip {
		flex-direction: row; align-items: center; gap: 6px;
		font-size: 12px; padding: 4px 12px; border-radius: var(--radius-pill);
		border: 1px solid var(--border); color: var(--muted-foreground);
		cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s;
	}
	.platform-chip input { position: absolute; opacity: 0; width: 0; height: 0; }
	.platform-chip.on {
		border-color: var(--primary); color: var(--primary);
		background: color-mix(in srgb, var(--primary) 8%, transparent);
	}
	.platform-chip:has(input:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }

	.credit-list { display: flex; flex-direction: column; gap: 10px; }
	.credit-row {
		display: flex; align-items: flex-end; gap: 12px; padding: 12px;
		border: 1px solid var(--border); border-radius: var(--radius-s);
		background: var(--background);
		transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
	}
	.credit-row.dragging { opacity: 0.4; }
	.credit-row.drop-target { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary); background: color-mix(in srgb, var(--primary) 8%, var(--background)); }
	.drag-handle {
		display: flex; align-items: center; justify-content: center; width: 24px; align-self: stretch;
		padding: 0; background: none; border: none; color: var(--muted-foreground);
		cursor: grab; touch-action: none; flex-shrink: 0;
	}
	.drag-handle:hover { color: var(--foreground); }
	.drag-handle:active { cursor: grabbing; }
	.drag-handle:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--radius-xs); }
	.credit-fields { flex: 1; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; align-items: end; }
	.remove-btn {
		display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
		background: none; color: var(--muted-foreground); border: 1px solid var(--border);
		border-radius: var(--radius-xs); cursor: pointer; flex-shrink: 0; align-self: center;
	}
	.remove-btn:hover { color: var(--destructive); border-color: var(--destructive); }
	.add-credit-btn {
		display: inline-flex; align-items: center; gap: 5px; align-self: flex-start;
		font-size: 12px; padding: 4px 12px; border-radius: var(--radius-pill);
		border: 1px dashed var(--border); background: none; color: var(--primary); cursor: pointer;
	}
	.add-credit-btn:hover { border-color: var(--primary); }

	.upload-zone {
		display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
		padding: 28px 24px; border: 2px dashed var(--border); border-radius: var(--radius-s);
		color: var(--muted-foreground); cursor: pointer; font-size: 13px; text-align: center;
		transition: border-color 0.15s, background 0.15s; min-height: 88px;
	}
	.upload-zone:hover { border-color: var(--primary); }
	/* Highlight while a file is dragged over the zone (SONA-216) — same treatment
	   as the upload page's dropzone. The class is set by the drop attachment. */
	.upload-zone:global(.drag-over) { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 5%, transparent); }
	/* No pointer-events: none — the drop attachment has to receive dragover/drop
	   to preventDefault, or a drop while uploading navigates away from the form.
	   The nested input's own disabled attribute keeps clicks inert. */
	.upload-zone.disabled { opacity: 0.55; cursor: not-allowed; }
	/* Keeping pointer events also keeps :hover alive, so hold the resting border
	   while the zone is busy rather than inviting a click it won't take. */
	.upload-zone.disabled:hover { border-color: var(--border); }
	.sr-file { position: absolute; opacity: 0; width: 0; height: 0; }
	/* The hidden file inputs stay keyboard-focusable — surface focus on their
	   visible hosts (same :has pattern as .platform-chip). */
	.upload-zone:has(.sr-file:focus-visible),
	.btn-sm:has(.sr-file:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }

	/* Guide link under the model-format hint (mock frame 1, SONA-162). Grouped
	   with the hint; 12px so it doesn't outrank the field labels. The
	   --status-attention contrast rationale lives in /admin/vr/guide's CSS. */
	.model-hint-group { display: flex; flex-direction: column; gap: 6px; }
	.guide-link {
		display: inline-flex; align-items: center; gap: 7px; align-self: flex-start;
		font-size: 12px; color: var(--status-attention); text-decoration: none;
	}
	.guide-link:hover { text-decoration: underline; }
	.guide-link :global(svg) { flex: none; }

	.upload-progress { display: flex; flex-direction: column; gap: 6px; }
	.progress-bar { height: 6px; border-radius: var(--radius-pill); background: var(--secondary); overflow: hidden; }
	.progress-fill { height: 100%; background: var(--primary); transition: width 0.2s; }
	.progress-text {
		font-size: 12px; color: var(--muted-foreground);
		font-family: var(--font-primary); font-variant-numeric: tabular-nums;
	}

	.model-card {
		display: flex; align-items: center; gap: 12px; padding: 12px 14px;
		border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--card);
		color: var(--muted-foreground);
	}
	.model-info { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
	.model-name { font-size: 13px; font-weight: 500; color: var(--foreground); overflow-wrap: anywhere; }
	.model-meta {
		font-size: 11px; color: var(--muted-foreground);
		font-family: var(--font-primary); font-variant-numeric: tabular-nums;
	}
	.model-actions { display: flex; gap: 8px; flex-shrink: 0; }
	.btn-sm {
		display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 10px;
		border: 1px solid var(--border); border-radius: var(--radius-xs);
		background: var(--secondary); color: var(--foreground); cursor: pointer; flex-direction: row;
		transition: border-color 0.15s, background 0.15s;
	}
	.btn-sm:hover { border-color: var(--primary); }
	.btn-sm:global(.drag-over) { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, var(--secondary)); }

	/* Showcase media rows (same row chrome as the credit list). */
	.media-list { display: flex; flex-direction: column; gap: 10px; }
	.media-row {
		display: flex; align-items: center; gap: 12px; padding: 10px 12px;
		border: 1px solid var(--border); border-radius: var(--radius-s);
		background: var(--background);
		transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
	}
	.media-row.dragging { opacity: 0.4; }
	.media-row.drop-target { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary); background: color-mix(in srgb, var(--primary) 8%, var(--background)); }
	.media-thumb {
		width: 56px; height: 56px; border-radius: var(--radius-xs); overflow: hidden;
		background: var(--secondary); flex-shrink: 0;
	}
	.media-thumb img, .media-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
	.media-meta {
		flex: 1; font-size: 12px; color: var(--muted-foreground);
		font-family: var(--font-primary); font-variant-numeric: tabular-nums;
	}
	.media-zone { min-height: 72px; padding: 20px; }

	/* .sr-only comes from the global rule in app.css — no local copy. */

	.poster-section { display: flex; flex-direction: column; gap: 8px; }
	.poster-preview { position: relative; width: 160px; }
	.poster-preview img { width: 100%; border-radius: var(--radius-xs); display: block; }
	.remove-poster {
		display: inline-flex; align-items: center; gap: 4px; margin-top: 6px;
		font-size: 12px; padding: 3px 10px; border-radius: var(--radius-pill);
		border: 1px solid var(--border); background: none; color: var(--muted-foreground); cursor: pointer;
	}
	.remove-poster:hover { color: var(--destructive); border-color: var(--destructive); }
	/* Fixed tracks on BOTH axes, deliberately: with 1fr columns the cell's height
	   came only from its aspect-ratio, and Firefox does not feed an
	   aspect-ratio-derived height back into row track sizing — the rows were
	   sized from content (~17px while the lazy images had no intrinsic size)
	   while each cell painted at its derived ~77px, so every cell overflowed its
	   row and was overlapped by the next one, leaving a sliver of each image.
	   Layout APIs report the correct height throughout (reading one forces the
	   reflow that fixes it), so this is pinned in picker-grid-tracks.test.ts
	   rather than measured. Fixed 72px tracks are square by construction.
	   Verified against stock Firefox 153; Chromium and Playwright's patched
	   Firefox never showed the bug. */
	.poster-grid {
		display: grid; grid-template-columns: repeat(auto-fill, 72px); grid-auto-rows: 72px;
		justify-content: space-between; gap: 8px;
		max-height: 260px; overflow-y: auto; padding: 2px;
	}
	.poster-option {
		padding: 0; border: 2px solid transparent; border-radius: var(--radius-xs);
		overflow: hidden; background: var(--secondary); cursor: pointer; aspect-ratio: 1;
		transition: border-color 0.15s;
	}
	.poster-option:hover { border-color: var(--border); }
	.poster-option.selected { border-color: var(--primary); }
	/* The square comes from the IMG's aspect-ratio: engines that ignore
	   aspect-ratio on form controls size the button from its content, so the
	   old height:100% img fell back to its natural ratio — ragged cells once
	   images load, near-zero slivers while lazy images sit unloaded or 404.
	   The button's own aspect-ratio above is kept because the e2e squareness
	   test disables exactly that rule to prove this img rule holds the square
	   alone — deleting it would silently defuse the test. */
	.poster-option img { width: 100%; height: auto; aspect-ratio: 1; object-fit: cover; display: block; }

	.switch-rows { display: flex; flex-direction: column; gap: 14px; }
	.switch-row { display: flex; align-items: center; gap: 12px; }
	.switch-label { flex-direction: row; cursor: pointer; }
	.sr-checkbox { position: absolute; opacity: 0; width: 0; height: 0; }
	.switch-visual {
		display: inline-flex; align-items: center; width: 36px; height: 20px; flex-shrink: 0;
		border-radius: var(--radius-pill); background: var(--secondary); transition: background 0.15s;
	}
	.switch-visual::after {
		content: ''; width: 14px; height: 14px; border-radius: 50%; background: #fff;
		margin-left: 3px; transition: transform 0.15s;
	}
	.sr-checkbox:checked + .switch-visual { background: var(--primary); }
	.sr-checkbox:checked + .switch-visual::after { transform: translateX(16px); }
	.sr-checkbox:focus-visible + .switch-visual { outline: 2px solid var(--ring); outline-offset: 2px; }
	.switch-text { display: flex; flex-direction: column; gap: 1px; }
	/* Aligns with the text column: 36px switch + 12px row gap. */
	.switch-hint { margin-left: 48px; margin-top: -10px; }
	.switch-text strong { font-size: 13px; font-weight: 500; }
	.switch-text span { font-size: 11px; color: var(--muted-foreground); }

	.save-bar {
		display: flex; align-items: center; justify-content: flex-end; gap: 16px; flex-wrap: wrap;
		padding-top: 16px; border-top: 1px solid var(--border);
	}
	.save-actions { display: flex; gap: 12px; }

	.danger-row { max-width: 700px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); }
	.btn-destructive-outline {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 8px 16px;
		border: 1px solid var(--destructive); border-radius: var(--radius-s);
		background: none; color: var(--destructive); cursor: pointer;
	}
	.btn-destructive-outline:hover { background: color-mix(in srgb, var(--destructive) 10%, transparent); }
	.btn-destructive-outline:disabled { opacity: 0.55; cursor: progress; }

	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 640px) {
		.credit-fields { grid-template-columns: 1fr; }
		.model-card { flex-wrap: wrap; }
	}
</style>
