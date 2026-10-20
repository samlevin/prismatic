// The labeled history format that evals/protocol.md defines. A history keeps
// four things apart, as §16.2 requires: the synthetic source the reviewer
// sees (`source`), the defects and decoys a person labeled (`labels`), the
// behavior the labeler expects in each round (`expected`), and nothing else.
// Mock model responses for deterministic tests never live in a labeled
// history; an unknown key, including `mockResponses`, is refused.
//
// parseHistory checks the shape and every cross-reference: each label must
// point at lines that exist in the round it names and contain its marker
// text, and the expected behavior must agree with the labels.
import { normalizeRepoPath } from '../../src/shared/path.ts';
import { severities, type Severity } from '../../src/shared/severity.ts';

export const historySchemaVersion = 1;

// The first round whose defects count as late (the §16.2 R6+ bucket).
export const lateRound = 6;

export const languages = ['typescript', 'javascript', 'python', 'go'] as const;
export type Language = (typeof languages)[number];

export const categories = [
  'correctness',
  'quality',
  'tests',
  'security',
] as const;
export type Category = (typeof categories)[number];

// The closed §8.1 failure-mode taxonomy, by category. `other` belongs to all.
export const failureModes: Readonly<Record<Category, readonly string[]>> = {
  correctness: [
    'logic-error',
    'null-or-undefined-access',
    'off-by-one-or-bounds',
    'race-or-concurrency',
    'missing-await-or-unhandled-promise',
    'error-swallowed-or-mishandled',
    'resource-leak',
    'state-or-invariant-violation',
    'breaking-api-change',
    'data-loss-or-corruption',
    'incorrect-type-or-cast',
    'dead-or-unreachable-code',
    'purpose-mismatch',
  ],
  quality: [
    'duplicated-logic',
    'misleading-name-or-comment',
    'overly-complex-control-flow',
    'missing-input-validation',
    'fragile-dependency-on-implementation-detail',
  ],
  tests: [
    'missing-test-for-changed-behavior',
    'test-does-not-assert',
    'test-depends-on-order-or-time',
    'test-disabled-or-skipped',
  ],
  security: [
    'injection',
    'authz-or-trust-boundary',
    'secret-exposure',
    'unsafe-deserialization-or-eval',
    'insecure-crypto-or-random',
    'path-traversal-or-ssrf',
  ],
};

// Scenario tags. Each tag has a rule in checkScenarios, so a history cannot
// claim a scenario its labels do not contain.
export const scenarios = [
  'correct-high-severity',
  'false-positive',
  'incremental-fix',
  'partial-fix',
  'dismissed-finding',
  'unreviewable-change',
  'late-round-regression',
  'clean-pr',
  'cross-file',
] as const;
export type Scenario = (typeof scenarios)[number];

export const coverages = ['complete', 'partial', 'none'] as const;
export type Coverage = (typeof coverages)[number];

export const triggers = ['opened', 'synchronize', 'force-push'] as const;
export type Trigger = (typeof triggers)[number];

export const transitionStatuses = ['fixed', 'persists', 'dismissed'] as const;
export type TransitionStatus = (typeof transitionStatuses)[number];

// A file's content as lines, without line terminators. Line N is index N-1.
export type FileLines = readonly string[];
export type FileTree = ReadonlyMap<string, FileLines>;

export interface Provenance {
  readonly origin: 'synthetic';
  readonly author: string;
  readonly createdOn: string;
  readonly license: string;
  readonly notes: string;
}

export interface DismissAction {
  readonly kind: 'dismiss';
  readonly defect: string;
  readonly reason: string;
}

export interface SourceRound {
  readonly number: number;
  readonly trigger: Trigger;
  readonly message: string;
  // Author actions taken after the previous round's review and before this
  // round is reviewed.
  readonly actions: readonly DismissAction[];
  // New content per path; null deletes the path.
  readonly changes: ReadonlyMap<string, FileLines | null>;
}

