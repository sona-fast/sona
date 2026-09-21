import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// SONA-209 step 4: buttons and form controls are declared once, in app.css.
//
// A page that restates `.btn` or `.input` drifts from the shared class the
// moment the shared class changes, and the drift is invisible until someone
// opens that one page. The restatements that had accumulated across the app are
// gone, the differences that repeated are named variants in app.css
// (.btn-compact, .btn-full-mobile, .btn-desktop-only,
// .input-sm, .input-plain, .input-form-width), and what is left is listed below
// with the reason it stays scoped.
//
// The list is counted, not just matched, in the same shape as the raw --primary
// allowlist in theme-contrast.test.ts: a file may keep exactly as many scoped
// control rules as it has reasons here, so a NEW one in a listed file fails this
// test the same way a new one in an unlisted file does.
describe('control styling lives in app.css (SONA-209)', () => {
	const srcRoot = fileURLToPath(new URL('..', import.meta.url));

	// Almost every entry is layout: the rule positions a shared-class control
	// inside the component's own row or grid (flex, order, width, margin) and
	// sets no property the shared class sets. Those cannot become variants
	// without moving the container's layout into app.css. The rest are one-offs
	// that no second page shares.
	const ALLOWED = new Map<string, string[]>([
		[
			'/routes/(public)/gallery/+page.svelte',
			[
				"select.filter-select — under forced colors, hands the native caret back where the page's own appearance:none outranks app.css's forced-colors rule; not expressible as a variant (SONA-209 #446)"
			]
		],
		[
			'/lib/components/ConCard.svelte',
			[
				'.actions .btn — a 7px gap, one past the shared 6px, on this card\'s own rhythm',
				'.actions .btn-primary — order, so the save sits on top once the pair stacks'
			]
		],
		['/lib/components/ConfirmDialog.svelte', ['.dialog-actions .btn — the two buttons split the dialog footer evenly']],
		[
			'/lib/components/NewArtistDialog.svelte',
			[
				'.social-field .input — fills the rest of its icon row',
				'.name-field .input — fills the row beside the lookup spinner'
			]
		],
		['/lib/components/StickerPackForm.svelte', ['.select-with-action .input — fills the row beside its action button']],
		[
			'/lib/components/TagSuggestions.svelte',
			[
				'.input-group — the row wrapper, not the .input control it holds',
				'.input-group .input — fills the row beside the add button',
				'.input-group — the same wrapper wrapping onto two rows below 640px'
			]
		],
		[
			'/lib/components/VrAvatarForm.svelte',
			[
				'.artist-pick select — fills the row beside the "new artist" button',
				'.btn-destructive-outline — the "delete avatar" button, the only one of its shape in the app',
				'.btn-destructive-outline:hover — its tinted hover fill',
				'.btn-destructive-outline:disabled — it shows a progress cursor, not a refusal'
			]
		],
		[
			'/routes/admin/artists/+page.svelte',
			['.modal-actions .btn — the modal footer buttons split the row on a phone']
		],
		['/routes/admin/collections/+page.svelte', ['.add-form-actions .btn — add and cancel split the row once the form stacks']],
		[
			'/routes/admin/fursuit/+page.svelte',
			[
				'.tag-field .input — a floor rather than a cap, so the tag list keeps room to type',
				'.grant-row .input — a denser field than .input-sm, sized to the grant row it sits in',
				'.btn-icon — a 32px square icon button; no second page uses one',
				'.btn-icon:hover — its hover colour'
			]
		],
		[
			'/routes/admin/settings/+page.svelte',
			[
				'.security-section > .btn — spacing below the section it submits',
				'textarea — vertical-only resize; the settings textareas sit in a fixed-width column',
				'.export-card .btn, .danger-card .btn — nowrap, so the description text takes the squeeze',
				'.lookup-section .btn-remove — destructive label on an outline button, with its contrast rationale in place',
				'.lookup-section .btn-remove:hover — the hover signal rides the border, for the same reason',
				'.lookup-section .remove-confirm .btn-outline — a boundary mixed for the panel it sits on',
				'.add-color .input — the hex field is capped narrower than a name field'
			]
		],
		['/routes/admin/stickers/+page.svelte', ['.btn.disabled — an anchor cannot be :disabled, so the state is a class']],
		['/routes/admin/stickers/import/+page.svelte', ['.select-with-action .input — fills the row beside its action button']],
		['/routes/admin/tags/+page.svelte', ['.add-form-actions .btn — add and cancel split the row once the form stacks']]
	]);

	const pages = readdirSync(srcRoot, { recursive: true })
		.map(String)
		.filter((p) => p.endsWith('.svelte'))
		.map((p) => `/${p}`);

	// The subject of a selector is its last compound — `.input-group .tag-pill`
	// styles a pill, not an input. A compound counts when it names one of the
	// shared controls: `.btn`, `.input`, any `.btn-*`/`.input-*` variant, or a
	// bare `select`/`textarea` element. The match is by name, so a control
	// rebuilt under another name (`.file-btn`, `.icon-btn`, a bare `button`
	// rule) is invisible to it; widening to `*-btn` and `button` trips 18
	// files today, nearly all of them icon and link buttons that are their own
	// controls rather than copies of `.btn`. Those belong to a later SONA-209
	// step, and the pattern grows when that step gives them shared names.
	const CONTROL_CLASS = /^\.(?:btn|input)(?:-[A-Za-z0-9_-]+)?$/;

	// `:global(select)` and `:where(textarea)` style the element they wrap, so
	// the wrapper comes off before the subject is read.
	const unwrap = (part: string): string => {
		const inner = part.replace(/:(?:global|where|is)\(([^()]*)\)/g, '$1');
		return inner === part ? part : unwrap(inner);
	};

	function isControlSubject(selector: string): boolean {
		return selector.split(',').some((part) => {
			const compound = unwrap(part).trim().split(/[\s>+~]+/).filter(Boolean).pop();
			if (!compound) return false;
			if (/^(?:select|textarea)\b/.test(compound)) return true;
			return (compound.match(/\.[A-Za-z][A-Za-z0-9_-]*/g) ?? []).some((c) => CONTROL_CLASS.test(c));
		});
	}

	// Walks the <style> blocks of a component and returns every rule selector,
	// including the ones nested inside @media and other at-rules, and the ones
	// nested inside another rule — CSS nesting puts `.btn { }` one level down,
	// where it styles a button exactly as a top-level copy would.
	function selectors(source: string): string[] {
		const found: string[] = [];
		// A nested rule's selector is relative to its parent: `&:hover` inside
		// `.btn` is `.btn:hover`, and a bare `.icon` inside it is `.btn .icon`.
		const resolve = (selector: string, parent: string): string =>
			selector
				.split(',')
				.map((part) => {
					const p = part.trim();
					if (!parent) return p;
					return p.includes('&') ? p.replace(/&/g, parent) : `${parent} ${p}`;
				})
				.join(', ');
		const collect = (css: string, parent = '') => {
			let depth = 0;
			let selectorStart = 0;
			let bodyStart = 0;
			for (let i = 0; i < css.length; i++) {
				const char = css[i];
				if (char === '{') {
					if (depth === 0) bodyStart = i + 1;
					depth++;
				} else if (char === '}') {
					depth--;
					if (depth === 0) {
						// Declarations can sit before a nested rule, so the selector is
						// what follows the last one rather than the whole slice.
						const selector = css
							.slice(selectorStart, bodyStart - 1)
							.split(';')
							.pop()!
							.trim()
							.replace(/\s+/g, ' ');
						// An at-rule is a container, not a rule: what it holds is found by
						// the same walk one level down. A plain rule's body holds
						// declarations, which have no braces, so the recursion is free.
						const resolved = selector.startsWith('@') ? parent : resolve(selector, parent);
						if (!selector.startsWith('@')) found.push(resolved);
						collect(css.slice(bodyStart, i), resolved);
						selectorStart = i + 1;
					}
				}
			}
		};
		for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
			collect(block[1].replace(/\/\*[\s\S]*?\*\//g, ''));
		}
		return found;
	}

	// No file uses CSS nesting today, so a fixture is the only thing holding the
	// walk to it: a nested restatement would otherwise be invisible to all three
	// counts below and drift exactly the way this suite exists to stop.
	it('reads the subject through :global, :where and :is', () => {
		expect(isControlSubject(':global(select)')).toBe(true);
		expect(isControlSubject('.row :where(textarea)')).toBe(true);
		expect(isControlSubject(':is(.card .btn)')).toBe(true);
		expect(isControlSubject(':global(select):focus')).toBe(true);
		expect(isControlSubject(':global(.btn).danger')).toBe(true);
		expect(isControlSubject(':global(.card) .tag-pill')).toBe(false);
	});

	it('counts a control rule nested inside another rule', () => {
		const nested = '<style>\n\t.card { padding: 4px; .btn { border: none; } }\n</style>';
		expect(selectors(nested)).toContain('.card .btn');
		expect(selectors(nested).filter(isControlSubject)).toEqual(['.card .btn']);
		const amp = '<style>\n\t.btn { color: red; &:hover { color: blue; } .icon { size: 1; } }\n</style>';
		expect(selectors(amp).filter(isControlSubject)).toEqual(['.btn', '.btn:hover']);
		const media = '<style>\n\t.row { @media (max-width: 640px) { .btn { width: 100%; } } }\n</style>';
		expect(selectors(media).filter(isControlSubject)).toEqual(['.row .btn']);
	});

	// The bulk-action bar on the sticker importer is a row of .btn-compact
	// buttons with the artist select at its head. The select carried a scoped
	// `sm` class that matched no rule; .input-sm is the variant that matches.
	// It sets font-size and padding only — .input's 40px height still applies —
	// so what this fixes is the select matching its twin in StickerPackForm's
	// bulk bar rather than rendering a size the app declares nowhere.
	it('the sticker importer bulk bar uses the compact input', () => {
		const source = readFileSync(`${srcRoot}/routes/admin/stickers/import/+page.svelte`, 'utf8');
		const select = source.match(/<select[^>]*bind:value=\{bulkArtist\}[^>]*>/)?.[0];
		expect(select, 'the bulk-artist select moved or was renamed').toBeDefined();
		expect(select).toContain('class="input input-sm"');
	});

	// .file-btn is the VR form's file-picker pair, kept local rather than folded
	// into .btn-compact. Pinned HERE, beside the variant it resembles, because no
	// other suite reads that component's layout CSS: the rule sits under a
	// `label { flex-direction: column }` that would stack the picker's label and
	// its icon, so `flex-direction: row` is what keeps the pair on one line
	// (SONA-209 r2).
	it('the VR file-picker buttons lay their contents out in a row', () => {
		const source = readFileSync(`${srcRoot}/lib/components/VrAvatarForm.svelte`, 'utf8');
		const rule = source.match(/^\s*\.file-btn\s*\{([^}]*)\}/m)?.[1];
		expect(rule, '.file-btn rule not found in VrAvatarForm.svelte').toBeDefined();
		expect(rule).toMatch(/flex-direction:\s*row/);
	});

	// The pair goes inert together during a save, so it has to dim together too:
	// the <label> has no :disabled state, so .file-btn.disabled carries the
	// dimming and the <button> twin takes the class as well as the attribute
	// (SONA-209 r3).
	it('both VR file-picker buttons take the disabled class while saving', () => {
		const source = readFileSync(`${srcRoot}/lib/components/VrAvatarForm.svelte`, 'utf8');
		const replace = source.match(/<label[^>]*class="file-btn"[^>]*>/)?.[0];
		expect(replace, 'the replace-model label moved or was renamed').toBeDefined();
		expect(replace).toContain('class:disabled={saving}');
		const remove = source.match(/<button[^>]*onclick=\{removeModel\}[^>]*>/)?.[0];
		expect(remove, 'the remove-model button moved or was renamed').toBeDefined();
		expect(remove).toContain('class:disabled={saving}');
	});

	const scopedSelectors = (file: string) =>
		selectors(readFileSync(`${srcRoot}${file}`, 'utf8')).filter(isControlSubject).sort();
	const scopedCount = (file: string) => scopedSelectors(file).length;
	// Each reason opens with the selector it excuses, so the allowlist names the
	// rules themselves and not only how many there are. A count alone lets a
	// wrapper rule such as `.input-group` (matched by name, styled as layout)
	// come and go in the same edit that adds a real restatement.
	const allowedSelectors = (reasons: string[]) => reasons.map((r) => r.split(' — ')[0].trim()).sort();

	it('has no allowlist entry for a file that no longer scopes a control rule', () => {
		const stale = [...ALLOWED.keys()].filter((f) => !pages.includes(f) || scopedCount(f) === 0);
		expect(stale, 'these files stopped scoping control rules — drop them from ALLOWED').toEqual([]);
	});

	it('allows exactly the scoped control rules each file lists, one reason per rule', () => {
		const drifted = [...ALLOWED]
			.filter(([file]) => pages.includes(file))
			.map(([file, reasons]) => ({ file, actual: scopedSelectors(file), listed: allowedSelectors(reasons) }))
			.filter(({ actual, listed }) => JSON.stringify(actual) !== JSON.stringify(listed))
			.map(({ file, actual, listed }) => {
				const added = actual.filter((s) => !listed.includes(s));
				const gone = listed.filter((s) => !actual.includes(s));
				return `${file}: unlisted [${added.join(' | ')}] missing [${gone.join(' | ')}]`;
			});
		expect(
			drifted,
			'a scoped .btn/.input/select/textarea rule was added to or removed from an allowlisted file — use a variant from app.css, or list the rule above (selector, then the reason it cannot be one).'
		).toEqual([]);
	});

	it('declares button and input styling once, in app.css', () => {
		const offenders = pages.filter((f) => !ALLOWED.has(f) && scopedCount(f) > 0);
		expect(
			offenders,
			'a page restated a shared control class. Delete the restatement, or add a named variant to app.css (.btn-compact, .btn-full-mobile, .btn-desktop-only, .input-sm, .input-plain, .input-form-width) and use that.'
		).toEqual([]);
	});
});
