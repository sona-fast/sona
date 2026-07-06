<!-- The public homepage. `+page@` escapes the (public) layout so the threePath
     splash can own the full viewport (no site Footer, its own footer-mark and
     MobileNav); the mosaic branch re-renders the (public) chrome (Header/Footer/
     MobileNav) explicitly, mirroring that layout's composition. -->
<script lang="ts">
	import { page } from '$app/state';
	import { User, Palette, Hand, Camera, ChevronRight } from 'lucide-svelte';
	import ArtworkCard from '$lib/components/ArtworkCard.svelte';
	import MosaicBanner from '$lib/components/MosaicBanner.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import Header from '$lib/components/Header.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import MobileCredit from '$lib/components/MobileCredit.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import { splashWordmark } from '$lib/landing';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const splash = $derived(data.settings.landingLayout === 'threePath');

	// ownerName "Sunday" -> "SUNDAY"; else "example.ink" -> "EXAMPLE"
	const wordmark = $derived(splashWordmark(data.settings.ownerName, data.settings.siteName));
	// The persona's name for the "art of {name}" card copy.
	const personaName = $derived(data.settings.ownerName || data.settings.siteName);

	const cards = $derived([
		{
			href: '/art',
			icon: Palette,
			title: m.splash_artist_title,
			desc: () => m.splash_artist_desc({ name: personaName })
		},
		{ href: '/connect', icon: Hand, title: m.splash_met_title, desc: () => m.splash_met_desc() },
		{
			href: '/share',
			icon: Camera,
			title: m.splash_photos_title,
			desc: () => m.splash_photos_desc({ name: personaName })
		}
	]);
</script>

<Meta
	title={data.settings.siteName}
	description={data.settings.aboutText}
	url={`${page.url.origin}/`}
	image={splash ? data.settings.adminAvatarUrl || null : (data.mosaicImageUrls[0] ?? null)}
	siteName={data.settings.siteName}
/>

