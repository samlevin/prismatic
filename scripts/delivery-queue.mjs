import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CliHelp, cliError, defineCli, parseCli } from './cli.cjs';
import { failureMessage, ghRest, ghRestPages } from './github-api.mjs';
import { implementationEffort, loadPolicy } from './agent-policy.mjs';
import { closingIssues } from './issue-pr-status.mjs';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const text = (value) =>
  typeof value === 'string' ? value : (value?.raw ?? '');

// Every invocation refetches GitHub; this REST client keeps no response cache.
export function restClient(run = execFileSync) {
  const request = (path, read) => {
    try {
      return read();
    } catch (error) {
      throw new Error(`GET ${path}: ${failureMessage(error)}`, {
        cause: error,
      });
    }
  };
  const get = (path) =>
    request(path, () => JSON.parse(ghRest([path], { run })));
  const list = (path, key) => {
    const pages = request(path, () =>
      ghRestPages(`${path}${path.includes('?') ? '&' : '?'}per_page=100`, {
        run,
      }),
    );
    return pages.flatMap((page) => {
      const items = key ? page?.[key] : page;
      if (!Array.isArray(items))
        throw new Error(`GET ${path}: expected a list`);
      return items;
    });
  };
  return { get, list };
}

export function claimRecord(comments) {
  let active = null;
  for (const comment of comments) {
    if (!TRUSTED.has(comment.author_association)) continue;
    const body = comment.body ?? '';
    const record = /<!-- prism-claim ([^\n]*?) -->/.exec(body);
    if (record) {
      const value = JSON.parse(record[1]);
      if (value.released) {
        if (active?.agent === value.agent) active = null;
      } else
        active = {
          ...value,
          url: comment.html_url,
          login: comment.user?.login,
        };
      continue;
    }
    // Legacy comments count only by their opening words, so prose that
    // mentions a claim never creates or releases one.
    const first = body.trimStart().split('\n', 1)[0];
    if (/^(?:Claimed|Claiming|Re-claimed|Re-claiming)\b/.test(first))
      active = {
        agent: /Agent\s+`([^`]+)`/i.exec(body)?.[1] ?? comment.user?.login,
        branch: /`(agent\/[^`\s]+)`/.exec(body)?.[1],
        worktree: /`([^`]*\.(?:codex|claude)\/worktrees\/[^`]+)`/.exec(
          body,
        )?.[1],
        url: comment.html_url,
        login: comment.user?.login,
      };
    else if (
      /^(?:Releasing|Released|Claim released|Pausing this claim)\b/.test(
        first,
      ) &&
      // Legacy releases belong to the GitHub account that wrote the claim.
      comment.user?.login === active?.login
    )
      active = null;
  }
  return active;
}

export function effortRecord(comments, policy) {
  let decision;
  let constraint;
  let transitions = 0;
  for (const comment of comments) {
    if (!TRUSTED.has(comment.author_association)) continue;
    const match = /<!-- prism-effort ([^\n]*?) -->/.exec(comment.body ?? '');
    if (!match) continue;
    const record = JSON.parse(match[1]);
    if (record.rule === 'user override') constraint = record;
    decision = implementationEffort(policy, {
      decision: constraint ?? record,
      transitions,
    });
    if (!constraint && record.later && decision.effort === 'high')
      transitions++;
  }
  return decision ?? implementationEffort(policy);
}

function fieldValues(item, fields) {
  return Object.fromEntries(
    (item?.fields ?? []).map((field) => {
      const definition = fields.find((entry) => entry.id === field.id);
      const option = definition?.options?.find(
        (entry) => entry.id === field.value,
      );
      return [
        definition?.name ?? field.name,
        text(option?.name ?? field.value?.name ?? field.value),
      ];
    }),
  );
}

