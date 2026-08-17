<script lang="ts">
	import { page } from '$app/state';
	import { Camera, Mail, Globe, Info, CircleCheck } from 'lucide-svelte';
	import LinkRow from '$lib/components/LinkRow.svelte';
	import Callout from '$lib/components/Callout.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import * as m from '$lib/paraglide/messages';
	import { socialAtHandle } from '$lib/social-label';

	let { data } = $props();

	// The row's title already says "Telegram", and the subtitle copy is built
	// around a handle — with none derivable there is no sentence to write, so the
	// row goes out with its title alone rather than "Send directly to Telegram".
	const tgAtHandle = $derived(socialAtHandle('telegram', data.settings.telegramUrl));

	// The persona's name for the "photos of {name}" copy.
	const personaName = $derived(data.settings.ownerName || data.settings.siteName);
</script>

<Meta
	title={`${m.share_title()} — ${data.settings.siteName}`}
	description={m.share_subtitle({ name: personaName })}
	url={`${page.url.origin}/share`}
	siteName={data.settings.siteName}
/>

<section class="hero">
	<Camera class="hero-icon" size={36} />
	<h1>{m.share_title()}</h1>
	<p>{m.share_subtitle({ name: personaName })}</p>
</section>

<section class="section">
	<Callout
		icon={Info}
		variant="primary"
		title={m.share_guidelines_title()}
		text={m.share_guidelines_text()}
	/>

	<h2 class="section-label">{m.share_how()}</h2>
	<div class="stack">
		{#if data.settings.telegramUrl}
			<LinkRow
				icon={TelegramIcon}
				title="Telegram"
				subtitle={tgAtHandle ? m.share_telegram_sub({ handle: tgAtHandle }) : undefined}
				href={`${data.settings.telegramUrl}?text=${encodeURIComponent(m.share_telegram_prefill({ name: personaName }))}`}
				highlight
			/>
		{/if}
		{#if data.settings.contactEmail}
			<LinkRow
				icon={Mail}
				title="Email"
				subtitle={m.share_email_sub({ email: data.settings.contactEmail })}
				href={`mailto:${data.settings.contactEmail}`}
				external={false}
			/>
		{/if}
		<LinkRow icon={Globe} title={m.share_drive_title()} subtitle={m.share_drive_sub()} />
	</div>

	<hr class="divider" />

	<h2 class="section-label">{m.share_tag()}</h2>
	<p class="tag-text">{m.share_tag_text()}</p>

	<Callout
		icon={CircleCheck}
		variant="success"
		title={m.share_credited_title()}
		text={m.share_credited_text()}
	/>
</section>

<style>
	.tag-text {
		font-family: var(--font-secondary);
		font-size: 14px;
		line-height: 1.6;
		color: var(--muted-foreground);
	}

	.section .divider {
		margin: 6px 0;
	}
</style>