{#if splash}
	<div class="landing">
		<div class="desktop-header">
			<Header siteName={data.settings.siteName} />
		</div>

		<main class="splash">
			<div class="hub">
				<div class="avatar">
					{#if data.settings.adminAvatarUrl}
						<img src={data.settings.adminAvatarUrl} alt={wordmark} />
					{:else}
						<User size={36} strokeWidth={1.75} />
					{/if}
				</div>

				<div class="identity">
					<h1>{wordmark}</h1>
					<p class="subtitle">{data.settings.splashSubtitle || m.splash_subtitle()}</p>
				</div>

				<p class="prompt">{m.splash_prompt()}</p>

				<nav class="cards">
					{#each cards as card}
						<a class="card" href={card.href}>
							<span class="badge"><card.icon size={20} /></span>
							<span class="text">
								<span class="card-title">{card.title()}</span>
								<span class="card-desc">{card.desc()}</span>
							</span>
							<ChevronRight class="chevron" size={18} />
						</a>
					{/each}
				</nav>
			</div>

			<p class="footer-mark">{data.settings.siteName}</p>
		</main>
	</div>

	<MobileNav />
{:else}
	<div class="public-layout">
		<div class="desktop-header">
			<Header siteName={data.settings.siteName} />
		</div>
		<main>
			<MosaicBanner
				images={data.mosaicImageUrls}
				subtitle={data.settings.aboutText}
				siteName={data.settings.siteName}
			/>

			<section class="recent container">
				<div class="section-header">
					<h2>{m.home_recent()}</h2>
					<a href="/gallery">{m.home_see_more()} &rarr;</a>
				</div>
				<div class="grid">
					{#each data.recentImages as image}
						<ArtworkCard
							slug={image.slug}
							title={image.title}
							artistName={image.artistName || m.common_unknown()}
							imageUrl={image.thumbnailUrl || image.imageUrl}
							tag={image.tag}
							nsfw={image.nsfw}
						/>
					{:else}
						<p class="empty">{m.home_empty()}</p>
					{/each}
				</div>
			</section>
		</main>
		<div class="desktop-footer">
			<Footer settings={data.settings} host={data.host} />
		</div>
		<MobileCredit host={data.host} />
		<MobileNav />
	</div>
{/if}

<style>
	/* ---- threePath splash: header + splash stacked in a full-height column,
	   mirroring the (public) layout's composition. The landing keeps its own
	   minimal footer-mark and MobileNav, so it renders <Header /> explicitly
	   instead of adopting that layout (which would also pull in the site
	   Footer). ---- */
	.landing {
		min-height: 100vh;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}

	.splash {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 32px;
		padding: 48px 28px 40px;
		background: var(--background);
	}

	@media (max-width: 768px) {
		.desktop-header {
			display: none;
		}

		.splash {
			padding-bottom: 88px;
		}
	}

	.hub {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 32px;
		width: 100%;
		max-width: 460px;
	}

	.avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100px;
		height: 100px;
		border-radius: var(--radius-pill);
		background: var(--card);
		border: 3px solid var(--primary);
		color: var(--muted-foreground);
		overflow: hidden;
		flex-shrink: 0;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.identity {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}

	.identity h1 {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 40px;
		letter-spacing: 4px;
		color: var(--foreground);
		line-height: 1;
	}

	.subtitle {
		font-family: var(--font-secondary);
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.prompt {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 18px;
		color: var(--foreground);
		text-align: center;
	}

	.cards {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 100%;
	}

	.card {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 18px 20px;
		border-radius: 10px;
		background: var(--card);
		border: 1px solid var(--border);
		color: var(--foreground);
		text-decoration: none;
		transition:
			border-color 0.15s,
			background 0.15s,
			transform 0.15s;
	}

	.card:hover {
		border-color: var(--primary);
		background: var(--secondary);
		text-decoration: none;
	}

	.card:hover :global(.chevron) {
		color: var(--primary);
	}

	.badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		color: var(--primary);
		flex-shrink: 0;
	}

	.text {
		display: flex;
		flex-direction: column;
		gap: 3px;
		flex: 1;
		min-width: 0;
	}

	.card-title {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 16px;
		letter-spacing: 1px;
		color: var(--foreground);
	}

	.card-desc {
		font-family: var(--font-secondary);
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted-foreground);
	}

	.card :global(.chevron) {
		color: var(--muted-foreground);
		flex-shrink: 0;
		transition: color 0.15s;
	}

	.footer-mark {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 11px;
		letter-spacing: 3px;
		color: var(--muted-foreground);
		opacity: 0.5;
		text-transform: lowercase;
	}

	/* Desktop: larger identity, cards laid out in a row */
	@media (min-width: 768px) {
		.splash {
			gap: 48px;
			padding: 64px 40px;
		}

		.hub {
			max-width: 960px;
			gap: 40px;
		}

		.avatar {
			width: 120px;
			height: 120px;
		}

		.identity h1 {
			font-size: 72px;
			letter-spacing: 6px;
		}

		.subtitle {
			font-size: 16px;
		}

		.prompt {
			font-size: 22px;
		}

		.cards {
			flex-direction: row;
			align-items: stretch;
			gap: 16px;
		}

		.card {
			flex: 1;
			padding: 20px;
		}
	}

	/* ---- Mosaic branch: replicates the (public) layout wrapper this page
	   opted out of. ---- */
	.public-layout {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}

	.public-layout main {
		flex: 1;
	}

	.recent {
		padding: 48px 24px;
	}

	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
	}

	.section-header h2 {
		font-size: 20px;
	}

	.section-header a {
		font-size: 14px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 20px;
	}

	.empty {
		color: var(--muted-foreground);
		font-size: 14px;
	}

	@media (max-width: 768px) {
		.desktop-footer {
			display: none;
		}

		.recent {
			padding: 24px 16px;
		}

		.section-header h2 {
			font-size: 18px;
		}

		.grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 12px;
		}
	}
</style>
