<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Check, ChevronDown } from 'lucide-svelte';
	import { knownCurrencies } from '$lib/currencies';
	import { getLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	// The commission form's currency field (SONA-236): a short row of radios
	// (the entry's own currency, then recent ones), and Other currency for the
	// rest. Before the page's script runs, Other currency is a plain select
	// named `currencyOther`, which the server prefers over the row; once it
	// runs, it becomes a search over every currency the browser can name.
	interface Props {
		row: string[];
		value: string;
		/** Ids for the radiogroup's aria-describedby (hint and error). */
		describedBy?: string;
		invalid?: boolean;
		/** Says a pick out loud through the form's live region. */
		announce: (text: string) => void;
	}
	let { row, value = $bindable(), describedBy, invalid = false, announce }: Props = $props();

	const locale = getLocale();
	const names = new Intl.DisplayNames([locale], { type: 'currency' });
	const nameOf = (code: string) => names.of(code) ?? code;
	function symbolOf(code: string): string {
		try {
			const parts = new Intl.NumberFormat(locale, {
				style: 'currency',
				currency: code,
				currencyDisplay: 'narrowSymbol'
			}).formatToParts(0);
			return parts.find((p) => p.type === 'currency')?.value ?? code;
		} catch {
			return code;
		}
	}

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
		<label class="option" class:checked={value === code}>
			<input type="radio" name="currency" value={code} bind:group={value} bind:this={radios[code]} />
			<span class="symbol" aria-hidden="true">{symbolOf(code)}</span>
			<span class="code">{code}</span>
			<span class="name">{nameOf(code)}</span>
		</label>
	{/each}
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
			<ChevronDown size={14} aria-hidden="true" />
		</button>
	{:else}
		<label class="option other">
			<span>{m.admin_currency_other()}</span>
			<select name="currencyOther" class="other-select">
				<option value="">{m.admin_currency_other_none()}</option>
				{#each all as code (code)}
					<option value={code}>{code} {nameOf(code)}</option>
				{/each}
			</select>
		</label>
	{/if}
</div>

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
			aria-expanded="true"
			aria-controls="ce-currency-list"
			aria-activedescendant={matches[active] ? `ce-currency-opt-${matches[active]}` : undefined}
			bind:value={query}
			bind:this={searchInput}
			onkeydown={onSearchKeydown}
		/>
		<ul class="list" id="ce-currency-list" role="listbox" aria-label={m.admin_currency_find()} bind:this={list}>
			{#each matches as code, i (code)}
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
					<span class="symbol" aria-hidden="true">{symbolOf(code)}</span>
					<span class="name">{nameOf(code)}</span>
					{#if code === value}<Check size={14} aria-hidden="true" />{/if}
				</li>
			{/each}
		</ul>
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
	.currency-row { display: flex; flex-wrap: wrap; gap: 8px; outline: none; }
	.option {
		position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px;
		padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--background);
		color: var(--foreground); font: inherit; font-size: 13px; cursor: pointer; min-width: 0;
	}
	.option:hover { border-color: var(--muted-foreground); }
	.option.checked { border-color: var(--foreground); background: var(--muted); }
	.option input[type='radio'] { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
	.option:has(input:focus-visible), .other:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
	.currency-row[aria-invalid='true'] .option:not(.other) { border-color: var(--destructive); }
	.symbol { font-weight: 600; }
	.code { font-variant-numeric: tabular-nums; font-weight: 500; }
	.name { color: var(--muted-foreground); overflow-wrap: anywhere; }
	.other-select { font: inherit; font-size: 13px; max-width: 14rem; }
	.search { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
	.search-label { font-size: 13px; color: var(--muted-foreground); }
	.list {
		list-style: none; margin: 0; padding: 4px; max-height: 14rem; overflow-y: auto;
		border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--background);
	}
	.list li {
		display: grid; grid-template-columns: 3.5rem 3rem minmax(0, 1fr) auto; align-items: center; gap: 8px;
		min-height: 36px; padding: 4px 8px; border-radius: var(--radius-xs); font-size: 13px; cursor: pointer;
	}
	.list li.active { background: var(--muted); }
	.count { margin: 0; font-size: 12px; color: var(--muted-foreground); }
	@media (forced-colors: active) {
		.option.checked { outline: 2px solid Highlight; }
		.list li.active { outline: 2px solid Highlight; }
	}
</style>
