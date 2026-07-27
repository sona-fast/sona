# Sona

A self-hostable, forkable **fursona site** — a personal gallery for your
character's commissioned art, fursuit photos, and sticker packs, with a clean
single-admin CMS. Fork it, deploy it to your own Cloudflare account, configure it
through the setup UI, pick a theme, and it's your site.

Sona is the generalized version of [sparky.ink](https://sparky.ink) (the
original deployment it grew out of). The project home is
[sona.fast](https://sona.fast).

> **Status:** under active generalization. The de-branding (config + settings)
> and repo/config scaffolding are in place; the first-run setup wizard, theming,
> and the shared artist registry are in progress. See [Roadmap](#roadmap).

## What you get

- **Art gallery** — upload commissioned artwork, organize into collections, tag
  it, credit artists, mark NSFW, link source posts. Public browse + search; no
  visitor login.
- **Fursuit photos** — import your fursuit photos from FurTrack (license-aware),
  self-hosted afterward. *(Gated by `FURTRACK_MODE`; requires FurTrack approval
  for live use.)*
- **Sticker packs** — mirror Telegram sticker sets or upload your own; static,
  animated (.tgs→Lottie), and video stickers, with per-sticker artist credit and
  emoji search. *(Telegram import gated by `TELEGRAM_BOT_TOKEN`.)*
- **Conventions** — track the cons you're attending (picked from the
  [cons.fyi](https://cons.fyi) feed, synced from your Bluesky "going" labels, or
  entered manually); upcoming ones show on the About page.
- **Single-admin CMS** — a protected admin panel for all content management. No
  user accounts, no moderation tools — it's a personal site, not a platform.
- **Themes + landing layouts** *(in progress)* — selectable visual themes and
  landing-page layouts (a mosaic hero, or a multi-path entry).
- **Shared artist registry** *(in progress)* — opt into a central, curated artist
  directory so you don't re-enter the same artists every fork.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | **SvelteKit** (Svelte 5 runes), SSR + form actions |
| Hosting | **Cloudflare Pages** (`@sveltejs/adapter-cloudflare`) |
| Database | **Cloudflare D1** (SQLite at the edge) via **Drizzle ORM** |
| Image storage | **R2** or **UploadThing** (pluggable, per-site setting) |
| Auth | Cookie session, single admin |
| i18n | **Paraglide** (inlang) — public UI localized (en/ja) |

## Quick start (fork → deploy)

1. **Fork** this repo and clone it. `npm install`.
2. **Provision Cloudflare** with the setup CLI (after `npx wrangler login`):
   ```sh
   npm run setup
   ```
   It creates the Pages project, D1 database, and (optionally) an R2 bucket;
   writes `wrangler.toml`; attaches the D1/R2 bindings to the Pages project;
   applies migrations; and generates + sets the `SETUP_TOKEN` and `CRON_SECRET`
   secrets. It prints your one-time `SETUP_TOKEN` — keep it for step 4.

   > **Setting up a custom domain?** Export `CLOUDFLARE_API_TOKEN` +
   > `CLOUDFLARE_ACCOUNT_ID` (the same token as step 3, under **API token
   > scopes** below) before running setup so it can preflight your DNS /
   > image-transform config.

   > **Run it in a real terminal.** `npm run setup` is interactive; piping input
   > through `npm run` (e.g. `printf ... | npm run setup`) truncates stdin. If you
   > must script it, run the script directly: `npx tsx scripts/setup.ts < answers`.

   *(Prefer to do it by hand? Copy `wrangler.toml.example` → `wrangler.toml`,
   create the resources with `wrangler d1 create` / `wrangler r2 bucket create`,
   and set `SETUP_TOKEN` yourself.)*
3. **Deploy.** Pushing to `main` runs the GitHub Actions workflow
   ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)): it applies
   D1 migrations and deploys to Pages. Set repo secrets `CLOUDFLARE_ACCOUNT_ID` +
   `CLOUDFLARE_API_TOKEN`, and (optionally) repo variables `CLOUDFLARE_PAGES_PROJECT` /
   `D1_DATABASE_NAME` / `SITE_URL` / `FURTRACK_MODE` (`npm run setup` can set
   these for you). (Or deploy directly:
   `npx wrangler pages deploy .svelte-kit/cloudflare`.)

   **API token scopes.** Create a Cloudflare API token (dash → *My Profile → API
   Tokens → Create Token → Custom token*) with:

   | Scope | Why |
   |-------|-----|
   | Account · Cloudflare Pages · Edit | create/deploy the Pages project |
   | Account · D1 · Edit | create + migrate the database |
   | Account · Workers R2 Storage · Edit | create the image bucket |
   | Zone · DNS · Edit | **only if** attaching a custom domain (writes the apex record) |
   | Zone · WAF · Edit | **only if** attaching a custom domain — adds a WAF rate limit on the public download beacon (`POST /api/metrics/download`) |
   | Zone · Zone Settings · Edit | *optional* — lets setup enable image resizing for you |

   Without **DNS · Edit**, registering the Pages apex domain succeeds but the DNS
   write fails, leaving the domain stuck `pending` with a confusing 522.
