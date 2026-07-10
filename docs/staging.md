# Staging environment (beta.sona.fast)

One staging deployment of the canonical `sona-fast/sona` repo, for testing changes
against real Cloudflare infrastructure before they reach a fork. It lives at
**https://beta.sona.fast** behind Cloudflare Access (invite-only beta testers).

- Deploy pipeline: [`.github/workflows/staging-deploy.yml`](../.github/workflows/staging-deploy.yml)
  — runs on push to `main` (and manual dispatch), gated `if: github.repository == 'sona-fast/sona'`
  (the exact inverse of `deploy.yml`'s fork gate, so the two never both fire on one repo).
- Cron: [`.github/workflows/staging-cron.yml`](../.github/workflows/staging-cron.yml)
  — sticker re-sync (daily), artist sync (daily), orphan cleanup (weekly).
- Seed: [`scripts/staging-seed.sql`](../scripts/staging-seed.sql) + [`scripts/hash-admin-password.ts`](../scripts/hash-admin-password.ts).

The Pages project is `sona-staging`; the D1 DB is `sona-staging-db`; the R2 bucket
is `sona-staging-images`.

> **Do NOT** convert `staging-deploy.yml` to `pull_request_target`. It holds
> `CLOUDFLARE_API_TOKEN`, `SETUP_TOKEN`, `CRON_SECRET`; that trigger would run an
> untrusted fork PR's code with those secrets in scope. See the comment at the top
> of the workflow.

---

## One-time setup

Do these **in order**. The Access policy + app (step 3) must exist **before the
first deploy** (step 6) so the site is never briefly public.

### Manual — needs Sparky's Cloudflare token / dashboard

These require account-level credentials and can't be scripted from CI.

**1. Repo secrets & variables** (`sona-fast/sona` → Settings → Secrets and variables → Actions)

Variables:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_PAGES_PROJECT` | `sona-staging` |
| `D1_DATABASE_NAME` | `sona-staging-db` |
| `OBSERVABILITY_ENABLED` | `true` (optional — exercise the metrics dashboard) |

Secrets (same names `deploy.yml` consumes, so the shared steps work unmodified):

| Secret | Notes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | required |
| `CLOUDFLARE_ACCOUNT_ID` | required |
| `SETUP_TOKEN` | required for the first-run wizard; re-bound on every deploy |
| `CRON_SECRET` | required for `staging-cron.yml` to authenticate to the endpoints |
| `TELEGRAM_BOT_TOKEN` / `RESEND_API_KEY` / `RESEND_FROM` / `CLOUDFLARE_ANALYTICS_TOKEN` / `CLOUDFLARE_ZONE_ID` | optional; each sync step skips cleanly when its secret is unset |

**2. Create the D1 DB + R2 bucket** (once):

```sh
npx wrangler d1 create sona-staging-db
npx wrangler r2 bucket create sona-staging-images
```

**3. Cloudflare Access — beta testers policy + app (BEFORE the first deploy)**

Use a **new reusable policy named "Sona beta testers"** — NOT the existing "Sona
team Allowlist" (owner's decision: beta testers are a distinct group). Create it
account-level, then attach it to a **new Access application** whose domains cover
**both**:

- `beta.sona.fast`
- `sona-staging.pages.dev` (the raw Pages URL — otherwise the deployment is
  reachable un-gated before the custom domain is attached)

Sequencing matters: the app + policy must be live before step 6 so `sona-staging`
is never served publicly. (Reusable policies are created at the account-level
`/policies` endpoint — see the `sona-fast-allowlist` skill for the exact call shape.)

**4. DNS + custom domain**

- Add a DNS record for `beta.sona.fast` (proxied) in the `sona.fast` zone.
- Attach `beta.sona.fast` as a custom domain on the `sona-staging` Pages project.

> This custom-domain attach is exactly the "Pages domain" rung of the SONA-6
> connect-domains / doctor tooling (in flight on `feat/connect-domains-doctor-11`).
> Staging doubles as that tooling's first live test bed: point it at `beta.sona.fast`
> + `sona-staging` and it should detect/attach the domain end to end.

**5. Pages project binding config** (once, in the dashboard or via `wrangler`)

The `#115` lesson: a CI-first Pages project has **no** bindings until you set them,
and a deploy without them 500s. Configure on `sona-staging`:

- D1 binding `DB` → `sona-staging-db`
- R2 binding `IMAGES` → `sona-staging-images`
- Compatibility flag `nodejs_compat`
- A `compatibility_date` (match the repo's `wrangler.toml`)

### Scriptable — after the manual prep

**6. First deploy**

Push to `main` (or run the **Deploy to Cloudflare Pages (staging)** workflow
manually from the Actions tab). It runs check/test/build, creates the Pages
project if needed, applies tracked D1 migrations, syncs secrets, and deploys.

**7. Seed generation + load**

`staging-seed.sql` ships a **placeholder** admin hash — generate a real one for a
password you choose, substitute it, and load the seed into the remote DB:

```sh
# 1. Generate a hash (password read from stdin, never argv/history):
HASH=$(echo -n 'your-staging-password' | npx tsx scripts/hash-admin-password.ts)

# 2. Substitute the placeholder and load into the remote staging DB:
sed "s#REPLACE_ME_WITH_pbkdf2_HASH#${HASH}#" scripts/staging-seed.sql \
  | npx wrangler d1 execute sona-staging-db --remote --file=/dev/stdin
```

Then sign in at `https://beta.sona.fast/admin/login` with that password. The seed
is synthetic (a fake artist + placeholder images that 404 harmlessly); never bake
a real password's hash into the repo.

---

## Resetting for wizard testing

To re-test the first-run wizard from scratch, clear the credential + setup flag so
`hooks.server.ts` redirects back to `/admin/setup`:

```sh
npx wrangler d1 execute sona-staging-db --remote --command \
  "DELETE FROM site_settings WHERE key IN ('setupComplete','adminPasswordHash'); DELETE FROM sessions;"
```

The wizard then requires the `SETUP_TOKEN` (repo secret, re-bound each deploy).
Re-run steps 6–7 (or just the wizard in the browser) to bring it back up. To wipe
data too, re-create the DB (step 2) and re-run migrations via a deploy.