export function orderLeaves(leaves, nodes) {
  const remaining = new Set(leaves);
  const result = [];
  const cycles = new Map();
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const active = new Set();
  function visit(number) {
    indices.set(number, indices.size);
    low.set(number, indices.get(number));
    stack.push(number);
    active.add(number);
    for (const dep of nodes.get(number)?.dependencies ?? []) {
      if (!indices.has(dep.number)) {
        visit(dep.number);
        low.set(number, Math.min(low.get(number), low.get(dep.number)));
      } else if (active.has(dep.number))
        low.set(number, Math.min(low.get(number), indices.get(dep.number)));
    }
    if (low.get(number) !== indices.get(number)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      component.push(member);
    } while (member !== number);
    const selfCycle = (nodes.get(number)?.dependencies ?? []).some(
      (dep) => dep.number === number,
    );
    if (component.length > 1 || selfCycle) {
      component.sort((a, b) => a - b);
      for (const n of component) cycles.set(n, component);
    }
  }
  for (const number of leaves) if (!indices.has(number)) visit(number);
  // Kahn's algorithm gives a numeric tie break among currently eligible leaves.
  while (remaining.size) {
    function hasRemainingDependency(number, visited = new Set()) {
      if (visited.has(number)) return false;
      visited.add(number);
      return (nodes.get(number)?.dependencies ?? []).some(
        (dep) =>
          remaining.has(dep.number) ||
          hasRemainingDependency(dep.number, visited),
      );
    }
    const ready = [...remaining].filter(
      (number) => !hasRemainingDependency(number),
    );
    const number = (ready.length ? ready : [...remaining]).sort(
      (a, b) => a - b,
    )[0];
    remaining.delete(number);
    result.push(number);
  }
  return { order: result, cycles };
}

