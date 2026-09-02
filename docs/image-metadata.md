# Image metadata scrubbing

Photos carry more than the picture. A phone stamps each JPEG with a capture
time, a camera serial number and a maker note, plus GPS coordinates when
location services are on. Editors add XMP packets that repeat the same fields as
text. Sona strips that material from every raster it stores, so publishing a
reference photo does not publish the address you took it at.

Cloudflare Image Transformations already drop metadata, but only on the
transform path. Several routes serve the stored original bytes untouched: GIFs
skip the transform, `rawFallback` in `src/lib/img.ts` falls back to the source
URL, the `/img/[...key]` route streams the object, and an R2 custom domain
serves it directly. So Sona strips the metadata at store time instead, and what
is stored is already clean on every route, including a full-quality download.

## Where it happens

`getStorage()` wraps whichever provider it builds in a decorator that scrubs
raster bodies on the way in (`src/lib/server/storage/scrub.ts`). Every put site
inherits it with no code of its own: uploads through `/api/upload`, the fursuit
and Telegram sticker imports, artist avatar re-hosting, the sticker re-key and
migration between storage providers. An importer added later inherits it too,
which is the reason the decorator sits there rather than at each call site.

The bytes decide, not the declared content type. A body declared as a raster is
scrubbed, and so is any other body whose leading bytes carry a raster
signature, because a caller can be wrong about what it holds. Bodies that sniff
as nothing pass straight through: the VR showcase clips (`video/webm`), the
Lottie JSON of an animated Telegram sticker, and VR model bytes.

## What Sona removes, and what it keeps

| Format | Removed | Kept |
| --- | --- | --- |
| JPEG | The Exif sub-IFD, the GPS IFD, the maker note, IFD1 and its embedded thumbnail, the XMP packet, the multi-picture (MPF) index, the Photoshop resource block with its IPTC fields, and every byte after the end-of-image marker | Orientation, Artist, Copyright, the ICC color profile, JFIF, the comment segment, the scan up to and including the end-of-image marker, and every other APPn segment |
| PNG | `eXIf` beyond the three kept tags, the `tEXt`, `zTXt` and `iTXt` text chunks (`iTXt` is where XMP lives), the compressed-Exif `zxIf` chunk and the `tXMP` chunk (matched whatever case the chunk type is written in), and every byte after the `IEND` chunk | Orientation, Artist, Copyright, `iCCP`, `IDAT`, and every other chunk, APNG included |
| WebP | The `EXIF` chunk beyond the three kept tags, the `XMP ` chunk (both matched whatever case the fourcc is written in), the XMP feature bit in `VP8X`, and any bytes past the declared RIFF size | Orientation, Artist, Copyright, `ICCP`, `ANIM`, `ANMF`, `ALPH`, `VP8`, `VP8L`, and every other chunk |
| AVIF | The Exif item beyond Artist and Copyright, the XMP item, and the content of every top-level `free`, `skip` and `uuid` box, which is where an editor parks an XMP packet that has no item of its own | The image data, the item properties, the `irot`/`imir` orientation, and the `ftyp` and `mdat` boxes. Every top-level box is walked, including the ones after the item payloads: a second `meta` box is refused, so is any top-level box outside `ftyp`, `meta`, `mdat`, `free`, `skip` and `uuid`, and the padding boxes keep their headers so the box structure still adds up. Inside `meta`, only the boxes a still image needs are allowed |
| GIF | The payload of an `XMP DataXMP` application extension, and every byte after the trailer | Every other block, the comment extension and the XMP extension's magic trailer included |

A JPEG's other application segments are the known gap. Sona rewrites APP1, APP2
and APP13, where Exif, XMP, the ICC profile, the MPF index and the Photoshop
resource block live. APP0 and APP3 through APP12, plus APP14 and APP15, pass
through as they are, so a JUMBF or C2PA record parked in APP11 survives the
scrub, and so does a JFXX thumbnail in APP0, which is a nested JPEG that can
carry Exif of its own. No camera writes one.

Orientation stays because dropping it turns a portrait photo sideways. Artist
and Copyright stay because they are the artist's own attribution, and stripping
them would work against the person the site exists to credit. The ICC profile
stays because it describes color, not identity. Sona forwards it as-is, keyed
on its `ICC_PROFILE` identifier, without reading what is inside.

Only the Exif copies of those fields survive. The same credit written into an
IPTC record or an XMP packet is lost, because those blocks are zeroed whole to
keep the rewrite size-preserving, and the site's own on-page credit is the
authoritative one either way. The removal is for visitor privacy: every work
keeps its on-page artist and photographer credit, and a rights holder can ask
for a correction or removal through the contact in the privacy policy.

The guarantee is about metadata a reader can find. A packet whose container
label has been corrupted, say an APP1 marker or an `iTXt` chunk type with one
byte changed, is no longer a metadata record to any reader, so the walk copies
it through like any other unrecognised segment, and its text can still be found
with a byte search. No encoder writes such a record; only a deliberately
crafted file has one.

The JPEG comment segment, the GIF comment extension and the PNG `tIME` chunk
are accepted exceptions. A comment sometimes carries the artist's own notice,
and `tIME` is a modification time rather than a capture time, so none of them
places anyone anywhere.

