# Updating your fork

Sona is a template you **fork**, so improvements land in the template
(`sona-fast/sona`) after you've forked. This is the operator's guide to pulling
those updates into your fork and getting them deployed.

The short version: pull the template's `main` into your fork's `main` and push.
Your fork's [deploy workflow](.github/workflows/deploy.yml) does the rest — it
runs the tests, applies any new D1 migrations exactly once, and deploys to Pages.
There are no manual post-update steps in the normal case.

## The happy path

1. **Pull template changes into your fork.** Either use GitHub's **Sync fork**
   button (repo home → *Sync fork* → *Update branch*), or do it from a clone:

   ```sh
   git checkout main
   git remote add upstream https://github.com/sona-fast/sona.git   # first time only
   git fetch upstream
   git merge upstream/main
   git push origin main
   ```

   (`gh repo sync <you>/<your-fork> --source sona-fast/sona` does the same as the
   button, from the command line.)

2. **The deploy runs itself.** A push to `main` triggers
   [`deploy.yml`](.github/workflows/deploy.yml), which:
   - installs deps and runs `npm test`, then `npm run build`;
   - applies D1 migrations with tracking — a `schema_migrations` table records
     which `drizzle/*.sql` files have run, so each is applied **exactly once** and
     a real SQL failure **fails the deploy** (no half-applied schema);
   - deploys the build to your Cloudflare Pages project.

3. **Done.** Watch it in the **Actions** tab; when the run is green your site is
   live on the new version. No manual migration or deploy step.

> **Custom domain?** If your site serves from a custom domain rather than
> `*.pages.dev`, updates deploy the same way — the domain is attached to the Pages
> project once and is unaffected by updates.

## Seeing what changed

