<script lang="ts">
	import { Box, ArrowLeft } from 'lucide-svelte';
	import VrAvatarForm from '$lib/components/VrAvatarForm.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();
</script>

{#if !data.publishingEnabled}
	<!-- Creating is locked while gated (mock vr-avatars-gated); the server action
	     refuses too — this page just doesn't offer a dead form. -->
	<a class="back-link" href="/admin/vr"><ArrowLeft size={16} /> {m.admin_vr_back()}</a>
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
	<VrAvatarForm
		heading={m.admin_vr_add()}
		submitLabel={m.admin_vr_create()}
		artists={data.artists}
		registryEnabled={data.registryEnabled}
		characters={data.characters}
		images={data.images}
		{form}
		publishingEnabled={data.publishingEnabled}
	/>
{/if}

<style>
	.back-link {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
		color: var(--muted-foreground); margin-bottom: 16px; text-decoration: none;
	}
	.back-link:hover { color: var(--foreground); }
	.gate-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 64px 24px;
		text-align: center;
		color: var(--muted-foreground);
	}
	.gate-empty h1 { font-size: 18px; color: var(--foreground); margin: 0; }
	.gate-body { font-size: 13px; line-height: 1.6; max-width: 48ch; margin: 0; }
	.gate-hint { font-size: 12px; color: var(--muted-foreground); margin: 0; }
</style>
