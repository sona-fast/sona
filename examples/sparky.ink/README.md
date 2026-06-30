# Example deployment: sparky.ink

This folder is the reference configuration for **sparky.ink**, the original
deployment Sona was extracted from. It documents what a fully-configured Sona
instance looks like and is **not** required to run a fork.

## Contents

- **`wrangler.toml`** — the Cloudflare config for sparky.ink (Pages project
  `sparky-ink`, D1 `sparky-ink-db`, R2 bucket `sparky-ink-images`, served from
  `cdn.sparky.ink`). Copy the pattern into your own `wrangler.toml` (see
  `../../wrangler.toml.example`).
- **`settings.seed.sql`** — the `site_settings` rows + first character that give
  sparky.ink its identity (site name, owner/persona name, social links, storage
  provider). Illustrative — a real fork sets these through the setup wizard.

## How a fork differs

A fresh fork starts with the neutral defaults in `src/lib/server/settings.ts`
(`siteName: "Sona"`, empty socials) and is configured entirely through the admin
UI — it never needs this folder. sparky.ink is just the first instance, kept
in-repo so the project dogfoods the exact fork experience.

The maintainer's live sparky.ink deploy supplies its real secrets + resource IDs
out-of-band (the root `wrangler.toml` is gitignored); this folder is the
committed, shareable record of that configuration.
