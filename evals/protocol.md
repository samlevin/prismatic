# Evaluation protocol

Protocol version 1. This page defines the labeled history format, how histories are labeled and checked, the quality and lifecycle metrics that labeled runs are scored on, the interval method, and the cost accounting. [Not yet defined](#not-yet-defined) lists the §16.2 measures this version leaves to later slices. The pilot corpus (P0.11a), the release corpus (P0.11b) and the release gates (P8.1) all use these definitions. Changing a definition after a run has been scored makes a new protocol version, and every variant is scored again under it.

The code in `evals/lib/` implements each definition, so a metric here and its computation cannot disagree:

| File | What it implements |
| --- | --- |
| `history.ts` | The history format and its checks |
| `corpus.ts` | Loading a corpus directory and the pilot requirements |
| `metrics.ts` | Scoring runs and aggregating them per variant |
| `intervals.ts` | The interval methods |
| `cost.ts` | Cost accounting |

## Labeled histories

A history is one synthetic pull request reviewed over one or more rounds. Each is a JSON file named `<id>.json`. Following §16.2, a history keeps four kinds of content apart:

- `source`: the base tree and, per round, the changed files (full new content, or `null` for a deletion), the trigger (`opened`, `synchronize`, `force-push`), and the author actions taken before that round is reviewed. The only action so far is `dismiss`.
- `labels`: the defects and decoys, who labeled them, and the second person's check.
- `expected`: per round, the coverage the labeler expects, the paths policy excludes, whether the round needs a model call, which defects should first be published, and which findings should be fixed, persist or be dismissed.
- Nothing else. Mock model responses for deterministic tests live with those tests, never in a labeled history; the parser refuses unknown keys, including `mockResponses`.

File content is stored as an array of lines, so line N is element N-1 and a label's line numbers can be read directly.

A defect label records its severity, category and failure mode from the closed §8.1 taxonomy; the round that introduced it; the round that fixed it, if any; its location; the required evidence; whether that evidence is eligible and available; and a one-sentence summary. Every location names a round (0 is the base), a line range, and marker text that must appear in those lines. The parser rejects a label whose lines do not exist in that round or do not contain the marker, so edits to the source cannot leave labels pointing at the wrong code.

Eligible means the required evidence lies in source the §5.1 policy admits. Available means it also fits the declared byte and file caps. Both are decided from the labels before any run. An ineligible defect is never available, and its path must be listed as excluded in its introduction round. A defect whose evidence the planner fails to retrieve is a miss, never unavailable.

A decoy marks code that invites a plausible but wrong finding. Decoys are diagnostics. A published finding is false whether or not it hits a decoy.

Scenario tags (`correct-high-severity`, `false-positive`, `incremental-fix`, `partial-fix`, `dismissed-finding`, `unreviewable-change`, `late-round-regression`, `clean-pr`, `cross-file`) are checked against the labels. For example, `clean-pr` requires no defects and `late-round-regression` requires an eligible, available defect introduced at round 6 or later.

## Provenance, licensing and secrets

Every history records its origin, author, creation date, license and notes. The pilot holds synthetic code only, written for this corpus and licensed MIT with the repository. Synthetic credential examples are allowed; real credentials and unauthorized private code are not. The pilot test runs the repository's credential patterns over every file in every round, the pull request text and the labels, and fails on any match.

## Labeling and checking

1. One person labels a history: defects, decoys, eligibility and availability, introduction and fix rounds, and the expected behavior per round. The labeler is recorded in `labels.labeledBy`.
2. A second person checks the labels and records `confirmed` or `amended` in `labels.check` with their GitHub login, the date and notes. The checker cannot be the labeler (compared without case), and cannot be an agent: the parser refuses a checker that starts with `agent:`. Until then the check is `pending`.
3. Scoring refuses a history whose check is pending. A run that only looks for implementation problems, such as the P0.12 pilot, may pass `allowPendingChecks`; its numbers are never reported as quality results.
4. Labels are frozen before the variant they score is run. Nobody who labels or checks a history sees that variant's output first.
5. After a run, a person adjudicates each published finding: which labeled defect it matches, if any, and whether its `introducedBy` supports the causal claim. The scorer never matches findings itself.

The pilot (P0.11a) uses one labeler and one checker. The release corpus (P0.11b) needs two independent labelers per history and adjudication of their disagreements before any variant is scored.

**Causality rule.** A finding on old code whose `introducedBy` cites a structurally valid but unrelated changed line is a false finding. Structural resolution is necessary, not sufficient.

## Metrics

A run is one variant reviewing every round of one history once. The scorer refuses a run that skips rounds, names unknown defects or findings, or omits a funnel record for an eligible, available defect. A variant must have at least one run of every history in the corpus, so dropping a hard history cannot raise its score.

A published finding is **true** when it matches a labeled defect, its causality is supported, the defect is present in that round (introduced at or before it and not yet fixed), and no earlier finding in the run already matched that defect. A later finding that matches an already credited defect is a **duplicate**. Every other published finding is **false**. Severe means `high` or `critical`.

| Metric | Numerator | Denominator | Use |
| --- | --- | --- | --- |
| Precision | True published findings | All published findings | Gate: at least 90% |
| Severe precision | True findings published as severe | Findings published as severe | Gate: at least 95% |
| Severe recall | Severe defects found | Severe defects that are eligible and available | Gate: at least 85% |
| End-to-end severe recall | Severe defects found | Every severe defect, including ineligible and unavailable ones | Reported next to severe recall, so policy and cap omissions stay visible |
| Retrieval miss | Defects in the severe recall denominator whose evidence was not retrieved | Same denominator | Gate: at most 10%, preregistered |
| R2+, R6+, R12+ severe recall | Severe recall restricted to defects introduced at or after that round | Per bucket | R2+ feeds the convergence gate; R6+ and R12+ are reported with counts and intervals, never gated and never folded into R2+ |
| False findings per PR | False published findings | All histories | Reported |
| Clean-PR false findings | False published findings on histories with no defects | Clean histories | Gate: at most 0.2 per PR |
| False `fixed` | `fixed` transitions on a causally supported finding whose defect is still present | Count | Gate: zero |
| Dismissed resurfacing | Findings matching a defect, published in or after the round the author dismissed it, when the run had already published a causally supported finding for that defect before the dismissal | Count | Gate: zero |
| Duplicates | Duplicate findings | Count | Gate: zero |
| Unneeded inference | Rounds the labels mark as needing no model call in which a reviewer request was sent | Count | Gate: zero |

The thresholds are the §16.2 release thresholds. They apply to the release corpus under P8.1. The pilot has no thresholds.

A defect the run never published before the author's dismissal cannot resurface; finding it later is an ordinary find. §16.2 allows a dismissed finding back when new causal evidence arrives. The labels encode that case: a history may not expect a dismissed defect to be published again, so a labeled dismissal asserts that no later round brings new causal evidence for it.

**Strata.** Per-language and per-severity results are the same metrics scored on the histories of one language, or restricted to defects of one severity. Each is reported with its counts and interval.

Every labeled defect is reported along the funnel with the first stage it failed:

1. Eligible, from the labels.
2. Available, from the labels.
3. Retrieved: the run's record says the required evidence reached the prompt.
4. Discovered: the run's record says a raw candidate matched the defect before validation.
5. Published: a true finding matched it.

A defect marked found must also be marked retrieved and discovered, or the scorer refuses the run.

**Paired comparisons.** Against a control such as the cumulative-diff variant, a paired case is a severe, eligible, available defect introduced at round 2 or later. A loss is a case the control found and the variant missed. The reported bound on recall loss is the exact one-sided 95% upper bound on losses over pairs. Gains are not netted against losses, so the bound is conservative. With no losses it is about 3/n: 30 pairs bound the loss near 10 points, and a 3-point bound needs on the order of 100 pairs.

## Intervals

Histories are the unit of uncertainty. When a variant runs a history more than once, the history's counts are averaged over its runs before anything is pooled, so repeated runs never count as independent examples.

- **Proportions** (precision, recall, retrieval miss, buckets). The point estimate is the pooled ratio of the averaged counts. The interval is the union of two 95% intervals. The first is the two-sided exact (Clopper-Pearson) interval, rounding averaged counts outward when they are fractional. The second is a history-cluster percentile bootstrap: draw as many histories as there are, with replacement, keep every finding and defect of a drawn history together, and take the 2.5th and 97.5th percentiles of the resampled ratio. The exact interval holds at small n and at 0 or 100%. The bootstrap widens it when findings within a history move together. The union keeps the weaker of the two.
- **Per-PR rates** (clean-PR false findings). The union of the exact Poisson (Garwood) interval on the total count divided by the number of histories, and the history-cluster bootstrap of the mean.
- **Cost and latency per PR.** Mean with a history-cluster bootstrap interval, plus the median and 95th percentile by nearest rank.
- **Paired loss.** The one-sided exact bound above.

The bootstrap uses 10,000 resamples and seed 20261019, so a report reproduces exactly. A metric with no denominator is reported as having no data, never as zero or 100%. Every reported value carries its numerator, denominator and number of contributing histories.

## Cost accounting

Every inference request a run sends is billed: discovery, finding assessment and verification, including retries and failed or uncertain attempts.

- A request with reported usage costs uncached input, cache writes, cached reads and output, each at its own per-million rate (§9.5). Uncached input is input minus cached minus written tokens. Reasoning tokens are part of output and are not billed twice.
- A request with no reported usage is charged its full pre-request reservation, never zero, and the run's usage is marked incomplete.
- A request refused for budget before sending costs nothing and is counted separately.
- Judge and curation requests go to a separate research ledger. They never count as reviewer cost.

Reports give the reviewer dollars per PR and per round (a history's reviewer dollars divided by its number of rounds, averaged over runs), the failed-attempt spend inside that total, the research spend, and whether usage was complete. Cache economics are reported as cached read tokens over cache-written tokens. Caching pays for its write premium once that share exceeds `(write rate - input rate) / (input rate - cached rate)`, 26.3% at the §9.5 rates. Dollars per found defect is undefined when nothing was found. A saving claimed against a control needs lower total measured cost on histories with equivalent coverage and lifecycle outcomes. Fewer tokens alone are not a saving.

## Not yet defined

These §16.2 measures need labels or run records that version 1 does not have. P0.11b and P8.1 add them, as a new protocol version where a definition changes:

- Unauthorized suppression, and missed discovery in a seeded deletion-only case. Both need a deletion-only scenario and suppression records in the run observation.
- Strata by PR size, dependency depth and change type, and the weighted target-workload result. The history format has no fields for them yet.
- The deterministic-replay checks in the convergence table, such as repeated paid assessment on an unchanged baseline and pending work lost after truncation. They run in the offline lifecycle fixtures, not on labeled runs.
- Developer burden per history: repeated findings, stale open findings after an evidenced fix, manual commands needed, and time from a valid fix to its acknowledgement.

## Live runs

Ordinary CI is offline. The tests here read only committed files and never call a model or GitHub. A live run needs an explicit evaluation budget and controlled credentials, and records model IDs, prompt versions, context selection, provider usage and cache age next to its results.

## The pilot corpus

`evals/labeled/pilot/` holds 10 histories in TypeScript, Python and Go. They cover a correct high-severity finding, a false positive, an incremental fix, a partial fix, a dismissed finding, an unreviewable change, a late-round regression and two clean pull requests. [The pilot README](labeled/pilot/README.md) lists them and their check status.

The pilot exists to find implementation and contract problems, for P0.12 (#146) in particular. It supports no quality claim. Ten histories cannot estimate any rate closely, and P0.12 need not meet the release thresholds on them.