export interface Location {
  readonly path: string;
  // 0 is the base.
  readonly round: number;
  readonly startLine: number;
  readonly endLine: number;
  // Text that must appear in one of the lines, so a label cannot silently
  // drift when the source is edited.
  readonly marker: string;
}

export interface DefectLabel {
  readonly id: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly failureMode: string;
  readonly introducedRound: number;
  readonly fixedRound: number | null;
  readonly location: Location;
  readonly requiredEvidence: readonly Location[];
  // Decided before any run. Eligible: the evidence lies in source the §5.1
  // policy admits. Available: it fits the declared byte and file caps.
  readonly eligible: boolean;
  readonly available: boolean;
  readonly summary: string;
}

// Code that invites a plausible but wrong finding.
export interface DecoyLabel {
  readonly id: string;
  readonly location: Location;
  readonly summary: string;
}

export type LabelCheck =
  | { readonly status: 'pending' }
  | {
      readonly status: 'confirmed' | 'amended';
      readonly by: string;
      readonly on: string;
      readonly notes: string;
    };

export interface Labels {
  readonly labeledBy: string;
  readonly labeledOn: string;
  readonly check: LabelCheck;
  readonly defects: readonly DefectLabel[];
  readonly decoys: readonly DecoyLabel[];
}

export interface ExpectedTransition {
  readonly defect: string;
  readonly status: TransitionStatus;
}

export interface ExpectedRound {
  readonly round: number;
  readonly coverage: Coverage;
  readonly excludedPaths: readonly string[];
  // Whether the round needs a model call at all.
  readonly inference: boolean;
  // Defects first published in this round.
  readonly publish: readonly string[];
  readonly transitions: readonly ExpectedTransition[];
}

export interface LabeledHistory {
  readonly schemaVersion: typeof historySchemaVersion;
  readonly id: string;
  readonly title: string;
  readonly language: Language;
  readonly provenance: Provenance;
  readonly scenarios: readonly Scenario[];
  readonly pullRequest: { readonly title: string; readonly body: string };
  readonly source: {
    readonly base: FileTree;
    readonly rounds: readonly SourceRound[];
  };
  readonly labels: Labels;
  readonly expected: readonly ExpectedRound[];
}

export class HistoryError extends Error {
  readonly at: string;

  constructor(at: string, message: string) {
    super(`${at}: ${message}`);
    this.name = 'HistoryError';
    this.at = at;
  }
}

// Each shape reader takes the JSON path for its error messages.

type Json = Record<string, unknown>;

function object(value: unknown, at: string, keys: readonly string[]): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HistoryError(at, 'must be an object');
  }
  const record = value as Json;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new HistoryError(at, `unknown key ${key}`);
  }
  for (const key of keys) {
    if (!(key in record)) throw new HistoryError(at, `missing key ${key}`);
  }
  return record;
}

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HistoryError(at, 'must be a non-empty string');
  }
  return value;
}

function line(value: unknown, at: string): string {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new HistoryError(at, 'must be a string without line breaks');
  }
  return value;
}

function date(value: unknown, at: string): string {
  const result = text(value, at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new HistoryError(at, 'must be a YYYY-MM-DD date');
  }
  return result;
}

function bool(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean')
    throw new HistoryError(at, 'must be true or false');
  return value;
}

function positive(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HistoryError(at, 'must be a positive integer');
  }
  return value;
}

// A round number, or 0 for the base before the first round.
function roundOrBase(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HistoryError(at, 'must be a round number, or 0 for the base');
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  at: string,
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new HistoryError(at, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function list(value: unknown, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new HistoryError(at, 'must be an array');
  return value;
}

function identifier(value: unknown, at: string): string {
  const result = text(value, at);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) {
    throw new HistoryError(at, 'must be lowercase words joined by hyphens');
  }
  return result;
}

function repoPath(value: unknown, at: string): string {
  try {
    return normalizeRepoPath(value);
  } catch (error) {
    throw new HistoryError(at, (error as Error).message);
  }
}

function lines(value: unknown, at: string): FileLines {
  return list(value, at).map((entry, index) => line(entry, `${at}[${index}]`));
}

function unique(values: readonly string[], at: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new HistoryError(at, `repeats ${value}`);
    seen.add(value);
  }
}

