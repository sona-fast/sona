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
| Variable | `CF_PAGES_PROJECT` | Your Pages project name (defaults to `sona`) |
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
