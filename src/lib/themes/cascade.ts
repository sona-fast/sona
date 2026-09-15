// How a token READS at runtime, as data. The generator emits blocks; this says
// which of those blocks an element actually sees and what a var() reference
// lands on, so `scripts/build-themes.ts` and `src/lib/theme-contrast.test.ts`
// agree on one implementation of the cascade instead of carrying a copy each.
//
// Not imported by index.ts on purpose: the themes are passed in, so nothing here
// pulls palette data into a client bundle (see the comment in ./all.ts).

import { TOKEN_CSS_NAMES, isAlias, type PartialThemeTokens, type ThemeDefinition, type TokenKey } from './types.ts';

export type ThemeMode = 'dark' | 'light';

/**
 * The blocks that match one theme × mode, in falling precedence.
 *
 * Every theme block has the same specificity except a theme's own light block
 * (two attribute selectors), so ties go to source order, and the alternate
 * themes are emitted after the default one. For an element carrying
 * data-theme-id='aurora' data-theme='light' the matching blocks are, in falling
 * precedence: the aurora light block, the aurora dark block (later in source
 * than [data-theme='light']), the default light block, then :root. That is why
 * aurora light has to re-declare --link: without it the aurora DARK block's
 * value wins there.
 */
export function blockChain(
	themes: ThemeDefinition[],
	id: string,
	mode: ThemeMode
): PartialThemeTokens[] {
	const theme = themes.find((t) => t.id === id);
	if (!theme) throw new Error(`unknown theme id: ${id}`);
	const base = themes[0];
	if (theme === base) {
		return mode === 'dark' ? [theme.dark] : [theme.light, theme.dark];
	}
	return mode === 'dark'
		? [theme.dark, base.dark]
		: [theme.light, theme.dark, base.light, base.dark];
}

/**
 * The value the browser computes for one token on one theme × mode, or
 * undefined when no matching block declares it. An alias (var(--primary))
 * resolves through the SAME chain, because that is what a var() reference does
 * at use time — it reads the element's own cascaded value. Throws on an alias
 * cycle, naming the path it looped through.
 */
export function resolveToken(
	themes: ThemeDefinition[],
	id: string,
	mode: ThemeMode,
	key: TokenKey,
	seen: TokenKey[] = []
): string | undefined {
	if (seen.includes(key)) {
		throw new Error(`alias cycle on ${id}/${mode}: ${[...seen, key].join(' → ')}`);
	}
	for (const block of blockChain(themes, id, mode)) {
		const value = block[key];
		if (value === undefined) continue;
		return isAlias(value) ? resolveToken(themes, id, mode, value.ref, [...seen, key]) : value;
	}
	return undefined;
}

/**
 * Throws if any token's alias chain loops on any theme × mode. A cycle
 * (`--accent: var(--accent-foreground)` pointing back at `--accent`) renders as
 * perfectly valid CSS that browsers resolve to the guaranteed-invalid value, so
 * the page loses the token silently — catching it at generation time is the only
 * place it is cheap.
 */
export function assertNoAliasCycles(themes: ThemeDefinition[]): void {
	for (const theme of themes) {
		for (const mode of ['dark', 'light'] as ThemeMode[]) {
			for (const key of Object.keys(TOKEN_CSS_NAMES) as TokenKey[]) {
				resolveToken(themes, theme.id, mode, key);
			}
		}
	}
}
