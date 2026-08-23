# Displaying an image and reading its bytes are different permissions

Showing a remote image in this app is easy. Reading its pixels or its bytes is
not, and the difference has bitten three separate features. If you are writing
anything that samples a canvas, embeds an image as a `data:` URI, or hashes or
measures image content, read this first.

## The rule

The app's CSP (`svelte.config.js`) sets:

```
img-src      'self' https: data: blob:
connect-src  'self' blob: data:
```

`img-src` governs **display**: `<img src>`, CSS backgrounds, `<image>` in an
inline SVG. It allows any HTTPS host, so a remote image renders without help.

`connect-src` governs **reading**: `fetch`, `XMLHttpRequest`, WebSockets. It
allows our own origin only. A cross-origin `fetch` fails no matter how
permissive the remote host's CORS headers are, because the browser never sends
the request.

So an image can be plainly visible on the page and still be unreadable by the
code next to it. That asymmetry is the trap.

## What to do instead

Reading bytes needs the image to arrive same-origin. Two proxies already exist,
both in `src/lib/server/image-proxy.ts`:

- `/api/admin/ref-image?id=<imageId>` for a stored image row, used by the
  ref-sheet colour picker.
- `/api/admin/avatar` for the persona avatar, used by the con card.

Both look the URL up on the server. Neither accepts a URL from the caller,
which is what keeps them from being SSRF holes. Both refuse private and
link-local hosts, decline to follow redirects, and only pass through `image/*`
content types.

If you need a third, add a lookup to `image-proxy.ts` rather than a second copy
of the hardening.

## Do not use a proxy to display an image

The proxies exist for reading, not rendering. Using one for a plain `<img>` is
wrong three times over:

- They sit under `/api`, which the hooks gate behind the admin session. A
  public page (`/connect`, the landing page) would get a redirect, not a
  picture.
- They send `Cache-Control: private, no-store`, so every view re-fetches
  through the Worker.
- `img-src` already allows the remote URL directly, and for our own storage
  `cdnImage()` gives a transformed, cached copy.

The persona avatar renders directly in four places for exactly this reason: the
admin header, the `/connect` here-now block, the stickers page, and the public
landing page. Only the con card, which embeds it, goes through the proxy.

## `storedImageSource` answers for the picker, not for you

`src/lib/server/ref-image.ts` exports `storedImageSource`, which picks a
loading strategy for a stored URL. Read its cases before reusing it: they are
written for a consumer that loads through `new Image()` and can set
`crossorigin`. Its UploadThing answer ("raw URL plus `crossorigin=anonymous`")
is correct for a canvas sampler and useless for anything using `fetch`, since
`connect-src` blocks the request before CORS is consulted.

Its `null` means "there is no way to read this URL's bytes from the page". That
is a signal to route through a proxy, not a cue to fall back to the raw URL.
Falling back to the raw URL is what shipped a convention badge with a coloured
initial where the operator's face belongs.

## How to test it

A fixture that cannot express the broken state cannot catch the bug. Every
avatar and image fixture in dev and e2e used to be same-origin, where all of
this works, so no test could tell a successful embed from a silent fallback.
The e2e seed now carries a real raster at `static/e2e-face.png`, and
`tests/e2e/con-card.spec.ts` asserts the printed sheet actually contains an
embedded image.

When you add a byte-reading path, add a case for a URL that is not same-origin.
If your harness cannot serve one, say so in the test file rather than leaving
the gap unmarked.