export function approvalPair(pr) {
  if (!TRUSTED.has(pr?.author_association)) return null;
  const match =
    /Pre-PR review: APPROVE(?:; base=([0-9a-f]{40}); head=([0-9a-f]{40})| for [`*_]*([0-9a-f]{40})\.\.([0-9a-f]{40}))/.exec(
      pr?.body ?? '',
    );
  return match
    ? { base: match[1] ?? match[3], head: match[2] ?? match[4] }
    : null;
}

export function stackReady(pr, checks, statuses, verifiedAncestor) {
  if (!pr || pr.state !== 'open' || pr.draft) return false;
  const approval = approvalPair(pr);
  if (
    !approval ||
    approval.head !== pr.head.sha ||
    approval.base !== verifiedAncestor
  )
    return false;
  const all = [
    ...checks.map(
      (check) =>
        check.status === 'completed' &&
        ['success', 'neutral', 'skipped'].includes(check.conclusion),
    ),
    ...statuses.map((status) => status.state === 'success'),
  ];
  return all.length > 0 && all.every(Boolean);
}

function relationshipRepository(issue) {
  return (
    issue.repository?.full_name ??
    /(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)(?:\/|$)/.exec(
      issue.repository_url ?? issue.url ?? issue.html_url ?? '',
    )?.[1]
  );
}

export function ownershipNotes(body = '') {
  const notes =
    /### Implementation notes\s*\n([\s\S]*?)(?=\n### |$)/i.exec(body)?.[1] ??
    '';
  const files = /(?:^|\n)Files:\s*([^\n]+)/i.exec(notes)?.[1];
  const contracts = /(?:^|\n)(?:Contracts|Provides):\s*([^\n]+)/i.exec(
    notes,
  )?.[1];
  return {
    files: files
      ? [...files.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      : [],
    contracts:
      !contracts || /^none[. ]*$/i.test(contracts.trim())
        ? []
        : contracts.split(',').map((value) => value.replaceAll('`', '').trim()),
    complete: Boolean(files && /`[^`]+`/.test(files) && contracts),
  };
}

function parallelMetadata(nodes, rows, merged) {
  const byNumber = new Map(rows.map((row) => [row.issue, row]));
  const ancestors = (n, result = new Set()) => {
    for (const dep of nodes.get(n)?.dependencies ?? [])
      if (!result.has(dep.number)) {
        result.add(dep.number);
        ancestors(dep.number, result);
      }
    return result;
  };
  for (const [container, node] of nodes) {
    const matches = [
      ...(node.issue?.body ?? '').matchAll(
        /<!-- prism-independence-groups -->([\s\S]*?)<!-- \/prism-independence-groups -->/g,
      ),
    ];
    if (matches.length !== 1) continue;
    const groups = new Map();
    let valid = true;
    for (const [index, line] of matches[0][1]
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .entries()) {
      // Older records omit `gN:`; their lines number the groups in order.
      const match = /^-(?: (g\d+):)?((?: #\d+)+)$/.exec(line);
      if (!match) {
        valid = false;
        break;
      }
      for (const number of match[2].matchAll(/#(\d+)/g)) {
        const n = Number(number[1]);
        if (
          groups.has(n) ||
          !node.children.some((child) => child.number === n) ||
          nodes.get(n)?.children?.length ||
          !byNumber.has(n)
        )
          valid = false;
        groups.set(n, `${container}/${match[1] ?? `g${index + 1}`}`);
      }
    }
    const entries = [...groups];
    for (const [a, ga] of entries)
      for (const [b, gb] of entries) {
        if (a >= b || ga === gb) continue;
        const aa = ancestors(a);
        const bb = ancestors(b);
        if (
          aa.has(b) ||
          bb.has(a) ||
          [...aa].some(
            (n) =>
              bb.has(n) &&
              nodes.get(n)?.issue?.state !== 'closed' &&
              !merged(n),
          )
        )
          valid = false;
      }
    if (!valid) continue;
    for (const [n, group] of groups) byNumber.get(n).group = group;
  }
  const overlap = (a, b) =>
    a.some((left) =>
      b.some((right) => {
        const l = left.split(/[?*{[]/)[0];
        const r = right.split(/[?*{[]/)[0];
        return l.startsWith(r) || r.startsWith(l);
      }),
    );
  for (const row of rows) {
    row.parallelWith = [];
    if (
      row.state !== 'ready' ||
      row.size !== 'M' ||
      !row.group ||
      !row.ownership?.complete
    )
      continue;
    for (const other of rows) {
      if (
        other.issue === row.issue ||
        other.state !== 'ready' ||
        other.size !== 'M' ||
        !other.ownership?.complete ||
        !other.group ||
        row.group.split('/')[0] !== other.group.split('/')[0] ||
        row.group === other.group
      )
        continue;
      if (
        !overlap(row.ownership.files, other.ownership.files) &&
        !row.ownership.contracts.some((contract) =>
          other.ownership.contracts.includes(contract),
        )
      )
        row.parallelWith.push({
          issue: other.issue,
          group: other.group,
          files: other.ownership.files,
          contracts: other.ownership.contracts,
        });
    }
  }
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
  function readIssue(n, tree = false, ancestors = []) {
    if (ancestors.includes(n)) {
      errors.push(`native sub-issue cycle: ${[...ancestors, n].join(' -> ')}`);
      return;
    }
    let node = nodes.get(n);
    if (!node) {
      try {
        const issue = api.get(`${repo}/issues/${n}`);
        const children = api.list(`${repo}/issues/${n}/sub_issues`);
        const dependencies = api.list(
          `${repo}/issues/${n}/dependencies/blocked_by`,
        );
        const comments = api.list(`${repo}/issues/${n}/comments`);
        for (const related of [...children, ...dependencies]) {
          const relatedRepo = relationshipRepository(related);
          if (
            relatedRepo &&
            relatedRepo.toLowerCase() !== repository.toLowerCase()
          )
            throw new Error(
              `unsupported repository relationship: ${relatedRepo}#${related.number}`,
            );
        }
        node = { issue, children, dependencies, comments };
        nodes.set(n, node);
      } catch (error) {
        errors.push(`issue #${n} inaccessible: ${error.message}`);
        nodes.set(n, { error: error.message, dependencies: [] });
        if (tree) leaves.push(n);
        return;
      }
    }
    if (tree) {
      if (!node.children?.length) {
        if (!leaves.includes(n)) leaves.push(n);
      } else
        for (const child of node.children)
          readIssue(child.number, true, [...ancestors, n]);
    }
    for (const dep of node.dependencies)
      if (!nodes.has(dep.number)) readIssue(dep.number);
  }
  readIssue(number, true);
  const trunk = api.get(`${repo}/commits/main`);
  const fields = api.list(
    `users/${project.owner}/projectsV2/${project.number}/fields`,
  );
  const items = api.list(
    `users/${project.owner}/projectsV2/${project.number}/items?fields=${fields
      .filter((field) => ['Status', 'Priority', 'Size'].includes(field.name))
      .map((field) => field.id)
      .join(',')}`,
  );
  const prs = api.list(`${repo}/pulls?state=all`);
  const branches = api
    .list(`${repo}/branches`)
    .filter((branch) => branch.name.startsWith('agent/'));
  const closing = (n) =>
    prs.filter(
      (pr) =>
        TRUSTED.has(pr.author_association) &&
        closingIssues(pr.body, repository).includes(n),
    );
  const merged = (n) => closing(n).find((pr) => pr.merged_at);
  const open = (n) => closing(n).find((pr) => pr.state === 'open');
  // Cache eligibility only within this ledger run.
  const checks = new Map();
  const qualifies = (pr) => {
    if (!pr || pr.draft) return false;
    const approval = approvalPair(pr);
    if (!approval || approval.head !== pr.head.sha) return false;
    const identity = `${pr.number}:${pr.base.sha}:${pr.head.sha}`;
    if (!checks.has(identity))
      checks.set(
        identity,
        stackReady(
          pr,
          api.list(`${repo}/commits/${pr.head.sha}/check-runs`, 'check_runs'),
          api.get(`${repo}/commits/${pr.head.sha}/status`).statuses ?? [],
          api.get(`${repo}/compare/${approval.base}...${pr.head.sha}`)
            .merge_base_commit?.sha,
        ),
      );
    return checks.get(identity);
  };
  const { order, cycles } = orderLeaves(leaves, nodes);
  const rows = order.map((n) => {
    try {
      const node = nodes.get(n);
      if (node.error)
        return {
          issue: n,
          state: 'waiting',
          blocker: `BLOCKED: ${node.error}`,
          effort: implementationEffort(policy),
        };
      const item = items.find(
        (entry) =>
          entry.content?.number === n &&
          entry.content?.repository_url?.endsWith(`/repos/${repository}`),
      );
      const metadata = fieldValues(item, fields);
      const claim = claimRecord(node.comments);
      const pr = merged(n) ?? open(n);
      const branch =
        claim?.branch ??
        branches.find((entry) => new RegExp(`^agent/${n}-`).test(entry.name))
          ?.name;
      const row = {
        issue: n,
        state: 'ready',
        title: node.issue.title,
        branch,
        head: branches.find((entry) => entry.name === branch)?.commit.sha,
        pr: pr?.html_url,
        projectState: metadata.Status ?? 'unset',
        size: metadata.Size,
        priority: metadata.Priority ?? 'P2',
        claim,
        effort: effortRecord(node.comments, policy),
        dependencies: node.dependencies.map((dep) => dep.number),
        ownership: ownershipNotes(node.issue.body),
        group: 'none',
        base: { branch: 'main', sha: trunk.sha },
        prerequisites: node.dependencies.map((dep) => {
          const candidate = open(dep.number);
          const met =
            nodes.get(dep.number)?.issue?.state === 'closed' ||
            Boolean(merged(dep.number));
          return {
            issue: dep.number,
            repository,
            met,
            pr: candidate?.html_url,
            branch: candidate?.head.ref,
            head: candidate?.head.sha,
            base: approvalPair(candidate)?.base,
            stackReady: !met && qualifies(candidate),
          };
        }),
      };
      if (node.issue.state === 'closed' || merged(n)) row.state = 'done';
      else if (open(n)) row.state = 'in review';
      else if (claim) {
        const owned =
          actor &&
          claim.agent === actor &&
          worktrees.some(
            (path) =>
              path === claim.worktree || path.endsWith(`/${claim.worktree}`),
          );
        row.state =
          Number(resume) === n || owned ? 'resume' : 'owned elsewhere';
      } else {
        const unmet = node.dependencies.filter(
          (dep) =>
            nodes.get(dep.number)?.issue?.state !== 'closed' &&
            !merged(dep.number) &&
            !qualifies(open(dep.number)),
        );
        if (unmet.length) {
          row.state = 'waiting';
          row.blocker = `unmet blockers: ${unmet.map((dep) => `#${dep.number}`).join(', ')}`;
        }
      }
      const openBases = row.prerequisites.filter((entry) => entry.stackReady);
      if (openBases.length === 1)
        row.base = { branch: openBases[0].branch, sha: openBases[0].head };
      if (openBases.length > 1 && ['ready', 'resume'].includes(row.state)) {
        row.state = 'waiting';
        row.blocker =
          'multiple unmerged prerequisite branches require a stacking decision';
      }
      if (cycles.has(n)) {
        row.state = 'waiting';
        row.blocker = `BLOCKED: cycle component [${cycles.get(n).join(', ')}]`;
      }
      return row;
    } catch (error) {
      const message = `issue #${n} invalid data: ${error.message}`;
      errors.push(message);
      return {
        issue: n,
        state: 'waiting',
        blocker: `BLOCKED: ${message}`,
        effort: implementationEffort(policy),
      };
    }
  });
  parallelMetadata(nodes, rows, merged);
  return { rows, errors };
}

