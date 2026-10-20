// Prints the delivery ledger for a container or a single leaf: one line per
// leaf with its queue state and implementation effort. Read-only.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadPolicy } from './agent-policy.mjs';
import { failureMessage } from './github-api.mjs';
import { closingIssues } from './issue-pr-status.mjs';

const POSITIVE_INTEGER = /^[1-9]\d*$/;
// Only collaborators can claim work or record an effort decision.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const USAGE =
  'Usage: delivery-queue.mjs <issue> [--next] [--resume <issue>] [--actor <delivery id>] [--skip <issue,...>]';

// Every run refetches GitHub; nothing is cached between runs.
export function restClient(run = execFileSync) {
  const get = (path, paginate = false) =>
    JSON.parse(
      run(
        'gh',
        [
          'api',
          '-X',
          'GET',
          path,
          ...(paginate ? ['--paginate', '--slurp'] : []),
        ],
        {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
  const list = (path, key) =>
    get(`${path}${path.includes('?') ? '&' : '?'}per_page=100`, true).flatMap(
      (page) => (key ? page[key] : page),
    );
  return { get, list };
}

const ORDINARY = {
  rule: 'default',
  evidence: 'issue/spec',
  reason: 'The written plan resolves the design.',
};

// A decision selects high only through a rubric rule whose required evidence
// is all recorded; labels and Size never reach this function.
export function implementationEffort(
  policy,
  { override, decision, transitions = 0 } = {},
) {
  const rubric = policy.implementationEffort;
  const ordinary = { effort: rubric.default, ...ORDINARY };
  if (override)
    return {
      effort: override,
      rule: 'user override',
      evidence: 'explicit user constraint',
      reason: 'The request selects this effort.',
    };
  if (!decision) return ordinary;
  if (decision.rule === 'user override') {
    if (
      !decision.effort ||
      !decision.evidence?.trim() ||
      !decision.reason?.trim()
    )
      throw new Error(
        'A user override record needs effort, evidence, and reason',
      );
    return { ...decision };
  }
  const rule = rubric.rules[decision.rule];
  if (
    !rule ||
    decision.effort !== rubric.automaticMaximum ||
    !decision.question?.trim() ||
    !decision.evidence?.trim() ||
    !decision.reason?.trim() ||
    !rule.requires.every((key) => decision.criteria?.[key] === true)
  )
    return ordinary;
  if (decision.later && transitions >= rubric.maximumTransitions)
    throw new Error(
      'Only one automatic medium-to-high transition is allowed per leaf',
    );
  return { ...decision };
}

export function effortAnnouncement(issue, decision) {
  if (decision.rule === 'default')
    return 'Implementation effort: medium (default)';
  return `Implementation effort: medium -> ${decision.effort}; issue: #${issue}; rule: ${decision.rule}; evidence: ${decision.evidence}; reason: ${decision.reason}`;
}

const trusted = (comments) =>
  comments.filter((comment) => TRUSTED.has(comment.author_association));

function record(body, name) {
  const match = new RegExp(`<!-- prism-${name} ([^\\n]*?) -->`).exec(
    body ?? '',
  );
  return match ? JSON.parse(match[1]) : null;
}

// Claims before the prism-claim record existed are free text; they count
// until a release comment by the same account.
export function claimRecord(comments) {
  let active = null;
  for (const comment of trusted(comments)) {
    const body = comment.body ?? '';
    const value = record(body, 'claim');
    if (value) {
      if (!value.released) active = { ...value, url: comment.html_url };
      else if (active?.agent === value.agent) active = null;
    } else if (/\breleas(?:e|ed|es|ing)\b/i.test(body)) {
      if (/\bclaim/i.test(body) && active?.login === comment.user?.login)
        active = null;
    } else if (/\bclaim(?:s|ed|ing)?\b/i.test(body))
      active = {
        agent: comment.user?.login,
        branch: /`(agent\/[^`\s]+)`/.exec(body)?.[1],
        worktree: /`([^`\s]*\.(?:claude|codex)\/worktrees\/[^`\s]+)`/.exec(
          body,
        )?.[1],
        url: comment.html_url,
        login: comment.user?.login,
      };
  }
  return active;
}

// A user override pins every later decision; each recorded later escalation
// to high counts toward the transition limit.
export function effortRecord(comments, policy) {
  let decision = implementationEffort(policy);
  let constraint = null;
  let transitions = 0;
  for (const comment of trusted(comments)) {
    const value = record(comment.body, 'effort');
    if (!value) continue;
    if (value.rule === 'user override') constraint = value;
    decision = implementationEffort(policy, {
      decision: constraint ?? value,
      transitions,
    });
    if (!constraint && value.later && decision.rule !== 'default')
      transitions += 1;
  }
  return decision;
}

// Blockers come first and ties go to the lower issue number. Every member of
// a dependency cycle is reported together.
export function orderLeaves(leaves, dependencies) {
  const edges = (n) =>
    (dependencies.get(n) ?? []).filter((d) => leaves.includes(d));
  const cyclic = leaves.filter((n) =>
    edges(n).some((d) => reaches(d, n, edges)),
  );
  const cycles = new Map(
    cyclic.map((n) => [
      n,
      cyclic
        .filter((m) => reaches(m, n, edges) && reaches(n, m, edges))
        .sort((a, b) => a - b),
    ]),
  );
  const order = [];
  const remaining = new Set(leaves);
  while (remaining.size) {
    const free = [...remaining].filter(
      (n) => !edges(n).some((d) => remaining.has(d)),
    );
    const n = (free.length ? free : [...remaining]).sort((a, b) => a - b)[0];
    remaining.delete(n);
    order.push(n);
  }
  return { order, cycles };
}

function reaches(from, to, edges) {
  if (from === to) return true;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of edges(queue.shift())) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// Accepts `Pre-PR review: APPROVE; base=<sha>; head=<sha>` and the older free
// text that names the pair as `<base>..<head>`.
export function approvalPair(body) {
  const match =
    /Pre-PR review: APPROVE(?:; base=([0-9a-f]{40}); head=([0-9a-f]{40})|[^\n]*?([0-9a-f]{40})\.\.([0-9a-f]{40}))/.exec(
      body ?? '',
    );
  return match
    ? { base: match[1] ?? match[3], head: match[2] ?? match[4] }
    : null;
}

// The AGENTS.md prerequisite rule: open, ready for review, passing checks,
// and approved before the PR at its current head.
export function stackReady(pr, checkRuns, statuses) {
  if (!pr || pr.state !== 'open' || pr.draft) return false;
  if (approvalPair(pr.body)?.head !== pr.head.sha) return false;
  const results = [
    ...checkRuns.map(
      (run) =>
        run.status === 'completed' &&
        ['success', 'neutral', 'skipped'].includes(run.conclusion),
    ),
    ...statuses.map((status) => status.state === 'success'),
  ];
  return results.length > 0 && results.every(Boolean);
}

function repositoryOf(issue) {
  return /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? '')?.[1];
}

export function deliveryQueue(
  policy,
  number,
  { api = restClient(), resume, actor, worktrees = [] } = {},
) {
  const { repository, project } = policy.binding;
  const repo = `repos/${repository}`;
  const nodes = new Map();
  const leaves = [];
  const errors = [];
  const read = (n, tree, ancestors = []) => {
    if (ancestors.includes(n)) {
      errors.push(`sub-issue cycle: ${[...ancestors, n].join(' -> ')}`);
      return;
    }
    if (!nodes.has(n)) {
      try {
        const node = {
          issue: api.get(`${repo}/issues/${n}`),
          children: api.list(`${repo}/issues/${n}/sub_issues`),
          dependencies: api.list(`${repo}/issues/${n}/dependencies/blocked_by`),
          comments: api.list(`${repo}/issues/${n}/comments`),
        };
        for (const related of [...node.children, ...node.dependencies]) {
          const other = repositoryOf(related);
          if (other && other.toLowerCase() !== repository.toLowerCase())
            throw new Error(
              `links ${other}#${related.number}, outside ${repository}`,
            );
        }
        nodes.set(n, node);
      } catch (error) {
        const message = `issue #${n} inaccessible: ${failureMessage(error)}`;
        errors.push(message);
        nodes.set(n, { error: message, children: [], dependencies: [] });
      }
    }
    const node = nodes.get(n);
    if (tree) {
      if (!node.children.length) {
        if (!leaves.includes(n)) leaves.push(n);
      } else
        for (const child of node.children)
          read(child.number, true, [...ancestors, n]);
    }
    for (const dependency of node.dependencies)
      if (!nodes.has(dependency.number)) read(dependency.number, false);
  };
  read(number, true);

  const trunk = api.get(`${repo}/commits/main`).sha;
  const fields = api.list(
    `users/${project.owner}/projectsV2/${project.number}/fields`,
  );
  const wanted = fields.filter((field) =>
    ['Status', 'Size'].includes(field.name),
  );
  const items = api.list(
    `users/${project.owner}/projectsV2/${project.number}/items?fields=${wanted.map((field) => field.id).join(',')}`,
  );
  const prs = api.list(`${repo}/pulls?state=all`);
  const branches = api
    .list(`${repo}/branches`)
    .filter((branch) => branch.name.startsWith('agent/'));
  const closing = (n) =>
    prs.filter((pr) => closingIssues(pr.body ?? '', repository).includes(n));
  const merged = (n) => closing(n).find((pr) => pr.merged_at);
  const open = (n) => closing(n).find((pr) => pr.state === 'open');
  const closed = (n) =>
    nodes.get(n)?.issue?.state === 'closed' || Boolean(merged(n));
  const ready = new Map();
  const qualifies = (pr) => {
    if (!pr) return false;
    if (!ready.has(pr.number))
      ready.set(
        pr.number,
        // Without an approval at the current head, skip the check reads.
        approvalPair(pr.body)?.head === pr.head.sha &&
          stackReady(
            pr,
            api.list(`${repo}/commits/${pr.head.sha}/check-runs`, 'check_runs'),
            api.get(`${repo}/commits/${pr.head.sha}/status`).statuses,
          ),
      );
    return ready.get(pr.number);
  };
  const field = (item, name) => {
    const value = item?.fields?.find((entry) => entry.name === name)?.value;
    return value?.name?.raw ?? value?.name ?? value?.raw ?? value;
  };

  const { order, cycles } = orderLeaves(
    leaves,
    new Map(
      [...nodes].map(([n, node]) => [
        n,
        node.dependencies.map((dependency) => dependency.number),
      ]),
    ),
  );
  const blocked = (row, blocker) => ({
    ...row,
    state: 'waiting',
    blocker: `BLOCKED: ${blocker}`,
  });
  const rows = order.map((n) => {
    const node = nodes.get(n);
    const base = { issue: n, effort: implementationEffort(policy) };
    if (node.error) return blocked(base, node.error);
    try {
      const item = items.find(
        (entry) =>
          entry.content?.number === n &&
          entry.content?.repository_url?.endsWith(`/repos/${repository}`),
      );
      const claim = claimRecord(node.comments);
      const pr = merged(n) ?? open(n);
      const branch =
        claim?.branch ??
        branches.find((entry) => entry.name.startsWith(`agent/${n}-`))?.name;
      const row = {
        ...base,
        state: 'ready',
        effort: effortRecord(node.comments, policy),
        base: { branch: 'main', sha: trunk },
        branch,
        head: branches.find((entry) => entry.name === branch)?.commit.sha,
        pr: pr?.html_url,
        project: field(item, 'Status'),
        size: field(item, 'Size'),
        claim,
      };
      if (cycles.has(n))
        return blocked(
          row,
          `dependency cycle among ${cycles
            .get(n)
            .map((m) => `#${m}`)
            .join(', ')}`,
        );
      if (closed(n)) return { ...row, state: 'done' };
      if (open(n)) return { ...row, state: 'in review' };
      const unmet = node.dependencies
        .map((dependency) => dependency.number)
        .filter((d) => !closed(d));
      const failed = unmet.filter((d) => nodes.get(d)?.error);
      if (failed.length)
        return blocked(
          row,
          `blocker ${failed.map((d) => `#${d}`).join(', ')} inaccessible`,
        );
      const stackable = unmet.filter((d) => qualifies(open(d)));
      if (claim) {
        const ours =
          actor &&
          claim.agent === actor &&
          worktrees.some(
            (path) =>
              path === claim.worktree || path.endsWith(`/${claim.worktree}`),
          );
        return {
          ...row,
          state: resume === n || ours ? 'resume' : 'owned elsewhere',
        };
      }
      if (stackable.length < unmet.length)
        return {
          ...row,
          state: 'waiting',
          blocker: `unmet blockers: ${unmet
            .filter((d) => !stackable.includes(d))
            .map((d) => `#${d}`)
            .join(', ')}`,
        };
      if (stackable.length > 1)
        return {
          ...row,
          state: 'waiting',
          blocker: `unmerged prerequisites ${stackable.map((d) => `#${d}`).join(', ')} need a stacking decision`,
        };
      if (stackable.length === 1) {
        const prerequisite = open(stackable[0]);
        row.base = {
          branch: prerequisite.head.ref,
          sha: prerequisite.head.sha,
        };
      }
      return row;
    } catch (error) {
      const message = `issue #${n} has an invalid record: ${error.message}`;
      errors.push(message);
      return blocked(base, message);
    }
  });
  return { rows, errors };
}

