<script lang="ts">
	import { enhance } from '$app/forms';
	import { APP_NAME } from '$lib/config';
	import { THEMES } from '$lib/themes';
	import { LANDING_LAYOUTS } from '$lib/landing';
	import CopyCommand from '$lib/components/CopyCommand.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let submitting = $state(false);
</script>

<div class="setup-page">
	<div class="setup-card">
		<h1>{m.admin_setup_welcome({ appName: APP_NAME })}</h1>
		<p class="subtitle">{m.admin_setup_subtitle()}</p>

		{#if data.setupBlocked}
			<div class="blocked">
				<p>
					{m.admin_setup_blocked_locked_pre()}<code>SETUP_TOKEN</code>{m.admin_setup_blocked_locked_post()}
					{m.admin_setup_secret_ci_pre()}
				</p>
				<CopyCommand text="gh secret set SETUP_TOKEN" />
				<p>{m.admin_setup_secret_ci_post_a()}<strong>{m.admin_setup_secret_ci_ui_path()}</strong>{m.admin_setup_secret_ci_post_b()}</p>
				<p>
					{m.admin_setup_blocked_set_pre()}<code>wrangler pages secret put SETUP_TOKEN</code>{m.admin_setup_blocked_set_post()}
				</p>
			</div>
		{:else}
			{#if form?.error}
				<!-- The form submits without navigating, so the message appears with no
				     focus change; role="alert" is what announces it. -->
				<p class="error" role="alert">{form.error}</p>
			{/if}

			<form
				method="POST"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						// Keep what the operator typed/picked when the submit fails —
						// the default reset silently reverts selects (e.g. theme) to
						// their first option, and a blind resubmit then saves those
						// defaults instead of the chosen values.
						await update({ reset: false });
						submitting = false;
					};
				}}
			>
				{#if data.tokenRequired}
					<section>
						<h2>{m.admin_setup_bootstrap_token()}</h2>
						<label>
							<span>{m.admin_setup_token_label()}</span>
							<input type="password" name="setupToken" class="input" required autocomplete="off" />
							<small>{m.admin_setup_token_hint_pre()}<code>SETUP_TOKEN</code>{m.admin_setup_token_hint_post()}</small>
						</label>
					</section>
				{/if}

				<section>
					<h2>{m.admin_setup_admin_password()}</h2>
					<p class="hint">{m.admin_setup_password_hint()}</p>
					<label>
						<span>{m.admin_field_password()}</span>
						<input type="password" name="password" class="input" required minlength="8" autocomplete="new-password" />
					</label>
					<label>
						<span>{m.admin_field_confirm_password()}</span>
						<input type="password" name="confirmPassword" class="input" required minlength="8" autocomplete="new-password" />
					</label>
					<label>
						<span>{m.admin_setup_recovery_email()} <span class="optional">{m.admin_setup_optional()}</span></span>
						<input type="email" name="adminEmail" class="input" autocomplete="email" placeholder={m.admin_setup_recovery_email_placeholder()} />
						<small>{m.admin_setup_recovery_email_hint()}</small>
					</label>
				</section>

				<section>
					<h2>{m.admin_setup_your_site()}</h2>
					<label>
						<span>{m.admin_setup_site_name()} *</span>
						<input type="text" name="siteName" class="input" required placeholder={m.admin_setup_site_name_placeholder()} />
					</label>
					<label>
						<span>{m.admin_setup_owner_name()}</span>
						<input type="text" name="ownerName" class="input" placeholder={m.admin_setup_owner_placeholder()} />
					</label>
					<label>
						<span>{m.admin_setup_fursona_name()}</span>
						<input type="text" name="fursonaName" class="input" placeholder={m.admin_setup_fursona_placeholder()} />
					</label>
					<label>
						<span>{m.admin_setup_about_text()}</span>
						<textarea name="aboutText" class="input" rows="3" placeholder={m.admin_setup_about_placeholder()}></textarea>
					</label>
				</section>

				<section>
					<h2>{m.admin_setup_social_links()} <span class="optional">{m.admin_setup_optional()}</span></h2>
					<div class="grid">
						<label><span>Twitter / X</span><input type="text" name="twitter" class="input" /></label>
						<label><span>Bluesky</span><input type="text" name="bluesky" class="input" /></label>
						<label><span>Instagram</span><input type="text" name="instagram" class="input" /></label>
						<label><span>Telegram</span><input type="text" name="telegram" class="input" /></label>
						<label><span>FurAffinity</span><input type="text" name="furaffinity" class="input" /></label>
						<!-- FurTrack sits last of the socials so it stays next to the
						     primary-character field, which is labelled as the FurTrack tag. -->
						<label><span>FurTrack</span><input type="text" name="furtrack" class="input" /></label>
						<label><span>{m.admin_setup_primary_character()}</span><input type="text" name="primaryCharacter" class="input" /></label>
					</div>
				</section>

				<section>
					<h2>{m.admin_setup_appearance()}</h2>
					<label>
						<span>{m.admin_setup_theme()}</span>
						<select name="themeId" class="input">
							{#each THEMES as t}
								<option value={t.id}>{t.label}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>{m.admin_setup_landing_layout()}</span>
						<select name="landingLayout" class="input">
							{#each LANDING_LAYOUTS as l}
								<option value={l.id}>{l.label}</option>
							{/each}
						</select>
						<small>{m.admin_setup_change_later()}</small>
					</label>
				</section>

				<button type="submit" class="btn btn-primary btn-lg full-width" disabled={submitting}>
					{submitting ? m.admin_setup_submitting() : m.admin_setup_finish()}
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
	/* Direct child only: a nested inline <span class="optional"> (e.g. on the
	   recovery-email label) must stay inline, not be forced onto its own line. */
	label > span {
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
	.blocked p:not(:first-child) {
		margin-top: 10px;
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
