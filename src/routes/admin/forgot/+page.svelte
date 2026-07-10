<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';

	let { form, data } = $props();

	let submitting = $state(false);
	// Move focus to the confirmation once the form is replaced by it, so
	// keyboard/screen-reader users aren't stranded on <body> (WCAG 2.4.3/4.1.3).
	let noticeEl = $state<HTMLParagraphElement | null>(null);
	$effect(() => {
		if (form?.sent) noticeEl?.focus();
	});
</script>

<div class="forgot-page">
	<div class="forgot-card">
		<h1>{data.siteName}</h1>
		<p class="subtitle">{m.admin_forgot_title()}</p>

		{#if form?.sent}
			<p class="notice" role="status" tabindex="-1" bind:this={noticeEl}>{m.admin_forgot_sent()}</p>
			<a href="/admin/login" class="back">{m.admin_forgot_back_to_login()}</a>
		{:else}
			<p class="hint" id="forgot-hint">{m.admin_forgot_hint()}</p>
			<form method="POST" use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}>
				<label>
					<span>{m.admin_forgot_email_label()}</span>
					<input type="email" name="email" class="input" required autocomplete="email" aria-describedby="forgot-hint" />
				</label>
				<button type="submit" class="btn btn-primary full-width" disabled={submitting}>
					{submitting ? m.admin_forgot_sending() : m.admin_forgot_send()}
				</button>
			</form>
			<a href="/admin/login" class="back">{m.admin_forgot_back_to_login()}</a>
		{/if}
	</div>
</div>

<style>
	.forgot-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}

	.forgot-card {
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

	.hint {
		font-size: 14px;
		color: var(--muted-foreground);
		margin-bottom: 16px;
		text-align: left;
	}

	/* Light success treatment, shared with the ?reset=1 login notice: a subtle
	   green-tinted card. Text stays --foreground so contrast holds in every theme. */
	.notice {
		font-size: 14px;
		margin-bottom: 20px;
		text-align: left;
		color: var(--foreground);
		background: color-mix(in srgb, #16a34a 12%, var(--card));
		border: 1px solid color-mix(in srgb, #16a34a 35%, transparent);
		border-radius: var(--radius-s);
		padding: 10px 12px;
	}

	/* Focused programmatically (tabindex="-1") to announce the confirmation to
	   screen readers; not keyboard-reachable, so suppress the default outline. */
	.notice:focus {
		outline: none;
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
		margin-top: 20px;
		font-size: 14px;
		color: var(--muted-foreground);
	}
</style>
