<!-- The passport homepage (landingLayout = 'passport'): the character's passport
     open flat. The left page is the data page, the right page holds one stamp
     per part of the site that has content. What renders for which data is
     decided server-side (src/lib/server/passport.ts and $lib/landing/passport);
     this component only lays it out and puts the words on it. -->
<script lang="ts">
	import { cdnImage, rawFallback } from '$lib/img';
	import { SOCIAL_PLATFORM_NAMES } from '$lib/social-label';
	import { getLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';
	import Stamp from './Stamp.svelte';
	import type { PassportData } from '$lib/server/passport';
	import type { FeatureStamp } from '$lib/landing/passport';

	let { passport }: { passport: PassportData } = $props();

	// Static tilts, cycled by position. Capped at 2 degrees either way so no
	// tilted stamp overlaps its neighbour.
	const FEATURE_TILTS = [-1, 2, -1.5, 2, -2, 1.5];
	const CON_TILTS = [-2, 2, -2, 1.5, -1.5, 2, -1];

	// The picture column's rendered width per viewport, from the .data grid's
	// container queries below (13rem; 7.5rem on a page under 30rem; at most
	// 10rem under 17.5rem), so a phone fetches the 480w file, not the 960w one.
	// A page is under 30rem on a phone below about 34.5rem, and on the two-page
	// spread below about 73rem, where each page is half the book.
	const PICTURE_SIZES =
		'(max-width: 22rem) 10rem, (max-width: 34.5rem) 7.5rem, (max-width: 56.25rem) 13rem, (max-width: 73rem) 7.5rem, 13rem';

	// Bare YYYY-MM-DD dates are calendar facts, so they format in UTC, which
	// keeps the server and the browser on the same day. English reads day before
	// month ("Monday 19 October"), which is en-GB's order; the month stamp uses
	// en-US, whose short September is "Sep" (en-GB's is "Sept"). Japanese puts
	// the short weekday in brackets after the day ("10月19日(月)").
	// Both return undefined on an Invalid Date, which format() would throw on
	// during SSR: the date line drops instead.
	const ja = $derived(getLocale() === 'ja');
	function monthYear(ym: string): string | undefined {
		const date = new Date(`${ym}-01T00:00:00Z`);
		if (Number.isNaN(date.getTime())) return undefined;
		return new Intl.DateTimeFormat(ja ? 'ja' : 'en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
			date
		);
	}
	function untilDay(day: string): string | undefined {
		const date = new Date(`${day}T00:00:00Z`);
		if (Number.isNaN(date.getTime())) return undefined;
		return new Intl.DateTimeFormat(ja ? 'ja' : 'en-GB', {
			weekday: ja ? 'short' : 'long',
			day: 'numeric',
			month: 'long',
			timeZone: 'UTC'
		}).format(date);
	}

	function liveLine(location: string | null, until: string | null): string[] {
		const date = until ? untilDay(until) : undefined;
		if (!date) return location ? [location] : [];
		return [location ? m.passport_live_line({ place: location, date }) : m.passport_live_until({ date })];
	}

	const ABOUT_LINES = {
		links: m.passport_about_links,
		conventions: m.passport_about_cons,
		both: m.passport_about_links_cons
	};

	function featureText(stamp: FeatureStamp): { name: string; lines: string[] } {
		const [a = 0, b = 0] = stamp.counts;
		switch (stamp.kind) {
			case 'gallery':
				return { name: m.nav_gallery(), lines: [m.passport_pieces({ count: a }), m.passport_by_artists({ count: b })] };
			case 'fursuit':
				return {
					name: m.passport_fursuit(),
					lines: [m.passport_photos({ count: a }), m.passport_by_photographers({ count: b })]
				};
			case 'stickers':
				return { name: m.nav_stickers(), lines: [m.passport_stickers({ count: a }), m.passport_in_packs({ count: b })] };
			case 'vr':
				return { name: m.passport_vr(), lines: [m.passport_avatars({ count: a })] };
			case 'collections':
				return { name: m.nav_collections(), lines: [m.passport_collections({ count: a })] };
			case 'about':
				return { name: m.nav_about(), lines: stamp.about ? [ABOUT_LINES[stamp.about]()] : [] };
		}
	}

	const picture = $derived(passport.picture);
	const stamps = $derived(passport.stamps);
	const live = $derived(stamps.live);
</script>

<!-- The avatar and the piece render the same picture element; only the alt
     differs. The piece comes from an SFW-only pool, so nothing here is ever
     blurred. -->
{#snippet art(imageUrl: string, alt: string)}
	<img
		class="art"
		src={cdnImage(imageUrl, 480)}
		srcset="{cdnImage(imageUrl, 480)} 480w, {cdnImage(imageUrl, 960)} 960w"
		sizes={PICTURE_SIZES}
		use:rawFallback={imageUrl}
		{alt}
		loading="eager"
		fetchpriority="high"
	/>
{/snippet}

<div class="book" class:book--single={!passport.hasStamps}>
	<section class="page page--data" aria-labelledby="pp-name">
		<p class="page-label" aria-hidden="true">{m.passport_label()}</p>
		<div class="data" class:data--solo={!picture}>
			{#if picture}
				<figure class="photo">
					{#if picture.kind === 'avatar'}
						<div class="photo-frame photo-frame--square">
							{@render art(picture.imageUrl, m.passport_alt_avatar({ name: passport.name }))}
						</div>
						<figcaption>{m.passport_caption_avatar()}</figcaption>
					{:else}
						<!-- The link is named by the image: its alt is the piece title. -->
						<a class="photo-frame" href="/gallery/{picture.slug}">
							{@render art(picture.imageUrl, picture.title)}
						</a>
						<!-- Only the credit, with no full stop: the title is the alt, not a
						     caption sentence. No template whitespace after "Art by": Japanese
						     runs on after 作者： with no space, so the space is rendered for
						     other locales only. -->
						<figcaption>
							{#if picture.artistName}{m.passport_art_by()}{ja ? '' : ' '}<a
									href="/gallery?artist={encodeURIComponent(picture.artistName)}">{picture.artistName}</a
								>{:else}{m.passport_unattributed()}{/if}
						</figcaption>
					{/if}
				</figure>
			{/if}
			<div class="fields">
				<div class="field">
					<span class="f-label" aria-hidden="true">{m.passport_name()}</span>
					<h1 id="pp-name" class="name">{passport.name}</h1>
				</div>
				{#if passport.pronouns}
					<div class="field">
						<span class="f-label" aria-hidden="true">{m.passport_pronouns()}</span>
						<p class="f-value"><span class="sr-only">{m.pronouns_prefix()}{' '}</span>{passport.pronouns}</p>
					</div>
				{/if}
				<dl class="f-grid">
					{#if passport.species}
						<div class="field">
							<dt class="f-label">{m.passport_species()}</dt>
							<dd class="f-value">{passport.species}</dd>
						</div>
					{/if}
					<div class="field">
						<dt class="f-label">{m.passport_home()}</dt>
						<dd class="f-value">{passport.host}</dd>
					</div>
					{#if passport.since}
						<div class="field field--wide">
							<dt class="f-label">{m.passport_since()}</dt>
							<dd class="f-value">{passport.since}</dd>
						</div>
					{/if}
					{#if passport.socials.length > 0}
						<div class="field field--wide">
							<dt class="f-label">{m.passport_elsewhere()}</dt>
							<dd class="f-value">
								<!-- role="list": list-style none drops the list semantics in WebKit. -->
								<ul class="socials" role="list">
									{#each passport.socials as social (social.platform)}
										<li>
											<a class="ext" href={social.url} target="_blank" rel="noopener noreferrer"
												>{SOCIAL_PLATFORM_NAMES[social.platform]}<svg
													class="ext-icon"
													width="12"
													height="12"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2.25"
													stroke-linecap="round"
													stroke-linejoin="round"
													aria-hidden="true"><path d="M7 17 17 7" /><path d="M8 7h9v9" /></svg
												><span class="sr-only">{' '}{m.link_opens_new_tab()}</span></a
											>
										</li>
									{/each}
								</ul>
							</dd>
						</div>
					{/if}
				</dl>
			</div>
		</div>
		{#if passport.about}
			<p class="about">{passport.about}</p>
		{/if}
		<p class="mrz" aria-hidden="true">{passport.mrz[0]}<br />{passport.mrz[1]}</p>
		<span class="folio" aria-hidden="true">2</span>
	</section>

	<section class="page page--stamps" aria-labelledby="pp-stamps">
		<!-- Visually hidden: it names the region and keeps the h1, h2, h3
		     outline. The first visible item takes the top of the page, level with
		     the data page's "Passport" label. -->
		<h2 id="pp-stamps" class="sr-only">{m.passport_stamps()}</h2>
		{#if passport.hasStamps}
			{#if live}
				<div class="live">
					<Stamp
						href={live.href}
						shape="live"
						tilt={-1}
						wide
						kicker={m.connect_here_now()}
						name={live.name}
						lines={liveLine(live.location, live.until)}
					/>
				</div>
			{/if}
			{#if stamps.features.length > 0}
				<h3 class="group-h" id="pp-site">{m.passport_on_this_site()}</h3>
				<ul class="stamps" role="list" aria-labelledby="pp-site">
					{#each stamps.features as stamp, i (stamp.kind)}
						{@const text = featureText(stamp)}
						<li class:lead={stamp.kind === 'gallery'}>
							<Stamp
								href={stamp.href}
								shape={stamp.kind === 'gallery' ? 'oval' : stamp.kind === 'fursuit' ? 'rect' : 'round'}
								wide={stamp.kind === 'gallery'}
								tilt={FEATURE_TILTS[i % FEATURE_TILTS.length]}
								name={text.name}
								lines={text.lines}
							/>
						</li>
					{/each}
				</ul>
			{/if}
			{#if stamps.conventions.length > 0}
				<h3 class="group-h" id="pp-cons">{m.passport_conventions()}</h3>
				<ul class="stamps stamps--cons" role="list" aria-labelledby="pp-cons">
					{#each stamps.conventions as con, i (con.href + con.name)}
						<li>
							{#if con.kind === 'next'}
								<Stamp
									href={con.href}
									shape="next"
									tilt={CON_TILTS[i % CON_TILTS.length]}
									kicker={m.passport_next()}
									name={con.name}
									date={con.startDate ? monthYear(con.startDate.slice(0, 7)) : undefined}
								/>
							{:else}
								<Stamp
									href={con.href}
									shape="past"
									tilt={CON_TILTS[i % CON_TILTS.length]}
									name={con.name}
									date={con.month ? monthYear(con.month) : undefined}
									lines={[m.passport_photos({ count: con.photos })]}
								/>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="stamps-empty">{m.passport_no_stamps()}</p>
		{/if}
		<span class="folio" aria-hidden="true">3</span>
	</section>
</div>

<style>
	.book {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		max-width: 72rem;
		margin-inline: auto;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
	}

	/* The bottom padding is in em, the same 48px at 100%, so it grows with text
	   zoom and the folio never overlaps the last stamp or the machine line. */
	.page {
		position: relative;
		container-type: inline-size;
		min-width: 0;
		padding: 28px 40px 3em;
	}

	.page + .page {
		border-inline-start: 1px solid var(--border);
	}

	/* The gutter: a soft fold either side of the spine. Decorative. */
	.page--data::after,
	.page--stamps::before {
		content: '';
		position: absolute;
		inset-block: 0;
		width: 28px;
		pointer-events: none;
	}

	.page--data::after {
		inset-inline-end: 0;
		background: linear-gradient(to left, color-mix(in srgb, var(--foreground) 5%, transparent), transparent);
	}

	.page--stamps::before {
		inset-inline-start: 0;
		background: linear-gradient(to right, color-mix(in srgb, var(--foreground) 5%, transparent), transparent);
	}

	/* Security print behind the data page: fine rings in 3% foreground, faint
	   enough that no text pair on it drops below its contrast bar. */
	.page--data {
		background: repeating-radial-gradient(
				circle at 100% 0%,
				transparent 0 11px,
				color-mix(in srgb, var(--foreground) 3%, transparent) 11px 12px
			)
			no-repeat;
		border-start-start-radius: var(--radius-m);
		border-end-start-radius: var(--radius-m);
	}

	/* A fresh site: nothing to stamp, so the book is one page rather than a
	   spread with a blank half. */
	.book--single {
		grid-template-columns: minmax(0, 1fr);
		max-width: 40rem;
	}

	.book--single .page + .page {
		border-inline-start: 0;
		border-top: 1px solid var(--border);
		padding-bottom: 2.5em;
	}

	.book--single .page--data::after,
	.book--single .page--stamps::before {
		display: none;
	}

	.book--single .page--data {
		border-radius: var(--radius-m) var(--radius-m) 0 0;
	}

	@media (max-width: 56.25rem) {
		.book {
			grid-template-columns: minmax(0, 1fr);
		}

		.page + .page {
			border-inline-start: 0;
			border-top: 1px solid var(--border);
		}

		.page--data::after,
		.page--stamps::before {
			display: none;
		}

		.page--data {
			border-radius: var(--radius-m) var(--radius-m) 0 0;
		}
	}

	@media (max-width: 768px) {
		.page {
			padding: 20px 20px 2.5em;
		}
	}

	/* --ring measures under 3:1 on the card and over the print and spine
	   shading, so rings inside the book use --foreground. */
	.book a:focus-visible {
		outline: 2px solid var(--foreground);
		outline-offset: 2px;
	}

	.page-label {
		font-family: var(--font-primary);
		font-weight: 600;
		font-size: 0.75rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		margin-bottom: 20px;
	}

	.folio {
		position: absolute;
		inset-block-end: 14px;
		font-family: var(--font-primary);
		font-weight: 500;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.page--data .folio {
		inset-inline-start: 40px;
	}

	.page--stamps .folio {
		inset-inline-end: 40px;
	}

	@media (max-width: 768px) {
		.page--data .folio {
			inset-inline-start: 20px;
		}

		.page--stamps .folio {
			inset-inline-end: 20px;
		}
	}

	/* ---- data page ---- */
	.data {
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr);
		gap: 28px;
		align-items: start;
	}

	.data--solo {
		grid-template-columns: minmax(0, 1fr);
	}

	.name {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 2.25rem;
		line-height: 1.05;
		letter-spacing: -0.02em;
		overflow-wrap: anywhere;
		color: var(--foreground);
	}

	@container (max-width: 30rem) {
		.data {
			grid-template-columns: 7.5rem minmax(0, 1fr);
			gap: 18px;
		}

		/* Restated: the rule above would otherwise put a pictureless page's
		   fields in the 7.5rem column. */
		.data--solo {
			grid-template-columns: minmax(0, 1fr);
		}

		.name {
			font-size: 1.75rem;
		}
	}

	@container (max-width: 17.5rem) {
		.data {
			grid-template-columns: minmax(0, 1fr);
		}

		.photo {
			max-width: 10rem;
		}
	}

	.photo {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
	}

	/* 3:4, letterboxed on --secondary: object-fit contain shows a landscape
	   piece whole instead of cutting its sides. */
	.photo-frame {
		position: relative;
		display: block;
		aspect-ratio: 3 / 4;
		overflow: hidden;
		border-radius: var(--radius-xs);
		background: var(--secondary);
		outline: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
		outline-offset: -1px;
		text-decoration: none;
	}

	/* The profile picture is square, so it fills the frame at 1:1. */
	.photo-frame--square {
		aspect-ratio: 1 / 1;
	}

	.art {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.photo-frame--square .art {
		object-fit: cover;
	}

	.photo figcaption {
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--muted-foreground);
	}

	.photo figcaption a {
		color: var(--muted-foreground);
	}

	.photo figcaption a:hover {
		color: var(--foreground);
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		margin: 0;
	}

	.f-label {
		font-family: var(--font-primary);
		font-weight: 500;
		font-size: 0.75rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}

	.f-value {
		font-family: var(--font-primary);
		font-weight: 500;
		font-size: 1rem;
		line-height: 1.4;
		color: var(--foreground);
		overflow-wrap: anywhere;
		margin: 0;
	}

	.f-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 7.5rem), 1fr));
		gap: 14px 20px;
		margin: 0;
	}

	.field--wide {
		grid-column: 1 / -1;
	}

	.socials {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		margin: 0;
		padding: 0;
		font-family: var(--font-secondary);
		font-weight: 500;
		font-size: 0.9375rem;
		line-height: normal;
	}

	.ext {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding-block: 2px;
	}

	.ext-icon {
		flex: none;
	}

	.about {
		margin-top: 24px;
		font-size: 1rem;
		line-height: 1.55;
		color: var(--foreground);
		max-width: 34rem;
		text-wrap: pretty;
	}

	/* Sized to the page's inline size so both 44-character rows fit on a phone,
	   with a rem floor so it never shrinks past legible; it may wrap instead. */
	.mrz {
		margin-top: 24px;
		font-family: var(--font-primary);
		font-weight: 500;
		font-size: max(0.625rem, min(0.875rem, 3.05cqi));
		line-height: 1.7;
		letter-spacing: 0.1em;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}

	/* ---- stamps page ---- */
	.stamps-empty {
		font-size: 1rem;
		line-height: 1.5;
		color: var(--muted-foreground);
	}

	.live {
		margin-bottom: 24px;
	}

	.group-h {
		font-family: var(--font-primary);
		font-weight: 600;
		font-size: 0.75rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		margin-block: 24px 14px;
	}

	.live + .group-h {
		margin-top: 4px;
	}

	/* With no Here now stamp, the first group label takes the top of the page,
	   level with the "Passport" label. The hidden h2 before it is out of flow. */
	.sr-only + .group-h {
		margin-top: 0;
	}

	/* The row gap is in em so it grows with text zoom: tilted neighbours keep
	   their distance at 200%. */
	.stamps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 1.125em 1em;
		align-items: center;
		justify-items: center;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 8.25rem), 1fr));
	}

	.stamps--cons {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 6.5rem), 1fr));
		gap: 1em 0.75em;
	}

	.stamps > li {
		width: 100%;
		display: flex;
		justify-content: center;
	}

	.stamps > li.lead {
		grid-column: 1 / -1;
	}
</style>