AVIF is the exception on orientation: it carries rotation in the `irot` and
`imir` item properties rather than in Exif, so an Exif Orientation tag there
would contradict the real rotation.

GIF has no Exif field, but GIF89a carries XMP in an application extension
labelled `XMP DataXMP`, and Photoshop and Lightroom write GPS coordinates into
it. That payload is replaced with an empty packet; the 258-byte magic trailer
that closes the extension is kept, because it is what makes a decoder's
sub-block walk terminate. Every other block, the comment extension included,
passes through byte for byte, and everything after the trailer is zeroed,
because a decoder stops at the trailer and never reaches a second image parked
behind it. Two shapes are refused instead of copied, both described below.

## Rewrites preserve the file size

Every rewrite overwrites the same number of bytes it read. A metadata record is
replaced by a minimal valid form and the slack is padded, with zeros for a
binary record and with ASCII spaces inside an XMP packet, which the XMP spec
already reserves for exactly this kind of in-place edit. An Exif record too
small to hold even an empty directory is zeroed whole, prefix included, so a
decoder skips an unrecognised segment rather than reading a hollow one.

The length has to hold because both storage providers stream a body only when
its exact length is declared up front, R2 through `FixedLengthStream` and
UploadThing through its presigned ingest URL. A scrub that changed the length
would force every upload to buffer in memory instead.

## What a scrub costs

The walk is linear in file size and holds at most one metadata record plus a
64 KiB output block in memory, whatever the file's shape. Processor time is the
other bound: a JPEG made of nothing but four-byte segments, or a GIF made of
one-byte sub-blocks, is among the slowest shapes the walk can be given, and a
file like that at the 64 MiB upload cap measured around ten seconds of worker
time. Only the signed-in operator can send such a file,
because every put site is admin-gated.

## When Sona refuses a file

The parser fails closed. If a raster cannot be walked, because a segment length
runs past the end of the file, a chunk length is impossible, or an AVIF places
its metadata in a layout the rewriter does not support, the put throws
`UnscrubbableImageError` and nothing is stored. Passing the bytes through
unexamined would break the guarantee that every stored raster was scrubbed. An
AVIF that keeps its Exif or XMP payload in an `mdat` box placed before the
`meta` box is refused on that rule: the layout is legal, but the walk has
already passed those bytes by the time the item list names them, and an extent
behind the walk cannot be rewritten in place. No common encoder writes it. An
AVIF whose item list names a `mime` item that is not XMP is refused as well,
because the scrubber cannot tell what that payload holds. So is an AVIF naming
an item of any type outside the inert set the scrubber knows (`av01`, `grid`,
`iovl`, `iden`, the `tmap` gain map, plus the `exif` and `mime` items it
rewrites), because the walk copies an item it skips straight through, bytes and
all. AVIF image sequences are refused: their `moov` box can carry location
atoms and the scrubber does not walk it. Inside `meta`, only the boxes a still
image needs are allowed: `hdlr`, `pitm`, `iinf`, `iloc`, `iprp`, `iref`,
`dinf`, `grpl` and `idat`. A `uuid`, `free`, `skip`, `udta`, `xml `, `bxml` or
nested `meta` box inside `meta`, or inside the `iprp`, `ipco`, `iref`, `dinf`,
`dref` and `grpl` containers below it, is refused, because each one is another
place an editor can park an XMP packet the walk would otherwise step over. An
item list whose declared entry count disagrees with the entries present, or
that holds anything other than item entries, is refused too.

A GIF is refused on two rules of its own. An application extension whose
identifier reads as `XMP Data` in any case but is not exactly `XMP DataXMP` is
refused rather than copied, because the payload behind such a label is raw XML
with no sub-block structure, so copying it through is the one way GPS
coordinates could survive the walk intact. An XMP extension that does not end in
the magic trailer is refused for the same reason: without the trailer the
payload cannot be located, and the bytes in front of it cannot be replaced in
place.

Each caller handles the refusal in its own way. An upload through `/api/upload`
returns 422 and asks you to re-export the file. A fursuit import counts that
photo as failed and logs the reason. Avatar re-hosting logs a warning and keeps
the source URL as a hotlink. A sticker import reports the failure for that
sticker. Uploading stickers by hand in the pack form counts the refused files
among the failures and names the refusal in a second message with its own
count, because the operator picked those files and can re-export them. A provider migration lists the object as failed and asks you to replace
it with a fresh copy. The sticker re-key reports it the same way a migration
does, because the operator has to replace the file either way.

## Objects stored before scrubbing existed

Sona does not rewrite objects already in the bucket, and nothing sweeps the
bucket, so a photo uploaded before the scrubber existed keeps whatever metadata
it came with. Re-uploading the file cleans it up. So does migrating between
storage providers, but only for the objects the migration re-stores: it walks
the artwork table, so it reaches artwork images and their thumbnails and
nothing else. Artist avatars, Telegram sticker media, imported fursuit photos
and VR media keep whatever metadata they were stored with until someone
uploads them again. An old object the parser refuses is listed as a migration
failure instead, and only a fresh upload replaces it.
