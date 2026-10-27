// Offline delivery-plan parsing. Filing and triage are owned by the skill.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliHelp, cliError, defineCli, parseCli } from './cli.cjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const isOutside = (base, path) => {
  const local = relative(base, path);
  return local === '..' || local.startsWith('../');
};
const inCheckout = (directory) => {
  for (let path = directory; ; path = dirname(path)) {
    if (existsSync(join(path, '.git'))) return true;
    if (dirname(path) === path) return false;
  }
};
const isBacklogPhase = (title) => title === 'Backlog (not filed with v1)';
const idPattern = /\bP\d+\.\d+(?:\.\d+)*\b/g;
const unique = (items) => [...new Set(items)];
const hash = (text) => createHash('sha256').update(text).digest('hex');
const anchor = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .replace(/ /g, '-');

function headings(text) {
  let fence = false;
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && /^(#{1,6}) (.+)$/.exec(line);
    return match
      ? [{ level: match[1].length, title: match[2], line: index }]
      : [];
  });
}

function fields(text) {
  const result = {};
  let current;
  for (const line of text.split('\n')) {
    const match = /^(?:- )?\*\*([^*]+?)(?::\*\*|\*\*:)\s*(.*)$/.exec(line);
    if (match) {
      current = match[1];
      result[current] = match[2];
    } else if (current) result[current] += `\n${line}`;
  }
  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, v.trim()]),
  );
}

