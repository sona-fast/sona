<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';

	let { form, data } = $props();

	let submitting = $state(false);
	// An expired-since-load token is caught on submit (form.invalidToken); otherwise
	// the load's verdict decides whether the form shows at all. (Only one of the
	// action's failure shapes carries invalidToken, so narrow before reading it.)
	let invalidOnSubmit = $derived(
		Boolean((form as { invalidToken?: boolean } | null | undefined)?.invalidToken)
	);
	let showForm = $derived(data.valid && !invalidOnSubmit);
	// When the invalid-token branch replaces the form, move focus to the error so
	// keyboard/screen-reader users aren't stranded on <body> (WCAG 2.4.3/4.1.3).
	let invalidEl = $state<HTMLParagraphElement | null>(null);
	$effect(() => {
		if (!showForm) invalidEl?.focus();
	});
</script>

<div class="reset-page">
	<div class="reset-card">
		<h1>{data.siteName}</h1>
		<p class="subtitle">{m.admin_reset_title()}</p>

		{#if showForm}
			{#if form?.error}
				<p class="error" role="alert">{form.error}</p>
			{/if}
			<form method="POST" use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}>
				<input type="hidden" name="token" value={data.token} />
				<label>
					<span>{m.admin_reset_new_password()}</span>
					<input type="password" name="password" class="input" required minlength="8" autocomplete="new-password" autofocus />
				</label>
				<label>
					<span>{m.admin_reset_confirm_password()}</span>
					<input type="password" name="confirmPassword" class="input" required minlength="8" autocomplete="new-password" />
				</label>
				<button type="submit" class="btn btn-primary full-width" disabled={submitting}>
					{submitting ? m.admin_reset_submitting() : m.admin_reset_submit()}
				</button>
			</form>
		{:else}
			<p class="error" role="alert" tabindex="-1" bind:this={invalidEl}>{m.admin_reset_invalid()}</p>
			<a href="/admin/forgot" class="back">{m.admin_reset_request_new()}</a>
		{/if}
	</div>
</div>

<style>
	.reset-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}

	.reset-card {
		width: 100%;
		max-width: 360px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		padding: 40px;
		text-align: center;
	}

	h1 {
		font-size: 24px;
		margin-bottom: 4px;
	}

	.subtitle {
		font-size: 14px;
		color: var(--muted-foreground);
		margin-bottom: 24px;
	}

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		text-align: left;
	}

	label span {
		display: block;
		font-size: 14px;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.full-width {
		width: 100%;
	}

	.back {
		display: inline-block;
		margin-top: 8px;
		font-size: 14px;
		color: var(--muted-foreground);
	}
</style>