export function nextLeaf(rows) {
  const resumable = rows.find((row) => row.state === 'resume');
  if (resumable) return resumable;
  return rows.find((row) => ['owned elsewhere', 'ready'].includes(row.state));
}

export function ledgerLine(row) {
  const decision = row.effort;
  return `#${row.issue} | ${row.state} | effort=${decision.effort}; rule=${decision.rule}; evidence=${decision.evidence}; reason=${decision.reason} | branch=${row.branch ?? 'none'}; head=${row.head ?? 'none'}; PR=${row.pr ?? 'none'}; project=${row.projectState ?? 'unset'}; size=${row.size ?? 'infer'} | claim=${row.claim?.url ?? 'none'} | dispatch=${JSON.stringify({ base: row.base, dependencies: row.dependencies, prerequisites: row.prerequisites, group: row.group, ownership: row.ownership, parallelWith: row.parallelWith })}${row.blocker ? ` | ${row.blocker}` : ''}`;
}

const cli = defineCli(
  'Usage: node scripts/delivery-queue.mjs <issue> [--next] [--resume <issue>] [--actor <delivery-agent>]',
  ['next', 'resume', 'actor'],
);
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { options, positionals } = parseCli(process.argv.slice(2), cli);
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
      throw cliError(cli, 'Give one positive issue number');
    if (options.resume && !/^[1-9]\d*$/.test(options.resume))
      throw cliError(cli, '--resume needs a positive issue number');
    const registry = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    const worktrees = [...registry.matchAll(/^worktree (.+)$/gm)].map(
      (match) => match[1],
    );
    const result = deliveryQueue(loadPolicy(), Number(positionals[0]), {
      ...options,
      worktrees,
    });
    const rows = options.next
      ? [nextLeaf(result.rows)].filter(Boolean)
      : result.rows;
    for (const row of rows) console.log(ledgerLine(row));
    for (const error of result.errors) console.error(`BLOCKED: ${error}`);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
