# Fonts

Sona serves its own typefaces, so no page contacts a font CDN. That is why the
CSP lists no external `style-src` or `font-src` origin, and why the built-in
privacy policy names no font provider.

The Latin slices are fetched by `node scripts/fetch-fonts.mjs`, which asks
Google's CSS2 API for the woff2 files and their `unicode-range` subsets, then
writes them here with a sha256 per file in `manifest.json` — the next run
re-checks it, so bytes that move under the same URL stop the fetch. The
`@font-face` blocks are not written by hand: they are generated into
`src/lib/themes/generated.css` from the `faces` arrays in
`src/lib/themes/*.theme.ts` by `npm run themes`. To add a family or a weight,
edit the theme file and the `FAMILIES` list in the fetch script, then run both.

Some families ship as one variable file per subset covering every weight.
JetBrains Mono does, so `JetBrainsMono-latin.woff2` carries no weight in its
name and its face is declared once over `400 700`; a per-weight name there meant
four identical binaries in the repo.

Geist is the exception. Its three files were placed here by hand and its
`@font-face` blocks live in `src/app.css`, because it is the default theme's
body font and applies whatever theme is selected.

## Japanese

Terracotta sets body text in IBM Plex Sans JP, so it needs real Japanese
coverage. Google serves that coverage as 123 unnamed slices per weight — 2.5 MiB
of binaries and roughly 295 KB of `unicode-range` text in a stylesheet every
visitor downloads, whatever theme they are on. So the Japanese side is cut from
the upstream release instead, by `node scripts/subset-plex-jp.mjs`:

| file | covers | bytes | cmap entries |
| --- | --- | --- | --- |
| `IBMPlexSansJP-400-kana.woff2` | kana, CJK punctuation, fullwidth forms | 167,432 | 409 |
| `IBMPlexSansJP-400-kanji.woff2` | JIS X 0208 level 1 | 482,892 | 2,965 |
| `IBMPlexSansJP-700-kana.woff2` | kana, CJK punctuation, fullwidth forms | 168,724 | 409 |
| `IBMPlexSansJP-700-kanji.woff2` | JIS X 0208 level 1 | 498,900 | 2,965 |

That is 1.26 MiB in four files instead of 2.5 MiB in 246. Weights are 400 and
700 only; a browser asked for 500 or 600 picks the nearer one. The kanji set is
JIS X 0208 level 1, derived from Python's `euc_jp` codec over JIS rows 16-47
rather than from a bundled list — see the script. Level 2 (3,390 rarer kanji)
falls back to the reader's system font, as does any kanji outside level 1.

The script pins the source by version and sha256, and installs the pinned,
hash-checked `fonttools` and `brotli` from `scripts/requirements-subset.txt`. It
needs Python: it builds a throwaway virtualenv in the OS temp directory. Node
stays the only thing you need to build Sona — these four files are committed, so
a normal build never runs the subsetter.

## Licenses

All four families are under the SIL Open Font License 1.1. The license text is
in [OFL.txt](OFL.txt), which covers every font file in this directory. Copyright
lines, as each font file states them in its own name table:

- Geist: `Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)`
- JetBrains Mono: `Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)`
- Chakra Petch: `Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)`
- IBM Plex Sans JP: `Copyright 2018 IBM Corp. All rights reserved.`, released as
  `Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex"`

The Japanese files are glyph-set subsets cut from IBM's own release. They keep
the family name, as the Google Fonts distribution of the same family does, and
the subsetter keeps the license name records (IDs 13 and 14) in them. "Plex" is
a Reserved Font Name, and the license does not allow a Modified Version to use
it. Before changing these files in any way beyond subsetting, read OFL.txt and
rename the result.