function fileMap(
  value: unknown,
  at: string,
  allowDelete: boolean,
): Map<string, FileLines | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HistoryError(at, 'must be an object of paths');
  }
  const result = new Map<string, FileLines | null>();
  for (const [key, content] of Object.entries(value)) {
    const path = repoPath(key, `${at}.${key}`);
    if (content === null && allowDelete) result.set(path, null);
    else result.set(path, lines(content, `${at}.${key}`));
  }
  return result;
}

function readProvenance(value: unknown, at: string): Provenance {
  const record = object(value, at, [
    'origin',
    'author',
    'createdOn',
    'license',
    'notes',
  ]);
  return {
    origin: oneOf(record['origin'], ['synthetic'], `${at}.origin`),
    author: text(record['author'], `${at}.author`),
    createdOn: date(record['createdOn'], `${at}.createdOn`),
    license: text(record['license'], `${at}.license`),
    notes: text(record['notes'], `${at}.notes`),
  };
}

function readRound(value: unknown, at: string): SourceRound {
  const record = object(value, at, [
    'number',
    'trigger',
    'message',
    'actions',
    'changes',
  ]);
  const actions = list(record['actions'], `${at}.actions`).map(
    (entry, index): DismissAction => {
      const where = `${at}.actions[${index}]`;
      const action = object(entry, where, ['kind', 'defect', 'reason']);
      return {
        kind: oneOf(action['kind'], ['dismiss'], `${where}.kind`),
        defect: identifier(action['defect'], `${where}.defect`),
        reason: text(action['reason'], `${where}.reason`),
      };
    },
  );
  return {
    number: positive(record['number'], `${at}.number`),
    trigger: oneOf(record['trigger'], triggers, `${at}.trigger`),
    message: text(record['message'], `${at}.message`),
    actions,
    changes: fileMap(record['changes'], `${at}.changes`, true),
  };
}

function readLocation(value: unknown, at: string): Location {
  const record = object(value, at, [
    'path',
    'round',
    'startLine',
    'endLine',
    'marker',
  ]);
  return {
    path: repoPath(record['path'], `${at}.path`),
    round: roundOrBase(record['round'], `${at}.round`),
    startLine: positive(record['startLine'], `${at}.startLine`),
    endLine: positive(record['endLine'], `${at}.endLine`),
    marker: text(record['marker'], `${at}.marker`),
  };
}

function readDefect(value: unknown, at: string): DefectLabel {
  const record = object(value, at, [
    'id',
    'severity',
    'category',
    'failureMode',
    'introducedRound',
    'fixedRound',
    'location',
    'requiredEvidence',
    'eligible',
    'available',
    'summary',
  ]);
  const fixed = record['fixedRound'];
  return {
    id: identifier(record['id'], `${at}.id`),
    severity: oneOf(record['severity'], severities, `${at}.severity`),
    category: oneOf(record['category'], categories, `${at}.category`),
    failureMode: text(record['failureMode'], `${at}.failureMode`),
    introducedRound: positive(
      record['introducedRound'],
      `${at}.introducedRound`,
    ),
    fixedRound: fixed === null ? null : positive(fixed, `${at}.fixedRound`),
    location: readLocation(record['location'], `${at}.location`),
    requiredEvidence: list(
      record['requiredEvidence'],
      `${at}.requiredEvidence`,
    ).map((entry, index) =>
      readLocation(entry, `${at}.requiredEvidence[${index}]`),
    ),
    eligible: bool(record['eligible'], `${at}.eligible`),
    available: bool(record['available'], `${at}.available`),
    summary: text(record['summary'], `${at}.summary`),
  };
}

function readCheck(value: unknown, at: string): LabelCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HistoryError(at, 'must be an object');
  }
  if ((value as Json)['status'] === 'pending') {
    object(value, at, ['status']);
    return { status: 'pending' };
  }
  const record = object(value, at, ['status', 'by', 'on', 'notes']);
  return {
    status: oneOf(record['status'], ['confirmed', 'amended'], `${at}.status`),
    by: text(record['by'], `${at}.by`),
    on: date(record['on'], `${at}.on`),
    notes: text(record['notes'], `${at}.notes`),
  };
}

