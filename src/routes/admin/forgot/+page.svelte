<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';

	let { form, data } = $props();

	let submitting = $state(false);
</script>

<div class="forgot-page">
	<div class="forgot-card">
		<h1>{data.siteName}</h1>
		<p class="subtitle">{m.admin_forgot_title()}</p>

		{#if form?.sent}
			<p class="notice">{m.admin_forgot_sent()}</p>
			<a href="/admin/login" class="back">{m.admin_forgot_back_to_login()}</a>
		{:else}
			<p class="hint">{m.admin_forgot_hint()}</p>
			<form method="POST" use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}>
				<label>
					<span>{m.admin_forgot_email_label()}</span>
					<input type="email" name="email" class="input" required autofocus autocomplete="email" />
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

	.notice {
		font-size: 14px;
		margin-bottom: 20px;
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
