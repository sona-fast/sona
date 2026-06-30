# sparky.ink

A personal furry art gallery for collecting and showcasing commissioned artwork from talented artists. Built as a self-hosted alternative to [AfterDark.art](https://afterdark.art/) (shutting down), inspired by [kobaj.art](https://kobaj.art/gallery/).

## Overview

sparky.ink is a single-admin gallery site. Visitors browse publicly with no login required. The site owner (Sparky) manages all content through a protected admin panel — uploading images, managing artists, organizing collections, and tagging artwork.

This is **not** a platform — there are no user accounts, no social features, no moderation tools. It's a personal portfolio/gallery with a clean, purpose-built admin CMS.

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | **SvelteKit** | Full-stack SSR, form actions for admin CRUD |
| Hosting | **Cloudflare Pages** | Edge deployment via `@sveltejs/adapter-cloudflare` |
| Database | **Cloudflare D1** | SQLite at the edge, serverless |
| ORM | **Drizzle** | Type-safe, lightweight, first-class D1 support |
| Image Storage | **UploadThing** | Handles uploads, returns hosted URLs |
| Auth | **Cookie-based session** | Single admin user, password hashed in D1 |
| Styling | **TBD** | Dark theme default, light mode toggle |

## Data Model

### Entities

**Images** — the core content unit
- Title, alt text (derived from title), source post URL
- Resolution, file size
- NSFW flag
- Upload date
- References one Artist, one Collection (optional), many Tags

**Artists** — directory that grows over time as new commissions are added
- Name, avatar
- Social links: Twitter/X, Bluesky, Telegram, FurAffinity, DeviantArt, Patreon

**Collections** — curated groupings (e.g., "Nature Spirits", "Cyberpunk OCs", "Commission Showcase")
- Name, cover image
- Contains many Images

**Tags** — freeform labels (e.g., "character", "fantasy", "cyberpunk", "portrait")
- Name
- Applied to many Images (many-to-many)

**Sticker Packs** (`sticker_packs`) — a pack of stickers, either mirrored from a Telegram set or self-hosted from uploads
- Name, slug, description, cover image, source (`telegram` / `self-hosted`), published flag
- Belongs to one Character; `manager_artist_id` (null = mixed-artist pack managed by the site owner; a value = single-artist pack)

**Stickers** (`stickers`) — one sticker within a pack
- Image/thumbnail URL, width/height, format (`png` / `webp` / `animated` / `video`), position, NSFW flag
- References one Pack and optionally one Artist (per-sticker attribution; null = "Unattributed")
- `telegram_file_unique_id` dedupes re-imports of the same Telegram set

**Sticker Emojis** (`sticker_emojis`) — emoji associated with a sticker
- Sticker reference + emoji glyph (many emoji per sticker, powers emoji search/filter)

### Relationships

```
Artist 1──* Image *──* Tag
                |
        Collection 1──* Image
```

- An image belongs to **one artist** (the commissioned artist)
- An image belongs to **zero or one collection**
- An image can have **many tags**, and a tag can be on **many images**
- An artist can have **many images** across different collections

## Pages

### Public Pages

#### Landing / Home (`/`)
- Hero banner with site tagline: "A home for the art I love"
- Subtitle describing the gallery's purpose
- "Browse Gallery" CTA button
- "Recent Uploads" section — 2 rows of 4 artwork cards
- "See more" link to full gallery
- Footer with copyright and social links

#### Gallery / Browse (`/gallery`)
- Page title with total artwork count
- **Search bar** — search artworks by title
- **Filters**: tag dropdown, artist dropdown, sort order (newest, oldest, etc.)
- **View toggle**: grid view / list view
- **Masonry-style grid** — artwork cards at varied sizes for visual interest
- **Pagination** — numbered pages with previous/next
- Each card shows: image thumbnail, title, artist name, primary tag

#### Single Image View (`/gallery/:slug`)
- **Breadcrumb navigation**: Gallery > Collection > Image Title
- **Large image preview** (left side)
- **Metadata panel** (right side):
  - Title, "Commission by [Artist]"
  - Artist avatar with social link icons
  - Commissioned date
  - "Source" link — "View original post on [platform]"
  - Tags (displayed as labels)
  - Details: resolution, file size, upload date, collection link
- **Download button** — full-resolution original
- **Share button**
- **NSFW handling**: blurred by default with click-to-reveal overlay

#### About (`/about`)
- Profile card with avatar
- Name and role: "Furry art collector & commissioner"
- Bio text describing the site's purpose
- "Find me on" social links (same platforms as artists)
- "Browse Gallery" CTA
- Footer

#### Stickers (`/stickers`)
- **Pack grid** — each card shows an auto-generated mosaic cover (up to 2×2 of the pack's stickers), source chip (Telegram / Self-hosted), artist credit, sticker count, and an "Add to Telegram" link
- **Emoji rail** — most-used emoji across packs, click to filter
- **Filters**: free-text/emoji search and artist dropdown — when active, the page switches to a cross-pack grid of matching stickers
- **Single pack (`/stickers/:slug`)** — pack header with cover, description, and artist credit; a scoped emoji rail and contributing-artist filter over the pack's stickers
- **Single sticker (`/stickers/:slug/:id`)** — large preview (static image, animated Lottie, or video), emoji chips, artist credit + social links, NSFW blur with click-to-reveal, and a format-aware download
- **Download (`/stickers/:slug/:id/download`)** — same-origin proxy that streams the original bytes (preserves animated/video formats)

### Admin Pages (behind auth)

All admin pages share a **sidebar navigation**: Upload, All Images, Collections, Tags, Settings. Top bar shows "Admin Panel" badge with admin avatar.

#### Admin: All Images (`/admin/images`)
- Page title with total count
- **"Upload New" button** (top right)
- **Search bar**
- **Sort dropdown** (sort by date, etc.)
- **Data table**: thumbnail, title, artist, tags, date, actions (edit, delete)
- **Pagination** (previous/next)

#### Admin: Upload / Edit Image (`/admin/upload`)
- **Drag-and-drop upload area** with "Browse Files" button
- Supported formats: PNG, JPG, GIF, WEBP up to 50MB
- **Image Details form**:
  - Title (text input)
  - Artist (select from existing directory, or add new)
  - Artist social links (Twitter/X, Bluesky, Telegram, FurAffinity, DeviantArt, Patreon) — shown when adding a new artist
  - Collection (select dropdown)
  - Tags (multi-select / comma-separated)
  - NSFW checkbox ("Mark as NSFW")
  - Source Post URL (link to original post on Twitter/FA/etc.)
- **Cancel / Upload Artwork** buttons

#### Admin: Collections (`/admin/collections`)
- Page title with total count
- **"New Collection" button**
- **Grid of collection cards**: cover image, name, artwork count, edit button

#### Admin: Tags (`/admin/tags`)
- Page title with total count
- **"Add Tag" button**
- **Search bar**
- **Data table**: tag name, "Used In" count, created date, actions (edit, delete)

#### Admin: Stickers (`/admin/stickers`)
- **Pack list** with client-side search and source filter: pack, credit, source, sticker count, published toggle, actions (open on Telegram, Re-sync, edit, delete)
- **"Import from Telegram"** (`/admin/stickers/import`) — paste a Telegram set URL to load a review grid; batched/limit-safe import (20 per batch with progress), per-sticker emoji/artist/NSFW/exclude controls, bulk editing, and an inline new-artist modal
- **Re-sync** — re-opens the import grid against the current Telegram set (already-imported stickers shown in place, new ones ready to add)
- **"Add pack manually"** (`/admin/stickers/manual`) — drag-and-drop PNG/WebP upload with per-sticker emoji/artist/NSFW
- **Edit pack** (`/admin/stickers/:id/edit`) — drag-to-reorder stickers, bulk artist/NSFW editing, inline new-artist modal, publish toggle

#### Admin: Settings (`/admin/settings`)
- **Site Information**: site name, tagline, about text
- **Your Social Links**: Twitter/X, Bluesky, Telegram, FurAffinity
- **Storage**: usage display (used space, image count, provider name)
- **Danger Zone**: destructive actions (TBD)
- **"Save Changes" button**

## Key Features

### For Visitors
- Browse artwork without login
- Search and filter by tags, artists, sort order
- View full image details with artist credits and social links
- Download original resolution images
- NSFW images blurred by default, click to reveal
- Dark theme (default) with light mode toggle
- Responsive / mobile-friendly grid layout
- Accessible alt text on all images
- Browse sticker packs, search/filter by emoji or artist, and download stickers (static, animated, or video) in their original format

### For Admin
- Upload images with drag-and-drop
- Manage artist directory (grows over time with each new commission)
- Organize images into collections
- Tag images with freeform labels
- Mark images as NSFW
- Link to original source posts
- View storage usage
- Edit site metadata and social links
- Manage sticker packs: import from Telegram (batched, with per-sticker review and bulk editing) or upload manually, re-sync packs (manually or via a scheduled, opt-in daily cron), with per-sticker emoji/artist attribution

## Design

Mockups are in `sparky-ink.pen` (Pencil file). The design uses the **Lunaris** design system (dark theme) with orange accent colors.

Key design decisions:
- Dark background (`#1a1a1a`-ish) as default — standard for art gallery sites
- Orange CTA buttons for primary actions
- Monospace headings for a distinctive, slightly technical feel
- Card-based artwork display with rounded corners
- Masonry/varied-size grid for visual interest in the gallery
- Clean metadata panel on single image view
- Sidebar navigation for admin pages

## Project Structure (Planned)

```
sparky.ink/
  src/
    lib/
      server/
        db/           # Drizzle schema & migrations
        auth.ts       # Admin session management
      components/     # Shared Svelte components
    routes/
      (public)/
        +page.svelte          # Landing / Home
        gallery/
          +page.svelte        # Gallery / Browse
          [slug]/
            +page.svelte      # Single Image View
        about/
          +page.svelte        # About
      admin/
        +layout.svelte        # Admin layout with sidebar
        images/
          +page.svelte        # All Images
        upload/
          +page.svelte        # Upload / Edit Image
        collections/
          +page.svelte        # Collections
        tags/
          +page.svelte        # Tags
        settings/
          +page.svelte        # Settings
  drizzle/                    # Migration files
  static/                    # Static assets
  sparky-ink.pen              # Design mockups
  wrangler.toml               # Cloudflare config
```

## References

- **AfterDark.art** — the platform being replaced ([example collection](https://afterdark.art/collection/Q29sbGVjdGlvbk5vZGU6MzM0))
- **kobaj.art** — friend's gallery, similar concept, hosted on S3+CloudFront ([gallery](https://kobaj.art/gallery/))
