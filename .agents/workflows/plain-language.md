---
name: plain-language
description: Style rules for text published for OTHER people to read. Load ONLY when writing or editing a PR title/description, commit message, GitHub issue body or comment, PR review comment, README/docs file, release notes, or email. NEVER load for replies to the user, progress updates, final reports, agent-to-agent handoffs, or code.
codex:
  display_name: "{{label}}: Plain language"
  short_description: "Style rules for PR bodies, issue bodies, comments, and docs"
  default_prompt: "Use ${{prefix}}plain-language before writing this text for other people."
---

# {{label}} plain language

These rules cover text that other people read: PR titles and bodies, commit messages, issue bodies and comments, review comments, docs, release notes, and email. Unless the text is for someone else, such as the users who read a release note, write for a developer who knows the repository and has little time. They read the first sentence closely and the rest only if it earns it. Give them the facts in the order they need them, in the plainest words that are still accurate, and stop when the facts run out.

## Example

A plain PR paragraph, for an invented change:

> The tracker scripts now retry a GitHub call once when it returns a 502. Before, one 502 failed the whole run and left the issue in the wrong column. The retry is in `ghRest`, which every script calls. A second 502 still fails the run and logs GitHub's error message. The new tests mock a 502 then a success, two 502s, and a 404. A 404 still fails at once, with no retry.

The same paragraph written badly. Each marker is a rule number below.

> In this PR, we'll dive into making our tracker scripts more resilient!\[1] 🚀\[15] Here's the thing:\[2] flaky GitHub responses aren't just an annoyance, they're a reliability crisis.\[3] This change introduces\[9] a robust, comprehensive, and seamless\[7]\[10] retry layer that should, in theory, make failures somewhat less likely\[5] — and, notably,\[6]\[16] it lands\[7] in `ghRest`, a helper that wraps the GitHub REST API,\[12] so every script gains retries via the shared layer, which keeps issue states accurate and also makes the whole tracker more reliable.\[8]\[9]\[11] But the real story is the tests.\[4] They cover just\[13] the cases that matter. Ready to merge?\[14]

Rules 17 and 18 work at the scale of a whole document, so one paragraph can't show them. When you add a rule, add a marked instance to the bad paragraph if one paragraph can show it.

## Rules

