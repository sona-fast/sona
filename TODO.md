# sparky.ink — Remaining Work

## What's Done
- SvelteKit + Cloudflare Pages + D1 + Drizzle scaffold
- Design system (Lunaris tokens, JetBrains Mono + Geist fonts, dark/light CSS)
- Lucide icons + custom brand SVGs (Twitter, Bluesky, Telegram, FurAffinity, DeviantArt, Patreon, Instagram)
- All public pages wired to D1: home (mosaic banner + recent uploads), gallery (search/filter/sort/pagination), single image view (full metadata, NSFW blur, download, share), about (stats + socials), collections listing + detail
- All admin pages wired: login, images list (sortable), upload with UploadThing drag-and-drop, collections CRUD, tags CRUD, artists CRUD, characters CRUD, settings with persistence
- Cookie-based admin auth with ADMIN_PASSWORD env var
- Server-side session validation: tokens stored in D1, verified on each request, deleted on logout, 7-day expiry
- Admin logout (sidebar button, clears session from D1)
- Dark/light theme toggle (persists to localStorage)
- UploadThing integration: drag-and-drop upload, image preview, dimensions/file size extraction, 64MB limit, duplicate file detection
- Delete images from UploadThing when removing from admin
- CI/CD: GitHub Actions deploy to Cloudflare Pages on push to main
- D1 migrations auto-run in deploy workflow
- Custom domain sparky.ink (CNAME active)
- Admin settings persistence: site name, about text, social links, storage stats
- Image edit page with pre-filled metadata
- Collection edit modal with rename + cover image picker
- Collections public route (`/collections` and `/collections/[slug]`)
- Gallery grid/list view toggle (persists to localStorage), NSFW blur in list view
- Mosaic banner on landing page with alternating row directions
- Edge caching for public pages (5min s-maxage, 1hr stale-while-revalidate)
- Security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- Admin/API routes auth-guarded and never cached
- Input sanitization: URL validation (blocks javascript:/data:, auto-prefixes https://), text length limits, tag cleaning
- Image slugs with random suffix for guaranteed uniqueness
- Pagination on admin images, tags, artists tables
- Sortable commissioned/uploaded date columns in admin images
- Commissioned date shown in gallery list view
- Pluralization helper across all pages (1 artwork vs 2 artworks)
- Timezone-safe date formatting (dates parsed as local time, not UTC)
- Mobile responsive layouts for all public pages with bottom tab bar navigation
- Mobile responsive layouts for admin pages with scrollable tab bar sub-nav
- Dynamic Bluesky avatar fetching for artists and site owner (about page + admin header)
- Confirmation dialogs before delete actions (styled modal, not native confirm())
- Featured characters/critters with full CRUD, social links, public display on single image view
- Afterdark.art import script with GraphQL scraping, md5 de-dup, artist URL matching
- Danger zone actions: Export data (JSON), Clear all data, Clear upload cache (orphan cleanup), Reset all tags
- Stickers public section (`/stickers`): pack grid with auto-generated mosaic covers (up to 2×2 from a pack's own stickers), emoji rail + emoji/artist filters that switch to a cross-pack sticker grid, per-pack page with scoped emoji rail and contributing-artist filter
- Per-sticker detail page: NSFW blur with click-to-reveal, emoji chips, artist credit + social links, format-aware download (static / animated Lottie / video) via same-origin proxy
- Telegram Bot-API import: batched/limit-safe review grid (20 per batch with progress bar), dedupe by Telegram file id, animated `.tgs` gunzip + Lottie sanitize, media self-hosted in R2
- Manual sticker pack upload (PNG/WebP drag-and-drop) and pack edit with drag-to-reorder
- Admin pack management: list (search, source filter, published toggle, delete), import review grid with bulk artist/NSFW/exclude editing + inline new-artist modal
- Per-pack Re-sync (re-opens import grid against the current Telegram set) + scheduled auto-resync (GitHub Actions daily cron → `/api/cron/resync-telegram`, admin-toggleable, default off)
- Per-sticker emoji and artist attribution (nullable artist → "Unattributed"); R2 storage with Telegram imports partitioned per pack (`stickers/{slug}/…`)

## What's Left

### Medium Priority
- **Image variants** — parent + children for alt versions (transparent bg, alt endings, background swaps) — [#1](https://github.com/sparkyfen/sparky.ink/issues/1)
- **Gallery sort by commissioned date** — public gallery currently sorts by upload date, could add commissioned date option.

### Low Priority / Polish
- **Favicon** — still using default SvelteKit favicon.
- **SEO / Open Graph tags** — no per-page meta tags for social sharing.
- **404 page** — no custom 404 design.
- **Avatar fallback** — only Bluesky auto-fetches avatars. Could add manual avatar URL field to artist edit modal for artists without Bluesky.
- **Session cleanup** — expired sessions accumulate in D1. Could add a periodic cleanup (cron trigger or cleanup on login).
- **Stickers backlog** — deferred from the initial ship: reorder packs (only stickers within a pack reorder today), ZIP/bulk upload for manual packs, bulk-delete in the pack editor, slug auto-suffix for duplicate pack names, and pagination on the admin pack list.

## Tech Notes
- Node 20 required (Node 18 too old for wrangler and sv CLI)
- `lucide-svelte@0.468.0` pinned — v1.x breaks on Node 20 SSR
- Geist font served from `/static/fonts/` (npm package is Next.js-only)
- UploadThing API route at `/api/uploadthing` — uses `platform.env.UPLOADTHING_TOKEN` (not process.env)
- Theme uses Svelte context (`$lib/theme.svelte.ts`) with `$effect` to set `data-theme` on `<html>`
- `.dev.vars` has local ADMIN_PASSWORD and UPLOADTHING_TOKEN (gitignored)
- Production secrets set via Cloudflare Pages env vars
- Drizzle `sql` template: use raw SQL column names in subqueries, not `${table.column}` (Drizzle treats those as parameter bindings)
- D1 `$dynamic()` queries don't work reliably in production — use static queries with `and()` instead
- `getSettings()` wrapped in try/catch to survive deploy race conditions
- Sessions table with try/catch fallback for deploy resilience
- Input sanitization via `$lib/server/validate.ts` — sanitizeUrl, sanitizeText, sanitizeTag
- Import script at `scripts/import-afterdark.ts` uses better-sqlite3 to talk directly to local D1 (remote import would need different approach)

## Accounts & Config
- Cloudflare Account ID: ae6e658c037606bf7536325a439f3456
- D1 Database: sparky-ink-db (36461474-0a61-4c8f-84cb-fd322554cab0)
- UploadThing App ID: nyneimr63ug
- GitHub repo: sparkyfen/sparky.ink
- Custom domain: sparky.ink (CNAME → sparky-ink.pages.dev)
- Social links: twitter.com/sparkyfen, bsky.app/profile/sparky.social, t.me/sparkyfen, furaffinity.net/user/sparkyyy
