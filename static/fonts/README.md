# Fonts

Sona serves its own typefaces. No page contacts a font CDN, which is why the
CSP lists no external `style-src` or `font-src` origin and the built-in privacy
policy names no font provider.

The Latin slices are fetched by `node scripts/fetch-fonts.mjs`, which asks
Google's CSS2 API for the woff2 files and their `unicode-range` subsets, then
writes them here. The `@font-face` blocks are not written by hand: they are
generated into `src/lib/themes/generated.css` from the `faces` arrays in
`src/lib/themes/*.theme.ts` by `npm run themes`. To add a family or a weight,
edit the theme file and the `FAMILIES` list in the fetch script, then run both.

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
| `IBMPlexSansJP-400-kana.woff2` | kana, CJK punctuation, fullwidth forms | 167,428 | 409 |
| `IBMPlexSansJP-400-kanji.woff2` | JIS X 0208 level 1 | 482,744 | 2,965 |
| `IBMPlexSansJP-700-kana.woff2` | kana, CJK punctuation, fullwidth forms | 168,568 | 409 |
| `IBMPlexSansJP-700-kanji.woff2` | JIS X 0208 level 1 | 498,892 | 2,965 |

That is 1.26 MiB in four files instead of 2.5 MiB in 246. Weights are 400 and
700 only; a browser asked for 500 or 600 picks the nearer one. The kanji set is
JIS X 0208 level 1, derived from Python's `euc_jp` codec over JIS rows 16-47
rather than from a bundled list — see the script. Level 2 (3,390 rarer kanji)
falls back to the reader's system font, as does any kanji outside level 1.

The script pins the source by version and sha256, and it needs Python: it builds
a throwaway virtualenv with `fonttools` and `brotli` in the OS temp directory.
Node stays the only thing you need to build Sona — these four files are
committed, so a normal build never runs the subsetter.

## Licenses

All four families are under the SIL Open Font License 1.1
(<https://openfontlicense.org>). Copyright lines as the upstream projects state
them:

- Geist: `Copyright 2023 Vercel, in collaboration with basement.studio`
- JetBrains Mono: `Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)`
- Chakra Petch: `Copyright 2018 The Chakra Petch Project Authors (https://github.com/cadsondemak/Chakra-Petch)`
- IBM Plex Sans JP: `Copyright 2017 IBM Corp. (https://github.com/IBM/plex)`
