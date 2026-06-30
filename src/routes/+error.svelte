<script lang="ts">
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
</script>

<div class="error-page">
	<p class="status-code">{page.status}</p>
	{#if page.status === 404}
		<h1>{m.error_404_title()}</h1>
		<p class="message">{m.error_404_message()}</p>
	{:else}
		<h1>{m.error_generic_title()}</h1>
		<p class="message">{page.error?.message ?? m.error_generic_fallback()}</p>
	{/if}
	<div class="actions">
		<a href="/" class="btn btn-outline">{m.error_back_home()}</a>
		<a href="/gallery" class="btn btn-primary">{m.error_browse_gallery()}</a>
	</div>
</div>

<style>
	.error-page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 96px 24px;
		gap: 16px;
		min-height: 60vh;
	}

	.status-code {
		font-family: var(--font-primary);
		font-size: 96px;
		font-weight: 700;
		color: var(--primary);
		line-height: 1;
		margin-bottom: 8px;
	}

	.error-page h1 {
		font-size: 28px;
	}

	.message {
		font-size: 15px;
		color: var(--muted-foreground);
		max-width: 420px;
	}

	.actions {
		display: flex;
		gap: 12px;
		margin-top: 16px;
		flex-wrap: wrap;
		justify-content: center;
	}

	@media (max-width: 768px) {
		.error-page {
			padding: 64px 20px;
			min-height: 50vh;
		}

		.status-code {
			font-size: 72px;
		}

		.error-page h1 {
			font-size: 22px;
		}

		.actions {
			flex-direction: column;
			width: 100%;
		}

		.actions .btn {
			width: 100%;
		}
	}
</style>
