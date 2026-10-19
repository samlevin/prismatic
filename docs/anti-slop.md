# Prose style for model-authored text

`AntiSlopFormatter` in `src/presentation/AntiSlopFormatter.ts` applies the §8.4 writing rules to titles, bodies, and walkthrough entries the model writes. It has two methods:

- `format(text)` makes only edits that cannot change a claim. It turns an em dash between two words into a comma. At the start of a sentence it removes filler openers such as `Here's the thing:` and `It's worth noting that`, sentence adverbs followed by a comma such as `Actually,`, `As an AI` openers, and whole filler sentences such as `Great job!` or `I hope this helps.` It then capitalizes the next word when that word is plain lowercase text, so identifiers like `npm_config` keep their case.
- `assertStyle(text)` returns every violation in the text as a rule name and UTF-16 offsets. The rules are `em-dash`, `filler`, `self-reference`, `jargon`, `vague`, and `emoji`. `assertStyle(format(text))` lists what `format` could not fix safely, and the caller decides whether to drop the text. The formatter never rewrites those.

Neither method reads code spans or fenced code blocks. An em dash between two digits stays, because it may mark a range. So does one at a line edge or next to punctuation. Mid-sentence filler, jargon, vague `consider` phrasing, first-person pronouns, and emoji are reported and never removed.

The upstream adverb list includes `just`, `deeply`, `inherently`, and `inevitably`, and the jargon list includes `navigate`, `unpack`, and `landscape`. These are left out because code review uses them literally. Upstream rules that need judgment, such as passive voice, three-item lists, and sentences that start with a question word, are not checked.

## Vendored rules

The phrase lists quote [stop-slop](https://github.com/hardikpandya/stop-slop) by Hardik Pandya, which is MIT-licensed. `vendor/anti-slop/stop-slop/` holds the license and the two reference files at the commit pinned in `vendor/anti-slop/manifest.json`, byte for byte. The manifest also records each file's SHA-256. `NOTICE` carries the attribution and the license text. Nothing is downloaded or run at review time. The phrases are compiled into the formatter, and its tests check three things:

- every vendored file matches its manifest checksum, and the manifest lists every file in the directory;
- every phrase marked with a vendored source appears in that file;
- `NOTICE` names the repository and commit and includes the license.

To move to a newer upstream commit, review the diff for content that tells a model to act, check the license again, replace the files, update the commit and checksums in the manifest and `NOTICE`, and adjust the phrase list. ESLint skips `vendor/`, and `.gitattributes` stops Git from converting line endings there, so the checksums stay valid.
