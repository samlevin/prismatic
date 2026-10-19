// Prior-head ancestry under §5.4. A fetched prior head is not proof that it
// is an ancestor of the current head. The classifier deepens commit and tree
// history without blobs, in bounded steps, until Git can answer: `ancestor`
// when the prior head is reachable from head, `rewritten` when the complete
// history shows it is not, and `unknown` when the prior head cannot be
// fetched, a deepen fails, or the step bound runs out. Unknown never counts
// as reviewed.

export type Ancestry = 'ancestor' | 'rewritten' | 'unknown';

export type AncestryReason =
  | 'reachable'
  | 'not-reachable-in-complete-history'
  | 'prior-unfetchable'
  | 'deepen-failed'
  | 'deepen-bound';

export interface AncestryProbe {
  // Fetches the prior head's commit and trees without blobs.
  fetchPrior(): Promise<boolean>;
  isAncestor(): Promise<boolean>;
  // True when the store holds the full history of both commits.
  historyComplete(): Promise<boolean>;
  // Deepens both commits by `commits` more parents, without blobs.
  deepen(commits: number): Promise<boolean>;
}

export interface AncestryOptions {
  readonly maxSteps: number;
  readonly commitsPerStep: number;
}

export interface AncestryResult {
  readonly ancestry: Ancestry;
  readonly reason: AncestryReason;
  readonly deepenSteps: number;
}

export async function classifyAncestry(
  probe: AncestryProbe,
  options: AncestryOptions,
): Promise<AncestryResult> {
  if (!(await probe.fetchPrior()))
    return { ancestry: 'unknown', reason: 'prior-unfetchable', deepenSteps: 0 };
  let steps = 0;
  for (;;) {
    if (await probe.isAncestor())
      return { ancestry: 'ancestor', reason: 'reachable', deepenSteps: steps };
    if (await probe.historyComplete())
      return {
        ancestry: 'rewritten',
        reason: 'not-reachable-in-complete-history',
        deepenSteps: steps,
      };
    if (steps >= options.maxSteps)
      return {
        ancestry: 'unknown',
        reason: 'deepen-bound',
        deepenSteps: steps,
      };
    steps += 1;
    if (!(await probe.deepen(options.commitsPerStep)))
      return {
        ancestry: 'unknown',
        reason: 'deepen-failed',
        deepenSteps: steps,
      };
  }
}