// An interrupted delivery resumes first. An earlier leaf someone else owns is
// reported, never skipped, so the person decides whether to take it over.
export function nextLeaf(rows, skip = []) {
  const candidates = rows.filter((row) => !skip.includes(row.issue));
  return (
    candidates.find((row) => row.state === 'resume') ??
    candidates.find((row) => ['owned elsewhere', 'ready'].includes(row.state))
  );
}

export function ledgerLine(row) {
  const { effort } = row;
  const parts = [
    `#${row.issue}`,
    row.state,
    `effort=${effort.effort}; rule=${effort.rule}; evidence=${effort.evidence}; reason=${effort.reason}`,
  ];
  if (row.base)
    parts.push(
      `base=${row.base.branch}@${row.base.sha}; branch=${row.branch ?? 'none'}; head=${row.head ?? 'none'}; PR=${row.pr ?? 'none'}; project=${row.project ?? 'none'}; size=${row.size ?? 'none'}; claim=${row.claim?.url ?? 'none'}`,
    );
  if (row.blocker) parts.push(row.blocker);
  return parts.join(' | ');
}

export function parseArguments(argv) {
  const options = { next: false, skip: [] };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--next') options.next = true;
    else if (['--resume', '--actor', '--skip'].includes(argument)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`Option ${argument} requires a value`);
      if (argument === '--actor') options.actor = value;
      else {
        const numbers = value.split(',');
        if (!numbers.every((entry) => POSITIVE_INTEGER.test(entry)))
          throw new Error(`${argument} requires issue numbers`);
        if (argument === '--resume') {
          if (numbers.length > 1)
            throw new Error('--resume takes one issue number');
          options.resume = Number(value);
        } else options.skip = numbers.map(Number);
      }
    } else if (argument.startsWith('--'))
      throw new Error(`Unknown option ${argument}`);
    else positional.push(argument);
  }
  if (positional.length !== 1 || !POSITIVE_INTEGER.test(positional[0]))
    throw new Error(USAGE);
  options.issue = Number(positional[0]);
  return options;
}

export function run(argv, { policy = loadPolicy(), api, worktrees } = {}) {
  const options = parseArguments(argv);
  const { rows, errors } = deliveryQueue(policy, options.issue, {
    ...(api ? { api } : {}),
    resume: options.resume,
    actor: options.actor,
    worktrees: worktrees ?? registeredWorktrees(),
  });
  const lines = [];
  if (options.next) {
    const row = nextLeaf(rows, options.skip);
    if (row)
      lines.push(ledgerLine(row), effortAnnouncement(row.issue, row.effort));
    else lines.push('No resume, ready, or owned-elsewhere leaf remains.');
  } else lines.push(...rows.map(ledgerLine));
  return { lines, errors };
}

function registeredWorktrees() {
  return [
    ...execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    }).matchAll(/^worktree (.+)$/gm),
  ].map((match) => match[1]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { lines, errors } = run(process.argv.slice(2));
    for (const line of lines) console.log(line);
    for (const error of errors) console.error(`BLOCKED: ${error}`);
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
