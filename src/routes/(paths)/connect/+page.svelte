<script lang="ts">
	import { page } from '$app/state';
	import { Hand } from 'lucide-svelte';
	import { formatDate } from '$lib';
	import LinkRow from '$lib/components/LinkRow.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import * as m from '$lib/paraglide/messages';
	import { SOCIAL_PLATFORM_NAMES, socialAtHandle } from '$lib/social-label';

	let { data } = $props();

	// The title is the platform name, so the subtitle is the handle or nothing:
	// socialLabel's platform-name fallback would stack "Twitter" over "Twitter".
	const socials = $derived(
		[
			{ icon: BlueskyIcon, platform: 'bluesky' as const, url: data.settings.blueskyUrl },
			{ icon: TelegramIcon, platform: 'telegram' as const, url: data.settings.telegramUrl },
			{ icon: FurAffinityIcon, platform: 'furaffinity' as const, url: data.settings.furAffinityUrl },
			{ icon: TwitterIcon, platform: 'twitter' as const, url: data.settings.twitterUrl },
			{ icon: InstagramIcon, platform: 'instagram' as const, url: data.settings.instagramUrl }
		]
			.filter((s) => s.url)
			.map((s) => ({
				...s,
				title: SOCIAL_PLATFORM_NAMES[s.platform],
				subtitle: socialAtHandle(s.platform, s.url) ?? undefined
			}))
	);

	function weekday(d: string): string {
		return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
	}

	// The convention the operator is at right now, if any. Resolved server-side in
	// the event's own timezone; see $lib/convention-window.
	const liveCon = $derived(data.liveConvention);

	// The live convention is already excluded from data.conventions server-side, so
	// it never shows up twice.
	const nextCon = $derived(data.conventions[0]);
	const laterCons = $derived(data.conventions.slice(1));

	// The persona's name for the "About {name}" heading.
	const personaName = $derived(data.settings.ownerName || data.settings.siteName);
</script>

<Meta
	title={`${m.connect_title()} — ${data.settings.siteName}`}
	description={data.settings.aboutText}
	url={`${page.url.origin}/connect`}
	siteName={data.settings.siteName}
/>

<section class="hero">
	<Hand class="hero-icon" size={32} />
	<h1>{m.connect_title()}</h1>
	<p>{m.connect_subtitle()}</p>
</section>

