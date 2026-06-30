# Design Brief: Stickers — public showcase + admin ingestion

## Goal
Add a **Stickers** feature to sparky.ink: a dedicated public section where visitors browse an
artist's sticker packs, see the **artist + their social links**, see the **emoji each sticker
maps to**, **search by emoji**, **search by artist**, and **jump straight to the Telegram pack**
("Add to Telegram"). Some packs are hosted on Telegram (`t.me/addstickers/…`); others Sparky
runs himself from PNGs an artist emailed as a ZIP — both are first-class.

Decisions already made (don't re-litigate in the mocks):
- **Placement:** stickers get their **own top-level `/stickers` section**, organized by pack —
  *not* mixed into the artwork grid. Add a small **"Stickers"** link into the existing gallery
  tab bar (Artwork / Fursuit Photos / **Stickers**) for discovery, but the link navigates to the
  dedicated section; the section is its own layout.
- **Granularity:** **per-sticker** records, each with one or more **emoji**. This is what makes
  search-by-emoji and individual sticker browsing possible. A contact-sheet preview (e.g.
  `NaL-4.png`) is *only* a pack cover/preview — it cannot power emoji search.
- **Ingestion: both paths.** (A) **Telegram auto-import** — paste a `t.me/addstickers/…` link and
  the site fetches every sticker image *and its emoji* and self-hosts them. (B) **Manual upload** —
  for self-run packs, admin uploads PNGs (or a ZIP) and assigns emoji. Both feed the same public
  section.

## Work with the existing design — do not start fresh
File: `sparky-ink.pen`. Reuse the established look on both the public and admin sides.

- **Public side — match the gallery:** mirror `Sparky.ink - Gallery` chrome and the existing
  **tab toggle** used for Artwork ↔ Fursuit Photos. Reuse `ArtworkCard` / `FursuitPhotoCard` as
  the visual reference for the new **`StickerCard`**, and the gallery's filter/search bar pattern.
- **Admin side — match admin chrome:** same left **Sidebar** (logo → Upload / All Images /
  Collections / Tags / Settings / Fursuit Photos), "Admin Panel" top-right, titled content area,
  orange primary buttons. **Add a new sidebar item "Stickers"** (sticker/smiley icon), active on
  these pages — mirror how the FurTrack import brief adds its sidebar item.
- **Design system:** `lunaris`. Reuse: Sidebar, Button/* (orange primary, outline secondary),
  Icon Button, Card / Card Image, Table, Label/* chips, Avatar/Image, Checkbox/*, Input + Select +
  Search Box, Dialog / Modal, Alert (Info/Success/Warning/Error), Pagination, Tooltip.
- **Visual language:** dark near-black bg, orange accent, monospace headers, rounded chips —
  identical to the rest of the site. Emoji are rendered as native unicode glyphs in chips.

## Data model (so mocks reflect real fields)
Two new tables + one junction, plus reuse of the existing `artists` and `characters` tables.

**Attribution lives at the sticker level, not the pack.** A pack belongs to a *character* and has a
*manager*; the **artist is per-sticker**, because a self-managed pack can mix many artists. A
"single-artist pack" is simply the common case where every sticker shares one artist — the UI
derives that, there's no separate pack-artist field.

- **`sticker_packs`** — `id`, `name`, `slug` (unique), `description`, `coverImageUrl` (the
  contact-sheet/preview), `characterId` (fk → existing `characters` — which character the pack is
  *of*), `managerArtistId` (nullable fk → `artists`; **null = managed by Sparky/site owner**, a
  value = managed by that artist), `telegramUrl` (the `t.me/addstickers/…` link, nullable for
  self-hosted-only), `source` (`'telegram'` | `'self-hosted'`), `published` (bool), `createdAt`.
- **`stickers`** — `id`, `packId` (fk), `artistId` (fk → `artists` — **who drew this sticker**),
  `imageUrl`, `thumbnailUrl`, `width`, `height`, `format` (`png` | `webp` | `animated` | `video` —
  Telegram sets can include `.tgs`/`.webm`), `position` (order within pack), `nsfw` (bool),
  `createdAt`.
- **`sticker_emojis`** (junction) — `stickerId` (fk), `emoji` (unicode text). Many emoji per
  sticker; search-by-emoji filters on this.
- **Artist + social links:** reuse the existing **`artists`** table (Twitter, Bluesky, Telegram,
  FurAffinity, DeviantArt, Patreon, Instagram + auto-resolved avatar). No new artist fields.
- **Character:** reuse the existing **`characters`** table (owner + social links). A pack is *of*
  one character; a character commonly has one single-artist pack and/or one self-managed
  multi-artist pack.
- **Storage:** images self-hosted via the existing pluggable provider (R2/UploadThing), key
  `stickers/{uuid}.{ext}`, served from `cdn.sparky.ink` — same path as artwork.

### Two pack shapes the mocks must show
- **Single-artist pack** (managed by that artist): every sticker shares one artist; header credits
  that one artist; **`managerArtistId` = that same artist** — invariant: for single-artist packs the
  manager *is* the artist, they never differ.
- **Multi-artist pack** (managed by Sparky): stickers credited to *different* artists; header reads
  "managed by Sparky" and lists/links the **contributing artists**; each `StickerCard` shows its
  own artist. `managerArtistId` = null.

This makes pack shape derivable, not a stored flag: **`managerArtistId` set → single-artist** (and
every sticker's `artistId` equals it); **`managerArtistId` null → self-managed**, single- or
multi-artist depending on the distinct sticker artists.

## Public flow & states to mock

### 1. Stickers section — landing (packs overview)
- Title **"Stickers"** + subtitle: "Grab Sparky's sticker packs for Telegram."
- The **gallery tab bar** with **Stickers** active (so users see it's part of the same family).
- A **search/filter bar**:
  - **Search by emoji** — an **emoji chip rail** of the most-used emoji (😀 🔥 💜 👀 …); tapping a
    chip filters to stickers tagged with it. Plus a free-text box that accepts a pasted emoji or a
    keyword (e.g. "heart").
  - **Search by artist** — artist selector / search (reuses gallery's artist filter).
- **Pack cards** in a grid: cover preview image, pack **name**, **character** it's of, a credit line
  that adapts to pack shape — single-artist: "by {artist}" (avatar + name, links to artist);
  multi-artist: "managed by {manager} · {N} artists" — sticker **count** (e.g. "24 stickers"), a
  small **source** chip ("Telegram" / "Self-hosted"), and a primary **"Add to Telegram"** button
  when a `telegramUrl` exists.

### 2. Pack detail — `/stickers/[slug]`
- Header: pack **name**, the **character** it's of, short description, and a credit block that
  adapts to pack shape:
  - **Single-artist:** the artist (avatar, name, **all their social links** as icon buttons — reuse
    the artist link row from the gallery).
  - **Multi-artist:** "Managed by {Sparky}" + a **contributing-artists row** (each artist as an
    avatar chip linking to them); per-artist social links surface on the individual stickers /
    sticker detail rather than crowding the header.
- Prominent **"Add to Telegram"** CTA (when applicable); for self-hosted packs, instead show a
  friendly "Hosted by Sparky" note (no external pack).
- **Sticker grid:** each `StickerCard` shows the sticker image (`object-fit: contain`, never
  cropped, on a subtle checkerboard/transparent bg) with its **emoji chip(s)** and — in
  multi-artist packs — a small **artist credit** (avatar + name, links to artist).
- Same **emoji + artist search/filter** scoped to this pack (filtering by artist is especially
  useful inside a multi-artist pack), plus a way to clear back to all packs.

### 3. Sticker detail (lightweight — modal or `/stickers/[slug]/[id]`)
- Large sticker, its **emoji chips**, the **pack** it belongs to (link), the **artist** + social
  links, and the **"Add to Telegram"** CTA for the parent pack. No download button needed.

### 4. Search results / empty
- Filtering by an emoji or artist re-renders the grid with a **summary line**
  ("12 stickers · 😀 · across 2 packs") and a clear-filters control.
- **Empty:** "No stickers match 🦊 yet." with a reset link.

## Admin flow & states to mock

### A. Stickers list (admin landing)
- Sidebar item **"Stickers"** active. Title + subtitle.
- Two primary actions: **"Import from Telegram"** and **"Add pack manually."**
- A **table/list of packs**: cover thumb, name, character, credit (artist or "managed by Sparky · N
  artists"), source chip, sticker count, published toggle, edit/delete — mirror `Admin: All Images`.

### B. Import from Telegram (the fast path)
- Input: **paste pack link** (`t.me/addstickers/Sparky84453`) + pick the **character** the pack is
  of, the **manager** (an artist, or "myself"), and a **pack-wide default artist** (or "create new
  artist" inline with social links, like the image edit form).
- **Checking** state: spinner + "Fetching pack from Telegram…" (hits the Bot API `getStickerSet`
  server-side).
- **Review** state: pack title + a grid of every fetched sticker with its **auto-detected emoji**
  shown as editable chips; admin can tweak emoji, exclude individual stickers, mark NSFW, and
  **override the artist per sticker** (defaults to the pack-wide artist — the override is the
  multi-artist path).
- Confirm dialog: "Import N stickers into '{name}' (of {character}, managed by {manager})? Images
  will be downloaded and hosted on sparky.ink, crediting each artist." → **Success** Alert with
  "View in section →".
- **Error:** "Couldn't reach Telegram / pack not found." (nothing imported).

### C. Add pack manually (self-hosted path)
- Form: pack **name**, **character**, **manager** (artist or "myself"), optional **description**,
  optional **Telegram link**, **cover image** upload.
- **Sticker uploader:** multi-file PNG drop (or ZIP) → thumbnails appear; per-sticker **artist
  assignment** (defaulting to a pack-wide artist, overridable for multi-artist packs), **emoji
  assignment** (emoji picker chips) and NSFW toggle; reorder by drag.
- Save → pack appears in the list and (when published) the public section.

### D. Edit pack / sticker
- Reuse the manual form to edit name/artist/links/cover, add or remove stickers, and re-assign
  emoji. Delete cascades stickers + emoji rows (and cleans up storage), like image delete.

## Do / Don't
- ✅ Make **"Add to Telegram"** the obvious primary action wherever a pack has a Telegram link.
- ✅ Show the **emoji** on/under every sticker and make emoji a real, tappable filter.
- ✅ Keep **artist credit + social links** prominent on packs and sticker detail (reuse the
  existing artist link row).
- ✅ **Credit each sticker to its own artist** — a pack can mix artists. Single-artist packs read
  "by {artist}"; self-managed multi-artist packs read "managed by Sparky" + a contributing-artists
  row, with each sticker carrying its own credit.
- ✅ Render stickers `object-fit: contain` on a transparent/checkerboard bg — never crop.
- ✅ Treat self-hosted and Telegram packs as equals; only the CTA differs.
- ❌ Don't mix stickers into the artwork gallery grid — it's its own section.
- ❌ Don't rely on the contact-sheet image for browsing/search; it's only a cover/preview.
- ❌ Don't add a download button (stickers are used via Telegram / the pack).
- ❌ Don't redesign the gallery tabs or admin chrome — extend them.

## Dependencies / open notes (not design, but flag for build)
- **Telegram auto-import needs a Bot API token** (`getStickerSet` + `getFile` to fetch images).
  Store it as a secret alongside the other env tokens. The existing `telegram` MCP also exposes
  `get_sticker_sets` as an alternative ingestion route — confirm which to wire up at build time.
- Telegram sets can contain **animated (`.tgs`) / video (`.webm`)** stickers — decide whether v1
  imports those or static-only (the `format` column anticipates both).

## Deliverables
1. **Public: Stickers landing** (packs grid + emoji rail + artist search + Stickers tab active).
2. **Public: Pack detail** (artist/social header, Add-to-Telegram CTA, sticker grid with emoji).
3. **Public: Sticker detail** (modal or page) + a **filtered/empty** state.
4. **Admin: Stickers list** + new sidebar item.
5. **Admin: Import from Telegram** — idle, checking, review (editable emoji), success, error.
6. **Admin: Add/Edit pack manually** — upload + per-sticker emoji assignment.
Place new screens in empty canvas areas beside the existing screens; don't overlap.