4. **Finish in the first-run wizard.** Open `/admin/setup`, enter your
   `SETUP_TOKEN`, and set your admin password + site name, owner/persona name,
   social links, theme, and landing layout. The wizard runs once, then closes
   itself. (Your **image storage backend is chosen in the setup CLI** above, not
   here — switch it later in Settings → Storage Provider.)
5. **(For Telegram stickers)** set `TELEGRAM_BOT_TOKEN`.

The admin password is stored as a salted **PBKDF2 hash** in D1 (never plaintext).
You can rotate it later in **Settings → Security**.

#### Locked out? (password recovery)

Sona is single-admin, so there's no second account to let you back in. Two paths:

- **Email reset (if configured).** Set a **recovery email** in the first-run
  wizard or **Settings → Security**, and add the `RESEND_API_KEY` secret (the
  setup CLI offers this; or `wrangler pages secret put RESEND_API_KEY`). Then
  `/admin/login` → **Forgot password?** emails a single-use link (valid 30 min)
  that lets you set a new password. Optionally set `RESEND_FROM`
  (`"Name <you@domain>"`) to send from your own verified domain — otherwise the
  default `onboarding@resend.dev` shared sender is used. **Note:** that shared
  sender only delivers to the email address on your own Resend account, so with
  the default the recovery email must be that same address; verify a custom
  domain and set `RESEND_FROM` to lift this. When you verify your own sender
  domain in Resend, also add the DNS records it asks for (SPF + DKIM) plus a
  DMARC record (start with `v=DMARC1; p=none; rua=mailto:you@yourdomain`) —
  without them, reset emails risk the spam folder as receivers tighten
  enforcement. The flow always shows the same confirmation (it never reveals
  whether an email matched).
- **CLI fallback (always available).** From the project root:

  ```sh
  npm run reset-password
  ```

  It prompts for a new password, hashes it the same way the app does, writes it to
  your remote D1, and clears all sessions. Needs `wrangler login` (or
  `CLOUDFLARE_API_TOKEN`) and a `wrangler.toml` with your `database_name`.

### Custom domain + image thumbnails (post-deploy)

Two things need a manual step on a custom domain — setup preflights them when it
can, but calls them out here because they need dashboard/DNS access:

