# Sona

A self-hostable, forkable **fursona site** — a personal gallery for your
character's commissioned art, fursuit photos, and sticker packs, with a clean
single-admin CMS. Fork it, deploy it to your own Cloudflare account, configure it
through the setup UI, pick a theme, and it's your site.

Sona is the generalized version of [sparky.ink](https://sparky.ink) (the original
deployment, kept in-repo as the reference config under
[`examples/sparky.ink/`](examples/sparky.ink)). The project home is
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
   writes `wrangler.toml`; applies migrations; and generates + sets the
   `SETUP_TOKEN` and `CRON_SECRET` secrets. It prints your one-time `SETUP_TOKEN`
   — keep it for step 4.

   *(Prefer to do it by hand? Copy `wrangler.toml.example` → `wrangler.toml`,
   create the resources with `wrangler d1 create` / `wrangler r2 bucket create`,
   and set `SETUP_TOKEN` yourself.)*
3. **Deploy.** Pushing to `main` runs the GitHub Actions workflow
   ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)): it applies
   D1 migrations and deploys to Pages. Set repo secrets `CLOUDFLARE_ACCOUNT_ID` +
   `CLOUDFLARE_API_TOKEN`, and (optionally) repo variables `CF_PAGES_PROJECT` /
   `D1_DATABASE_NAME` / `SITE_URL`. (Or deploy directly:
   `npx wrangler pages deploy .svelte-kit/cloudflare`.)
4. **Finish in the first-run wizard.** Open `/admin/setup`, enter your
   `SETUP_TOKEN`, and set your admin password + site name, owner/persona name,
   social links, and storage provider. The wizard runs once, then closes itself.
5. **(If using UploadThing)** set the token:
   `wrangler pages secret put UPLOADTHING_TOKEN`. **(For Telegram stickers)** set
   `TELEGRAM_BOT_TOKEN`.

The admin password is stored as a salted **PBKDF2 hash** in D1 (never plaintext).
You can rotate it later in **Settings → Security**.

### Local development

```sh
npm run dev      # localhost:5173 (D1 + R2 via wrangler platformProxy)
npm run check    # paraglide compile + svelte-check
npm test         # vitest
```

Local secrets go in `.dev.vars` (gitignored). `FURTRACK_MODE=mock` serves bundled
demo fursuit data without calling FurTrack.

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

Schema: [`src/lib/server/db/schema.ts`](src/lib/server/db/schema.ts); migrations
in [`drizzle/`](drizzle).

## Pages

**Public:** Home (`/`), Gallery (`/gallery`, `/gallery/[slug]`), Fursuit
(`/gallery/fursuit/[id]`), Collections (`/collections`, `/collections/[slug]`),
Stickers (`/stickers`, `/stickers/[slug]`, `/stickers/[slug]/[id]`), About
(`/about`).

**Admin** (behind auth, shared sidebar): Upload, All Images, Collections, Tags,
Artists, Characters, Fursuit Photos, Stickers (import / manual / edit), Settings.

## Roadmap

Generalization is phased (full plan tracked separately):

- ✅ **Phase 0** — de-brand identity into config + settings.
- ✅ **Phase 1** — repo split + config/seed.
- ✅ **Phase 2** — auth hardening (DB-hashed password) + first-run wizard + setup CLI (this).
- ⏳ **Phase 3** — themes + selectable landing layouts.
- ⏳ **Phase 4** — central artist registry service (`sona-registry`).
- ⏳ **Phase 5** — fork ↔ registry integration.

## References

- **AfterDark.art** — the platform this lineage replaced.
- **kobaj.art** — a similar self-hosted gallery.
