# Image Variants — Implementation Plan

Tracks [#1](https://github.com/sparkyfen/sparky.ink/issues/1).

## Goal

Allow an image to have related "variants" — alternate versions of the same piece (transparent background, NSFW alt ending, color swap, etc.) — grouped under a single parent so the gallery isn't cluttered with near-duplicates.

## Data model

Migration `0009_add_image_variants.sql`:

```sql
ALTER TABLE images ADD parent_image_id INTEGER REFERENCES images(id) ON DELETE CASCADE;
ALTER TABLE images ADD variant_label TEXT;
```

`schema.ts` adds:

```ts
parentImageId: integer('parent_image_id').references((): AnySQLiteColumn => images.id, { onDelete: 'cascade' }),
variantLabel: text('variant_label')
```

Notes:
- `parent_image_id` is nullable; a row is a "parent" when null, a "variant" when set.
- `variant_label` is what the variant strip shows (e.g. "Transparent BG", "NSFW alt"). Not in the issue, but added because variant pickers are unusable without a discriminator.
- One-level only — enforced in the edit form action, not the schema. (Variants of variants would complicate the variant strip and offer no real benefit.)
- `ON DELETE CASCADE` — deleting a parent removes its variants. Simpler than promoting a sibling.
- Variants are **independent** for tags, characters, NSFW, dimensions, collection, published state. No inheritance.

## Public-side filtering

Every list query needs to exclude variants so they don't appear as standalone cards. Add `WHERE parent_image_id IS NULL` to:

- `(public)/+page.server.ts` — recent uploads + mosaic (both branches)
- `(public)/gallery/+page.server.ts` — list + count
- `(public)/collections/+page.server.ts` — `artworkCount` + `latestImageUrl` subqueries
- `(public)/collections/[slug]/+page.server.ts` — image list
- `(public)/about/+page.server.ts` — artworks stat

Single image view (`/gallery/[slug]`) and `oembed` stay open to either parent or variant — direct links to a specific variant should still resolve, otherwise share links break.

## Single image view — "Variants" section

Below the metadata panel, render a horizontal strip when the image has siblings:

- Show the parent + all of its variants, current one highlighted.
- Each tile: thumbnail (CDN-resized), `variant_label || 'Variant N'`.
- Click navigates to the variant's slug — URL changes, browser back works, share/oembed for the variant still functions.

Server load logic:

```ts
const parentId = image.parentImageId ?? image.id;
const siblings = await db
  .select({ id, slug, thumbnailUrl, imageUrl, variantLabel, nsfw })
  .from(images)
  .where(or(eq(images.id, parentId), eq(images.parentImageId, parentId)))
  .orderBy(asc(images.id));
```

Only render the strip when `siblings.length > 1`.

## Admin UX

### Image edit page (`/admin/images/[id]/edit`)

Two new fields under Collection:

1. **Variant of** — combobox listing existing parent-eligible images (i.e. `parent_image_id IS NULL`), searchable by title. Sets `parentImageId`.
2. **Variant label** — text input. Only shown when "Variant of" has a value.

Form-action validation (in order, first-match returns `fail(400, ...)`):
- Self-reference: `parentImageId !== self.id`
- One-level enforcement: chosen parent must itself have `parentImageId IS NULL`
- Clearing the variant link clears `variant_label` too

### Upload page (`/admin/upload`)

Skip variant UI on initial upload — keep upload single-purpose. Users mark variants on the edit page after upload. (Adding it to upload doubles the form size for a flow most uploads won't need.)

### Admin images table (`/admin/images`)

- Keep showing all rows (parents + variants) — admin needs to see everything.
- Under variant rows, render a small "variant of: [parent title]" subline with a link to the parent's edit page.
- **Optional polish:** filter chip "Hide variants" for cleaner browsing during review passes.

## Edge cases

| Case | Behavior |
|---|---|
| Variant of a variant | Disallowed by edit-action validation, not schema |
| Deleting parent | Cascades — all variants removed |
| Deleting a variant | Just removes that row; parent untouched |
| Tag/character inheritance | None — variants manage their own |
| Variant in a different collection than parent | Allowed |
| Variant as a collection cover image | Allowed |
| Variant `published = 0` | Treated like any private image; strip on the public single-image view should also filter out unpublished siblings |

## Implementation order (suggested PRs)

Each step ships independently — the public site stays stable throughout.

1. **Schema + filters** — migration 0009, `schema.ts` update, public query filters. Lands invisibly (no parent rows exist yet so no behavior change).
2. **Admin edit page** — Variant of + Variant label fields, form validation. Now you can create variants, but they're invisible on the public site.
3. **Public variants strip** — single image view shows siblings. The feature is now user-visible.
4. **Admin table polish** — variant-of sublabel under titles, optional "Hide variants" filter chip.

## Out of scope (for now)

- Bulk-upload variants in one flow
- Reordering variants (current order is by id)
- Per-variant download buttons in a single combined download (each variant has its own download button on its own page)
- Reassigning a variant to a different parent in bulk
