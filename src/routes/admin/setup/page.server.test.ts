import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { readFileSync } from 'node:fs';
import { isRedirect } from '@sveltejs/kit';
import * as schema from '$lib/server/db/schema';
import { getRawSetting, setRawSetting } from '$lib/server/settings';
import { __resetSetupCache } from '$lib/server/admin-auth';
import { DEFAULT_THEME_ID } from '$lib/themes';
import * as m from '$lib/paraglide/messages';
import { actions, load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
	CREATE TABLE characters (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
		is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL
	);`);
	const d1 = makeD1(sqlite);
	// The $app/environment stub sets dev=false, so the action walks the
	// production path: SETUP_TOKEN must exist and match the submitted token.
	const platform = { env: { DB: d1, SETUP_TOKEN: 'boot-token' } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

const VALID_FIELDS = {
	setupToken: 'boot-token',
	password: 'hunter2hunter2',
	confirmPassword: 'hunter2hunter2',
	siteName: 'Taro Surf'
};

function setupEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries({ ...VALID_FIELDS, ...fields })) body.append(k, v);
	return {
		platform,
		cookies: { set: () => {} },
		request: new Request('https://taro.surf/admin/setup', { method: 'POST', body })
	} as never;
}

describe('setup wizard — unrecognized enum values fail instead of silently defaulting', () => {
	it('rejects an unknown landingLayout and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { landingLayout: 'hero' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/landing layout/i);
		expect(await getRawSetting(db, 'landingLayout')).toBeNull();
		expect(await getRawSetting(db, 'siteName')).toBeNull();
	});

	it('rejects an unknown themeId and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { themeId: 'neon' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/theme/i);
		expect(await getRawSetting(db, 'themeId')).toBeNull();
	});

	it('saves the submitted values when they are valid', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(
				setupEvent(platform, {
					themeId: 'terracotta',
					landingLayout: 'threePath',
					adminEmail: 'admin@taro.surf'
				})
			);
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
			expect(e.status).toBe(303);
		}
		expect(await getRawSetting(db, 'themeId')).toBe('terracotta');
		expect(await getRawSetting(db, 'landingLayout')).toBe('threePath');
		// The optional recovery email is persisted when provided.
		expect(await getRawSetting(db, 'adminEmail')).toBe('admin@taro.surf');
	});

	it('rejects an adminEmail that does not look like an email and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { adminEmail: 'not-an-email' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/email/i);
		expect(await getRawSetting(db, 'adminEmail')).toBeNull();
		expect(await getRawSetting(db, 'siteName')).toBeNull();
	});

	it('does not write adminEmail when the field is empty', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { adminEmail: '' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'adminEmail')).toBeNull();
	});

	it('takes the defaults when the fields are absent', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, {}));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'themeId')).toBe(DEFAULT_THEME_ID);
	});
});

describe('setup wizard — AI disclosure affirmation (SONA-167)', () => {
	// Source pin: the action reads data.get('aiPageAffirmed'), so renaming or
	// dropping the checkbox would leave every test green while each new install
	// silently stored aiPageEnabled='false' and never published /ai.
	it('the wizard form posts the affirmation checkbox', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		// Capture the tag by name, then look inside it: attribute order and extra
		// attributes are harmless, the wrong type is not.
		const input = src.match(/<input[^>]*\bname="aiPageAffirmed"[^>]*>/)?.[0] ?? '';
		expect(input, 'affirmation input').toContain('type="checkbox"');
	});

	// Source pin (SONA-183): the affirmation enumerates three claims, so wrapping
	// its hint in the <label> made the checkbox's accessible name ~450 characters
	// read out before the checked state. The hint stays outside, wired up by id.
	it('describes the affirmation from outside its label', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		// Capture the whole tag, then look inside it: attribute order and extra
		// attributes are harmless, a missing aria-describedby is not.
		const input = src.match(/<input[^>]*\bname="aiPageAffirmed"[^>]*>/)?.[0] ?? '';
		expect(input).toContain('aria-describedby="aiPageAffirmed-desc"');
		// `>[^<]*</label>` is the containment assertion: the title label holds text and
		// nothing else, so no hint can be folded back in to restore the ~450-character
		// accessible name with every id still unchanged.
		const title = src.match(/<label[^>]*\bfor="aiPageAffirmed"[^>]*>[^<]*<\/label>/)?.[0] ?? '';
		expect(title, 'affirmation title label').toMatch(/class="[^"]*\baffirm-title\b/);
		const hint = src.match(/<small[^>]*\bid="aiPageAffirmed-desc"[^>]*>/)?.[0] ?? '';
		expect(hint, 'affirmation hint').toMatch(/class="[^"]*\baffirm-hint\b/);
		// Whole class token, so `class="affirm wide"` is caught but `affirm-title`
		// (a different class) is not.
		expect(src).not.toMatch(/<label[^>]*class="(?:[^"]*\s)?affirm(?:\s[^"]*)?"/);
	});

	// The /ai page speaks in the owner's first person and states their gallery
	// holds no AI-generated art. A NEW install must never publish that on the
	// absent-means-ON default, so the wizard writes the row explicitly from the
	// affirmation checkbox — both ways.
	it('publishes /ai only when the owner affirms it', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { aiPageAffirmed: 'on' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'aiPageEnabled')).toBe('true');
	});

	it('writes an explicit off when the affirmation is left unticked', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, {}));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		// Explicitly 'false', not absent: absence means ON for installs that
		// pre-date the feature, which a fresh install must not inherit.
		expect(await getRawSetting(db, 'aiPageEnabled')).toBe('false');
	});
});

describe('setup wizard — blank optional fields never clobber CLI-seeded settings (#60)', () => {
	it('a blank primaryCharacter leaves the CLI-seeded value intact', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.siteSettings).values({ key: 'primaryCharacter', value: 'Sparky' });

		try {
			await actions.default(setupEvent(platform, { primaryCharacter: '' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'primaryCharacter')).toBe('Sparky');
	});

	it('a filled primaryCharacter still saves', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { primaryCharacter: 'Taro' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'primaryCharacter')).toBe('Taro');
	});
});

describe('setup wizard — collects pronouns alongside the owner name (SONA-210)', () => {
	it('saves a submitted pronouns value verbatim', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { pronouns: 'she/her' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'pronouns')).toBe('she/her');
	});

	// Optional by operator decision: skipping the field in the wizard must not be
	// a different state from never having one, and it follows the #60 rule so a
	// blank does not clear a value the setup CLI seeded.
	it('a blank pronouns writes nothing and leaves a seeded value intact', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.siteSettings).values({ key: 'pronouns', value: 'they/them' });

		try {
			await actions.default(setupEvent(platform, { pronouns: '' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'pronouns')).toBe('they/them');
	});

	it('the wizard form carries the field, next to the owner name', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toMatch(/<input[^>]*\bname="pronouns"[^>]*>/);
		// Order matters: the pair reads as one identity, and a pronouns box that
		// drifted below the about textarea would read as a site setting instead.
		expect(source.indexOf('name="ownerName"')).toBeLessThan(source.indexOf('name="pronouns"'));
		expect(source.indexOf('name="pronouns"')).toBeLessThan(source.indexOf('name="fursonaName"'));
		// Not required: an owner who does not want pronouns published gets past
		// setup by leaving it empty.
		const input = source.match(/<input[^>]*\bname="pronouns"[^>]*>/)?.[0] ?? '';
		expect(input).not.toContain('required');
		// The wizard's own placeholder, which says the value gets published — the
		// settings one is just an example and the wizard is where the field is met
		// for the first time.
		expect(input).toContain('{m.admin_setup_pronouns_placeholder()}');
		expect(m.admin_setup_pronouns_placeholder()).toMatch(/shown/i);
	});
});

describe('setup wizard — collects Instagram alongside the other socials (SONA-130)', () => {
	it('normalizes and saves a submitted Instagram handle', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { instagram: 'sona.e2e.example' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		// Bare handle in, full profile URL out — same normalizeSocialUrl treatment
		// the other social fields get, not a raw passthrough.
		expect(await getRawSetting(db, 'instagramUrl')).toBe('https://www.instagram.com/sona.e2e.example');
	});

	it('accepts a full profile URL unchanged', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { instagram: 'https://instagram.com/sona.e2e.example' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'instagramUrl')).toBe('https://instagram.com/sona.e2e.example');
	});

	it('a blank Instagram writes nothing, per the #60 rule', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { instagram: '' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'instagramUrl')).toBeNull();
	});

	it('keeps FurTrack last, next to the primary-character field', () => {
		// Also the proof that the form posts the field at all — the server mapping is
		// useless if it does not, and the two live in different files.
		//
		// The primary-character label reads "(FurTrack tag)", so appending Instagram
		// to the end of the grid would have split the pair. Instagram goes after
		// Bluesky instead.
		const form = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const order = [...form.matchAll(/name="(\w+)" class="input" \/><\/label>/g)].map(([, n]) => n);
		expect(order).toEqual([
			'twitter',
			'bluesky',
			'instagram',
			'telegram',
			'furaffinity',
			'furtrack',
			'primaryCharacter'
		]);
	});
});

describe('setup wizard — the submit error is announced', () => {
	it('marks the error paragraph as an alert', () => {
		// enhance() submits without navigating, so a failed setup changes nothing a
		// screen reader would otherwise notice.
		const form = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(form).toMatch(/<p class="error" role="alert">\{form\.error\}<\/p>/);
	});
});

describe('setup wizard — creates the site character as is_owner (excluded from Featured) (#51)', () => {
	it('flags the wizard-created character is_owner=true', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { fursonaName: 'Sparky' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}

		const row = await db
			.select({ name: schema.characters.name, isOwner: schema.characters.isOwner })
			.from(schema.characters)
			.get();
		expect(row).toEqual({ name: 'Sparky', isOwner: true });
	});
});

describe('setup wizard — missing SETUP_TOKEN error is gh-first (#140 follow-up)', () => {
	it('fails 503 and leads with gh secret set, keeping wrangler as the fallback', async () => {
		const { platform } = makeDb();
		delete (platform as { env: Record<string, unknown> }).env.SETUP_TOKEN;

		const result = await actions.default(setupEvent(platform, {}));

		expect(result).toMatchObject({ status: 503 });
		const error = (result as { data: { error: string } }).data.error;
		const ghAt = error.indexOf('gh secret set SETUP_TOKEN');
		const wranglerAt = error.indexOf('wrangler pages secret put SETUP_TOKEN');
		expect(ghAt).toBeGreaterThanOrEqual(0);
		expect(wranglerAt).toBeGreaterThan(ghAt);
	});
});

// SONA-186. The wizard is the one route the setup gate exempts, so its own
// load/action pair is the only thing standing on it during a D1 outage.
describe('setup wizard — behaviour when the setup state cannot be read', () => {
	beforeEach(() => {
		__resetSetupCache();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// No site_settings table — how a D1 outage presents to this code.
	function brokenPlatform(): App.Platform {
		const sqlite = new Database(':memory:');
		return {
			env: { DB: makeD1(sqlite), SETUP_TOKEN: 'boot-token' }
		} as unknown as App.Platform;
	}

	function loadEvent(platform: App.Platform) {
		return { platform } as never;
	}

	async function redirectFrom(fn: () => unknown): Promise<string | null> {
		try {
			await fn();
			return null;
		} catch (e) {
			if (isRedirect(e)) return e.location;
			throw e;
		}
	}

	it('renders the wizard rather than erroring when the read fails', async () => {
		// Deliberate: the load must survive 'unknown' so the action's own 503
		// message has a page to render into. Erroring here would replace the
		// operator's only diagnostic with a bare error page.
		expect(await redirectFrom(() => load(loadEvent(brokenPlatform())))).toBeNull();
	});

	it('still closes the wizard on a configured site', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'adminPasswordHash', 'x');

		expect(await redirectFrom(() => load(loadEvent(platform)))).toBe('/admin/login');
	});

	it('renders the wizard on a genuinely unclaimed fork', async () => {
		const { platform } = makeDb();

		expect(await redirectFrom(() => load(loadEvent(platform)))).toBeNull();
	});

	// The load-bearing guard. Everything else in SONA-186 rests on the claim that
	// a takeover cannot complete while the setup state is unreadable, so assert it
	// end to end rather than trusting that getRawSetting still propagates.
	it('REFUSES to run setup while the setup state is unreadable', async () => {
		const platform = brokenPlatform();

		const result = await actions.default(setupEvent(platform, {}));

		expect(result).toMatchObject({ status: 503 });
		expect((result as { data: { error: string } }).data.error).toMatch(/could not verify setup state/i);
	});
});