function readLabels(value: unknown, at: string): Labels {
  const record = object(value, at, [
    'labeledBy',
    'labeledOn',
    'check',
    'defects',
    'decoys',
  ]);
  return {
    labeledBy: text(record['labeledBy'], `${at}.labeledBy`),
    labeledOn: date(record['labeledOn'], `${at}.labeledOn`),
    check: readCheck(record['check'], `${at}.check`),
    defects: list(record['defects'], `${at}.defects`).map((entry, index) =>
      readDefect(entry, `${at}.defects[${index}]`),
    ),
    decoys: list(record['decoys'], `${at}.decoys`).map((entry, index) => {
      const where = `${at}.decoys[${index}]`;
      const decoy = object(entry, where, ['id', 'location', 'summary']);
      return {
        id: identifier(decoy['id'], `${where}.id`),
        location: readLocation(decoy['location'], `${where}.location`),
        summary: text(decoy['summary'], `${where}.summary`),
      };
    }),
  };
}

function readExpected(value: unknown, at: string): ExpectedRound {
  const record = object(value, at, [
    'round',
    'coverage',
    'excludedPaths',
    'inference',
    'publish',
    'transitions',
  ]);
  return {
    round: positive(record['round'], `${at}.round`),
    coverage: oneOf(record['coverage'], coverages, `${at}.coverage`),
    excludedPaths: list(record['excludedPaths'], `${at}.excludedPaths`).map(
      (entry, index) => repoPath(entry, `${at}.excludedPaths[${index}]`),
    ),
    inference: bool(record['inference'], `${at}.inference`),
    publish: list(record['publish'], `${at}.publish`).map((entry, index) =>
      identifier(entry, `${at}.publish[${index}]`),
    ),
    transitions: list(record['transitions'], `${at}.transitions`).map(
      (entry, index) => {
        const where = `${at}.transitions[${index}]`;
        const transition = object(entry, where, ['defect', 'status']);
        return {
          defect: identifier(transition['defect'], `${where}.defect`),
          status: oneOf(
            transition['status'],
            transitionStatuses,
            `${where}.status`,
          ),
        };
      },
    ),
  };
}

// The files at the end of a round; round 0 is the base.
export function treeAtRound(history: LabeledHistory, round: number): FileTree {
  if (
    !Number.isInteger(round) ||
    round < 0 ||
    round > history.source.rounds.length
  ) {
    throw new RangeError(`Round ${round} is not in history ${history.id}.`);
  }
  const tree = new Map(history.source.base);
  for (const step of history.source.rounds.slice(0, round)) {
    for (const [path, content] of step.changes) {
      if (content === null) tree.delete(path);
      else tree.set(path, content);
    }
  }
  return tree;
}

function checkLocation(
  trees: readonly FileTree[],
  location: Location,
  at: string,
): void {
  const tree = trees[location.round];
  if (tree === undefined) {
    throw new HistoryError(at, `round ${location.round} does not exist`);
  }
  const content = tree.get(location.path);
  if (content === undefined) {
    throw new HistoryError(
      at,
      `${location.path} does not exist at round ${location.round}`,
    );
  }
  if (
    location.startLine > location.endLine ||
    location.endLine > content.length
  ) {
    throw new HistoryError(
      at,
      `lines ${location.startLine}-${location.endLine} are outside ${location.path} (${content.length} lines)`,
    );
  }
  const span = content.slice(location.startLine - 1, location.endLine);
  if (!span.some((entry) => entry.includes(location.marker))) {
    throw new HistoryError(at, 'marker text is not in the labeled lines');
  }
}

