<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';

	let { form, data } = $props();

	let signingIn = $state(false);

	// Cloudflare Turnstile: rendered only when the fork configured a site key. We
	// render explicitly (rather than the implicit class scan) so it also appears on
	// client-side navigations to this page, and so we hold a widget id to reset the
	// single-use token after a failed submit — siteverify consumes the token, so a
	// retry needs a fresh one.
	let widgetEl = $state<HTMLDivElement>();
	let widgetId: string | undefined;
	// Holds the solved token so we can keep the submit button disabled until the
	// widget solves — a click before then just 403s (recoverable, but confusing).
	let turnstileToken = $state('');

	onMount(() => {
		const sitekey = data.turnstileSitekey;
		if (!sitekey) return;
		const render = () => {
			const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
			if (!ts || !widgetEl) return;
			widgetId = ts.render(widgetEl, {
				sitekey,
				theme: 'auto',
				callback: (t: string) => (turnstileToken = t),
				'expired-callback': () => (turnstileToken = '')
			});
		};
		if ((window as unknown as { turnstile?: TurnstileApi }).turnstile) {
			render();
			return;
		}
		const s = document.createElement('script');
		s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		s.async = true;
		s.onload = render;
		document.head.appendChild(s);
	});

	function resetTurnstile() {
		turnstileToken = '';
		const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
		if (ts && widgetId !== undefined) ts.reset(widgetId);
	}

	interface TurnstileApi {
		render(
			el: HTMLElement,
			opts: {
				sitekey: string;
				theme?: string;
				callback?: (token: string) => void;
				'expired-callback'?: () => void;
			}
		): string;
		reset(id?: string): void;
	}
</script>

<div class="login-page">
	<div class="login-card">
		<h1>{data.siteName}</h1>
		<p class="subtitle">{m.admin_login_subtitle()}</p>

		{#if data.resetSuccess}
			<p class="notice">{m.admin_login_reset_success()}</p>
		{/if}

		{#if form?.error}
			<p class="error">{form.error}</p>
		{/if}

		<form method="POST" use:enhance={() => {
			signingIn = true;
			return async ({ update }) => {
				await update();
				signingIn = false;
				// The submitted token was redeemed by siteverify (single-use); clear the
				// widget so a retry after a wrong password gets a fresh one.
				resetTurnstile();
			};
		}}>
			<label>
				<span>{m.admin_field_password()}</span>
				<input type="password" name="password" class="input" required autofocus />
			</label>
			{#if data.turnstileSitekey}
				<div bind:this={widgetEl} class="turnstile"></div>
			{/if}
			<button
				type="submit"
				class="btn btn-primary full-width"
				disabled={signingIn || (!!data.turnstileSitekey && !turnstileToken)}
			>
				{signingIn ? m.admin_login_signing_in() : m.admin_login_sign_in()}
			</button>
		</form>

		<a href="/admin/forgot" class="forgot">{m.admin_login_forgot_password()}</a>
	</div>
</div>

<style>
	.login-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}

	.login-card {
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

	/* Light success treatment, shared with the forgot-password confirmation: a
	   subtle green-tinted card. Text stays --foreground so contrast holds in every
	   theme. */
	.notice {
		font-size: 14px;
		margin-bottom: 16px;
		text-align: left;
		color: var(--foreground);
		background: color-mix(in srgb, #16a34a 12%, var(--card));
		border: 1px solid color-mix(in srgb, #16a34a 35%, transparent);
		border-radius: var(--radius-s);
		padding: 10px 12px;
	}

	.forgot {
		display: inline-block;
		margin-top: 20px;
		font-size: 14px;
		color: var(--muted-foreground);
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
</style>
