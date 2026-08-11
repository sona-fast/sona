<script lang="ts">
	import { Box, Plus, Pencil, ExternalLink } from 'lucide-svelte';
	import {
		externalSiteName,
		formatBytes,
		isPermissiveVrLicense,
		licenseLabel,
		modelFormatDetailLabel
	} from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const gated = $derived(!data.publishingEnabled);

	// The Download column shows the EFFECTIVE state the route enforces, not the
	// raw flag: downloadable=true still 403s under a restrictive license or with
	// no recorded permission, and "On · All rights reserved" would read as live.
	function downloadState(avatar: (typeof data.avatars)[number]): string {
		if (!avatar.downloadable) return m.admin_vr_download_off();
		if (!isPermissiveVrLicense(avatar.license)) return m.admin_vr_download_blocked_license();
		if (!avatar.hasPermission) return m.admin_vr_download_blocked_permission();
		return `${m.admin_vr_download_on()} · ${licenseLabel(avatar.license)}`;
	}
	function downloadActive(avatar: (typeof data.avatars)[number]): boolean {
		return avatar.downloadable && isPermissiveVrLicense(avatar.license) && avatar.hasPermission;
	}
	// A BLOCKED download (flag on, but license/permission refuses it) is a
	// conflict the owner should notice — distinct from a deliberate "Off".
	function downloadBlocked(avatar: (typeof data.avatars)[number]): boolean {
		return avatar.downloadable && !downloadActive(avatar);
	}
</script>

