<script lang="ts">
	import { ArrowLeft, Info, AlertTriangle } from 'lucide-svelte';
	import { page as pageState } from '$app/state';
	import { MAX_VR_MODEL_BYTES, formatBytes } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	// Step 4 interpolates the REAL cap ($lib/vr), so the guide can't drift from
	// what the upload endpoint actually enforces. Renders as "50.0 MB" —
	// formatBytes' one-decimal form, matching the dropzone.
	const maxModel = formatBytes(MAX_VR_MODEL_BYTES);

	// Localized paragraphs carry three inline markers the catalogue can't express
	// as plain strings: `…` for Unity paths/shader names (mono chip, untranslated
	// tokens), **…** for the mock's bold runs, and [text](https://…) for the one
	// external link (UniVRM releases). Splitting at render time keeps each
	// paragraph ONE translatable message instead of brittle text fragments
	// interleaved with markup in locale-specific order. Markers do not nest.
	type Segment = { type: 'text' | 'kbd' | 'strong'; text: string } | { type: 'link'; text: string; href: string };
	function segments(text: string): Segment[] {
		const out: Segment[] = [];
		const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
		let last = 0;
		let match: RegExpExecArray | null;
		while ((match = re.exec(text))) {
			if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) });
			if (match[1] !== undefined) out.push({ type: 'kbd', text: match[1] });
			else if (match[2] !== undefined) out.push({ type: 'strong', text: match[2] });
			else out.push({ type: 'link', text: match[3], href: match[4] });
			last = re.lastIndex;
		}
		if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
		return out;
	}

	// Troubleshooting rows, data-driven so the details/summary chrome is written
	// once. Plain <details> — no JS, state per row, and the +/– marker comes
	// from CSS like the mock.
	const trouble = [
		{ q: m.admin_vr_guide_trouble_grey_q, a: m.admin_vr_guide_trouble_grey_a },
		{ q: m.admin_vr_guide_trouble_eyes_q, a: m.admin_vr_guide_trouble_eyes_a },
		{ q: m.admin_vr_guide_trouble_colors_q, a: m.admin_vr_guide_trouble_colors_a },
		{ q: m.admin_vr_guide_trouble_size_q, a: m.admin_vr_guide_trouble_size_a },
		{ q: m.admin_vr_guide_trouble_menu_q, a: m.admin_vr_guide_trouble_menu_a },
		{ q: m.admin_vr_guide_trouble_pose_q, a: m.admin_vr_guide_trouble_pose_a },
		{ q: m.admin_vr_guide_trouble_missing_q, a: m.admin_vr_guide_trouble_missing_a }
	];
</script>

<svelte:head>
	<!-- Same title composition as the public routes ((public)/vr/+page.svelte):
	     page title — site name, overriding the root layout's bare site name. -->
	<title>{m.admin_vr_guide_title()} — {pageState.data.siteName}</title>
</svelte:head>