function defaultLabels(files, known) {
  const paths = [...files.matchAll(/(?:applications|packages)\/([a-z-]+)/g)];
  const areas = paths
    .map((m) => `package: ${m[1]}`)
    .filter((v) => known.has(v));
  if (/infrastructure\//.test(files)) areas.push('area: infrastructure');
  if (!areas.length || /(?:scripts|\.agents|\.github)\//.test(files))
    areas.push('area: repository');
  return unique(['enhancement', 'severity: none', ...areas]);
}

export function buildPlan(text, { specPath, repository, labels }) {
  const errors = [];
  const fail = (ref, message) => errors.push(`${ref}: ${message}`);
  const known = new Set(labels);
  const all = headings(text);
  const lines = text.split(/\r?\n/);
  const start = all.findIndex((h) => /^20\. Delivery plan/.test(h.title));
  if (start < 0) return { errors: ['§20: missing delivery plan'], nodes: [] };
  const end = all.findIndex(
    (h, i) =>
      i > start && h.level <= 2 && !/^(?:P\d+\.\d|Phase\b)/.test(h.title),
  );
  const planHeadings = all.slice(start + 1, end < 0 ? undefined : end);
  const contents = (h) => {
    const next = all.find((item) => item.line > h.line);
    return lines
      .slice(h.line + 1, next?.line ?? lines.length)
      .join('\n')
      .trim();
  };
  const doneHeading = planHeadings.find((h) => /^20\.3 /.test(h.title));
  const done = doneHeading ? contents(doneHeading) : '';
  if (!done || !/^\s*- /m.test(done))
    fail('§20.3', 'missing definition of done bullets');
  for (const section of ['20.1', '20.2'])
    if (!planHeadings.some((h) => h.title.startsWith(`${section} `)))
      fail(`§${section}`, 'missing required section');
  const contextHeading = planHeadings.find((h) => /^20\.4 /.test(h.title));
  const context = contextHeading ? contents(contextHeading) : '';
  const name = all
    .find((h) => h.level === 1)
    ?.title.replace(/: Technical Specification$/i, '');
  if (!name) fail('spec', 'missing document title');
  const nodes = [
    {
      ref: 'root',
      kind: 'CONTAINER',
      title: `${name} delivery plan`,
      parent: null,
      blockedBy: [],
      size: null,
      priority: 'P2',
      labels: ['severity: none', 'area: repository'],
    },
  ];
  const seenIDs = new Set();
  const seenTitles = new Set([nodes[0].title.toLowerCase()]);
  const sectionMap = new Map();
  for (const h of all) {
    const section = /^(\d+(?:\.\d+)*)\.?\s/.exec(h.title)?.[1];
    if (section) {
      sectionMap.set(section, h.title);
      for (const line of contents(h).split('\n')) {
        const item = /^(\d+)\. /.exec(line);
        if (item) sectionMap.set(`${section}.${item[1]}`, h.title);
      }
    }
  }
  let phase;
  let slice;
  const deferred = new Set();
  const labelField = (value, fallback) =>
    value
      ? value.split(',').map((v) => v.trim().replace(/^`|`$/g, ''))
      : fallback;
  const checkLabels = (node) => {
    for (const label of node.labels)
      if (!known.has(label)) fail(node.ref, `unknown label ${label}`);
  };
  for (const h of planHeadings) {
    if (/^Phase\b/.test(h.title) && h.level !== 3) {
      fail(h.title, 'phase heading must use three hashes');
      continue;
    }
    if (/^P\d+\.\d/.test(h.title) && ![4, 5].includes(h.level)) {
      fail(
        h.title,
        'slice heading must use four hashes, or five for a split child',
      );
      continue;
    }
    const phaseMatch = /^Phase (\d+): (.+)$/.exec(h.title);
    if (h.level === 3 && phaseMatch) {
      const ref = `phase-${phaseMatch[1]}`;
      const data = fields(contents(h));
      phase = {
        ref,
        kind: 'EPIC',
        title: phaseMatch[2],
        parent: 'root',
        blockedBy: [],
        size: null,
        priority: data.Priority || 'P2',
        labels: labelField(data.Labels, [
          'epic',
          'severity: none',
          'area: repository',
        ]),
        goal: data.Goal,
        exit: data['Exit criteria'],
        deferred: isBacklogPhase(phaseMatch[2]),
      };
      slice = undefined;
      if (!phase.deferred) {
        for (const field of ['Goal', 'Exit criteria'])
          if (!data[field]) fail(ref, `missing ${field}`);
        if (nodes.some((node) => node.ref === ref))
          fail(ref, 'duplicate phase');
        nodes.push(phase);
      }
      continue;
    }
    if (h.level === 3 && /^Phase\b/.test(h.title)) {
      fail(h.title, 'expected Phase <number>: <title>');
      phase = undefined;
      continue;
    }
    if (phase?.deferred) {
      for (const id of (contents(h) + h.title).match(idPattern) || [])
        deferred.add(id);
      continue;
    }
    if (h.level < 4) continue;
    const match = /^(P\d+\.\d+(?:\.\d+)*) (.+) \(([^)]+)\)$/.exec(h.title);
    if (!match) {
      fail(h.title, 'expected Plan ID, title and (XS|S|M)');
      if (h.level === 4) slice = undefined;
      continue;
    }
    const [, ref, title, size] = match;
    const data = fields(contents(h));
    const node = {
      ref,
      kind: data['Split into'] ? 'CONTAINER' : 'LEAF',
      title,
      size,
      priority: data.Priority || 'P2',
      labels: labelField(data.Labels, defaultLabels(data.Files || '', known)),
      parent: h.level === 4 ? phase?.ref : slice?.ref,
      blockedBy: unique(data['Blocked by']?.match(idPattern) || []),
      fields: data,
      section: h.title,
    };
    if (!phase) fail(ref, 'slice has no phase');
    if (h.level === 5 && slice?.kind !== 'CONTAINER')
      fail(ref, 'nested slice needs a split container');
    if (h.level > 5) fail(ref, 'only one split level is supported');
    if (h.level === 5 && !ref.startsWith(`${slice?.ref}.`))
      fail(ref, 'child Plan ID must extend its split container ID');
    if (h.level === 4) slice = node;
    for (const field of [
      'Blocked by',
      'Spec',
      'Files',
      'Provides',
      'Acceptance',
    ])
      if (!data[field]) fail(ref, `missing ${field}`);
    if (!/^\s*- /m.test(data.Acceptance || ''))
      fail(ref, 'Acceptance needs bullets');
    if (
      data['Blocked by'] &&
      !/^none$/i.test(data['Blocked by']) &&
      !/^(?:P\d+\.\d+(?:\.\d+)*(?:,\s*P\d+\.\d+(?:\.\d+)*)*)$/.test(
        data['Blocked by'],
      )
    )
      fail(ref, 'Blocked by must be none or Plan IDs');
    if (!['XS', 'S', 'M'].includes(size)) fail(ref, `invalid size ${size}`);
    if (seenIDs.has(ref)) fail(ref, 'duplicate Plan ID');
    seenIDs.add(ref);
    if (seenTitles.has(title.toLowerCase()))
      fail(ref, `duplicate title ${title}`);
    seenTitles.add(title.toLowerCase());
    const sections = unique(data.Spec?.match(/§\d+(?:\.\d+)*/g) || []);
    if (!sections.length) fail(ref, 'Spec needs section references');
    node.specLinks = sections.map((section) => {
      const heading = sectionMap.get(section.slice(1));
      if (!heading) fail(ref, `unknown spec section ${section}`);
      return `[${section}](https://github.com/${repository}/blob/main/${specPath}#${anchor(heading || '')})`;
    });
    nodes.push(node);
  }
  // Backlog table rows are deferred even when there are no detailed slices.
  const backlog = planHeadings.find(
    (h) => h.level === 3 && isBacklogPhase(h.title.replace(/^Phase \d+: /, '')),
  );
  if (backlog)
    for (const id of contents(backlog).match(idPattern) || []) deferred.add(id);
  const byRef = new Map();
  for (const node of nodes) if (!byRef.has(node.ref)) byRef.set(node.ref, node);
  for (const node of nodes) {
    if (node.parent && byRef.get(node.parent)?.fields)
      node.blockedBy = unique([
        ...node.blockedBy,
        ...byRef.get(node.parent).blockedBy,
      ]);
    checkLabels(node);
    if (!/^P[0-3]$/.test(node.priority))
      fail(node.ref, `invalid priority ${node.priority}`);
    if (node.kind === 'EPIC') {
      if (seenTitles.has(node.title.toLowerCase()))
        fail(node.ref, `duplicate title ${node.title}`);
      seenTitles.add(node.title.toLowerCase());
      if (!nodes.some((n) => n.parent === node.ref))
        fail(node.ref, 'phase has no slices');
    }
    for (const blocker of node.blockedBy) {
      if (!byRef.has(blocker))
        fail(
          node.ref,
          deferred.has(blocker)
            ? `blocked by deferred slice ${blocker}; resolve before filing`
            : `unknown blocked-by slice ${blocker}`,
        );
    }
    if (node.kind === 'CONTAINER' && node.ref !== 'root') {
      const declared = unique(node.fields['Split into'].match(idPattern) || []);
      const children = nodes
        .filter((n) => n.parent === node.ref)
        .map((n) => n.ref);
      if (
        !children.length ||
        declared.length !== children.length ||
        declared.some((id) => !children.includes(id))
      )
        fail(node.ref, 'Split into must list exactly its nested children');
    }
  }
  if (nodes.length === 1) fail('§20', 'no active phases or slices');
  errors.push(...cycles(nodes));
  for (const node of nodes) {
    const parentKind = byRef.get(node.parent)?.kind;
    const parent = `### Parent ${parentKind === 'EPIC' ? 'epic' : 'issue'}\n\n${node.parent || 'None'}`;
    const specLink = `https://github.com/${repository}/blob/main/${specPath}`;
    node.body =
      node.kind === 'LEAF'
        ? `${parent}\n\n### Outcome\n\nPlan ID: ${node.ref}\n\n${node.title}\n\n### Acceptance criteria\n\n${node.fields.Acceptance}\n\nDefinition of done (§20.3):\n\n${done}\n\n### Implementation notes\n\nSpec: ${node.specLinks.join(', ')}\n\nFiles: ${node.fields.Files}\n\nProvides: ${node.fields.Provides}\n\n### Validation\n\nSatisfy the acceptance criteria and §20.3 using the checks in the linked spec and AGENTS.md.\n\n### Dependencies\n\n${node.blockedBy.join(', ') || 'None'}`
        : `${parent}\n\n### What\n\n${node.kind === 'EPIC' ? node.goal : node.title}\n\n${node.fields ? `Plan ID: ${node.ref}\n\n` : ''}### Why\n\nDeliver [${name}](${specLink}) within this plan's boundaries.\n\n### How\n\n${node.kind === 'EPIC' ? `Exit criteria: ${node.exit}` : node.fields ? `Provides: ${node.fields.Provides}\n\nFiles: ${node.fields.Files}\n\nSpec: ${node.specLinks.join(', ')}\n\nScope inherited by children:\n\n${node.fields.Acceptance}\n\n${done}` : 'Complete the phase epics through their native sub-issues.'}\n\nChildren: ${nodes
            .filter((n) => n.parent === node.ref)
            .map((n) => n.ref)
            .join(', ')}\n\nBlocked by: ${node.blockedBy.join(', ') || 'None'}`;
  }
  return {
    version: 1,
    specPath,
    fingerprint: hash(text),
    context,
    deferred: [...deferred],
    errors,
    nodes,
  };
}

// A node waits on its blockers, and a container also waits on its children.
function cycles(nodes) {
  const found = [];
  const byRef = new Map();
  for (const node of nodes) if (!byRef.has(node.ref)) byRef.set(node.ref, node);
  const visiting = new Set();
  const visited = new Set();
  const visit = (ref, chain = []) => {
    if (visiting.has(ref)) {
      found.push(`${ref}: dependency cycle ${[...chain, ref].join(' -> ')}`);
      return;
    }
    if (visited.has(ref)) return;
    visiting.add(ref);
    const dependencies = [
      ...(byRef.get(ref)?.blockedBy || []),
      ...nodes.filter((n) => n.parent === ref).map((n) => n.ref),
    ];
    for (const blocker of dependencies) visit(blocker, [...chain, ref]);
    visiting.delete(ref);
    visited.add(ref);
  };
  for (const node of nodes) visit(node.ref);
  return found;
}

// Adds the triager's EDGES line to the drafts: each `<waiting> <- <blocker>`
// pair of leaves joins the waiting leaf's blocked-by refs and its
// Dependencies section. Returns the errors; the plan is unchanged when any
// edge is malformed, names an unknown or non-leaf ref, or closes a cycle, or
// when a waiting leaf's body does not end with its Dependencies section.
export function applyEdges(plan, line) {
  const match = /^EDGES \| (.+)$/.exec(line.trim());
  if (!match) return [`EDGES: expected "EDGES | <edges>" or "EDGES | none"`];
  if (match[1].trim() === 'none') return [];
  const errors = [];
  const byRef = new Map(plan.nodes.map((node) => [node.ref, node]));
  const blockedBy = new Map(
    plan.nodes.map((node) => [node.ref, [...node.blockedBy]]),
  );
  for (const item of match[1].split(';').map((part) => part.trim())) {
    const edge = /^(\S+) <- (\S+): \S.*$/.exec(item);
    if (!edge) {
      errors.push(`EDGES: malformed edge "${item}"`);
      continue;
    }
    const [, waiting, blocker] = edge;
    const unknown = [waiting, blocker].filter(
      (ref) => byRef.get(ref)?.kind !== 'LEAF',
    );
    if (unknown.length) {
      errors.push(`EDGES: ${unknown.join(', ')} is not a leaf in this plan`);
      continue;
    }
    if (waiting === blocker) {
      errors.push(`EDGES: ${waiting} cannot block itself`);
      continue;
    }
    blockedBy.set(waiting, unique([...blockedBy.get(waiting), blocker]));
  }
  if (errors.length) return errors;
  const updated = plan.nodes.map((node) => ({
    ...node,
    blockedBy: blockedBy.get(node.ref),
  }));
  const found = cycles(updated);
  if (found.length) return found;
  const dependencies = /### Dependencies\n\n[^\n]*$/;
  const changed = plan.nodes.filter(
    (node) => blockedBy.get(node.ref).length !== node.blockedBy.length,
  );
  const missing = changed.filter((node) => !dependencies.test(node.body));
  if (missing.length)
    return missing.map(
      (node) => `EDGES: ${node.ref} body does not end with its Dependencies`,
    );
  for (const node of changed) {
    node.blockedBy = blockedBy.get(node.ref);
    node.body = node.body.replace(
      dependencies,
      `### Dependencies\n\n${node.blockedBy.join(', ')}`,
    );
  }
  return [];
}

export function printTree(plan) {
  const rows = plan.nodes.map((node, i) =>
    [
      node.number ? `#${node.number}` : String(i + 1),
      node.kind,
      node.ref,
      node.size || '-',
      node.priority,
      node.parent || '-',
      node.blockedBy.join(', ') || '-',
      node.labels.join(', '),
      node.title,
    ]
      .map((cell) => cell.replaceAll('|', '\\|'))
      .join(' | '),
  );
  return [
    'Number | Kind | Plan ID | Size | Priority | Parent | Blocked by | Labels | Title',
    '--- | --- | --- | --- | --- | --- | --- | --- | ---',
    ...rows,
  ].join('\n');
}

const cli = defineCli(
  [
    'Usage: node scripts/spec-to-issues.mjs plan <spec-path> [--output <drafts.json>]',
    '       node scripts/spec-to-issues.mjs edges <drafts.json> <edges-line> [--output <triaged.json>]',
  ].join('\n'),
  ['output'],
);
// Drafts and triaged plans live outside the repository and are never
// overwritten.
function writeOutside(path, plan) {
  const output = resolve(path);
  const outputDirectory = realpathSync(resolve(output, '..'));
  if (!isOutside(root, outputDirectory) || inCheckout(outputDirectory))
    throw cliError(cli, 'Draft output must be outside the repository');
  writeFileSync(output, JSON.stringify(plan, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
export function main(argv) {
  try {
    const { options, positionals } = parseCli(argv, cli);
    if (positionals[0] === 'edges') {
      if (positionals.length !== 3)
        throw cliError(cli, 'Expected edges <drafts.json> <edges-line>');
      const plan = JSON.parse(readFileSync(resolve(positionals[1]), 'utf8'));
      const errors = applyEdges(plan, positionals[2]);
      if (errors.length) throw new Error(errors.join('\n'));
      if (options.output) writeOutside(options.output, plan);
      else process.stdout.write(printTree(plan) + '\n');
      return 0;
    }
    if (positionals.length !== 2 || positionals[0] !== 'plan')
      throw cliError(cli, 'Expected plan <spec-path> or edges');
    const input = realpathSync(resolve(positionals[1]));
    const specPath = relative(root, input);
    if (isOutside(root, input))
      throw cliError(cli, 'Spec must be inside the repository');
    const catalog = JSON.parse(
      readFileSync(new URL('../.github/labels.json', import.meta.url), 'utf8'),
    );
    const plan = buildPlan(readFileSync(resolve(root, specPath), 'utf8'), {
      specPath,
      repository: catalog.repository,
      labels: catalog.labels.map((l) => l.name),
    });
    if (plan.errors.length) throw new Error(plan.errors.join('\n'));
    if (options.output) writeOutside(options.output, plan);
    else process.stdout.write(printTree(plan) + '\n');
    return 0;
  } catch (error) {
    if (error instanceof CliHelp) {
      process.stdout.write(error.message + '\n');
      return 0;
    }
    process.stderr.write(error.message + '\n');
    return 1;
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
