# Design Brief: Fursuit Photos feature for sparky.ink

## Goal
Add a way to view **fursuit photos** of a character alongside the existing artwork.
On a character/gallery view, the visitor can **toggle between "Artwork" and "Fursuit
Photos."** Artwork is the existing experience; Fursuit Photos is a new grid sourced from
FurTrack (a fursuit photo-sharing site) showing photos of that character, each crediting
the photographer and linking back to FurTrack.

This is a **non-commercial personal site.** Fursuit photos are owned by their photographers,
so the design must make **attribution and source-linking first-class**, not afterthoughts.

---

## Work with the existing design — do not start fresh
The file `sparky-ink.pen` already contains the product and its design system. Extend it.

- **Design system:** `lunaris: design system components` (frame `hTAsB`). Reuse its components:
  Tabs (`Tab Item/Active`, `Tab Item/Inactive`, `Tabs`), `Label/*` chips, `Avatar/Image` &
  `Avatar/Text`, `Card` / `Card Image`, `Button/*`, `Icon Button/*`, `Tooltip`, breadcrumbs,
  pagination, search box, dropdowns.
- **Screens to extend:**
  - `Sparky.ink - Gallery/Browse` (`eXoj3`) — the artwork grid + filter bar. This is where the
    Artwork/Fursuit toggle lives.
  - `Sparky.ink - Single Image View` (`2Z3Eu`) — the detail page; we need a fursuit-photo variant.
- **Reusable card to mirror:** `ArtworkCard` (`qXYtZ`) — image, title, "by [artist]", tag chip.
- **Visual language (match exactly):** dark near-black background, orange primary accent,
  monospace logo/headers, rounded tag chips, generous grid spacing, top nav
  `sparky.ink … Gallery / Collections / About`.

---

## What to design

### 1. The Artwork / Fursuit Photos toggle
A segmented control built from the existing **Tabs** component, placed at the top of the
gallery/character content (above the grid, near the title). Two tabs:
`Artwork` (default/active) | `Fursuit Photos`.

- Keep it visually distinct from the existing grid/list view-mode icons (top-right of the
  filter bar) — the tabs switch *what content* is shown; the view-mode icons switch *layout*.
- Optional small count badge per tab (e.g. "Fursuit Photos · 48").

### 2. New component: `FursuitPhotoCard`
A sibling to `ArtworkCard`, same grid footprint and styling, but content reflects a photo:

- Photo thumbnail (fills card top, same aspect treatment as ArtworkCard).
- **Photographer credit**, prominent: `📸 by {photographer}` (camera glyph or icon).
- **Event/convention** chip when present (e.g. `FWA 2026`) — use a `Label` chip, visually
  secondary to the photographer.
- **License badge** (small, subtle): e.g. `CC-BY-NC-ND`, `CC-BY`, `Public Domain`. Use a quiet
  `Label/Secondary`-style chip; on hover show a Tooltip with the plain-language terms
  (e.g. "Reposts OK. Edits & commercial use prohibited. Must attribute photographer.").
- Whole card links to the FurTrack detail variant; an explicit "View on FurTrack" affordance
  (small external-link icon) should also be visible.

### 3. Fursuit Photo grid (Fursuit Photos tab active)
Reuse the gallery grid layout, populated with `FursuitPhotoCard`s instead of `ArtworkCard`s.

- Filter bar adapts: keep search; swap artwork-specific dropdowns for relevant ones —
  **Photographer**, **Event/Convention**, and sort (Newest / Most liked). Keep grid/list toggle.
- Pagination identical to the artwork grid.

### 4. Fursuit Photo detail view (variant of `2Z3Eu`)
Same layout as Single Image View (big image left, info sidebar right), with these changes to
the sidebar — this is where attribution/licensing must be explicit:

- Title line: character name (e.g. "Sparky") + small "Fursuit photo" eyebrow/label.
- Replace "Commission by Sparky" with **`📸 Photo by {photographer}`**, with the photographer's
  avatar (`Avatar/Image`) and a link to their FurTrack profile.
- **Source:** "View original post on FurTrack" (mirrors the existing "View original post on
  Twitter" row) — links to `furtrack.com/p/{id}`.
- **License block:** the license name + plain-language terms (the Tooltip text), shown inline
  rather than hidden, since this is the page where someone evaluates reuse.
- Tags: character, species, event/convention, photographer (chips, as today).
- Details: Resolution, File size, Date taken, Event.
- **Buttons:** primary is **"View on FurTrack"** (external link), secondary **"Share"**.
  ⚠️ **Do NOT include a Download button here** (artwork has one; fursuit photos must not —
  many licenses forbid redistribution/derivatives).

### 5. States to mock
- **Loading:** skeleton cards in the grid (we fetch from an external source; show pending state).
- **Empty:** "No fursuit photos yet for this character" with a subtle illustration/icon and a
  line like "Photos are pulled from FurTrack as they're tagged."
- **Hidden/withheld note (optional):** a small footnote on the grid: "Only photos licensed for
  reposting are shown. Photographers can request removal anytime." (Reassures the community.)

---

## Content & real data (so mocks feel real)
Each fursuit photo has: photographer name + handle, one or more character/species tags, an
event/convention, a license (one of: Photographer's discretion, Photographer's license,
CC-BY-NC-ND, CC-BY-NC, CC-BY-ND, CC-BY, Public Domain, © All Rights Reserved), a date taken,
image dimensions, and a canonical FurTrack URL. Use varied, realistic placeholder values across
the grid (different photographers, events, and a mix of CC license chips) so the attribution and
license treatments are visible.

Note: only CC / Public Domain photos are ever shown publicly; "All Rights Reserved" and
unspecified are excluded — so the mock grid should only display CC/PD license badges.

---

## Do / Don't recap
- ✅ Reuse lunaris components and the dark + orange aesthetic; match `ArtworkCard` footprint.
- ✅ Make photographer credit + FurTrack source link unmissable on both card and detail.
- ✅ Show the license clearly (chip on card, full terms on detail).
- ❌ No download button on fursuit photos.
- ❌ Don't crop/overlay/recolor the photo thumbnails (licenses can forbid edits — present as-is).
- ❌ Don't invent new visual styling that diverges from the existing screens.

## Deliverables requested from the design AI
1. The **Artwork / Fursuit Photos toggle** placed on the gallery/character view.
2. A **`FursuitPhotoCard`** reusable component.
3. The **Fursuit Photos grid** state of the gallery.
4. A **Fursuit Photo detail** screen (variant of Single Image View).
5. **Loading** and **empty** states for the grid.
Place new screens/components in empty canvas areas next to the existing ones; don't overlap.
