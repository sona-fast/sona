<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { Check, ChevronDown } from 'lucide-svelte';
	import { CURRENCY_OTHER, currencySymbol, knownCurrencies } from '$lib/currencies';
	import { getLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	// The commission form's currency field (SONA-236): a short row of radios
	// (the entry's own currency, then recent ones), and Other currency for the
	// rest. Before the page's script runs, Other currency is a radio in the row
	// and a plain select named `currencyOther`, which the server reads when that
	// radio is picked; once it runs, it becomes a search over every currency the
	// browser can name.
	interface Props {
		row: string[];
		value: string;
		/** Ids for the radiogroup's aria-describedby (hint and error). */
		describedBy?: string;
		invalid?: boolean;
		/** Says a pick out loud through the form's live region. */
		announce: (text: string) => void;
		/** The field's error and hint, drawn under the row and above the search. */
		below?: Snippet;
	}
	let { row, value = $bindable(), describedBy, invalid = false, announce, below }: Props = $props();

	const locale = getLocale();
	const names = new Intl.DisplayNames([locale], { type: 'currency' });
	const nameOf = (code: string) => names.of(code) ?? code;

	// Currencies picked from Other currency join the row at the front. The row
	// prop holds what the page loaded with; a pick never removes one of those.
	let picked = $state<string[]>([]);
	// The current value always has an option, even one the row never offered
	// (a refused save that came back with an Other currency in it).
	const shown = $derived.by(() => {
		const extra = [...picked, value].filter((c, i, a) => c && !row.includes(c) && a.indexOf(c) === i);
		return [...extra, ...row];
	});

	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const all = knownCurrencies();
	let open = $state(false);
	let query = $state('');
	let active = $state(0);
	let searchInput = $state<HTMLInputElement>();
	let otherButton = $state<HTMLButtonElement>();
	let list = $state<HTMLUListElement>();
	const radios: Record<string, HTMLInputElement> = $state({});

	// Matches the code or the name in the admin language, so a Japanese owner
	// can type 円 or ドル.
	const matches = $derived.by(() => {
		const q = query.trim().toLocaleLowerCase(locale);
		if (!q) return all;
		return all.filter((code) => code.toLowerCase().includes(q) || nameOf(code).toLocaleLowerCase(locale).includes(q));
	});
	$effect(() => {
		void matches;
		active = 0;
	});

	async function openSearch() {
		open = true;
		query = '';
		await tick();
		searchInput?.focus();
	}

	async function closeSearch() {
		open = false;
		await tick();
		otherButton?.focus();
	}

	async function pick(code: string) {
		if (!row.includes(code) && !picked.includes(code)) picked = [code, ...picked];
		value = code;
		open = false;
		announce(m.admin_currency_picked_announce({ code, name: nameOf(code) }));
		await tick();
		radios[code]?.focus();
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (matches.length === 0) return;
			const step = e.key === 'ArrowDown' ? 1 : -1;
			active = (active + step + matches.length) % matches.length;
			list?.querySelector(`#ce-currency-opt-${matches[active]}`)?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter') {
			// Enter in a form field would submit the entry.
			e.preventDefault();
			if (matches[active]) void pick(matches[active]);
		} else if (e.key === 'Escape') {
			// Stop here so an enclosing dialog or page handler doesn't also act.
			e.preventDefault();
			e.stopPropagation();
			void closeSearch();
		}
	}
</script>

<!-- Other currency sits beside the radiogroup, not in it: it's an action (or,
     before the script runs, a select), not one of the group's radios. -->