{#snippet rich(text: string)}{#each segments(text) as seg}{#if seg.type === 'kbd'}<span class="kbd-path">{seg.text}</span>{:else if seg.type === 'strong'}<strong>{seg.text}</strong>{:else if seg.type === 'link'}<a href={seg.href} target="_blank" rel="noopener">{seg.text}<span class="sr-only">{' '}{m.link_opens_new_tab()}</span></a>{:else}{seg.text}{/if}{/each}{/snippet}

<div class="guide">
	<a class="back-link" href="/admin/vr"><ArrowLeft size={15} aria-hidden="true" /> {m.admin_vr_back()}</a>

	<div class="eyebrow">{m.admin_vr_guide_eyebrow()}</div>
	<h1>{m.admin_vr_guide_title()}</h1>
	<p class="lede">{m.admin_vr_guide_lede()}</p>
	<div class="meta-row">
		<span class="chip">{m.admin_vr_guide_chip_first_time()}</span>
		<span class="chip">{m.admin_vr_guide_chip_repeats()}</span>
		<span class="chip">{m.admin_vr_guide_chip_no_blender()}</span>
		<span class="chip">{m.admin_vr_guide_chip_no_code()}</span>
	</div>

	<div class="callout">
		<Info size={17} aria-hidden="true" />
		<p>{m.admin_vr_guide_callout_no_download()}</p>
	</div>

	<h2>{m.admin_vr_guide_before_title()}</h2>
	<p>{m.admin_vr_guide_before_intro()}</p>
	<ul>
		<li>{@render rich(m.admin_vr_guide_before_project())}</li>
		<li>{@render rich(m.admin_vr_guide_before_unity())}</li>
		<li>{@render rich(m.admin_vr_guide_before_univrm())}</li>
	</ul>
	<p class="muted">{m.admin_vr_guide_wont_work()}</p>

	<h2>{m.admin_vr_guide_steps_title()}</h2>
	<!-- Explicit role: list-style:none strips the implicit list semantics in
	     Safari/VoiceOver. -->
	<ol class="steps" role="list">
		<li class="step">
			<div class="step-num" aria-hidden="true">1</div>
			<div>
				<h3><span class="sr-only">{m.admin_vr_guide_step_prefix({ n: 1 })}{' '}</span>{m.admin_vr_guide_step1_title()}</h3>
				<p>{@render rich(m.admin_vr_guide_step1_body())}</p>
			</div>
		</li>

		<li class="step">
			<div class="step-num" aria-hidden="true">2</div>
			<div>
				<h3><span class="sr-only">{m.admin_vr_guide_step_prefix({ n: 2 })}{' '}</span>{m.admin_vr_guide_step2_title()}</h3>
				<p>{@render rich(m.admin_vr_guide_step2_body())}</p>
			</div>
		</li>

		<li class="step">
			<div class="step-num" aria-hidden="true">3</div>
			<div>
				<h3><span class="sr-only">{m.admin_vr_guide_step_prefix({ n: 3 })}{' '}</span>{m.admin_vr_guide_step3_title()}</h3>
				<p>{m.admin_vr_guide_step3_p1()}</p>
				<p>{m.admin_vr_guide_step3_p2()}</p>
			</div>
		</li>

		<li class="step">
			<div class="step-num" aria-hidden="true">4</div>
			<div>
				<h3><span class="sr-only">{m.admin_vr_guide_step_prefix({ n: 4 })}{' '}</span>{m.admin_vr_guide_step4_title()}</h3>
				<p>{m.admin_vr_guide_step4_p1()}</p>
				<!-- The measured export sizes from the verified end-to-end run.
				     Locale-identical, so they live inline rather than as per-locale
				     catalogue entries; the row LABELS stay translated. -->
				<div class="numbers">
					<div><span>{m.admin_vr_guide_step4_row_all()}</span><span class="v">147.85 MB</span></div>
					<div class="hl"><span>{m.admin_vr_guide_step4_row_stripped()}</span><span class="v">7.28 MB</span></div>
					<div><span>{m.admin_vr_guide_step4_row_textures()}</span><span class="v">~5 MB</span></div>
				</div>
				<p>{m.admin_vr_guide_step4_p2({ max: maxModel })}</p>
			</div>
		</li>

		<li class="step">
			<div class="step-num" aria-hidden="true">5</div>
			<div>
				<h3><span class="sr-only">{m.admin_vr_guide_step_prefix({ n: 5 })}{' '}</span>{m.admin_vr_guide_step5_title()}</h3>
				<p>{@render rich(m.admin_vr_guide_step5_p1())}</p>
				<p>{@render rich(m.admin_vr_guide_step5_p2())}</p>
				<p class="muted">{m.admin_vr_guide_step5_p3()}</p>
			</div>
		</li>

		<li class="step">
			<div class="step-num" aria-hidden="true">6</div>
			<div>
				<h3><span class="sr-only">{m.admin_vr_guide_step_prefix({ n: 6 })}{' '}</span>{m.admin_vr_guide_step6_title()}</h3>
				<p>{@render rich(m.admin_vr_guide_step6_p1())}</p>
				<p>{m.admin_vr_guide_step6_p2()}</p>
			</div>
		</li>
	</ol>

	<h2>{m.admin_vr_guide_license_title()}</h2>
	<div class="callout warn">
		<AlertTriangle size={17} aria-hidden="true" />
		<p>{m.admin_vr_guide_license_callout()}</p>
	</div>
	<p>{m.admin_vr_guide_license_p1()}</p>
	<p>{m.admin_vr_guide_license_p2()}</p>

	<h2>{m.admin_vr_guide_trouble_title()}</h2>
	<div class="trouble">
		{#each trouble as row}
			<details>
				<summary>{row.q()}</summary>
				<div class="a">{row.a()}</div>
			</details>
		{/each}
	</div>
</div>

<style>
	.guide { max-width: 720px; }

	.back-link {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
		color: var(--muted-foreground); margin-bottom: 26px; text-decoration: none;
	}
	.back-link:hover { color: var(--foreground); }

	/* --status-attention, not --primary: small text in --primary computes 2.20:1
	   on the default light background; --status-attention passes 4.5:1 in every
	   theme/mode and tracks --primary in dark. */
	.eyebrow {
		font-family: var(--font-primary); font-size: 11.5px; letter-spacing: 0.14em;
		text-transform: uppercase; color: var(--status-attention); margin-bottom: 10px;
	}
	h1 {
		font-family: var(--font-primary); font-size: 26px; font-weight: 600;
		line-height: 1.25; margin: 0 0 14px; text-wrap: balance;
	}
	.lede { color: var(--muted-foreground); max-width: 62ch; margin-bottom: 8px; }

	.meta-row { display: flex; gap: 10px; margin: 18px 0 30px; flex-wrap: wrap; }
	.chip {
		font-family: var(--font-primary); font-size: 12px; color: var(--muted-foreground);
		border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 5px 12px;
	}

	.callout {
		display: flex; gap: 12px; background: var(--card); border: 1px solid var(--border);
		border-left: 3px solid var(--status-attention); border-radius: var(--radius-s);
		padding: 16px 18px; margin: 0 0 34px; font-size: 14.5px;
	}
	.callout.warn { border-left-color: var(--destructive); }
	.callout :global(svg) { flex: none; margin-top: 2px; color: var(--status-attention); }
	.callout.warn :global(svg) { color: var(--destructive); }
	.callout p { max-width: 60ch; margin: 0; }

	h2 { font-family: var(--font-primary); font-size: 17px; font-weight: 600; margin: 38px 0 12px; }
	/* line-break: strict — JA kinsoku: without it lines can start with ー. */
	p { max-width: 62ch; margin: 0 0 12px; line-height: 1.55; line-break: strict; }
	ul { padding-left: 20px; margin: 0 0 12px; display: grid; gap: 7px; max-width: 60ch; }
	li { line-height: 1.55; line-break: strict; }
	li::marker { color: var(--status-attention); }
	.muted { color: var(--muted-foreground); }

	/* CJK body text needs more leading than Latin at the same size. Scoped on
	   the html lang attribute, which hooks.server.ts fills per-request. */
	:global(html[lang='ja']) p,
	:global(html[lang='ja']) li,
	:global(html[lang='ja']) .trouble .a { line-height: 1.8; }

	.kbd-path {
		font-family: var(--font-primary); font-size: 0.86em; background: var(--secondary);
		border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 2px 5px;
		/* Wraps instead of nowrap: the step-2 menu path forced horizontal
		   scroll at 320-390px viewports. */
		white-space: normal; overflow-wrap: anywhere;
	}

	/* The <ol> is semantic only — the numbering chrome is the .step-num chips,
	   so the list's own markers and indent go away. */
	.steps { list-style: none; padding: 0; margin: 0; }
	.step { display: grid; grid-template-columns: 34px 1fr; gap: 16px; margin: 26px 0; }
	.step-num {
		font-family: var(--font-primary); font-size: 14px; font-weight: 600;
		width: 34px; height: 34px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		background: var(--secondary); color: var(--foreground); margin-top: 1px;
		border: 1px solid var(--border);
	}
	.step h3 {
		font-family: var(--font-primary); font-size: 15.5px; font-weight: 600;
		margin: 0 0 8px; padding-top: 6px;
	}

	.numbers {
		font-family: var(--font-primary); font-size: 13px; border: 1px solid var(--border);
		border-radius: var(--radius-s); overflow: hidden; margin: 14px 0; max-width: 460px;
	}
	.numbers > div { display: flex; justify-content: space-between; gap: 24px; padding: 10px 16px; }
	.numbers > div + div { border-top: 1px solid var(--border); }
	.numbers span:first-child { color: var(--muted-foreground); }
	/* nowrap: a value must never split number from unit — the label column
	   absorbs any wrapping. */
	.numbers .v { font-variant-numeric: tabular-nums; color: var(--foreground); white-space: nowrap; }
	.numbers .hl .v { color: var(--status-attention); }

	.trouble { border-top: 1px solid var(--border); margin-top: 8px; }
	.trouble details { border-bottom: 1px solid var(--border); }
	.trouble summary {
		cursor: pointer; padding: 14px 2px; font-weight: 500; font-size: 14.5px;
		list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 12px;
	}
	.trouble summary::-webkit-details-marker { display: none; }
	/* Base rule without alt-text: Safari before 17.4 drops the whole
	   declaration when it carries the `/ ''` form, which would leave no expand
	   affordance at all. */
	.trouble summary::after { content: '+'; font-family: var(--font-primary); color: var(--muted-foreground); }
	.trouble details[open] summary::after { content: '–'; }
	/* Empty alt-text where supported: the marker is decorative, so AT must not
	   announce "plus". */
	@supports (content: 'x' / '') {
		.trouble summary::after { content: '+' / ''; }
		.trouble details[open] summary::after { content: '–' / ''; }
	}
	.trouble summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--radius-xs); }
	.trouble .a { padding: 0 2px 16px; font-size: 14px; color: var(--muted-foreground); max-width: 60ch; line-break: strict; }

	@media (max-width: 480px) {
		h1 { font-size: 21px; }
		.step { grid-template-columns: 28px 1fr; gap: 12px; }
		.step-num { width: 28px; height: 28px; font-size: 12.5px; }
	}
</style>
