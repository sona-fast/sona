<!-- One passport stamp: always a link. Its accessible name is its visible text
     with punctuation between the lines ("Gallery, 3 pieces by 1 artist"). The
     tilt is static: nothing on the page moves on its own. -->
<script lang="ts">
	interface Props {
		href: string;
		shape: 'oval' | 'rect' | 'round' | 'past' | 'next' | 'live';
		/** Degrees, between -2 and 2. */
		tilt?: number;
		/** Spans the whole row (the Gallery oval and Here now). A wide stamp tilts
		 *  half as far, so stacked wide stamps can't touch at 200% text zoom. */
		wide?: boolean;
		/** The small line above the name ("Next", "Here now"). */
		kicker?: string;
		name: string;
		/** The month line on a convention stamp. */
		date?: string;
		lines?: string[];
	}

	let { href, shape, tilt = 0, wide = false, kicker, name, date, lines = [] }: Props = $props();

	// The visible text with punctuation between the lines, so a screen reader
	// pauses: "Here now: Cinder Valley Con, Reno, until Monday 19 October". An
	// aria-label rather than visually hidden commas, because Chrome pads each
	// hidden span with spaces ("Gallery , 3 pieces"). It carries every visible
	// word in order, so the spoken name still matches what a voice user reads.
	const label = $derived(
		(kicker ? `${kicker}: ` : '') + [name, date, lines.join(' ')].filter(Boolean).join(', ')
	);
</script>

<a class="stamp stamp--{shape}" class:wide {href} style="--tilt: {tilt}deg" aria-label={label}>
	{#if kicker}<span class="kicker">{kicker}</span>{/if}
	<span class="name">{name}</span>
	{#if date}<span class="date">{date}</span>{/if}
	{#each lines as line}<span class="line">{line}</span>{/each}
</a>

<style>
	/* The ink is --muted-foreground, which clears 3:1 as an edge on the card in
	   every shipped theme, so a stamp's boundary reads at any tilt. */
	.stamp {
		--ink: var(--muted-foreground);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		width: 100%;
		min-height: 6.5rem;
		padding: 10px 8px;
		text-align: center;
		border: 2px solid var(--ink);
		border-radius: var(--radius-xs);
		color: var(--foreground);
		text-decoration: none;
		font-family: var(--font-primary);
		transform: rotate(var(--tilt, 0deg));
	}

	.stamp.wide {
		transform: rotate(calc(var(--tilt, 0deg) / 2));
	}

	.stamp:hover {
		background: color-mix(in srgb, var(--foreground) 6%, transparent);
	}

	.stamp:hover .name {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	/* --ring drops under 3:1 on the card and over the page texture; the book's
	   rings use --foreground instead. */
	.stamp:focus-visible {
		outline: 2px solid var(--foreground);
		outline-offset: 3px;
	}

	.name {
		font-weight: 700;
		font-size: 0.8125rem;
		line-height: 1.25;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		overflow-wrap: anywhere;
	}

	.line {
		font-size: 0.875rem;
		line-height: 1.35;
		color: var(--muted-foreground);
		text-wrap: balance;
	}

	.kicker {
		font-weight: 700;
		font-size: 0.75rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--primary-text);
	}

	.date {
		font-weight: 700;
		font-size: 0.875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		margin-block: 2px;
	}

	/* The gallery leads: a wide oval with a larger name. */
	.stamp--oval {
		width: min(100%, 22rem);
		min-height: 7.5rem;
		border-radius: 50%;
		border-style: double;
		border-width: 6px;
		padding: 14px 28px;
	}

	.stamp--oval .name {
		font-size: 1.125rem;
		letter-spacing: 0.1em;
	}

	.stamp--round {
		border-radius: 20px;
	}

	/* Rectangles hold photos: the fursuit stamp, and the past events below. */
	.stamp--rect {
		box-shadow:
			inset 0 0 0 3px var(--card),
			inset 0 0 0 4px var(--ink);
	}

	.stamp--past {
		border-style: double;
		border-width: 6px;
		border-radius: 10px;
	}

	/* The next convention: dashed, in --primary-text, which clears text contrast
	   on the card in both modes. */
	.stamp--next {
		--ink: var(--primary-text);
		border-style: dashed;
	}

	/* Here now: a filled stamp that leads the page. Its edge is --primary-text,
	   so the boundary clears 3:1 on a light card where the fill alone does not. */
	.stamp--live {
		align-items: flex-start;
		text-align: start;
		min-height: 0;
		padding: 16px 20px;
		background: var(--primary);
		color: var(--primary-foreground);
		border-color: var(--primary-text);
		box-shadow:
			inset 0 0 0 4px var(--primary),
			inset 0 0 0 5px var(--primary-foreground);
	}

	/* The hover moves the fill the way .btn-primary's does: toward white in dark
	   modes and toward black in light ones, where white drops the label under
	   4.5:1 (aurora and terracotta light). */
	.stamp--live:hover {
		background: color-mix(in srgb, var(--primary) 88%, white);
	}

	:global([data-theme='light']) .stamp--live:hover {
		background: color-mix(in srgb, var(--primary) 88%, black);
	}

	.stamp--live .kicker,
	.stamp--live .line {
		color: var(--primary-foreground);
	}

	.stamp--live .name {
		font-size: 1.125rem;
	}
</style>