<div class="currency-field">
	<div
		class="currency-row"
		role="radiogroup"
		id="ce-currency"
		tabindex="-1"
		aria-labelledby="ce-currency-label"
		aria-describedby={describedBy}
		aria-invalid={invalid ? 'true' : undefined}
	>
		{#each shown as code (code)}
			{@const symbol = currencySymbol(code, locale)}
			<!-- The pill shows the symbol and code; the name stays in the radio's
			     accessible name. Checked state is drawn from :checked, so it shows
			     before the page's script runs too. -->
			<label class="option">
				<input type="radio" name="currency" value={code} bind:group={value} bind:this={radios[code]} />
				<span class="tick" aria-hidden="true"><Check size={14} /></span>
				{#if symbol}<span class="symbol" aria-hidden="true">{symbol}</span>{/if}
				<span class="code">{code}</span>
				<span class="sr-only">{nameOf(code)}</span>
			</label>
		{/each}
		{#if !hydrated}
			<!-- Picking this radio is what makes the server read the select beside
			     the row, so a row pick made after a select pick still wins. -->
			<label class="option">
				<input type="radio" name="currency" value={CURRENCY_OTHER} />
				<span class="tick" aria-hidden="true"><Check size={14} /></span>
				<span>{m.admin_currency_other()}</span>
			</label>
		{/if}
	</div>
	{#if hydrated}
		<button
			type="button"
			class="option other"
			aria-expanded={open}
			aria-controls="ce-currency-search"
			bind:this={otherButton}
			onclick={() => (open ? closeSearch() : openSearch())}
		>
			{m.admin_currency_other()}
			<ChevronDown size={14} class="chevron" aria-hidden="true" />
		</button>
	{:else}
		<select name="currencyOther" class="other-select" aria-label={m.admin_currency_other()}>
			<option value="">{m.admin_currency_other_none()}</option>
			{#each all as code (code)}
				<option value={code}>{code} {nameOf(code)}</option>
			{/each}
		</select>
	{/if}
</div>

{@render below?.()}

{#if hydrated && open}
	<div class="search" id="ce-currency-search">
		<label class="search-label" for="ce-currency-find">{m.admin_currency_find()}</label>
		<input
			id="ce-currency-find"
			class="input"
			type="text"
			role="combobox"
			autocomplete="off"
			aria-autocomplete="list"
			aria-expanded={matches.length > 0}
			aria-controls={matches.length > 0 ? 'ce-currency-list' : undefined}
			aria-activedescendant={matches[active] ? `ce-currency-opt-${matches[active]}` : undefined}
			bind:value={query}
			bind:this={searchInput}
			onkeydown={onSearchKeydown}
		/>
		<!-- No list at all with no matches: an empty bordered box reads as a stray line. -->
		{#if matches.length > 0}
			<ul class="list" id="ce-currency-list" role="listbox" aria-label={m.admin_currency_find()} bind:this={list}>
				{#each matches as code, i (code)}
					{@const listSymbol = currencySymbol(code, locale, 'symbol')}
					<!-- 'symbol', not 'narrowSymbol': the list tells A$ from CA$. -->
					<!-- Options are picked with a click or from the search box's keys
					     (aria-activedescendant); they never take focus themselves. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id="ce-currency-opt-{code}"
						role="option"
						aria-selected={i === active}
						class:active={i === active}
						onclick={() => pick(code)}
						onmousemove={() => (active = i)}
					>
						<span class="code">{code}</span>
						{#if listSymbol}<span class="symbol" aria-hidden="true">{listSymbol}</span>{/if}
						<span class="name">{nameOf(code)}</span>
						{#if code === value}
							<span class="current"
								><Check size={14} aria-hidden="true" /><span class="sr-only">{m.admin_currency_current()}</span></span
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<p class="count" role="status">
			{#if matches.length === 0}
				{m.admin_currency_matches_none({ query: query.trim() })}
			{:else}
				{m.admin_currency_matches({ count: matches.length })}
			{/if}
		</p>
	</div>
{/if}

<style>
	/* Wraps instead of scrolling sideways; each option at least 36px tall. */
	.currency-field, .currency-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
	.currency-row { outline: none; }
	/* --input, not --border: the pill's edge is the whole visible control (SONA-126). */
	.option {
		position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px;
		padding: 6px 12px; border: 1px solid var(--input); border-radius: var(--radius-pill); background: var(--background);
		color: var(--foreground); font: inherit; font-size: 13px; cursor: pointer; min-width: 0;
	}
	/* Hover only darkens the edge to the text color, never a primary tint.
	   Checked changes the edge and the fill and adds a check, so a hovered pill
	   never looks picked. */
	.option:not(:has(input:checked)):hover { border-color: var(--foreground); }
	.option:has(input:checked) {
		border-color: var(--primary-text);
		background: color-mix(in srgb, var(--primary) 14%, transparent);
	}
	.tick { display: none; color: var(--primary-text); }
	.option:has(input:checked) .tick { display: inline-flex; }
	/* Dashed: Other currency opens a search; it isn't a currency. */
	.other { border-style: dashed; }
	.other[aria-expanded='true'] :global(.chevron) { transform: rotate(180deg); }
	.option input[type='radio'] { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
	.option:has(input:focus-visible), .other:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
	.currency-row[aria-invalid='true'] .option { border-color: var(--destructive); }
	.symbol { font-weight: 600; }
	.code { font-variant-numeric: tabular-nums; font-weight: 500; }
	.name { color: var(--muted-foreground); overflow-wrap: anywhere; }
	.other-select { font: inherit; font-size: 13px; max-width: 14rem; }
	.search { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-width: 24rem; }
	.search-label { font-size: 13px; color: var(--muted-foreground); }
	.list {
		list-style: none; margin: 0; padding: 4px; max-height: 14rem; overflow-y: auto;
		border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--background);
	}
	.list li {
		display: grid; grid-template-columns: 3.5rem 3rem minmax(0, 1fr) auto; align-items: center; gap: 8px;
		min-height: 36px; padding: 4px 8px; border: 1px solid transparent; border-radius: var(--radius-xs);
		font-size: 13px; cursor: pointer;
	}
	/* No symbol of its own: the name moves up beside the code. */
	.list li .code + .name { grid-column: span 2; }
	/* --muted alone can match the list's background (light mode), so the edge
	   carries the active option, in --primary-text as on the New Artist results
	   list (SONA-126). The crud e2e checks it against the list at 3:1. */
	.list li.active { border-color: var(--primary-text); background: var(--muted); }
	.current { display: inline-flex; }
	.count { margin: 0; font-size: 12px; color: var(--muted-foreground); }
	@media (forced-colors: active) {
		.option:has(input:checked) { outline: 2px solid Highlight; }
		.list li.active { outline: 2px solid Highlight; }
	}
</style>