The template is versioned with semver tags. To see what you're pulling in before
you sync — or to catch up on what shipped since you last did — read the
[Releases page](https://github.com/sona-fast/sona/releases); each release lists
the merged changes since the previous one. `git log --oneline <last-tag>..upstream/main`
after a fetch gives the same view from a clone.

## One-time backfill: sticker animation flags (SONA-123)

The release that adds the per-sticker download-format menu also adds a
`stickers.is_animated` column. The migration applies automatically, but it can't
inspect your stored files — animated GIF/WebP stickers **imported before this
release** start out flagged static. Until the backfill runs, those stickers may
show a PNG download option; picking it is safe — the download endpoint sniffs
the file's actual bytes and serves the original file instead of a flattened
conversion — but the option shouldn't be there, and the backfill removes it.

After this release deploys, run the backfill **once** from your fork repo's
Actions tab: **Sticker animation backfill** → Run workflow (or
`gh workflow run backfill-animated.yml`). It uses the same `CRON_SECRET` +
`SITE_URL` pair as the other scheduled workflows — no admin login needed — and
pages through your whole library automatically, retry-safely (it's idempotent;
re-running changes nothing). On a Workers **free-plan** fork, dispatch it with
the `limit` input set to `15` to stay inside the tighter per-request subrequest
budget; if a run still reports failed rows, dispatch it again — they clear.

If you'd rather not use the workflow, the same job is available signed in as
admin from the browser devtools console:

```js
fetch('/api/stickers/backfill-animated', { method: 'POST' })
  .then((r) => r.json())
  .then(console.log);
```

Page manually with `?afterId=<lastId>` from each response until `rasters` comes
back below the limit. Stickers imported after the upgrade are sniffed at import
time and need nothing.

## One-time per fork: re-apply the WAF rate-limit rule (oEmbed, RSS feed)

Two releases have widened this rule. The oEmbed provider (`/api/oembed`) added a
second anonymous `/api` path, and the RSS feed (`/feed.xml`, v1.2.0) added a
third public endpoint that reads the database several times per uncached
request. New forks get the current rule from `npm run setup`; a fork that was
**already deployed** still has whichever expression it was created with, and
nothing re-applies it on deploy, so until you run this the newer endpoints are
anonymous with no rate limit.

Run it again after any release that says so, even if you ran it before: it
rewrites the rule to the current expression rather than only creating a missing
one.

Run this once per fork, from a clone:

```sh
CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- <domain>
```

`<domain>` is your site domain (e.g. `akito.dog`). The token needs one permission,
**Zone · WAF · Edit**, on a token whose Zone Resources include that domain; it is
read from the environment and never printed. The command is idempotent — the first
run reports `updated`, any re-run reports `exists` — so it is safe to repeat if
you're unsure whether it already ran.

> **Serving on `*.pages.dev`?** Then your site has no Cloudflare zone, and a
> rate-limiting rule cannot be applied at all. Nothing to run; the endpoint is
> unprotected until the site moves to a custom domain.

The rule blocks an address for 10 seconds once it makes 20 matching requests in
10 seconds, counted per Cloudflare data centre. One rule covers all three paths
because the Free plan allows exactly one rate-limiting rule per zone, so the
count is shared between them. Link-preview services fetch from shared addresses,
so roughly twenty-odd of your links pasted into one chat channel at once can trip
it. The previews that miss show no image rather than an error, and they come back
on the next paste.

**Your link previews also change on this release** if your images are hosted off
your own Cloudflare zone — UploadThing (the default), a `*.r2.dev` bucket, or an
R2 custom domain on a different zone. Those previews pointed at a resized URL
your zone refuses to serve, so they showed no image at all; they now point at the
original file, which does load. The tradeoff is that the original is full size,
and some services cap how large a preview they will fetch. Sites whose images sit
on their own zone (`cdn.yoursite.com`) are unaffected and keep the resized
version.

## Read before upgrading: your site gains an AI disclosure page (SONA-167)

This release adds a public page at `/ai`, linked from your footer. **Sites that
already exist get it switched on**, because turning it on for everyone is how
the fleet discloses by default; only sites set up after this release are asked
during the setup wizard. Forks bootstrapped with the `ADMIN_PASSWORD`
environment variable skip that wizard, so they get the page without being
asked too.

The page credits the Sona Team for building the software, so running it does
not imply you wrote it. The one claim it makes about your site, in your own
voice, is that the artwork here is commissioned from human artists rather than
AI-generated.

**If that is not true for your site, edit or disable the page.** Both
controls are in Settings, under "Serve the AI disclosure page (/ai)" and the
text override beneath it. Turning it off makes `/ai` return a plain 404 and
removes the footer link.

Two knock-on effects worth knowing:

- Turning the page off also stops your privacy policy naming Anthropic's Claude
  and CodeRabbit specifically. The general disclosure stays, because diagnostic
  logs can still reach development tools on any site. If you do use those tools
  and want them named, write your own privacy text in Settings, Legal.
- The built-in privacy policy gained disclosures for the AI development tools,
  Cloudflare's Web Analytics beacon, Google Fonts, and the feature integrations
  (Turnstile, Telegram, cons.fyi, X, Bluesky, FurTrack, and the shared artist
  registry). **If you pasted your own privacy text, none of that was added to
  your site** and the third-party recipients your deployment actually contacts
  are yours to list.

## First sync only: check the Actions tab

There is exactly one gotcha, and it only bites the **first time** you ever sync a
fresh fork.

GitHub registers a fork's workflows on that first sync, and the push event can
race that registration — so the very first **Sync fork** may fast-forward your
`main` **without** triggering a deploy. Your code is updated but your live site
and D1 schema are not.

**What to do:** after your first sync, open the **Actions** tab. If no
"Deploy to Cloudflare Pages" run appeared, trigger it by hand:

> Actions → **Deploy to Cloudflare Pages** → **Run workflow** → branch `main` →
> **Run workflow**.

That button exists because `deploy.yml` also listens for `workflow_dispatch`.
Every sync *after* the first one is a normal push event and auto-deploys — you
only need this once.

> Doing the sync via `git push` (step 1's clone path) instead of the button
> avoids the race entirely: a push you make always emits a push event.

## Prerequisites (set once, by `npm run setup`)

CI deploys need these on your fork. `npm run setup` offers to set them for you at
provision time; if you skipped that, add them under
**Settings → Secrets and variables → Actions**:

| Kind | Name | Purpose |
|------|------|---------|
| Secret | `CLOUDFLARE_API_TOKEN` | Deploy + run D1 migrations |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account |
| Variable | `CLOUDFLARE_PAGES_PROJECT` | Your Pages project name (defaults to `sona`) |
| Variable | `D1_DATABASE_NAME` | Your D1 database name (defaults to `sona-db`) |

If `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are missing, the deploy fails
early with a clear message telling you to set them — a real setup step, not a
silent skip.

The scheduled sync workflows ([`artist-sync.yml`](.github/workflows/artist-sync.yml),
[`sticker-resync.yml`](.github/workflows/sticker-resync.yml)) additionally use the
`CRON_SECRET` secret (set by `npm run setup`, matching the Pages secret) and a
`SITE_URL` variable (your site's base URL; defaults to `https://sona.fast`). These
are optional — a missing `CRON_SECRET` makes those jobs skip quietly rather than
fail — but set `SITE_URL` if you use the shared artist registry or Telegram
sticker re-sync, or those cron jobs will hit the wrong host.

## Enabling optional features

Two optional features can be switched on entirely from your fork's repo
settings — the deploy workflow syncs them to your Pages project, so no
Cloudflare dashboard access is needed:

| Feature | What to set (Settings → Secrets and variables → Actions) |
|---------|-----------------------------------------------------------|
| FurTrack photo integration | Variable `FURTRACK_MODE` = `live` (or `mock` for fake data) |
| Telegram sticker import | Secret `TELEGRAM_BOT_TOKEN` = your bot's token |

The **next deploy** (push to `main`, or Actions → Run workflow) applies both:
the workflow writes `FURTRACK_MODE` into the Pages project's production env
vars and uploads `TELEGRAM_BOT_TOKEN` as a Pages secret before deploying. When
neither is set, the sync steps log a skip and change nothing.

Setting the secret manually with `wrangler pages secret put TELEGRAM_BOT_TOKEN`
(as the in-app setup help describes) still works — that's the path if you'd
rather not store the token in GitHub.

## Marking a feature early-access

New features can ship in an *early-access window*: supporters (anyone with a
valid supporter key from `sona.fast/supporter-key`) get the feature the day it
lands, and everyone else gets it automatically on its GA date, one week later.

This is driven by one file, `src/lib/early-access.ts`:

- **At release**, add the feature's entry to `EARLY_ACCESS`: `gaDate` is the
  release date + 7 days (`'YYYY-MM-DD'`), and `label` is the flag's message
  function, referenced statically as `m.early_access_label_<flag>` — never a
  computed lookup into the messages namespace, which re-pins the whole catalog
  into the route chunk (SONA-169; `scripts/check-catalog-pinning.mjs` fails CI
  on it). Add that message id to both `messages/en.json` and
  `messages/ja.json`, re-add `import * as m from '$lib/paraglide/messages';`
  at the top of `early-access.ts` (the empty registry doesn't carry it), then
  gate the feature on `isFeatureEnabled(flag, { supporterKeyValid, now })`.
- **At the next release**, delete that entry — its GA date has passed, so the
  feature is now on for everyone — and remove the gate. The registry only ever
  holds the handful of features still inside their window.

The registry ships empty; nothing is gated until a feature is added. The
owner's supporter key is managed under **Settings → Account → Supporter key**.

## Pre-pipeline forks: seed the migration baseline once

The tracked-migration step assumes `schema_migrations` reflects reality. A fork
set up with `npm run setup` is fine — setup applies the migrations **and** records
them, so the first CI deploy is a clean no-op.

You only need a one-time baseline seed if your D1 database was migrated
**out-of-band before this pipeline existed** (for example, the original
`sparky.ink` production DB): the schema is already there, but `schema_migrations`
is empty, so the deploy would try to re-apply every `drizzle/*.sql` and fail on
tables that already exist.

Seed it once, against your remote DB, so existing files are marked applied:

```sh
DB=<your D1 database name>   # matches D1_DATABASE_NAME

# Create the tracking table if it isn't there yet.
npx wrangler d1 execute "$DB" --remote --command \
  "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);"

# Mark every current migration as already applied.
for f in drizzle/*.sql; do
  npx wrangler d1 execute "$DB" --remote --command \
    "INSERT OR IGNORE INTO schema_migrations(name,applied_at) VALUES ('$(basename "$f")', datetime('now'));"
done
```

After this, only *new* migrations pulled from the template will be applied.
**Fresh forks need none of this.**

## When `git merge` conflicts

Conflicts happen where your site customizations overlap the template's changes.
Keep it simple:

1. Read the conflict — is it your customization or a template fix?
   - **Config / content you deliberately changed** (`src/lib/config.ts`,
     `wrangler.toml`, examples, theme/settings): keep your version, but fold in any
     genuinely new keys the template added.
   - **App code, migrations, workflows, dependencies:** prefer the template's
     version — that's the update you're pulling in. Re-apply your customization on
     top only if you truly changed that file on purpose.
2. Resolve, then `npm run check` and `npm test` locally before pushing —
   the deploy runs both anyway, but catching it locally is faster.
3. `git add` the resolved files, `git commit`, `git push origin main`.

> **Never resolve a conflict by deleting a `drizzle/*.sql` migration.** Migrations
> are append-only and tracked by filename; dropping one desyncs
> `schema_migrations` from your actual schema. Keep both sides' migration files.

If a merge gets away from you, `git merge --abort` returns you to your
pre-merge `main` with nothing lost, and you can try again.