<!-- Promoted above the socials on the few days a year it is live. This page is
     normally read at leisure; during a con it is read in a hallway by someone
     who met the operator minutes ago, so the live state leads. -->
{#if liveCon}
	<hr class="divider" />

	<section class="section">
		<div class="here-now">
			<span class="live-pill">{m.connect_here_now()}</span>

			<div class="here-ident">
				{#if data.settings.adminAvatarUrl}
					<img class="here-avatar" src={data.settings.adminAvatarUrl} alt="" width="60" height="60" />
				{/if}
				<span class="here-who">{personaName}</span>
			</div>

			<span class="here-event">
				<span class="here-name">{liveCon.name}</span>
				{#if liveCon.location}<span class="here-loc">{liveCon.location}</span>{/if}
			</span>
			<span class="here-through">
				{m.connect_here_through({ date: formatDate(liveCon.endDate || liveCon.startDate) })}
			</span>
		</div>
	</section>
{/if}

<hr class="divider" />

<section class="section">
	<h2 class="section-label">{m.connect_online()}</h2>
	<div class="stack">
		{#each socials as s}
			<LinkRow icon={s.icon} title={s.title} subtitle={s.subtitle} href={s.url} />
		{/each}
	</div>
</section>

<hr class="divider" />

<section class="section">
	<h2 class="section-label">{m.connect_cons()}</h2>
	{#if nextCon}
		<svelte:element
			this={nextCon.url ? 'a' : 'div'}
			class="next-con"
			href={nextCon.url ?? undefined}
			target={nextCon.url ? '_blank' : undefined}
			rel={nextCon.url ? 'noopener noreferrer' : undefined}
		>
			<span class="next-pill">{m.connect_next_up()}</span>
			<span class="next-date">{formatDate(nextCon.startDate)} · {weekday(nextCon.startDate)}</span>
			<span class="next-name">{nextCon.name}</span>
			{#if nextCon.location}<span class="next-loc">{nextCon.location}</span>{/if}
		</svelte:element>

		{#each laterCons as con}
			<svelte:element
				this={con.url ? 'a' : 'div'}
				class="con-row panel"
				href={con.url ?? undefined}
				target={con.url ? '_blank' : undefined}
				rel={con.url ? 'noopener noreferrer' : undefined}
			>
				<span class="con-date">
					<span class="con-dot">{formatDate(con.startDate)}</span>
					<span class="con-day">{weekday(con.startDate)}</span>
				</span>
				<span class="con-info">
					<span class="con-name">{con.name}</span>
					{#if con.location}<span class="con-loc">{con.location}</span>{/if}
				</span>
			</svelte:element>
		{/each}
	{:else}
		<p class="empty">{m.connect_no_cons()}</p>
	{/if}
</section>

<hr class="divider" />

<section class="section">
	<h2 class="section-label">{m.connect_about({ name: personaName })}</h2>
	<p class="about">{data.settings.aboutText}</p>
</section>

<style>
	/* The live state. Deliberately a step up from .next-con rather than a new
	   colour: it reuses the primary-mixed border and wash that /art already uses
	   for its featured section, so it reads as "elevated" in every fork theme
	   instead of introducing a signal colour that only works in some of them. */
	.here-now {
		display: flex;
		flex-direction: column;
		gap: 13px;
		padding: 16px;
		border-radius: var(--radius-m);
		border: 1px solid color-mix(in srgb, var(--primary) 55%, var(--border));
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--primary) 12%, transparent), transparent 72%),
			var(--card);
	}

	.live-pill {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 10px;
		letter-spacing: 2px;
		text-transform: uppercase;
		color: var(--primary-foreground);
		background: var(--primary);
		padding: 4px 10px;
		border-radius: var(--radius-pill);
	}



	.here-ident {
		display: flex;
		align-items: center;
		gap: 13px;
		min-width: 0;
	}

	.here-avatar {
		width: 60px;
		height: 60px;
		border-radius: var(--radius-s);
		flex: none;
		object-fit: cover;
		outline: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
		outline-offset: -1px;
	}

	.here-who {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 22px;
		letter-spacing: 0.5px;
		line-height: 1.15;
		min-width: 0;
		overflow-wrap: break-word;
	}

	.here-event {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.here-name {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 15px;
		letter-spacing: 0.5px;
		text-wrap: balance;
	}

	.here-loc {
		font-family: var(--font-secondary);
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.here-through {
		font-family: var(--font-primary);
		font-size: 11px;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	.next-con {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 16px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
		color: var(--foreground);
		text-decoration: none;
	}

	a.next-con:hover {
		border-color: var(--primary);
		text-decoration: none;
	}

	.next-pill {
		align-self: flex-start;
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 10px;
		letter-spacing: 2px;
		text-transform: uppercase;
		color: var(--primary-foreground);
		background: var(--primary);
		padding: 3px 8px;
		border-radius: var(--radius-pill);
	}

	.next-date {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 12px;
		letter-spacing: 1px;
		color: var(--muted-foreground);
		margin-top: 4px;
	}

	.next-name {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 18px;
		letter-spacing: 1px;
		color: var(--foreground);
	}

	.next-loc {
		font-family: var(--font-secondary);
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.con-row {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 12px 16px;
		color: var(--foreground);
		text-decoration: none;
	}

	a.con-row:hover {
		border-color: var(--primary);
		text-decoration: none;
	}

	.con-date {
		display: flex;
		flex-direction: column;
		width: 92px;
		flex-shrink: 0;
	}

	.con-dot {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 11px;
		letter-spacing: 1px;
		color: var(--muted-foreground);
	}

	.con-day {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 14px;
		color: var(--foreground);
	}

	.con-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.con-name {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 14px;
		letter-spacing: 1px;
		color: var(--foreground);
	}

	.con-loc {
		font-family: var(--font-secondary);
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.about {
		font-family: var(--font-secondary);
		font-size: 14px;
		line-height: 1.6;
		color: var(--muted-foreground);
	}

	.empty {
		font-family: var(--font-secondary);
		font-size: 13px;
		color: var(--muted-foreground);
	}
</style>