{#if gated && data.avatars.length === 0}
	<!-- Gate empty-state (mock vr-avatars-gated): the section exists but creating
	     needs GA or a supporter key. Reading isn't gated — there's just nothing
	     to read yet. -->
	<div class="gate-empty">
		<Box size={36} />
		<h1>{m.admin_vr_gate_title()}</h1>
		<p class="gate-body">
			{data.gaDateDisplay
				? m.admin_vr_gate_body({ date: data.gaDateDisplay })
				: m.admin_vr_gate_body_nodate()}
		</p>
		<a href="/admin/settings?tab=account" class="btn btn-primary">{m.admin_vr_gate_cta()}</a>
		<p class="gate-hint">{m.admin_vr_gate_hint()}</p>
	</div>
{:else}
	<div class="page-header">
		<div>
			<h1>{m.admin_nav_vr()}</h1>
			<p class="subtitle">{m.admin_vr_subtitle({ count: data.avatars.length })}</p>
		</div>
		<div class="header-actions">
			{#if !gated}
				<a href="/admin/vr/new" class="btn btn-primary"><Plus size={16} /> {m.admin_vr_add()}</a>
			{/if}
		</div>
	</div>

	{#if gated}
		<!-- Existing avatars stay readable while gated; only creating/publishing is
		     locked, so the Add button gives way to the gate banner. One dedicated
		     message — component-side "title — body" concatenation is
		     untranslatable and repeated "VR avatars" twice. -->
		<div class="gate-banner">
			<Box size={18} />
			<span class="gate-banner-msg">
				{data.gaDateDisplay
					? m.admin_vr_gate_banner({ date: data.gaDateDisplay })
					: m.admin_vr_gate_title()}
			</span>
			<a href="/admin/settings?tab=account" class="gate-banner-link">{m.admin_vr_gate_cta()}</a>
		</div>
	{/if}

	{#if data.avatars.length === 0}
		<div class="empty">
			<Box size={36} />
			<p>{m.admin_vr_empty()}</p>
		</div>
	{:else}
		<div class="table-wrapper">
			<table class="data-table">
				<thead>
					<tr>
						<th class="col-poster"><span class="sr-only">{m.vr_media_poster()}</span></th>
						<th>{m.admin_vr_col_avatar()}</th>
						<th class="col-character">{m.admin_vr_col_character()}</th>
						<th class="col-model">{m.admin_vr_col_model()}</th>
						<th class="col-platforms">{m.admin_vr_col_platforms()}</th>
						<th class="col-visibility">{m.admin_vr_col_visibility()}</th>
						<th class="col-download">{m.admin_vr_col_download()}</th>
						<th class="col-actions">{m.admin_col_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each data.avatars as avatar (avatar.id)}
						<!-- data-label feeds the mobile card layout's ::before column
						     labels — localized like the <th>s (the label-suppressing CSS
						     hooks below select by class, never by label text). -->
						<tr>
							<td class="col-poster" data-label={m.vr_media_poster()}>
								<div class="poster-thumb" class:has-poster={!!avatar.posterUrl}>
									{#if avatar.posterUrl}
										<img src={avatar.posterUrl} alt="" loading="lazy" />
									{:else}
										<!-- Box glyph, not a bare grey square (reads as broken). -->
										<Box size={16} aria-hidden="true" />
									{/if}
								</div>
							</td>
							<td class="col-avatar" data-label={m.admin_vr_col_avatar()}>
								<div class="avatar-cell">
									<span class="avatar-name">{avatar.name}</span>
									<span class="avatar-slug">/vr/{avatar.slug}</span>
								</div>
							</td>
							<td class="col-character" data-label={m.admin_vr_col_character()}>{avatar.characterName}</td>
							<td class="col-model" data-label={m.admin_vr_col_model()}>
								{#if avatar.hasModel}
									<span class="model-chip">{modelFormatDetailLabel(avatar.modelFormat)} · {formatBytes(avatar.modelSizeBytes)}</span>
								{:else if avatar.externalUrl}
									<a href={avatar.externalUrl} target="_blank" rel="noopener" class="model-chip external">
										{externalSiteName(avatar.externalUrl)}
										<ExternalLink size={11} aria-hidden="true" />
									</a>
								{:else}
									<span class="model-none">—</span>
								{/if}
							</td>
							<td class="col-platforms" data-label={m.admin_vr_col_platforms()}>{avatar.platformCount}</td>
							<td class="col-visibility" data-label={m.admin_vr_col_visibility()}>
								<!-- Two chips, not one: Mature is a content warning and must not
								     inherit the Published chip's success green (DS8). -->
								<span class="vis-chip" class:published={avatar.published}>
									{avatar.published ? m.admin_vr_chip_published() : m.admin_vr_chip_draft()}
								</span>
								{#if avatar.nsfw}
									<!-- Poster-inherited Mature gets its own label + tooltip (SONA-159):
									     the edit form's "Mark as NSFW" toggle is off in that case, and an
									     unlabelled chip reads as a broken toggle. -->
									{#if avatar.nsfwFromPoster}
										<span class="vis-chip mature" title={m.admin_vr_chip_mature_poster_title()}>{m.admin_vr_chip_mature_poster()}</span>
									{:else}
										<span class="vis-chip mature">{m.admin_vr_chip_mature()}</span>
									{/if}
								{/if}
							</td>
							<td class="col-download" data-label={m.admin_vr_col_download()}>
								<span
									class="dl-text"
									class:off={!downloadActive(avatar)}
									class:blocked={downloadBlocked(avatar)}>{downloadState(avatar)}</span
								>
							</td>
							<td class="col-actions" data-label={m.admin_col_actions()}>
								<a href="/admin/vr/{avatar.id}/edit" class="icon-btn" aria-label={m.admin_vr_edit_aria({ name: avatar.name })}>
									<Pencil size={15} />
								</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<p class="storage-line">
			{m.admin_vr_storage_line({ used: formatBytes(data.storage.usedBytes), limit: formatBytes(data.storage.limitBytes) })}
		</p>
	{/if}
{/if}

<style>
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 24px;
		flex-wrap: wrap;
	}
	h1 { font-size: 22px; margin: 0 0 4px; }
	.subtitle { font-size: 13px; color: var(--muted-foreground); margin: 0; }
	.header-actions { display: flex; gap: 10px; flex-wrap: wrap; }

	/* Gate empty-state (mock vr-avatars-gated) */
	.gate-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 64px 24px;
		text-align: center;
		color: var(--muted-foreground);
	}
	/* Same size as the list state's h1 — the page shouldn't retitle itself
	   smaller just because it's empty. */
	.gate-empty h1 { font-size: 22px; color: var(--foreground); margin: 0; }
	.gate-body { font-size: 13px; line-height: 1.6; max-width: 48ch; margin: 0; }
	.gate-hint { font-size: 12px; color: var(--muted-foreground); margin: 0; }

	/* Gate banner shown above the list when avatars already exist */
	.gate-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--card);
		font-size: 13px;
		margin-bottom: 16px;
	}
	.gate-banner :global(svg) { flex-shrink: 0; color: var(--muted-foreground); }
	.gate-banner-msg { flex: 1; min-width: 0; }
	.gate-banner-link { flex-shrink: 0; color: var(--primary); font-weight: 600; text-decoration: underline; white-space: nowrap; }

	.empty {
		display: flex; flex-direction: column; align-items: center; gap: 8px;
		padding: 48px; color: var(--muted-foreground); text-align: center;
	}

	.table-wrapper { border: 1px solid var(--border); border-radius: var(--radius-s); overflow: hidden; }
	.data-table td { vertical-align: middle; }
	.col-poster { width: 56px; }
	.col-character { width: 130px; }
	.col-model { width: 160px; }
	.col-platforms { width: 90px; }
	.col-visibility { width: 140px; }
	.col-download { width: 150px; }
	.col-actions { width: 56px; white-space: nowrap; }

	.poster-thumb {
		width: 40px; height: 40px; border-radius: var(--radius-xs);
		background: var(--secondary); overflow: hidden;
		display: flex; align-items: center; justify-content: center;
		color: var(--muted-foreground);
	}
	.poster-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

	.avatar-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
	.avatar-name { font-weight: 500; }
	.avatar-slug { font: 11px var(--font-primary); color: var(--muted-foreground); }
	.col-character { font-size: 13px; }
	.col-platforms { font: 13px var(--font-primary); }

	.model-chip {
		display: inline-flex; align-items: center; gap: 4px;
		padding: 2px 8px; border-radius: var(--radius-pill);
		/* --foreground, not --muted-foreground: muted on --secondary is 3.96:1 on
		   the terracotta light theme (see theme-contrast.test.ts SONA-124 block). */
		background: var(--secondary); color: var(--foreground);
		font-size: 11px; font-weight: 500;
		font-family: var(--font-primary);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.model-chip.external { text-decoration: none; }
	.model-chip.external:hover { color: var(--foreground); }
	.model-none { color: var(--muted-foreground); }

	.vis-chip {
		display: inline-block; padding: 2px 8px; border-radius: var(--radius-pill);
		font-size: 11px; font-weight: 500;
		/* --foreground on --secondary — see the .model-chip contrast note. */
		background: var(--secondary); color: var(--foreground);
		white-space: nowrap;
	}
	/* --status-ok, not a hardcoded dark-green: the raw #4ade80 was 1.45:1 on the
	   light themes — invisible, and this chip is the only Published/Draft signal. */
	.vis-chip.published {
		background: color-mix(in srgb, var(--status-ok) 15%, transparent);
		color: var(--status-ok);
	}
	/* Mature is a content warning, not a success state — its own chip keeps it
	   off the Published green (DS8). */
	.vis-chip.mature {
		background: color-mix(in srgb, var(--status-warn) 15%, transparent);
		color: var(--status-warn);
	}

	.dl-text { font-size: 12px; white-space: nowrap; }
	.dl-text.off { color: var(--muted-foreground); }
	/* Downloadable is ON but license/permission refuses it: a conflict worth
	   noticing, not the same muted grey as a deliberate "Off" (DS5). */
	.dl-text.blocked { color: var(--status-warn); }

	.icon-btn {
		background: none; border: none; color: var(--muted-foreground); cursor: pointer;
		padding: 4px; border-radius: var(--radius-xs); display: inline-flex; transition: color 0.15s;
	}
	.icon-btn:hover { color: var(--foreground); }

	.storage-line { font-size: 12px; color: var(--muted-foreground); margin: 10px 2px 0; }

	/* .sr-only comes from the global rule in app.css — no local copy. */

	/* Mobile: collapse into stacked cards (same shape as /admin/stickers). */
	@media (max-width: 640px) {
		.table-wrapper { border: none; border-radius: 0; }
		.data-table { display: block; }
		.data-table thead { display: none; }
		.data-table tbody { display: flex; flex-direction: column; gap: 12px; }
		.data-table tr {
			display: block;
			border: 1px solid var(--border);
			border-radius: var(--radius-s);
			background: var(--card, var(--secondary));
			padding: 12px 14px;
		}
		.data-table td {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			width: auto !important;
			padding: 6px 0;
			border: none;
			white-space: normal;
		}
		.data-table td + td { border-top: 1px solid var(--border); }
		.data-table td::before {
			content: attr(data-label);
			font: 600 11px var(--font-secondary);
			color: var(--muted-foreground);
			text-transform: uppercase;
			letter-spacing: 0.04em;
			flex-shrink: 0;
		}
		/* Class hooks, NOT [data-label='…'] — the labels are localized. */
		.data-table td.col-avatar { display: block; padding-top: 0; }
		.data-table td.col-avatar::before { display: none; }
		.data-table td.col-poster { display: block; padding-top: 0; }
		.data-table td.col-poster::before { display: none; }
		.avatar-name { font-size: 15px; }
		.col-actions { justify-content: flex-end; }
		.col-actions .icon-btn { padding: 8px; }
	}
</style>