function checkSource(history: LabeledHistory): FileTree[] {
  const rounds = history.source.rounds;
  if (rounds.length === 0)
    throw new HistoryError('source.rounds', 'must not be empty');
  const trees: FileTree[] = [treeAtRound(history, 0)];
  rounds.forEach((round, index) => {
    const at = `source.rounds[${index}]`;
    if (round.number !== index + 1) {
      throw new HistoryError(at, `must be round ${index + 1}`);
    }
    if (index === 0 && round.trigger !== 'opened') {
      throw new HistoryError(at, 'the first round must be opened');
    }
    if (index > 0 && round.trigger === 'opened') {
      throw new HistoryError(at, 'only the first round is opened');
    }
    const before = trees[index] as FileTree;
    for (const [path, content] of round.changes) {
      if (content === null && !before.has(path)) {
        throw new HistoryError(
          `${at}.changes`,
          `deletes ${path}, which does not exist`,
        );
      }
    }
    trees.push(treeAtRound(history, index + 1));
  });
  return trees;
}

function checkDefect(
  history: LabeledHistory,
  trees: readonly FileTree[],
  defect: DefectLabel,
  at: string,
): void {
  const rounds = history.source.rounds.length;
  const allowed = failureModes[defect.category];
  if (defect.failureMode !== 'other' && !allowed.includes(defect.failureMode)) {
    throw new HistoryError(
      `${at}.failureMode`,
      `is not a ${defect.category} failure mode`,
    );
  }
  if (
    defect.failureMode === 'purpose-mismatch' &&
    defect.severity !== 'critical'
  ) {
    throw new HistoryError(
      `${at}.severity`,
      'purpose-mismatch is always critical',
    );
  }
  if (defect.introducedRound > rounds) {
    throw new HistoryError(`${at}.introducedRound`, 'is after the last round');
  }
  if (
    defect.fixedRound !== null &&
    (defect.fixedRound <= defect.introducedRound || defect.fixedRound > rounds)
  ) {
    throw new HistoryError(
      `${at}.fixedRound`,
      'must follow the introduction round and be a round of the history',
    );
  }
  if (defect.location.round !== defect.introducedRound) {
    throw new HistoryError(
      `${at}.location.round`,
      'must be the introduction round',
    );
  }
  checkLocation(trees, defect.location, `${at}.location`);
  if (defect.requiredEvidence.length === 0) {
    throw new HistoryError(`${at}.requiredEvidence`, 'must not be empty');
  }
  defect.requiredEvidence.forEach((location, index) => {
    if (location.round > defect.introducedRound) {
      throw new HistoryError(
        `${at}.requiredEvidence[${index}].round`,
        'must not be after the introduction round',
      );
    }
    checkLocation(trees, location, `${at}.requiredEvidence[${index}]`);
  });
  if (!defect.eligible && defect.available) {
    throw new HistoryError(
      `${at}.available`,
      'an ineligible defect is never available',
    );
  }
}

interface DefectState {
  published: number | null;
  closed: number | null;
}

