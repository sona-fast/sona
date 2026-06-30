<script lang="ts">
	import { enhance } from '$app/forms';
	import { APP_NAME } from '$lib/config';

	let { data, form } = $props();

	let storageProvider = $state<'uploadthing' | 'r2'>('uploadthing');
	let submitting = $state(false);
</script>

<div class="setup-page">
	<div class="setup-card">
		<h1>Welcome to {APP_NAME}</h1>
		<p class="subtitle">Let's set up your site. This runs once.</p>

		{#if data.setupBlocked}
			<div class="blocked">
				<p>
					Setup is locked because <code>SETUP_TOKEN</code> isn't configured. Set it with
					<code>wrangler pages secret put SETUP_TOKEN</code> (the setup CLI does this for you), then
					redeploy and reload this page.
				</p>
			</div>
		{:else}
			{#if form?.error}
				<p class="error">{form.error}</p>
			{/if}

			<form
				method="POST"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
					};
				}}
			>
				{#if data.tokenRequired}
					<section>
						<h2>Bootstrap token</h2>
						<label>
							<span>Setup token</span>
							<input type="password" name="setupToken" class="input" required autocomplete="off" />
							<small>Printed by the setup CLI (the <code>SETUP_TOKEN</code> secret).</small>
						</label>
					</section>
				{/if}

				<section>
					<h2>Admin password</h2>
					<p class="hint">You'll use this to sign in to the admin panel.</p>
					<label>
						<span>Password</span>
						<input type="password" name="password" class="input" required minlength="8" autocomplete="new-password" />
					</label>
					<label>
						<span>Confirm password</span>
						<input type="password" name="confirmPassword" class="input" required minlength="8" autocomplete="new-password" />
					</label>
				</section>

				<section>
					<h2>Your site</h2>
					<label>
						<span>Site name *</span>
						<input type="text" name="siteName" class="input" required placeholder="e.g. mysona.example" />
					</label>
					<label>
						<span>Owner / persona name</span>
						<input type="text" name="ownerName" class="input" placeholder="Shown on the About page" />
					</label>
					<label>
						<span>Fursona / character name</span>
						<input type="text" name="fursonaName" class="input" placeholder="The character this site is about" />
					</label>
					<label>
						<span>About text</span>
						<textarea name="aboutText" class="input" rows="3" placeholder="A short description of your site"></textarea>
					</label>
				</section>

				<section>
					<h2>Social links <span class="optional">(optional)</span></h2>
					<div class="grid">
						<label><span>Twitter / X</span><input type="text" name="twitter" class="input" /></label>
						<label><span>Bluesky</span><input type="text" name="bluesky" class="input" /></label>
						<label><span>Telegram</span><input type="text" name="telegram" class="input" /></label>
						<label><span>FurAffinity</span><input type="text" name="furaffinity" class="input" /></label>
						<label><span>FurTrack</span><input type="text" name="furtrack" class="input" /></label>
						<label><span>Primary character (FurTrack tag)</span><input type="text" name="primaryCharacter" class="input" /></label>
					</div>
				</section>

				<section>
					<h2>Image storage</h2>
					<label>
						<span>Provider</span>
						<select name="storageProvider" class="input" bind:value={storageProvider}>
							<option value="uploadthing">UploadThing</option>
							<option value="r2">Cloudflare R2</option>
						</select>
					</label>
					{#if storageProvider === 'r2'}
						<label>
							<span>R2 public URL</span>
							<input type="text" name="r2PublicUrl" class="input" placeholder="https://cdn.example.com" />
							<small>Your R2 bucket's custom domain.</small>
						</label>
					{:else}
						<p class="hint">Set the <code>UPLOADTHING_TOKEN</code> secret for uploads to work.</p>
					{/if}
				</section>

				<button type="submit" class="btn btn-primary btn-lg full-width" disabled={submitting}>
					{submitting ? 'Setting up…' : 'Finish setup'}
				</button>
			</form>
		{/if}
	</div>
</div>

<style>
	.setup-page {
		min-height: 100vh;
		display: flex;
		justify-content: center;
		padding: 48px 24px;
	}
	.setup-card {
		width: 100%;
		max-width: 560px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		padding: 40px;
	}
	h1 {
		font-size: 26px;
		margin-bottom: 4px;
	}
	.subtitle {
		font-size: 14px;
		color: var(--muted-foreground);
		margin-bottom: 24px;
	}
	section {
		margin-bottom: 28px;
	}
	section h2 {
		font-size: 13px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		margin-bottom: 12px;
		border-bottom: 1px solid var(--border);
		padding-bottom: 6px;
	}
	.optional {
		text-transform: none;
		letter-spacing: 0;
		opacity: 0.6;
	}
	label {
		display: block;
		margin-bottom: 14px;
	}
	label span {
		display: block;
		font-size: 14px;
		font-weight: 500;
		margin-bottom: 6px;
	}
	label small {
		display: block;
		font-size: 12px;
		color: var(--muted-foreground);
		margin-top: 4px;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 16px;
	}
	.hint {
		font-size: 13px;
		color: var(--muted-foreground);
		margin-bottom: 12px;
	}
	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}
	.blocked {
		font-size: 14px;
		line-height: 1.6;
		color: var(--muted-foreground);
	}
	code {
		font-family: var(--font-primary);
		font-size: 0.9em;
		background: var(--secondary);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
	}
	.full-width {
		width: 100%;
	}
	@media (max-width: 560px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.setup-card {
			padding: 28px 20px;
			border: none;
		}
	}
</style>
