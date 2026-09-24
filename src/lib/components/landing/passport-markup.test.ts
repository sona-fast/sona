import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source pins for the passport markup that the unit suite can't render (it runs
// no Svelte components). The rendered page, its heading, stamp names and empty
// state are driven end to end in tests/e2e/passport.spec.ts.

const passport = readFileSync(new URL('./Passport.svelte', import.meta.url), 'utf8');
const stamp = readFileSync(new URL('./Stamp.svelte', import.meta.url), 'utf8');
const home = readFileSync(new URL('../../../routes/(public)/+page@.svelte', import.meta.url), 'utf8');
const artworkCard = readFileSync(new URL('../ArtworkCard.svelte', import.meta.url), 'utf8');
const gallery = readFileSync(new URL('../../../routes/(public)/gallery/+page.svelte', import.meta.url), 'utf8');
const collection = readFileSync(
	new URL('../../../routes/(public)/collections/[slug]/+page.svelte', import.meta.url),
	'utf8'
);
const ja = JSON.parse(readFileSync(new URL('../../../../messages/ja.json', import.meta.url), 'utf8'));

// Both pictures (the avatar and the piece) render the one <img> in the art
// snippet, so its attributes hold for each.
const imgs = [...passport.matchAll(/<img\b[\s\S]*?\/>/g)].map((m) => m[0]);
const img = imgs[0] ?? '';