function checkExpected(history: LabeledHistory): void {
  const { rounds } = history.source;
  const { defects } = history.labels;
  if (history.expected.length !== rounds.length) {
    throw new HistoryError('expected', 'must have one entry per round');
  }
  const byId = new Map(defects.map((defect) => [defect.id, defect]));
  const state = new Map<string, DefectState>(
    defects.map((defect) => [defect.id, { published: null, closed: null }]),
  );
  const known = (id: string, at: string): DefectLabel => {
    const defect = byId.get(id);
    if (defect === undefined)
      throw new HistoryError(at, `names unknown defect ${id}`);
    return defect;
  };

  history.expected.forEach((expected, index) => {
    const at = `expected[${index}]`;
    const round = rounds[index] as SourceRound;
    if (expected.round !== round.number) {
      throw new HistoryError(`${at}.round`, `must be round ${round.number}`);
    }
    unique(expected.excludedPaths, `${at}.excludedPaths`);
    for (const path of expected.excludedPaths) {
      if (!round.changes.has(path)) {
        throw new HistoryError(
          `${at}.excludedPaths`,
          `${path} is not changed in this round`,
        );
      }
    }
    if (expected.excludedPaths.length > 0 && expected.coverage === 'complete') {
      throw new HistoryError(
        `${at}.coverage`,
        'cannot be complete with excluded paths',
      );
    }
    if (!expected.inference && expected.publish.length > 0) {
      throw new HistoryError(
        `${at}.publish`,
        'a round without inference publishes nothing',
      );
    }

    const dismissed = new Set<string>();
    round.actions.forEach((action, actionIndex) => {
      const where = `source.rounds[${index}].actions[${actionIndex}]`;
      known(action.defect, where);
      const current = state.get(action.defect) as DefectState;
      if (current.published === null || current.closed !== null) {
        throw new HistoryError(
          where,
          `${action.defect} is not an open published finding`,
        );
      }
      dismissed.add(action.defect);
    });

    unique(expected.publish, `${at}.publish`);
    for (const id of expected.publish) {
      const defect = known(id, `${at}.publish`);
      const current = state.get(id) as DefectState;
      if (!defect.eligible || !defect.available) {
        throw new HistoryError(
          `${at}.publish`,
          `${id} is not eligible and available`,
        );
      }
      if (
        defect.introducedRound > round.number ||
        (defect.fixedRound !== null && defect.fixedRound <= round.number)
      ) {
        throw new HistoryError(
          `${at}.publish`,
          `${id} is not present in this round`,
        );
      }
      if (current.published !== null) {
        throw new HistoryError(`${at}.publish`, `${id} was already published`);
      }
      current.published = round.number;
    }

    unique(
      expected.transitions.map((transition) => transition.defect),
      `${at}.transitions`,
    );
    for (const transition of expected.transitions) {
      const where = `${at}.transitions`;
      const defect = known(transition.defect, where);
      const current = state.get(transition.defect) as DefectState;
      if (
        current.published === null ||
        current.published >= round.number ||
        current.closed !== null
      ) {
        throw new HistoryError(
          where,
          `${transition.defect} is not an open finding from an earlier round`,
        );
      }
      if (transition.status === 'dismissed') {
        if (!dismissed.has(transition.defect)) {
          throw new HistoryError(
            where,
            `${transition.defect} has no dismiss action this round`,
          );
        }
        current.closed = round.number;
        continue;
      }
      if (!expected.inference) {
        throw new HistoryError(where, 'assessing a finding needs inference');
      }
      if (transition.status === 'fixed') {
        if (defect.fixedRound !== round.number) {
          throw new HistoryError(
            where,
            `${transition.defect} is not fixed in this round`,
          );
        }
        current.closed = round.number;
      } else if (
        defect.fixedRound !== null &&
        defect.fixedRound <= round.number
      ) {
        throw new HistoryError(
          where,
          `${transition.defect} no longer persists`,
        );
      }
    }
    for (const id of dismissed) {
      if (state.get(id)?.closed !== round.number) {
        throw new HistoryError(
          `${at}.transitions`,
          `the dismissal of ${id} is not expected`,
        );
      }
    }
  });

  for (const defect of defects) {
    const current = state.get(defect.id) as DefectState;
    const counted = defect.eligible && defect.available;
    if (counted && current.published === null) {
      throw new HistoryError('expected', `${defect.id} is never published`);
    }
    // A fixed defect that was published must close by its fix: through the
    // fixed transition, or through an earlier dismissal.
    if (
      defect.fixedRound !== null &&
      current.published !== null &&
      (current.closed === null || current.closed > defect.fixedRound)
    ) {
      throw new HistoryError(
        'expected',
        `${defect.id} has no fixed transition`,
      );
    }
    if (!counted) {
      const excluded = history.expected[
        defect.introducedRound - 1
      ] as ExpectedRound;
      if (
        defect.eligible === false &&
        !excluded.excludedPaths.includes(defect.location.path)
      ) {
        throw new HistoryError(
          'expected',
          `${defect.id} is ineligible but ${defect.location.path} is not excluded in round ${defect.introducedRound}`,
        );
      }
    }
  }
}

