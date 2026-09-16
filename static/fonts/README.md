# Fonts

Sona serves its own typefaces, so no page contacts a font CDN. That is why the
CSP lists no external `style-src` or `font-src` origin, and why the built-in
privacy policy names no font provider.

The Latin slices are fetched by `node scripts/fetch-fonts.mjs`, which asks
Google's CSS2 API for the woff2 files and their `unicode-range` subsets, then
writes them here with a sha256 per file in `manifest.json`. Every run checks
every file against that manifest and stops if the bytes no longer match, so a
re-cut upstream file never lands on the committed one. Files already on disk are
checked as the script reads them, and a fetched file is checked before it is
written. The `@font-face` blocks are not written by hand: they are generated
into `src/lib/themes/generated.css` from the `faces` arrays in
`src/lib/themes/*.theme.ts` by `npm run themes`. To add a family or a weight,
edit the theme file and the `FAMILIES` list in the fetch script, then run both.

Some families ship as one variable file per subset covering every weight.
JetBrains Mono and Nunito do, so `JetBrainsMono-latin.woff2` and
`Nunito-latin.woff2` carry no weight in their names and each face is declared
once over `400 700`. Per-weight names would put four identical binaries in the
repo for every subset of those families.

Geist is the exception. Its three files were placed here by hand and its
`@font-face` blocks live in `src/app.css`, because it is the default theme's
body font and applies whatever theme is selected.

## Licenses

All five families are under the SIL Open Font License 1.1. The license text is
in [OFL.txt](OFL.txt), which covers every font file in this directory. Copyright
lines, as each font file states them in its own name table:

- Geist: `Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)`
- JetBrains Mono: `Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)`
- Chakra Petch: `Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)`
- Nunito: `Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)`
- IBM Plex Sans JP: `Copyright 2018 IBM Corp. All rights reserved.`, released as
  `Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex"`

The IBM Plex Sans JP files here are Google Fonts' own Latin slices, unmodified.
"Plex" is a Reserved Font Name under the license, which does not allow a Modified
Version to use it. Before changing these files in any way, read OFL.txt and
rename the result.