1. **Throat-clearing.** An opening that announces the text instead of starting it: "In this PR, we'll...", "Let's look at...", "In a world where...". Start with the subject.
2. **Label and colon.** "The fix: retry on timeout." "Here's the thing: ..." The label is scaffolding. Write the sentence: "Retrying on timeout fixes it."
3. **Contrast crutch.** "It isn't X, it's Y" sets up a claim nobody made so it can knock it down. Say Y.
4. **Teaser.** "But the real story is...", "Here's where it gets interesting." Fake suspense that delays the point. Give the facts in order.
5. **Hedging.** Qualifiers piled on one claim, such as "should, in theory, be somewhat faster", leave the reader nothing to act on. State what you measured ("this halves the run time"), or say you haven't measured it.
6. **Filler.** Words the sentence would mean the same without. Some frame the subject instead of naming it ("when it comes to", "in terms of", "in this day and age"). Some point at the text itself ("as we can see", "as mentioned above", "to summarize", "in conclusion"). Some flag interest or importance ("interestingly", "notably", "it's worth noting that"). Some put a claim in someone else's mouth ("one might argue"), and some vouch for sincerity ("honestly", "to be honest", "the honest answer"). Delete them. In place of "furthermore", "moreover", and "additionally", use "and" or "also", or begin the next sentence with its subject. If several paragraphs open with "However" or another connective, cut the connective.
7. **Inflated words.** A grand word where a plain one is accurate. See [Words](#words).
8. **Sprawl.** One sentence that chains clauses with "which", "and", "so", and "but", each qualifying the last. Put one idea in each sentence. Join two only when the link between them is the point.
9. **Missing actor.** A person's work told without the person. The artifact acts ("this PR introduces", "your tests shaped ours"), the thing that changed becomes the subject while the doer hides in a phrase ("every script gains retries via the shared layer"), or the sentence goes passive ("a retry was added"). Make the doer the subject and the deed the verb: "I added a retry to `ghRest`." Or state the new state with no event: "`ghRest` retries once." A tool doing its own job is a fine subject: "the parser rejects malformed input." Name things directly too: "our new tests", not "the ones that merged". Naming the doer makes a claim clear. It is not a reason to tell the story of the work, which [PR bodies and commit messages](#pr-bodies-and-commit-messages) leaves out.
10. **Forced symmetry.** Three adjectives in a row, a list padded or trimmed to a tidy count such as three or five, sections cut to equal length, every bullet opening the same way, bullets for what is one sentence. Facts are uneven. Let each list be as long as its facts.
11. **Restatement.** Saying a thing twice: a lead sentence that sums up its paragraph, a first line that repeats its heading, a clause that repeats its sentence's opening. If deleting a phrase loses no information, delete it:

    > ~~Failures are visible now too.~~ A startup failure used to print to the server log and leave a half-booted dialog that looked ready. It now raises, the user gets an error toast and a red status dot, and the dialog stays editable.

    Prefer the shorter wording of the same fact: "nothing new needs specifying", not "there is nothing new to learn and nothing new to specify". A summary belongs at the top of a long document, not at the top of each paragraph.
12. **Explaining the known.** Defining a term the reader uses daily, spelling out an inference they make at once, describing a practice they take for granted. Decide who the reader is, then cut what they would skim.
13. **"Just".** "It's just a wrapper", "it just works". Delete it. When the limit matters, "only" is clearer.
14. **Closing flourish.** A rhetorical question or a one-line moral at the end. End on the last fact.
15. **Decoration.** Emoji, bold or italics for emphasis in running text, and non-ASCII symbols such as arrows. Write `->` when you need an arrow. Bold labels at the start of list items are fine.
16. **Splices.** Em dashes, ` - ` or ` -- ` used the same way, and semicolons or colons that join two clauses. Split the sentence or rebuild it. A colon that introduces a list or an example is fine.
17. **Even texture.** Paragraphs that all follow one template, and sentences that all run about twenty words. Let length follow content. A section with two facts gets two sentences.
18. **False depth.** Text that sounds thorough without adding facts: an "it depends" that never says on what, a list of considerations every reader already has in mind, or the problem told again in bigger words. Replace it with the measurement, the failing input, or the decision you made.

## Words

Use the most ordinary word that is still accurate. These come up most often:

| Instead of | Write |
| --- | --- |
| bolster, enhance, elevate | strengthen, improve |
| comprehensive, holistic | complete, whole, or cut it |
| crucial, pivotal, vital | important, or say why it matters |
| delve into | look at, read |
| empower, enable (a person) | let |
| ensure | make sure, or name the check that does it |
| facilitate | help |
| foster | encourage |
| harness, leverage, utilize | use |
| invariant | rule, guarantee, unless nothing plainer is accurate |
| journey, landscape, realm, tapestry | name what you mean |
| land, landed (metaphorical) | merged, pushed, released, appears |
| load-bearing and other `-bearing` words | required, or say what depends on it |
| minted (metaphorical) | created, generated |
| myriad, plethora | many |
| navigate (metaphorical) | handle, or say what you did |
| nuanced | say which distinction matters, or delete it |
| robust | reliable, or say what it survives |
| seamless, seamlessly | smooth, or cut it |
| shape (structure or influence) | structure, format, or what happened: copied, adapted. A geometric or array shape is fine. |
| streamline | simplify |
| surface (verb) | show, report, raise |
| testament to | shows |
| underscore | show, stress |

## PR bodies and commit messages

A PR body or commit message states the change, the reason for it, the decisions a reviewer should check, the open findings, and the validation results. It leaves out the delivery history: how the evidence was gathered, the order the work was done in, and who raised what during review. Write the fact that the history points to. "The parser reads both totals correctly" replaces "In both dev runs, the parser read the right numbers". "`parseRow` accepts a negative score" replaces "The reviewer raised three low findings that I left for follow-up", with one line for each open finding. A before-and-after statement of behavior, such as "Before, one 502 failed the whole run", is a fact about the defect and stays.

## Docs and code comments

Docs, READMEs, guides, specs, agent instructions, wiki pages, and code comments describe the current state: what exists, and how to set it up, bootstrap, deploy, and run it. They are not a log of problems and fixes, and they are not ordered by when things happened. Write how it works, not how it came to work that way: "`ghRest` retries once on a 502", not "`ghRest` now retries, because a 502 used to fail the run". Change history goes in PR bodies, commit messages, and changelogs, where the example above belongs. A code comment may keep prior context only to explain an established regression the code must not reintroduce.

## Format

Don't hard-wrap text. Write each paragraph as one line and let the display wrap it. Put code symbols in backticks: function and package names, parameters, file paths, commands, and literal syntax.