function checkScenarios(history: LabeledHistory): void {
  unique(history.scenarios, 'scenarios');
  if (history.scenarios.length === 0)
    throw new HistoryError('scenarios', 'must not be empty');
  const { defects, decoys } = history.labels;
  const counted = defects.filter(
    (defect) => defect.eligible && defect.available,
  );
  const rules: Record<Scenario, () => boolean> = {
    'correct-high-severity': () =>
      counted.some(
        (defect) =>
          defect.severity === 'high' || defect.severity === 'critical',
      ),
    'false-positive': () => decoys.length > 0,
    'incremental-fix': () =>
      defects.some((defect) => defect.fixedRound !== null),
    'partial-fix': () =>
      history.expected.some((round) =>
        round.transitions.some(
          (transition) => transition.status === 'persists',
        ),
      ),
    'dismissed-finding': () =>
      history.source.rounds.some((round) => round.actions.length > 0),
    'unreviewable-change': () =>
      history.expected.some(
        (round) =>
          round.coverage !== 'complete' || round.excludedPaths.length > 0,
      ),
    'late-round-regression': () =>
      counted.some((defect) => defect.introducedRound >= lateRound),
    'clean-pr': () => defects.length === 0,
    'cross-file': () =>
      defects.some((defect) =>
        defect.requiredEvidence.some(
          (location) => location.path !== defect.location.path,
        ),
      ),
  };
  for (const scenario of history.scenarios) {
    if (!rules[scenario]()) {
      throw new HistoryError(
        'scenarios',
        `${scenario} is not supported by the labels`,
      );
    }
  }
}

// Parses and checks one history. Throws HistoryError naming the first
// problem it finds.
export function parseHistory(value: unknown): LabeledHistory {
  const record = object(value, 'history', [
    'schemaVersion',
    'id',
    'title',
    'language',
    'provenance',
    'scenarios',
    'pullRequest',
    'source',
    'labels',
    'expected',
  ]);
  if (record['schemaVersion'] !== historySchemaVersion) {
    throw new HistoryError('schemaVersion', `must be ${historySchemaVersion}`);
  }
  const pullRequest = object(record['pullRequest'], 'pullRequest', [
    'title',
    'body',
  ]);
  const source = object(record['source'], 'source', ['base', 'rounds']);
  const base = fileMap(source['base'], 'source.base', false) as Map<
    string,
    FileLines
  >;
  const history: LabeledHistory = {
    schemaVersion: historySchemaVersion,
    id: identifier(record['id'], 'id'),
    title: text(record['title'], 'title'),
    language: oneOf(record['language'], languages, 'language'),
    provenance: readProvenance(record['provenance'], 'provenance'),
    scenarios: list(record['scenarios'], 'scenarios').map((entry, index) =>
      oneOf(entry, scenarios, `scenarios[${index}]`),
    ),
    pullRequest: {
      title: text(pullRequest['title'], 'pullRequest.title'),
      body: text(pullRequest['body'], 'pullRequest.body'),
    },
    source: {
      base,
      rounds: list(source['rounds'], 'source.rounds').map((entry, index) =>
        readRound(entry, `source.rounds[${index}]`),
      ),
    },
    labels: readLabels(record['labels'], 'labels'),
    expected: list(record['expected'], 'expected').map((entry, index) =>
      readExpected(entry, `expected[${index}]`),
    ),
  };

  const trees = checkSource(history);
  const { labels } = history;
  unique(
    [
      ...labels.defects.map((defect) => defect.id),
      ...labels.decoys.map((decoy) => decoy.id),
    ],
    'labels',
  );
  labels.defects.forEach((defect, index) =>
    checkDefect(history, trees, defect, `labels.defects[${index}]`),
  );
  labels.decoys.forEach((decoy, index) =>
    checkLocation(trees, decoy.location, `labels.decoys[${index}].location`),
  );
  // The checker must differ from the labeler. Identities compare without
  // case, as GitHub logins do.
  if (
    labels.check.status !== 'pending' &&
    labels.check.by.toLowerCase() === labels.labeledBy.toLowerCase()
  ) {
    throw new HistoryError(
      'labels.check.by',
      'the checker must not be the labeler',
    );
  }
  checkExpected(history);
  checkScenarios(history);
  return history;
}
