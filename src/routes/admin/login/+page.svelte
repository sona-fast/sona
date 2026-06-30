<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();
</script>

<div class="login-page">
	<div class="login-card">
		<h1>sparky.ink</h1>
		<p class="subtitle">Admin Login</p>

		{#if form?.error}
			<p class="error">{form.error}</p>
		{/if}

		<form method="POST" use:enhance>
			<label>
				<span>Password</span>
				<input type="password" name="password" class="input" required autofocus />
			</label>
			<button type="submit" class="btn btn-primary full-width">Sign In</button>
		</form>
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
