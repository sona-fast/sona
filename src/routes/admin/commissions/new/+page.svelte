<script lang="ts">
	import type { PageData } from './$types';
	import { page } from '$app/state';
	import { ArrowLeft } from 'lucide-svelte';
	import CommissionForm from '$lib/components/CommissionForm.svelte';
	import CommissionIntro from '$lib/components/CommissionIntro.svelte';
	import * as m from '$lib/paraglide/messages';
	import { draftSnapshot } from '$lib/drafts';

	let { form } = $props();
	// Read from `page`, not the `data` prop: a Back press that interrupts a
	// navigation between two ledger pages can leave the prop holding the other
	// page's data for good (sveltejs/kit#13276), while `page.data` is this page's.
	const data = $derived(page.data as PageData);

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
		recentCurrencies={data.recentCurrencies}
		recentKinds={data.recentKinds}
		localeCurrency={data.localeCurrency}
		registryEnabled={data.registryEnabled}
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
