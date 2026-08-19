<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{data.displayUrl}</title>
	<!-- A utility screen for one person holding a phone, not a page anyone should
	     reach from a search result. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<!-- Black ground and a white plate, fixed rather than themed. This is the one
     screen whose colours are a scanning requirement instead of a style choice:
     it gets held at arm's length under bad hall lighting, and a dark-on-dark
     rendering in a fork's custom theme would simply fail to scan. -->
<main class="handoff">
	<a class="exit" href="/connect" aria-label={m.connect_qr_close()}>&#10005;</a>

	<div class="plate">
		<svg
			class="qr"
			viewBox={data.qr.viewBox}
			shape-rendering="crispEdges"
			role="img"
			aria-label={m.con_qr_svg_label({ url: data.displayUrl })}
		>
			<rect width="100%" height="100%" fill="#ffffff" />
			<g transform="translate({data.qr.translate} {data.qr.translate})">
				<path d={data.qr.path} fill="#111111" />
			</g>
		</svg>
	</div>

	<p class="who">{data.siteName}</p>
	<p class="url">{data.displayUrl}</p>
	<p class="hint">{m.connect_qr_hint()}</p>
</main>

<style>
	.handoff {
		position: fixed;
		inset: 0;
		background: #000000;
		color: #ffffff;
		display: flex;
		flex-direction: column;
		align-items: center;
		/* Safe centering plus a scroll: at 200% zoom, or on a phone held landscape,
		   the plate is taller than the viewport and plain centering would push the
		   typed-URL fallback off both ends with no way to reach it. */
		justify-content: safe center;
		overflow: auto;
		gap: 16px;
		padding: 24px;
		text-align: center;
		/* The one screen whose first paint cannot wait on a webfont round trip: it
		   is opened on convention wifi to be read out loud. */
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
	}

	.exit {
		position: absolute;
		top: 10px;
		right: 10px;
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		color: #b8b9b6;
		text-decoration: none;
		font-size: 18px;
	}

	.exit:hover {
		color: #ffffff;
		background: rgba(255, 255, 255, 0.08);
	}

	.exit:focus-visible {
		outline: 2px solid #ffffff;
		outline-offset: 2px;
	}

	.plate {
		background: #ffffff;
		padding: 14px;
		border-radius: 12px;
		line-height: 0;
	}

	/* Bounded by the shorter viewport side so the code stays square and fully
	   visible when the phone is held in landscape. */
	.qr {
		display: block;
		width: min(62vw, 62vh, 420px);
		height: min(62vw, 62vh, 420px);
	}

	.who {
		margin: 0;
		font-weight: 700;
		font-size: 22px;
		letter-spacing: 0.5px;
	}

	.url {
		margin: 0;
		font-size: 12px;
		letter-spacing: 0.06em;
		color: #b8b9b6;
		overflow-wrap: anywhere;
	}

	.hint {
		margin: 0;
		font-size: 13px;
		color: #b8b9b6;
		max-width: 26ch;
	}
</style>
