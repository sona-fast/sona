# Stickers — resume prompts

Two copy-paste prompts: one to mock the screens in Pencil, one to start a build session.
Spec lives in `stickers-design-brief.md`. Background in memory `stickers-feature.md`.

---

## A. Pencil mock prompt

> Mock the **Stickers** feature for sparky.ink in `sparky-ink.pen`. Read
> `stickers-design-brief.md` (repo root) as the source of truth — follow its Deliverables list.
>
> First call `get_editor_state(include_schema: true)` and `get_guidelines`, then study the existing
> screens so you match them exactly: the public **Gallery** (its tab toggle, filter bar, and
> `ArtworkCard`/`FursuitPhotoCard`) and the **admin** screens (Sidebar nav, "Admin Panel" header,
> orange primary buttons). Use the **lunaris** design system components only — don't invent new
> ones. Visual language: dark near-black bg, orange accent, monospace headers, rounded chips.
>
> Build these screens, placed in empty canvas beside the existing ones (don't overlap):
> 1. **Public — Stickers landing**: gallery tab bar with "Stickers" active, an emoji chip rail +
>    free-text search, an artist search, and a grid of **pack cards** (cover, character, adaptive
>    credit line "by {artist}" vs "managed by Sparky · N artists", sticker count, Telegram/
>    Self-hosted source chip, "Add to Telegram" button).
> 2. **Public — Pack detail** (two variants, side by side): a **single-artist** pack (header credits
>    one artist with their social-link row) and a **multi-artist self-managed** pack (header
>    "managed by Sparky" + contributing-artists row; each `StickerCard` shows its own artist credit).
>    Both show the sticker grid (images `object-fit: contain`, never cropped, transparent/
>    checkerboard bg) with **emoji chips** per sticker, and an "Add to Telegram" CTA.
> 3. **Public — Sticker detail** (modal or page) + a **filtered/empty** state.
> 4. **Admin — Stickers list** + a new "Stickers" sidebar item (active).
> 5. **Admin — Import from Telegram**: idle (paste link + character + manager + default-artist
>    pickers), checking, review (grid of fetched stickers with editable emoji chips + per-sticker
>    artist override), success, error.
> 6. **Admin — Add/Edit pack manually**: name/character/manager/cover form + multi-file PNG/ZIP
>    uploader with per-sticker artist + emoji assignment.
>
> Key rule for the credit UI: **for single-artist packs the manager IS the artist**; for
> self-managed packs the per-sticker artist is editable and packs may mix artists. Show realistic
> emoji (😀🔥💜👀), real-looking artist names + social icons, and a mix of single- and multi-artist
> packs so all states read true.

---

## B. Build kickoff prompt (paste when you start me up again)

> We're building the **Stickers** feature for sparky.ink. Read `stickers-design-brief.md` (repo
> root) and the `stickers-feature` memory first — they hold the locked decisions, data model, and
> invariants. The Pencil mocks are done (in `sparky-ink.pen`).
>
> Spin up agents to implement it in parallel where the work is independent:
> 1. **Data layer** — add `sticker_packs`, `stickers`, `sticker_emojis` to
>    `src/lib/server/db/schema.ts` (match the existing Drizzle style; reuse `artists` + `characters`
>    fks), then generate the Drizzle migration. Enforce the invariant that single-artist packs have
>    `managerArtistId` = the sole sticker artist.
> 2. **Public `/stickers` section** — landing (pack grid + emoji rail + artist search), pack detail
>    (single- and multi-artist credit logic), sticker detail. Reuse gallery chrome + storage layer;
>    new `StickerCard`. Server-side filtering by emoji and artist like the gallery does.
> 3. **Admin** — Stickers list + sidebar item; "Add/Edit pack manually" (PNG/ZIP upload, per-sticker
>    artist + emoji); "Import from Telegram" (Bot API `getStickerSet` + `getFile`, self-host images,
>    auto-detect emoji, per-sticker artist override). Mirror the FurTrack import flow.
>
> Confirm the build order and surface open questions (e.g. Bot API token secret, static-only vs
> animated/video stickers for v1) before writing code. **Do not push or deploy without my
> per-push approval** (see the ask-before-push memory).