- **Pages apex domain.** After adding your domain to the Pages project, the
  **apex** needs a manual **proxied CNAME** `yourdomain.com → <project>.pages.dev`
  in the zone's DNS. (The R2 image domain is different — `wrangler r2 bucket
  domain add` creates its own record.) Without the apex CNAME the domain sticks
  `pending` and serves a 522.
- **Image Transformations.** Thumbnails and OG images are built via
  `/cdn-cgi/image/…` (Cloudflare Image Transformations), which is **off by
  default**, enabled **per zone**, and only works on a custom-domain zone (not
  `*.pages.dev`). Enable it at **dashboard → your zone → Images →
  Transformations → "Enable for zone"**, and turn on **"Resize images from any
  origin"** so it can pull from the R2 CDN host. Free tier: **5,000
  transformations/month**. Until it's on, gallery thumbnails serve the full-size
  original (slow) or fail. The deploy token can't enable this unless it carries
  *Zone · Zone Settings · Edit*.

### Local development

```sh
npm run dev      # localhost:5173 (D1 + R2 via wrangler platformProxy)
npm run check    # paraglide compile + svelte-check
npm test         # vitest
```

On a fresh clone this just works — no `npm run setup` needed to develop locally.
A `predev` step (`scripts/dev-bootstrap.ts`) runs before `vite dev`: when there's
no `wrangler.toml` yet, it copies `wrangler.toml.example` (placeholder IDs are
fine — local dev uses a local SQLite keyed by binding name, so no real Cloudflare
resources are provisioned) and applies the `drizzle/` migrations to the local D1.
It's a no-op once a `wrangler.toml` exists, so it never touches a real config from
`npm run setup`. To reset the local database, delete the generated `wrangler.toml`
and run `npm run dev` again — the bootstrap re-copies the template and re-wipes +
re-migrates a clean local D1. (Keep a real `wrangler.toml` from `npm run setup`;
this only applies to the auto-generated placeholder one.)

```sh
rm -f wrangler.toml    # placeholder config only — keep a real one from `npm run setup`
npm run dev            # re-bootstraps: fresh wrangler.toml + a clean, migrated local D1
```

Local secrets go in `.dev.vars` (gitignored). `FURTRACK_MODE=mock` serves bundled
demo fursuit data without calling FurTrack.

#### E2E tests

```sh
npx playwright install chromium   # one-time
npm run test:e2e                  # browser tests (playwright)
```

These are browser tests (kept out of `npm test` so the unit suite stays fast).
They boot `npm run dev` against a **throwaway local D1** — a seed step wipes,
migrates and seeds it (`tests/e2e/fixtures/seed.sql`) in an isolated persist dir,
so your real dev database is untouched. CI runs them on the canonical repo (a
separate `e2e` job in `.github/workflows/ci.yml`); forks skip them.

#### Integration tests

```sh
npm run test:integration   # needs real wrangler + a local D1 (miniflare)
```

These are heavier than the unit suite (they run the real dev-bootstrap and boot miniflare),
so they live under `tests/integration/` — outside `npm test`'s scope — and run in
their own canonical-repo-gated CI job. `tests/integration/dev-bootstrap.integration.test.ts`
proves the fresh-clone bootstrap (#137) migrates the local D1 into the exact
persist dir `getPlatformProxy` reads at `vite dev` boot; it runs entirely in a
throwaway temp repo, so your real dev database is untouched.

#### Terminology (ja)

日本語UIでは、Telegram/チャットのステッカー系コンテンツは常に「ステッカー」と表記する（「スタンプ」は使わない）。物理的なダイカットグッズは「シール」で区別する。
_(In the JA UI, Telegram/chat sticker content is always ステッカー — never スタンプ; physical die-cut merch is シール.)_ Enforced by `src/lib/i18n-parity.test.ts`.

### Keeping your fork up to date

Pull template improvements into your fork with GitHub's **Sync fork** button (or
`git merge` + push); your deploy workflow runs the tests, applies new migrations,
and redeploys automatically. See [`UPDATING.md`](UPDATING.md) for the full guide,
including the first-sync gotcha and conflict handling.

## Configuration model

Two tiers (see [`src/lib/config.ts`](src/lib/config.ts) and
[`src/lib/server/settings.ts`](src/lib/server/settings.ts)):

- **Runtime, editable in the admin UI → `site_settings` (D1):** site name, owner
  name, about text, social links, storage provider, public R2 URL, primary
  character, theme, landing layout. These are what make your site *yours*.
- **Build/deploy-time → `src/lib/config.ts` + `wrangler.toml`:** values needed
  before the DB exists or baked into the deploy (app name, session cookie name,
  storage keys, Cloudflare resource IDs).

## Data model

- **Images** — the core unit: title, slug, URLs, dimensions, NSFW/published
  flags, source post, md5 (dedup). Belongs to **one artist**, **zero or one
  collection**, **many tags**, and is linked to the site **character(s)**.
- **Artists** — directory of credited artists: name, avatar, social links. The
  seam for the shared registry.
- **Collections** — curated groupings of images.
- **Tags** — freeform many-to-many labels.
- **Characters** — the fursona(s) the site is about (single per instance by
  convention; resolved implicitly).
- **Fursuit photos** — imported from FurTrack; credit a free-text photographer,
  carry a license + optional manual-permission audit string.
- **Sticker packs / stickers / sticker emojis** — a pack (Telegram-mirrored or
  self-hosted) of stickers; **per-sticker** artist attribution; emoji junction
  powers search. Pack shape (single- vs multi-artist) is derived, not stored.
- **Conventions** — cons on your schedule: name, dates, location, URL, a
  confirmed/maybe/considering status, and the cons.fyi event id when picked from
  the feed (dedupes re-adds).

Schema: [`src/lib/server/db/schema.ts`](src/lib/server/db/schema.ts); migrations
in [`drizzle/`](drizzle).

## Pages

**Public:** Home (`/`), Gallery (`/gallery`, `/gallery/[slug]`), Fursuit
(`/gallery/fursuit/[id]`), Collections (`/collections`, `/collections/[slug]`),
Stickers (`/stickers`, `/stickers/[slug]`, `/stickers/[slug]/[id]`), About
(`/about`).

**Admin** (behind auth, shared sidebar): Upload, All Images, Collections, Tags,
Artists, Characters, Fursuit Photos, Stickers (import / manual / edit),
Conventions, Settings.

## Roadmap

Generalization is phased (full plan tracked separately):

- ✅ **Phase 0** — de-brand identity into config + settings.
- ✅ **Phase 1** — repo split + config/seed.
- ✅ **Phase 2** — auth hardening (DB-hashed password) + first-run wizard + setup CLI.
- ✅ **Phase 3** — themes + selectable landing layouts.
- ✅ **Phase 4** — central artist registry service ([`sona-registry`](https://github.com/sona-fast/sona-registry)).
- ✅ **Phase 5** — fork ↔ registry integration (opt-in via `REGISTRY_API_KEY`; search/pull/submit + background sync).

## License

Sona is open source under the [Apache License 2.0](./LICENSE) — fork it, modify it,
run your own instance, no strings beyond keeping the license + attribution notices.
See [`NOTICE`](./NOTICE) for the attribution that carries with redistributions.

"Sona", "sona.fast", and the "made with sona." lockup are trade names of the Sona
project. The code is yours to fork under Apache-2.0; the names identify this
project and its official builds, so please brand meaningfully different forks as
their own thing (the "made with sona." badge is the intended way to credit the
platform).

## Support the project

Sona is built and maintained by one person for the community. If it's useful to you,
you can [sponsor its development](https://github.com/sponsors/sona-fast) — sponsorship
covers hosting/domain costs and funds new features. Not required, always appreciated.

Want a fork set up or hosted for you? That's offered as an optional paid convenience —
reach out. The code itself is and stays free.

## References

- **AfterDark.art** — the platform this lineage replaced.
- **kobaj.art** — a similar self-hosted gallery.
