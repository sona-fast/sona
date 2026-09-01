# Image metadata scrubbing

Photos carry more than the picture. A phone writes GPS coordinates, a capture
time, a camera serial number and a maker note into every JPEG, and editors add
XMP packets that repeat the same fields as text. Sona strips that material from
every raster it stores, so publishing a reference photo does not publish the
address you took it at.

Cloudflare Image Transformations already drop metadata, but only on the
transform path. Several routes serve the stored original bytes untouched: GIFs
skip the transform, `rawFallback` in `src/lib/img.ts` falls back to the source
URL, the `/img/[...key]` route streams the object, and an R2 custom domain
serves it directly. So the strip happens at store time instead, and what is
stored is already clean on every route, including a full-quality download.

## Where it happens

`getStorage()` wraps whichever provider it builds in a decorator that scrubs
raster bodies on the way in (`src/lib/server/storage/scrub.ts`). Every put site
inherits it with no code of its own: uploads through `/api/upload`, the fursuit
and Telegram sticker imports, artist avatar re-hosting, the sticker re-key and
migration between storage providers. An importer added later inherits it too,
which is the reason the decorator sits there rather than at each call site.

Bodies whose declared content type is not a raster we serve publicly pass
straight through. That covers the VR showcase clips (`video/webm`), the Lottie
JSON of an animated Telegram sticker, and VR model bytes.

## What is removed, and what stays

| Format | Removed | Kept |
| --- | --- | --- |
| JPEG | The Exif sub-IFD, the GPS IFD, the maker note, IFD1 and its embedded thumbnail, the XMP packet, the multi-picture (MPF) index, the Photoshop resource block with its IPTC fields | Orientation, Artist, Copyright, the ICC colour profile, JFIF, the comment segment, and everything from the start of scan onward |
| PNG | `eXIf` beyond the three kept tags, and the `tEXt`, `zTXt` and `iTXt` text chunks (`iTXt` is where XMP lives) | Orientation, Artist, Copyright, `iCCP`, `IDAT`, and every other chunk, APNG included |
| WebP | The `EXIF` chunk beyond the three kept tags, the `XMP ` chunk, and the XMP feature bit in `VP8X` | Orientation, Artist, Copyright, `ICCP`, `ANIM`, `ANMF`, `ALPH`, `VP8`, `VP8L` |
| AVIF | The Exif item beyond Artist and Copyright, and the XMP item | The image data, the item properties, and the `irot`/`imir` orientation |
| GIF | Nothing | Everything |

Orientation stays because dropping it turns a portrait photo sideways. Artist
and Copyright stay because they are the artist's own attribution, and stripping
them would work against the person the site exists to credit. The ICC profile
stays because it describes colour, not identity.

AVIF is the exception on orientation: it carries rotation in the `irot` and
`imir` item properties rather than in Exif, so keeping an Exif Orientation tag
there could only fight the real one.

GIF passes through byte for byte. The format has no location field, and its one
free-text place is the comment extension, which cameras do not write.

## Size is preserved

Every rewrite overwrites the same number of bytes it read. A metadata record is
replaced by a minimal valid form and the slack is padded, with zeros for a
binary record and with ASCII spaces inside an XMP packet, which the XMP spec
already reserves for exactly this kind of in-place edit.

The length has to hold because both storage providers stream a body only when
its exact length is declared up front, R2 through `FixedLengthStream` and
UploadThing through its presigned ingest URL. A scrub that changed the length
would force every upload to buffer in memory instead.

## When a file is refused

The parser fails closed. If a raster cannot be walked, because a segment length
runs past the end of the file, a chunk length is impossible, or an AVIF places
its metadata in a layout the rewriter does not support, the put throws
`UnscrubbableImageError` and nothing is stored. Passing the bytes through
unexamined would quietly break the guarantee this exists to make.

Each caller handles the refusal in its own way. An upload through `/api/upload`
returns 422 and asks you to re-export the file. A fursuit import marks that item
failed with the message. Avatar re-hosting logs a warning and keeps the source
URL as a hotlink. A sticker import reports the failure for that sticker.

## Objects stored before this shipped

Existing objects are not rewritten. Nothing sweeps the bucket, so a photo
uploaded before this landed keeps whatever it came with. Two things do clean it
up: re-uploading the file, and migrating between storage providers, since
migration re-stores every object through the same layer.
