# Prose style for model-authored text

`AntiSlopFormatter` in `src/presentation/AntiSlopFormatter.ts` applies the §8.4 writing rules to titles, bodies, and walkthrough entries the model writes. It has two methods:

- `format(text)` makes only edits that cannot change a claim. It turns an em dash between two words into a comma. At the start of a sentence it removes filler openers followed by a comma or colon, such as `Here's the thing:` and `It's worth noting,`, sentence adverbs followed by a comma such as `Actually,`, `As an AI` openers, and whole filler sentences such as `Great job!` or `I hope this helps.` If the word left at the start is an English function word such as `the` or `this`, it is capitalized. Any other word keeps its case, because it may be an identifier such as `npm` or `x`.
- `assertStyle(text)` returns every violation in the text as a rule name and UTF-16 offsets. The rules are `em-dash`, `filler`, `self-reference`, `jargon`, `vague`, and `emoji`. `assertStyle(format(text))` lists what `format` could not fix safely, and the caller decides whether to drop the text. The formatter never rewrites those.

Neither method reads code spans, fenced code blocks at any indent, or lines indented four spaces or a tab. Indented prose inside a list item is skipped too, which errs on the side of leaving text alone. An em dash that may mark a range stays: one between two digits, and an unspaced one next to a token with a digit or before a capital, as in `v1—v3` or `Monday—Friday`. So does one at a line edge or next to punctuation. A filler opener followed by `that` stays, because `that` may begin the claim ("It turns out that way because..."). Mid-sentence filler, jargon, vague `consider` phrasing, first-person pronouns, and emoji are reported and never removed. `I` counts as first person in a contraction or before a common verb, so `Type I` passes. The `As an AI` phrases match only with that capitalization.

The upstream adverb list includes `just`, `deeply`, `inherently`, and `inevitably`, and the jargon list includes `navigate`, `unpack`, `landscape`, `moving forward`, and `on the same page`. These are left out because code review uses them literally. `At the end of the day` is reported but never removed, for the same reason. Upstream rules that need judgment, such as passive voice, three-item lists, and sentences that start with a question word, are not checked, and neither is the promotional language §8.4 bans.

## Vendored rules

The phrase lists quote [stop-slop](https://github.com/hardikpandya/stop-slop) by Hardik Pandya, which is MIT-licensed. `vendor/anti-slop/stop-slop/` holds the license and the two reference files at the commit pinned in `vendor/anti-slop/manifest.json`, byte for byte. The manifest also records each file's SHA-256. `NOTICE` carries the attribution and the license text. Nothing is downloaded or run at review time. The phrases are compiled into the formatter, and its tests check three things:

- every vendored file matches its manifest checksum, and the manifest lists every file in the directory;
- every phrase marked with a vendored source appears in that file;
- `NOTICE` names the repository and commit and includes the license.

To move to a newer upstream commit, review the diff for content that tells a model to act, check the license again, replace the files, update the commit and checksums in the manifest and `NOTICE`, and adjust the phrase list. ESLint skips `vendor/`, and `.gitattributes` stops Git from converting line endings there, so the checksums stay valid.