// Comments stripped: a comment explaining why --ring is avoided must not count as a use.
const styleOf = (source: string) =>
	(source.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (source: string, selector: string) => {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return styleOf(source).match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
};

describe('passport markup', () => {
	it('renders both pictures from the one art snippet', () => {
		expect(imgs.length).toBe(1);
		expect(passport).toMatch(/\{#snippet art\(imageUrl: string, alt: string\)\}\s*<img\b/);
		expect([...passport.matchAll(/\{@render art\(picture\.imageUrl,/g)].length).toBe(2);
	});

	it('loads every first-screen picture eagerly at high priority', () => {
		expect(img).toContain('loading="eager"');
		expect(img).toContain('fetchpriority="high"');
	});

	// The avatar used to skip the transform, and a fixed "13rem" sizes made a
	// phone fetch the 960w file for a 7.5rem column.
	it('routes every picture through the image transform, sized to its column', () => {
		expect(img).toContain('src={cdnImage(imageUrl, 480)}');
		expect(img).toContain('use:rawFallback={imageUrl}');
		expect(img).toContain('sizes={PICTURE_SIZES}');
		expect(passport).toMatch(/const PICTURE_SIZES =\s*'\(max-width: 22rem\) 10rem, \(max-width: 34\.5rem\) 7\.5rem,/);
	});

	// Intl.DateTimeFormat.format throws on an Invalid Date, which would 500 the
	// homepage during SSR; both formatters bail out first.
	it('drops a date line rather than formatting an Invalid Date', () => {
		for (const fn of ['monthYear', 'untilDay']) {
			const body = passport.match(new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\t\\}`))?.[1] ?? '';
			expect(body).toMatch(/if \(Number\.isNaN\(date\.getTime\(\)\)\) return undefined;[\s\S]*\.format\(/);
		}
	});

	// The caption is only the credit: the title is the image's alt (and so the
	// link's name), never a caption sentence with a full stop after it.
	it('captions the piece with the credit alone and names the link by the title', () => {
		const caption =
			passport.match(/<a class="photo-frame"[\s\S]*?<figcaption>([\s\S]*?)<\/figcaption>/)?.[1] ?? '';
		expect(caption).toMatch(/^\s*\{#if picture\.artistName\}\{m\.passport_art_by\(\)\}/);
		expect(caption).not.toContain('title');
		expect(passport).toContain('<a class="photo-frame" href="/gallery/{picture.slug}">');
		expect(passport).toContain('{@render art(picture.imageUrl, picture.title)}');
		expect(passport).not.toContain('passport_caption_title');
		expect(passport).not.toContain('passport_caption_ref');
	});

	// The pool is SFW only, so the passport has no NSFW gate of its own: no
	// blur, no scrim, no label, and no reveal button inside the link.
	it('draws no NSFW gate on the picture', () => {
		expect(passport).not.toMatch(/<button\b/);
		expect(passport).not.toMatch(/class:blurred|class="gate"|\.gate\b|picture\.nsfw/);
	});

	// 50% black measures 3.95:1 behind the label over light blurred art, so the
	// gallery card's gate uses 60%.
	it('lays the gallery card NSFW label on a 60% scrim', () => {
		expect(rule(artworkCard, '.nsfw-overlay')).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.6\)/);
	});

	// The heading names the stamps region and keeps the h1, h2, h3 outline, but
	// nothing shows: no visible "Stamps" label and no note under it.
	it('keeps the stamps heading for screen readers only, with no note', () => {
		expect(passport).toContain('<section class="page page--stamps" aria-labelledby="pp-stamps">');
		expect(passport).toContain('<h2 id="pp-stamps" class="sr-only">{m.passport_stamps()}</h2>');
		expect(passport).not.toContain('stamps-note');
		// The first group label takes the top of the page when no Here now stamp
		// sits between it and the hidden heading.
		expect(rule(passport, '.sr-only + .group-h')).toMatch(/margin-top:\s*0/);
	});

	// The card's title was a fixed h3, so /gallery and a collection page jumped
	// from the h1 straight to h3. Other callers (the homepage, under its h2)
	// keep the h3 default.
	it('lets the page pick the card title level: h2 straight under an h1', () => {
		expect(artworkCard).toContain("headingLevel = 'h3'");
		expect(artworkCard).toContain('<svelte:element this={headingLevel} class="card-title">');
		expect(artworkCard).not.toMatch(/<h3\b/);
		for (const source of [gallery, collection]) expect(source).toMatch(/<ArtworkCard\b[^>]*headingLevel="h2"/);
		expect(gallery).toContain('<h2 class="list-title">');
		expect(home).not.toContain('headingLevel=');
	});

	// Japanese joins with its own full-width colon and 読点, and runs on after 。
	// with no space.
	it('punctuates the accessible names and the caption for Japanese', () => {
		expect(stamp).toContain("`${kicker}${ja ? '：' : ': '}`");
		expect(stamp).toContain(".join(ja ? '、' : ', ')");
		expect(stamp).toContain("lines.join(ja ? '、' : ' ')");
		// 作者：Test Artist, but Art by Test Artist.
		expect(passport).toContain("{m.passport_art_by()}{ja ? '' : ' '}<a");
		expect(ja.passport_art_by).toBe('作者：');
		// The place carries its own ASCII comma ("Denver, CO"), so a 読点 after
		// it would mix the two; a space joins it to the date.
		expect(ja.passport_live_line).toBe('{place} {date}まで');
		// A zero-width space in a message is a visual break point, never spoken.
		expect(stamp).toContain(".replace(/\\u200b/g, '')");
	});

	// Japanese has no spaces, so without keep-all the browser splits words
	// mid-way ("今 / 後") and strands 「す。」 on a line of its own.
	it('breaks Japanese stamp lines at punctuation, not mid-word', () => {
		const line = rule(stamp, '.line:lang(ja)');
		expect(line).toMatch(/word-break:\s*keep-all/);
		expect(line).toMatch(/overflow-wrap:\s*anywhere/);
		// The name too, and strict so no line starts with ー ("ギャラリ / ー").
		const name = rule(stamp, '.name:lang(ja)');
		expect(name).toMatch(/word-break:\s*keep-all/);
		expect(name).toMatch(/overflow-wrap:\s*anywhere/);
		expect(name).toMatch(/line-break:\s*strict/);
		// keep-all leaves no break inside the About line, so its zero-width space
		// after と is the one place it may wrap in the round stamp.
		expect(ja.passport_about_links_cons).toBe('リンクと\u200b参加予定のコン');
	});

	// Text zoom scales em but not px, so an em bottom padding keeps the folio
	// clear of the last stamp at 200%.
	it('reserves em space for the folio under each page', () => {
		expect(rule(passport, '.page')).toMatch(/padding:\s*28px 40px 3em/);
		// The phone and single-page layouts override it; theirs stay in em too.
		expect(styleOf(passport)).toMatch(
			/@media \(max-width: 768px\)\s*\{\s*\.page\s*\{\s*padding:\s*20px 20px 2\.5em;/
		);
		expect(rule(passport, '.book--single .page + .page')).toMatch(/padding-bottom:\s*2\.5em/);
	});

	// With no picture the lone .fields child must fill the row. The phone rule
	// for .data comes after .data--solo at the same specificity, so without the
	// restatement inside the 30rem block it put the fields in a 7.5rem column.
	it('keeps the pictureless data page one column at phone widths', () => {
		const phone = styleOf(passport).match(/@container \(max-width: 30rem\)\s*\{([\s\S]*?)\n\t\}/)?.[1] ?? '';
		expect(phone).toMatch(/\.data\s*\{[^}]*\}\s*\.data--solo\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}/);
	});

	it('keeps list semantics on the unstyled stamp and social lists', () => {
		const lists = [...passport.matchAll(/<ul\b[^>]*>/g)].map((m) => m[0]);
		expect(lists.length).toBe(3);
		for (const list of lists) expect(list).toContain('role="list"');
	});

	it('renders the pronouns row only when pronouns are set, spoken once with the prefix', () => {
		expect(passport).toMatch(/\{#if passport\.pronouns\}[\s\S]*?m\.pronouns_prefix\(\)[\s\S]*?\{\/if\}/);
	});

	it('draws focus rings inside the book with --foreground, never --ring', () => {
		expect(rule(passport, '.book a:focus-visible')).toMatch(/outline:\s*2px solid var\(--foreground\)/);
		expect(rule(stamp, '.stamp:focus-visible')).toMatch(/outline:\s*2px solid var\(--foreground\)/);
		expect(styleOf(passport) + styleOf(stamp)).not.toContain('--ring');
	});

	it('gives the machine-readable line a rem floor so it never shrinks past legible', () => {
		expect(rule(passport, '.mrz')).toMatch(/font-size:\s*max\(0\.625rem,\s*min\(0\.875rem,\s*3\.05cqi\)\)/);
	});

	it('animates nothing: the stamps tilt statically and nothing transitions', () => {
		for (const source of [passport, stamp]) {
			expect(styleOf(source)).not.toMatch(/\b(animation|transition)\s*:/);
		}
		// Wide stamps tilt half as far, so stacked ones can't touch at 200% zoom.
		expect(rule(stamp, '.stamp.wide')).toMatch(/rotate\(calc\(var\(--tilt, 0deg\) \/ 2\)\)/);
	});

	it('is the homepage branch for the passport layout, with the shared chrome', () => {
		const branch = home.match(/\{:else if passport\}([\s\S]*?)\{:else\}/)?.[1] ?? '';
		expect(branch).toContain('<Passport {passport} />');
		for (const part of ['<Header', '<Footer', '<MobileCredit', '<MobileNav']) expect(branch).toContain(part);
	});
});
