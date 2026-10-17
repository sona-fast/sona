<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';
	import CommissionForm from '$lib/components/CommissionForm.svelte';
	import CommissionIntro from '$lib/components/CommissionIntro.svelte';
	import * as m from '$lib/paraglide/messages';
	import { draftSnapshot } from '$lib/drafts';

	let { data, form } = $props();

	// The draft survives following a link off the page (the lookup's "Artists
	// page") and coming back with the browser's Back button. The form decides
	// what a draft is and when there's one.
	let commissionForm = $state<ReturnType<typeof CommissionForm>>();
	export const snapshot = draftSnapshot(() => commissionForm);
</script>

<a class="back-link" href="/admin/commissions"><ArrowLeft size={16} aria-hidden="true" /> {m.admin_commissions_back()}</a>
<div class="page-header"><h1>{m.admin_commissions_new_title()}</h1></div>
<CommissionIntro gate={data.gate} empty />

<!-- While the gate is closed the notice above says why there's no form. The
     create action refuses on the server either way. -->
{#if data.gate.open}
	<CommissionForm
		bind:this={commissionForm}
		artists={data.artists}
		characters={data.characters}
		{form}
		gaDate={data.gate.gaDate}
	/>
{/if}

<style>
	.back-link {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
		color: var(--muted-foreground); margin-bottom: 16px; text-decoration: none;
	}
	.back-link:hover { color: var(--foreground); }
	.page-header { margin-bottom: 12px; }
	.page-header h1 { font-size: 24px; margin: 0; }
</style>
