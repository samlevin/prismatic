import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  binding,
  check,
  generate,
  loadPolicy,
  implementationDispatch,
  implementationEffort,
  include,
  effortAnnouncement,
  parseReviewReport,
  parseSource,
  placeholders,
  prefix,
  publishReview,
  render,
  renderBody,
  renderRole,
  renderWorkflow,
  resolve,
  reviewEvent,
  REVIEW_VERDICTS,
  substitute,
  TOOLS,
} from './agent-policy.mjs';

const policy = loadPolicy();
const PREFIX = prefix(policy);
// The same policy bound to another repository with no CI-applied infrastructure.
const other = {
  ...policy,
  binding: {
    namespace: 'other',
    label: 'Other',
    repository: 'example/other',
    project: { owner: 'example', number: 7, name: 'Other delivery' },
    docs: { triage: 'TRIAGE.md', workflow: 'AGENTS.md', guides: ['AGENTS.md'] },
    features: { infrastructure: false },
  },
};

test('missing and unknown commands show an actionable error and combined help', () => {
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [new URL('./agent-policy.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  for (const option of [
    '--tool',
    '--role',
    '--pr',
    '--base',
    '--head',
    '--report',
  ])
    assert.ok(help.stdout.includes(option), option);
  for (const [args, message] of [
    [[], 'Name a command'],
    [['unknown'], 'Unknown command unknown'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${message}\n\n${help.stdout}`);
  }
});

test('the binding resolves every placeholder and feature section', () => {
  assert.equal(PREFIX, `${policy.binding.namespace}-`);
  assert.deepEqual(placeholders(other), {
    prefix: 'other-',
    label: 'Other',
    repository: 'example/other',
    'project.owner': 'example',
    'project.number': '7',
    'project.name': 'Other delivery',
    'project.url': 'https://github.com/users/example/projects/7',
    'docs.triage': 'TRIAGE.md',
    'docs.workflow': 'AGENTS.md',
    'docs.guides': '`AGENTS.md`',
  });
  assert.equal(
    placeholders({
      ...other,
      binding: {
        ...other.binding,
        docs: { ...other.binding.docs, guides: ['A.md', 'B.md', 'C.md'] },
      },
    })['docs.guides'],
    '`A.md`, `B.md`, or `C.md`',
  );
  const text =
    'Spawn {{prefix}}implementer in {{repository}}{{#infrastructure}} (infra){{/infrastructure}}.';
  assert.equal(
    substitute(text, policy),
    `Spawn ${PREFIX}implementer in ${policy.binding.repository}${
      policy.binding.features.infrastructure ? ' (infra)' : ''
    }.`,
  );
  assert.equal(
    substitute(text, other),
    'Spawn other-implementer in example/other.',
  );
  assert.throws(
    () => substitute('{{nope}}', policy),
    /Unknown placeholder: nope/,
  );
  assert.equal(substitute('a \\{{prefix}} b', policy), 'a {{prefix}} b');
  assert.throws(
    () => substitute('{{#magic}}x{{/magic}}', policy),
    /Unknown feature section: magic/,
  );
  assert.throws(
    () => substitute('{{#infrastructure}}x', policy),
    /Unbalanced feature section/,
  );
  assert.throws(
    () => binding({ ...policy, binding: undefined }),
    /missing binding/,
  );
  assert.throws(
    () =>
      binding({
        ...policy,
        binding: { ...policy.binding, namespace: 'Bad-Name' },
      }),
    /namespace must be lowercase/,
  );
  assert.throws(
    () =>
      binding({
        ...policy,
        binding: { ...policy.binding, project: { owner: 'x', name: 'y' } },
      }),
    /missing project.number/,
  );
});

test('worktree ignores preserve tracked agent definitions and configuration', () => {
  const gitignore = readFileSync(
    new URL('../.gitignore', import.meta.url),
    'utf8',
  ).split(/\r?\n/);
  const worktrees = ['.claude/worktrees/', '.codex/worktrees/'];
  for (const path of worktrees)
    assert.ok(gitignore.includes(path), `missing .gitignore entry: ${path}`);

  const probes = worktrees.map((path) => `${path}ignore-probe`);
  const definitions = [...render().keys()].filter((path) =>
    /^\.(claude|codex)\//.test(path),
  );
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: new URL('..', import.meta.url),
    input: [...probes, ...definitions, '.codex/config.toml'].join('\n') + '\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), probes);
});

test('local agent files are ignored while tracked agent files stay tracked', () => {
  const local = [
    'CLAUDE.local.md',
    '.claude/scheduled_tasks.lock',
    '.playwright-mcp/ignore-probe',
  ];
  const tracked = [
    'CLAUDE.md',
    'AGENTS.md',
    '.agents/policy.json',
    '.codex/config.toml',
    ...[...render().keys()].filter((path) =>
      /^\.(claude|codex|agents)\//.test(path),
    ),
  ];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: new URL('..', import.meta.url),
    input: [...local, ...tracked].join('\n') + '\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), local);
});

test('generated output carries no unresolved placeholder and follows the binding', () => {
  for (const [path, content] of render()) {
    // The maintainer skill documents the placeholders literally.
    if (!path.includes(`/${PREFIX}agents/`))
      assert.doesNotMatch(content, /\{\{/, path);
    assert.ok(path.includes(`/${PREFIX}`), path);
  }
  const resolved = resolve(other, { tool: 'claude', role: 'implementer' });
  assert.equal(resolved.spawn.subagent_type, 'other-implementer');
});

test('every role and capability resolves to a supported setting for both tools', () => {
  for (const tool of TOOLS) {
    for (const role of Object.keys(policy.roles)) {
      const resolved = resolve(policy, { tool, role });
      assert.equal(resolved.source.model, 'policy');
      assert.equal(resolved.source.effort, 'policy');
      assert.ok(resolved.model);
      assert.ok(resolved.effort);
    }
    for (const capability of Object.keys(policy.capabilities))
      assert.ok(resolve(policy, { tool, capability }).model);
  }
});

test('capabilities have explicit, differentiated policies per tool', () => {
  const required = [
    'issue-creation',
    'issue-triage',
    'implementation',
    'code-review',
    'security-review',
  ];
  for (const capability of required)
    for (const tool of TOOLS)
      assert.ok(policy.capabilities[capability][tool].model, capability);
  for (const tool of TOOLS) {
    const settings = new Set(
      required.map((capability) => {
        const entry = policy.capabilities[capability][tool];
        return `${entry.model}/${entry.effort}`;
      }),
    );
    assert.ok(settings.size > 1, `${tool} policy is undifferentiated`);
  }
});

test('a prompt override replaces only the named setting', () => {
  const base = resolve(policy, { tool: 'claude', role: 'implementer' });
  const modelOnly = resolve(policy, {
    tool: 'claude',
    role: 'implementer',
    model: 'sonnet',
  });
  assert.equal(modelOnly.model, 'sonnet');
  assert.equal(modelOnly.effort, base.effort);
  assert.deepEqual(modelOnly.source, { model: 'override', effort: 'policy' });
  const effortOnly = resolve(policy, {
    tool: 'codex',
    role: 'code-reviewer',
    effort: 'xhigh',
  });
  assert.equal(
    effortOnly.model,
    policy.capabilities['code-review'].codex.model,
  );
  assert.equal(effortOnly.effort, 'xhigh');
  assert.deepEqual(effortOnly.source, { model: 'policy', effort: 'override' });
  const both = resolve(policy, {
    tool: 'codex',
    role: 'implementer',
    model: 'gpt-6-sol',
    effort: 'ultra',
  });
  assert.deepEqual(both.spawn, {
    agent_type: `${PREFIX}implementer`,
    model: 'gpt-6-sol',
    reasoning_effort: 'ultra',
    fork_turns: 'none',
  });
});

test('spawn parameters use each tool vocabulary and the namespaced agent', () => {
  const claude = resolve(policy, { tool: 'claude', role: 'security-reviewer' });
  assert.deepEqual(claude.spawn, {
    subagent_type: `${PREFIX}security-reviewer`,
    model: claude.model,
    effort: claude.effort,
  });
  const codex = resolve(policy, { tool: 'codex', role: 'security-reviewer' });
  assert.equal(codex.spawn.agent_type, `${PREFIX}security-reviewer`);
  assert.equal(codex.spawn.reasoning_effort, codex.effort);
  assert.equal(codex.spawn.fork_turns, 'none');
  assert.equal(
    resolve(policy, { tool: 'claude', capability: 'issue-creation' }).spawn
      .subagent_type,
    null,
  );
});

test('unsupported models and efforts fail instead of falling back', () => {
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'claude',
        role: 'implementer',
        model: 'gpt-6-luna',
      }),
    /Unsupported claude model "gpt-6-luna"/,
  );
  assert.throws(
    () =>
      resolve(policy, { tool: 'codex', role: 'implementer', model: 'opus' }),
    /Unsupported codex model "opus"/,
  );
  assert.throws(
    () =>
      resolve(policy, { tool: 'claude', role: 'implementer', effort: 'ultra' }),
    /Unsupported claude effort "ultra"/,
  );
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'codex',
        role: 'implementer',
        model: 'gpt-6-luna',
        effort: 'ultra',
      }),
    /Unsupported codex effort "ultra" for model "gpt-6-luna"/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'cursor', role: 'implementer' }),
    /Unknown tool/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'claude', role: 'reviewer' }),
    /Unknown role/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'claude', capability: 'deploy' }),
    /Unknown capability/,
  );
});

test('a full Claude model ID is accepted with the shared effort levels', () => {
  const resolved = resolve(policy, {
    tool: 'claude',
    role: 'code-reviewer',
    model: 'claude-opus-5-5',
    effort: 'max',
  });
  assert.equal(resolved.model, 'claude-opus-5-5');
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'claude',
        role: 'code-reviewer',
        model: 'gpt-x',
      }),
    /Unsupported claude model/,
  );
});

const source = `---
name: sample
description: Sample role.
claude:
  tools: Read, Grep
  color: blue
codex:
  default_permissions: ":read-only"
---
Shared line.
<!-- claude-only -->
Claude line.
<!-- /claude-only -->
<!-- codex-only -->
Codex line.
<!-- /codex-only -->
Last shared line.
`;

test('tool-only blocks render for one tool and vanish for the other', () => {
  const { body } = parseSource(source);
  assert.equal(
    renderBody(body, 'claude'),
    'Shared line.\nClaude line.\nLast shared line.\n',
  );
  assert.equal(
    renderBody(body, 'codex'),
    'Shared line.\nCodex line.\nLast shared line.\n',
  );
});

test('a plain frontmatter value containing " #" is rejected, not truncated', () => {
  const truncated = `---
name: implement
description: Use for "implement #N" or an issue URL.
---
Body
`;
  assert.throws(
    () => parseSource(truncated),
    /Quote the frontmatter value of description/,
  );
  const quoted = truncated.replace(
    'description: Use for "implement #N" or an issue URL.',
    'description: "Use for \\"implement #N\\" or an issue URL."',
  );
  assert.equal(
    parseSource(quoted).meta.description,
    'Use for "implement #N" or an issue URL.',
  );
  assert.equal(
    parseSource(`---\nname: x\nargument-hint: <#N | URL>\n---\nBody\n`).meta[
      'argument-hint'
    ],
    '<#N | URL>',
  );
});

test('Claude agents pin the policy; Codex agents omit model and effort', () => {
  const sample = {
    ...policy,
    roles: { ...policy.roles, sample: 'code-review' },
  };
  const claude = renderRole(sample, 'sample', source, 'claude');
  assert.match(claude, new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.match(claude, /^tools: Read, Grep$/m);
  assert.match(
    claude,
    new RegExp(
      `^model: ${policy.capabilities['code-review'].claude.model}$`,
      'm',
    ),
  );
  assert.match(
    claude,
    new RegExp(
      `^effort: ${policy.capabilities['code-review'].claude.effort}$`,
      'm',
    ),
  );
  assert.match(claude, /Claude line\./);
  assert.doesNotMatch(claude, /Codex line\./);
  const codex = renderRole(sample, 'sample', source, 'codex');
  assert.match(codex, new RegExp(`^name = "${PREFIX}sample"$`, 'm'));
  assert.match(codex, /^default_permissions = ":read-only"$/m);
  assert.doesNotMatch(codex, /^model/m);
  assert.doesNotMatch(codex, /^model_reasoning_effort/m);
  assert.match(codex, /Codex line\./);
  assert.doesNotMatch(codex, /Claude line\./);
  assert.match(codex, /developer_instructions = '''\n[\s\S]*'''\n$/);
});

test('workflows become a Claude skill and a Codex skill with a manifest', () => {
  const workflow = `---
name: sample
description: Sample workflow.
argument-hint: "[target]"
capability: issue-creation
claude:
  disable-model-invocation: true
codex:
  display_name: "Sample: Sample"
  allow_implicit_invocation: false
---
Body.
`;
  const claude = renderWorkflow(policy, 'sample', workflow, 'claude');
  assert.deepEqual(Object.keys(claude), ['SKILL.md']);
  assert.match(claude['SKILL.md'], new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.match(claude['SKILL.md'], /^argument-hint: '\[target\]'$/m);
  assert.match(claude['SKILL.md'], /^disable-model-invocation: true$/m);
  assert.match(
    claude['SKILL.md'],
    new RegExp(
      `^model: ${policy.capabilities['issue-creation'].claude.model}$`,
      'm',
    ),
  );
  const codex = renderWorkflow(policy, 'sample', workflow, 'codex');
  assert.deepEqual(Object.keys(codex).sort(), [
    'SKILL.md',
    'agents/openai.yaml',
  ]);
  assert.match(codex['SKILL.md'], new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.doesNotMatch(codex['SKILL.md'], /^model:/m);
  assert.match(codex['agents/openai.yaml'], /display_name: 'Sample: Sample'/);
  assert.match(codex['agents/openai.yaml'], /allow_implicit_invocation: false/);
});

test('every role and workflow renders for both tools with matching bodies', () => {
  const files = render();
  const names = [...files.keys()];
  for (const role of Object.keys(policy.roles)) {
    assert.ok(names.includes(`.claude/agents/${PREFIX}${role}.md`), role);
    assert.ok(names.includes(`.codex/agents/${PREFIX}${role}.toml`), role);
  }
  for (const skill of [
    'agents',
    'implement',
    'create-github-issue',
    'spec-to-issues',
    'review-code',
    'review-security',
    'plain-language',
    'stack',
  ]) {
    assert.ok(
      names.includes(`.claude/skills/${PREFIX}${skill}/SKILL.md`),
      skill,
    );
    assert.ok(
      names.includes(`.agents/skills/${PREFIX}${skill}/SKILL.md`),
      skill,
    );
    assert.ok(
      names.includes(`.agents/skills/${PREFIX}${skill}/agents/openai.yaml`),
      skill,
    );
  }
  // Shared references are copied into both skills byte for byte.
  assert.equal(
    files.get(
      `.claude/skills/${PREFIX}create-github-issue/references/github-operations.md`,
    ),
    files.get(
      `.agents/skills/${PREFIX}create-github-issue/references/github-operations.md`,
    ),
  );
  // Tool-only blocks aside, the two renderings of a source are the same text:
  // every shared line of every role, workflow, and Markdown reference appears
  // in both tools' output.
  for (const [source, outputs] of sourcePairs()) {
    const text = substitute(
      include(readFileSync(new URL(`../${source}`, import.meta.url), 'utf8')),
      policy,
    );
    const body = source.includes('/references/')
      ? text
      : parseSource(text).body;
    for (const line of sharedLines(body))
      for (const output of outputs)
        assert.ok(
          files.get(output).includes(line),
          `${output}: ${line.slice(0, 60)}`,
        );
  }
});

// Each canonical source with its Claude Code and Codex renderings.
function sourcePairs() {
  const pairs = [];
  for (const role of Object.keys(policy.roles))
    pairs.push([
      `.agents/roles/${role}.md`,
      [
        `.claude/agents/${PREFIX}${role}.md`,
        `.codex/agents/${PREFIX}${role}.toml`,
      ],
    ]);
  for (const path of render().keys()) {
    const match = path.match(
      new RegExp(`^\\.claude/skills/${PREFIX}([^/]+)/(.+\\.md)$`),
    );
    if (!match) continue;
    const [, skill, file] = match;
    pairs.push([
      file === 'SKILL.md'
        ? `.agents/workflows/${skill}.md`
        : `.agents/workflows/${skill}/${file}`,
      [path, `.agents/skills/${PREFIX}${skill}/${file}`],
    ]);
  }
  return pairs;
}

// The non-empty lines outside every tool-only block. Codex TOML keeps the
// text verbatim, so the same lines must appear in both renderings.
function sharedLines(body) {
  return body
    .replace(/<!-- (claude|codex)-only -->\n[\s\S]*?<!-- \/\1-only -->\n?/g, '')
    .split('\n')
    .filter((line) => line.trim());
}

// Report and relay wording that callers depend on. Each check matches a short
// phrase on one rendered line, so rewording elsewhere does not break it.
const lineWith = (content, ...phrases) =>
  content
    .split('\n')
    .find((line) =>
      phrases.every((phrase) =>
        typeof phrase === 'string' ? line.includes(phrase) : phrase.test(line),
      ),
    );

test('caller skills relay the agent result verbatim in both tools', () => {
  const files = render();
  for (const skill of ['implement', 'review-code', 'review-security'])
    for (const path of [
      `.claude/skills/${PREFIX}${skill}/SKILL.md`,
      `.agents/skills/${PREFIX}${skill}/SKILL.md`,
    ])
      assert.ok(
        lineWith(
          files.get(path),
          /\b(relay|print)\b/i,
          'Requested settings:',
          /\bverbatim\b/,
        ),
        `${path} must relay the result and its Requested settings line verbatim`,
      );
});

test('every role reports its requested settings in both tools', () => {
  const files = render();
  for (const role of Object.keys(policy.roles))
    for (const path of [
      `.claude/agents/${PREFIX}${role}.md`,
      `.codex/agents/${PREFIX}${role}.toml`,
    ])
      assert.ok(
        files.get(path).includes('Requested settings: Policy:'),
        `${path} must return a Requested settings: Policy: line`,
      );
});

// The leaf delivery procedure that the main thread and an isolated
// implementer both follow, in each tool's package.
const DELIVERY = [
  `.claude/skills/${PREFIX}implement/references/delivery.md`,
  `.agents/skills/${PREFIX}implement/references/delivery.md`,
];
const QUEUE = DELIVERY.map((path) => path.replace('delivery.md', 'queue.md'));
const IMPLEMENT = [
  `.claude/skills/${PREFIX}implement/SKILL.md`,
  `.agents/skills/${PREFIX}implement/SKILL.md`,
];
const STACK = [
  `.claude/skills/${PREFIX}stack/SKILL.md`,
  `.agents/skills/${PREFIX}stack/SKILL.md`,
];

// The text under one `## ` heading of a rendered Markdown file.
function section(content, heading) {
  const start = content.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = content.indexOf('\n## ', start + 1);
  return content.slice(start, end === -1 ? undefined : end);
}

test('the delivery owner sends the reviewer its own resolved policy line', () => {
  const files = render();
  for (const path of DELIVERY)
    assert.ok(
      lineWith(
        files.get(path),
        'review_mode=pre_pr',
        "reviewer's own `Policy:` line composed from that resolver output",
        `role=${PREFIX}code-reviewer`,
      ),
      `${path} pre-PR packet must carry the reviewer's resolved Policy: line`,
    );
});

test('the delivery owner never sets In review and reports the state as read', () => {
  const files = render();
  for (const path of DELIVERY) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, /^Never:/, 'In review or Done'),
      `${path} must forbid setting In review or Done`,
    );
    assert.ok(
      lineWith(
        section(content, 'Claim'),
        'In progress is the only project status you ever set',
      ),
      `${path} claim step must limit the agent to In progress`,
    );
    assert.ok(
      lineWith(section(content, 'PR'), "Leave the issue's status alone"),
      `${path} PR step must leave In review to automation`,
    );
    assert.ok(
      lineWith(content, /^Return /, 'project state as read'),
      `${path} handoff must report the project state as read`,
    );
    assert.doesNotMatch(content, /Move the issue to In review/i, path);
  }
});

test('removed coordination roles cannot be selected through any entry point', () => {
  assert.deepEqual(Object.keys(policy.roles).sort(), [
    'code-reviewer',
    'implementer',
    'issue-triager',
    'security-reviewer',
  ]);
  for (const capability of ['orchestration', 'stack-management'])
    assert.equal(policy.capabilities[capability], undefined, capability);
  for (const tool of TOOLS)
    for (const role of ['orchestrator', 'stack-manager'])
      assert.throws(
        () => resolve(policy, { tool, role }),
        /Unknown role/,
        `${tool} ${role}`,
      );
  const files = render();
  const agents = [...files.keys()].filter((path) =>
    /^\.(claude|codex)\/agents\//.test(path),
  );
  assert.deepEqual(
    agents.sort(),
    Object.keys(policy.roles)
      .flatMap((role) => [
        `.claude/agents/${PREFIX}${role}.md`,
        `.codex/agents/${PREFIX}${role}.toml`,
      ])
      .sort(),
  );
  for (const [path, content] of files)
    assert.doesNotMatch(
      content,
      new RegExp(`${PREFIX}(orchestrator|stack-manager)\\b`),
      path,
    );
  // The CLI refuses the removed roles as well.
  for (const role of ['orchestrator', 'stack-manager']) {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./agent-policy.mjs', import.meta.url).pathname,
        'resolve',
        '--tool',
        'claude',
        '--role',
        role,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, role);
    assert.match(result.stderr, /Unknown role/, role);
  }
});

test('default delivery dispatches isolated implementers and keeps the main thread thin', () => {
  const files = render();
  for (const path of IMPLEMENT) {
    const content = files.get(path);
    for (const target of ['Leaf issue', 'PR rework'])
      assert.ok(
        lineWith(
          content,
          `| ${target} |`,
          `isolated ${PREFIX}implementer`,
          'references/delivery.md',
        ),
        path,
      );
    for (const requirement of [
      'explicit `inline` keyword',
      'queue ledger and fixed result fields only',
      'Do not read source or diffs',
      'detailed review reports',
      'scripts/delivery-queue.mjs',
      "leaf's ledger line",
      'actual base branch and SHA',
      'Owned by other running leaves:',
      'reads its own issue',
      'never spawns another implementer',
    ])
      assert.ok(content.includes(requirement), `${path}: ${requirement}`);
    assert.doesNotMatch(content, /concrete-benefit|concrete benefit/);
    assert.match(content, /session settings.*cannot change/s);
    assert.match(content, /Advisory policy:/);
    assert.doesNotMatch(content, /^model:/m);
  }
  const [claude, codex] = IMPLEMENT.map((path) =>
    section(files.get(path), 'Dispatch and continuation'),
  );
  assert.match(claude, new RegExp(`subagent_type: ${PREFIX}implementer`));
  assert.match(claude, /`model` and `effort` explicitly copied/);
  assert.match(
    codex,
    /`agent_type`, `model`, and `reasoning_effort` explicitly copied/,
  );
  assert.match(codex, /fork_turns: "none"/);
  assert.match(claude, /SendMessage/);
  assert.match(codex, /continue mechanism/);
});

test('a container runs as a dependency queue in the owning thread', () => {
  const files = render();
  for (const path of QUEUE) {
    const content = files.get(path);
    assert.ok(lineWith(content, 'No separate orchestrator agent'), path);
    assert.ok(lineWith(content, 'Detect cycles in the blocked-by edges'), path);
    assert.ok(lineWith(content, '`resume`', 'Reuse its pushed branch'), path);
    assert.ok(lineWith(content, '`waiting`', 'blocker is unmet'), path);
    assert.ok(
      lineWith(
        content,
        'Delivery is sequential by default',
        'record its result',
        'before you start the next leaf',
      ),
      `${path} must deliver one leaf at a time and record each result`,
    );
    const parallel = section(content, 'Parallel exception');
    assert.match(parallel, /explicitly asked for parallel delivery/);
    assert.match(parallel, /different groups/);
    assert.match(parallel, /no overlapping files or shared contracts/);
    assert.match(parallel, /At most one leaf per group runs at a time/);
    assert.match(parallel, /Never infer, form, extend, or merge groups/);
    // Each concurrent implementer learns what the other running leaves own.
    assert.ok(
      lineWith(
        parallel,
        'carries an `Owned by other running leaves:` field',
        'issue numbers of the other leaves',
        'files and shared contracts',
      ),
      `${path} must hand each concurrent leaf the other leaves' ownership`,
    );
    // Resume checks out the existing branch instead of creating it.
    assert.ok(
      lineWith(content, '`resume`', 'git worktree add <path> <branch>'),
      `${path} must check out the existing branch on resume`,
    );
    // A claim whose worktree is missing here is never taken over silently.
    assert.ok(
      lineWith(content, '`resume`', '`git worktree list`'),
      `${path} must tie resume to a worktree in this checkout`,
    );
    assert.ok(
      lineWith(content, 'whose worktree is missing here', 'Ask the person'),
      `${path} must treat a missing worktree as owned elsewhere`,
    );
  }
  // Concurrent leaves really run at the same time in each tool.
  assert.match(
    section(files.get(QUEUE[0]), 'Parallel exception'),
    /`run_in_background: true`/,
  );
  // Claude records each background result as it arrives and lets a finished
  // group start its next leaf while other groups still run.
  for (const fragment of [
    'Record each result as its notification arrives',
    'the next ready leaf in that group may start while leaves in other groups still run',
    'Before any early return, wait for every running implementer and record each result',
  ])
    assert.ok(
      section(files.get(QUEUE[0]), 'Parallel exception').includes(fragment),
      fragment,
    );
  assert.doesNotMatch(
    section(files.get(QUEUE[0]), 'Parallel exception'),
    /blocks until it returns/,
  );
  assert.match(
    section(files.get(QUEUE[1]), 'Parallel exception'),
    /`spawn_agent` returns at once/,
  );
  const creation = readFileSync(
    new URL('../.agents/independence-groups.md', import.meta.url),
    'utf8',
  );
  assert.ok(
    lineWith(creation, `${PREFIX}implement\` reads only the lines`),
    'independence-groups.md must name the queue as the record reader',
  );
});

test('the delivery owner runs stack operations itself through the shared stack skill', () => {
  const files = render();
  for (const path of DELIVERY)
    assert.ok(
      lineWith(
        section(files.get(path), 'Stack'),
        `Run every stack operation yourself with the ${PREFIX}stack skill`,
        'in the worktree you created',
      ),
      path,
    );
  assert.match(
    section(files.get(DELIVERY[0]), 'Stack'),
    new RegExp(`Skill tool \\(\`${PREFIX}stack\`\\)`),
  );
  assert.match(
    section(files.get(DELIVERY[1]), 'Stack'),
    new RegExp(`\\$${PREFIX}stack`),
  );
  for (const path of STACK) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, 'You run this skill yourself', 'worktree you created'),
      path,
    );
    assert.match(content, /git worktree list --porcelain/, path);
    const never = section(content, 'Never run');
    for (const phrase of [
      '`gh stack sync`',
      '`gh stack rebase`',
      '`--no-trunk`',
      '`gh stack push`',
      '`gh stack submit`',
      'rebase.updateRefs=false',
      'bare `git push --force`',
    ])
      assert.ok(never.includes(phrase), `${path} never runs: ${phrase}`);
    assert.ok(
      lineWith(never, '`gh stack push`', 'fetch', 'previously verified SHA'),
      `${path} must explain why the stack push lease is unsafe`,
    );
    const operations = section(content, 'Operations');
    assert.match(
      operations,
      /git -c rebase\.updateRefs=false rebase --onto/,
      path,
    );
    assert.match(
      operations,
      /--force-with-lease=<branch>:<expected SHA>/,
      path,
    );
    assert.match(operations, /gh stack link --base main <PR URL>/, path);
    assert.match(operations, /Never adopt, rebase, or push the prerequisite/);
    // Rework and resume of an earlier delivery's branch have working paths.
    assert.ok(
      lineWith(content, 'earlier delivery', 'head branch of the target PR'),
      `${path} must define ownership for rework and resume`,
    );
    assert.match(
      operations,
      /rebase\.updateRefs=false rebase --onto <new parent head> <old parent head>`, then push with `git push --force-with-lease=<branch>:<verified remote head> origin HEAD:<branch>`/,
      path,
    );
    assert.match(operations, /`git worktree add <path> <branch>`/, path);
    assert.ok(
      lineWith(content, 'Authority:', 'never covers merges'),
      `${path} must not authorize merges`,
    );
  }
});

test('independent review stays a separate fresh-context gate on mandatory paths', () => {
  const files = render();
  for (const path of DELIVERY) {
    const review = section(files.get(path), 'Pre-PR review');
    for (const scope of [
      '`.agents/`',
      '`AGENTS.md`',
      '`scripts/agent-policy*`',
      '`.github/workflows/`',
    ])
      assert.ok(
        lineWith(review, 'always required', scope),
        `${path}: ${scope}`,
      );
    assert.match(review, new RegExp(`fresh ${PREFIX}code-reviewer`));
    assert.match(review, /Leave out your self-assessment/);
    assert.match(review, /exact base\/head pair/);
    assert.match(review, /After two rejected rounds, return BLOCKED/);
    assert.match(review, /Never self-approve/);
    assert.ok(
      lineWith(files.get(path), 'Once a PR exists, never invoke'),
      `${path} must keep requested review separate from pre-PR review`,
    );
    assert.ok(
      lineWith(files.get(path), /^Never:/, `${PREFIX}security-reviewer`),
      `${path} must never start a security review`,
    );
  }
  assert.match(
    files.get(`.claude/skills/${PREFIX}review-security/SKILL.md`),
    /^disable-model-invocation: true$/m,
  );
  assert.match(
    files.get(`.agents/skills/${PREFIX}review-security/agents/openai.yaml`),
    /allow_implicit_invocation: false/,
  );
});

test('an isolated implementer follows the shared procedure and delegates nothing else', () => {
  const files = render();
  const claude = files.get(`.claude/agents/${PREFIX}implementer.md`);
  const codex = files.get(`.codex/agents/${PREFIX}implementer.toml`);
  assert.match(claude, /^isolation: worktree$/m);
  assert.match(
    claude,
    new RegExp(
      `git show origin/main:\\.claude/skills/${PREFIX}implement/references/delivery\\.md`,
    ),
  );
  assert.match(
    codex,
    new RegExp(
      `git show origin/main:\\.agents/skills/${PREFIX}implement/references/delivery\\.md`,
    ),
  );
  for (const content of [claude, codex]) {
    assert.ok(lineWith(content, 'Never spawn another implementer'));
    assert.ok(lineWith(content, 'BLOCKED: container'));
    assert.ok(
      lineWith(content, '`Owned by other running leaves:`', 'return BLOCKED'),
    );
  }
});

test('issue filing classifies inline and reserves the triager for independent judgment', () => {
  const files = render();
  for (const path of [
    `.claude/skills/${PREFIX}create-github-issue/SKILL.md`,
    `.agents/skills/${PREFIX}create-github-issue/SKILL.md`,
  ]) {
    const triage = section(files.get(path), 'Triage');
    assert.match(triage, /Classify inline by default/);
    for (const reason of [
      '- Classification:',
      '- Decomposition:',
      '- Dependency judgment:',
    ])
      assert.ok(triage.includes(reason), `${path}: ${reason}`);
    assert.match(triage, /Only the triager forms independence groups/);
    assert.match(triage, /the batch files two or more leaves/);
    assert.match(triage, /single leaf .* still classifies inline/);
    assert.match(triage, /`EDGES` line/);
    const publish = section(files.get(path), 'Publish');
    assert.match(
      publish,
      /native parent links, then blocked-by edges, planned and triager-returned alike/,
    );
  }
  const role = readFileSync(
    new URL('../.agents/roles/issue-triager.md', import.meta.url),
    'utf8',
  );
  for (const rule of [
    'EDGES | <waiting ref> <- <blocker ref>: <=15-word reason',
    '`EDGES | none`',
    'whether or not they share a container',
    'even when the pair needs no particular order',
    'never recommend an edge that closes a cycle',
    'leaves linked by an edge never sit in different groups',
  ])
    assert.ok(role.includes(rule), rule);
});

// Routing facts: the namespaced agents and skills a file names and the
// references it links. Both tools' renderings of one source must agree.
function routing(content) {
  return [
    ...new Set(
      [
        ...content.matchAll(
          new RegExp(
            `${PREFIX}[a-z]+(?:-[a-z]+)*|references/[a-z-]+\\.md`,
            'g',
          ),
        ),
      ].map((match) => match[0]),
    ),
  ].sort();
}

test('both tools route every source to the same agents, skills, and references', () => {
  const files = render();
  for (const [source, [claude, codex]] of sourcePairs())
    assert.deepEqual(
      routing(files.get(claude)),
      routing(files.get(codex)),
      source,
    );
  // The delivery result fields match word for word.
  const [claudeResult, codexResult] = DELIVERY.map((path) =>
    lineWith(files.get(path), /^Return READY FOR REVIEW or BLOCKED/),
  );
  assert.ok(claudeResult);
  assert.equal(claudeResult, codexResult);
});

// Manual review publication against a mocked `gh api --include`. Nothing here
// reaches GitHub.
const REPO = policy.binding.repository;
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const URL_POSTED = `https://github.com/${REPO}/pull/7#pullrequestreview-1`;
const report = (verdict, pair = `${BASE}..${HEAD}`) =>
  [
    `Verdict: ${verdict}`,
    `Base/Head: ${pair}`,
    'Acceptance: criterion one met',
    'Findings: high | scripts/x.mjs:1 | problem | fix',
    'Limits: tests read, not run.',
    `Requested settings: Policy: tool=claude role=${PREFIX}code-reviewer model=opus effort=high (model: policy, effort: policy)`,
  ].join('\n');

// A gh stand-in keyed by the REST path. `null` or a status number makes the
// call fail with that HTTP status (404 for null).
function fakeGh(overrides = {}) {
  const routes = {
    [`repos/${REPO}/pulls/7`]: {
      state: 'open',
      merged_at: null,
      head: { sha: HEAD },
      base: { sha: TIP, ref: 'main' },
      user: { login: 'author' },
    },
    [`repos/${REPO}/compare/${TIP}...${HEAD}?per_page=1`]: { sha: BASE },
    user: { login: 'reviewer' },
    [`repos/${REPO}/pulls/7/reviews`]: { html_url: URL_POSTED },
    ...overrides,
  };
  const calls = [];
  const posts = [];
  const run = (command, args, options) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 2), ['api', '--include']);
    const rest = args.slice(2);
    const path = rest.find((arg) => arg === 'user' || arg.startsWith('repos/'));
    calls.push(rest);
    if (rest.includes('POST')) posts.push(JSON.parse(options.input));
    const route = routes[path];
    if (route === undefined) assert.fail(`unexpected gh call: ${path}`);
    if (route === null || typeof route === 'number')
      throw Object.assign(new Error('gh failed'), {
        status: 1,
        stdout: `HTTP/2.0 ${route ?? 404} Error\n\n${JSON.stringify({ message: route ? 'Unprocessable Entity' : 'Not Found' })}`,
      });
    return `HTTP/2.0 200 OK\n\n${JSON.stringify(route)}`;
  };
  return { run, calls, posts };
}

const publish = (text, github, fields = {}) =>
  publishReview(
    policy,
    { pr: '7', base: BASE, head: HEAD, report: text, ...fields },
    { run: github.run },
  );

test('a review report yields its verdict and reviewed SHAs', () => {
  assert.deepEqual(parseReviewReport(report('REQUEST CHANGES')), {
    verdict: 'REQUEST CHANGES',
    base: BASE,
    head: HEAD,
  });
  assert.deepEqual(
    parseReviewReport('**Verdict:** APPROVE\n- Base/Head: `abc1234..def5678`'),
    { verdict: 'APPROVE', base: 'abc1234', head: 'def5678' },
  );
  for (const text of [
    'Verdict: BLOCKED',
    'Verdict: BLOCKED\nBase/Head: unknown',
    'Verdict: BLOCKED\nBase/Head: abc1234',
  ])
    assert.throws(
      () => parseReviewReport(text),
      /Review not posted: the report has no Base\/Head: <sha>\.\.<sha> line/,
    );
  assert.throws(
    () => parseReviewReport('Findings: none'),
    /Review not posted: the report has no Verdict: line/,
  );
  assert.throws(
    () => parseReviewReport('Verdict: APPROVE\nVerdict: REQUEST CHANGES'),
    /conflicting verdicts/,
  );
});

test('publish-review requests changes only when the poster is not the PR author', () => {
  const github = fakeGh();
  const text = report('REQUEST CHANGES');
  const result = publish(text, github);
  assert.equal(result.event, 'REQUEST_CHANGES');
  assert.equal(result.url, URL_POSTED);
  assert.deepEqual(
    github.calls.map((args) =>
      args.find((arg) => arg === 'user' || arg.startsWith('repos/')),
    ),
    [
      `repos/${REPO}/pulls/7`,
      `repos/${REPO}/compare/${TIP}...${HEAD}?per_page=1`,
      'user',
      `repos/${REPO}/pulls/7/reviews`,
    ],
  );
  // gh filters the compare response so its file patches never reach the buffer.
  assert.deepEqual(github.calls[1].slice(1), [
    '--jq',
    '{sha: .merge_base_commit.sha}',
  ]);
  // The body goes on stdin as JSON, never as a command-line argument.
  assert.deepEqual(github.calls[3].slice(-2), ['--input', '-']);
  assert.deepEqual(github.posts, [
    { commit_id: HEAD, event: 'REQUEST_CHANGES', body: text },
  ]);

  for (const login of ['author', 'AUTHOR']) {
    const own = fakeGh({ user: { login } });
    assert.equal(publish(text, own).event, 'COMMENT');
    assert.equal(
      own.posts[0].body,
      `Verdict REQUEST CHANGES is posted as a comment because GitHub does not let author request changes on their own pull request.\n\n${text}`,
    );
  }
});

test('publish-review comments when the posting identity is unknown', () => {
  for (const user of [null, 403, {}]) {
    const github = fakeGh({ user });
    assert.equal(publish(report('REQUEST CHANGES'), github).event, 'COMMENT');
    assert.match(
      github.posts[0].body,
      /^Verdict REQUEST CHANGES is posted as a comment because the posting account could not be identified/,
    );
  }
});

test('publish-review never approves and says why the event differs', () => {
  for (const [verdict, reason] of [
    ['APPROVE', /because agent reviews never approve\./],
    ['BLOCKED', /because it is not a review decision\./],
  ]) {
    const github = fakeGh();
    const result = publish(report(verdict), github);
    assert.equal(result.event, 'COMMENT');
    assert.match(result.note, reason);
    assert.equal(github.posts[0].commit_id, HEAD);
    assert.ok(github.posts[0].body.endsWith(report(verdict)));
  }
  assert.throws(
    () => reviewEvent({ verdict: 'LGTM' }),
    /Unknown review verdict/,
  );
  assert.deepEqual(REVIEW_VERDICTS, ['APPROVE', 'REQUEST CHANGES', 'BLOCKED']);
});

test('publish-review posts nothing to a merged or closed pull request', () => {
  for (const [merged, word] of [
    ['2026-10-01T00:00:00Z', 'merged'],
    [null, 'closed'],
  ]) {
    const github = fakeGh({
      [`repos/${REPO}/pulls/7`]: {
        state: 'closed',
        merged_at: merged,
        head: { sha: HEAD },
        base: { sha: TIP, ref: 'gone' },
        user: { login: 'author' },
      },
    });
    assert.throws(
      () => publish(report('REQUEST CHANGES'), github),
      new RegExp(
        `Review not posted: pull request #7 is ${word}; reviews post only to open pull requests$`,
      ),
    );
    assert.deepEqual(github.posts, []);
  }
});

test('publish-review posts nothing when the head or merge base moved', () => {
  const headMoved = fakeGh({
    [`repos/${REPO}/pulls/7`]: {
      state: 'open',
      merged_at: null,
      head: { sha: 'd'.repeat(40) },
      base: { sha: TIP, ref: 'main' },
      user: { login: 'author' },
    },
  });
  assert.throws(
    () => publish(report('APPROVE'), headMoved),
    new RegExp(`head is now ${'d'.repeat(40)}, not the reviewed ${HEAD}`),
  );
  assert.equal(headMoved.calls.length, 1);
  const baseMoved = fakeGh({
    [`repos/${REPO}/compare/${TIP}...${HEAD}?per_page=1`]: {
      sha: 'e'.repeat(40),
    },
  });
  assert.throws(
    () => publish(report('APPROVE'), baseMoved),
    new RegExp(
      `now has merge base ${'e'.repeat(40)} with main, not the reviewed ${BASE}`,
    ),
  );
  assert.deepEqual(baseMoved.posts, []);
});

test('publish-review posts nothing for a report without the reviewed pair', () => {
  for (const [text, reason] of [
    [
      report('APPROVE').replace(/^Base\/Head:.*\n/m, ''),
      /no Base\/Head: <sha>\.\.<sha> line/,
    ],
    [
      report('APPROVE', `${BASE}..${'f'.repeat(40)}`),
      /the report names a+\.\.f+, not the reviewed/,
    ],
    [report('APPROVE').replace(/^Verdict:.*\n/m, ''), /no Verdict: line/],
  ]) {
    const github = fakeGh();
    assert.throws(() => publish(text, github), reason);
    assert.equal(github.calls.length, 0);
  }
});

test('publish-review reports a failed or unconfirmed submission without retrying', () => {
  const failed = fakeGh({ [`repos/${REPO}/pulls/7/reviews`]: 422 });
  assert.throws(
    () => publish(report('REQUEST CHANGES'), failed),
    /Review not posted: GitHub API request failed: HTTP 422: Unprocessable Entity\.$/,
  );
  assert.equal(failed.posts.length, 1);
  const unconfirmed = fakeGh({ [`repos/${REPO}/pulls/7/reviews`]: {} });
  assert.throws(
    () => publish(report('REQUEST CHANGES'), unconfirmed),
    /GitHub returned no review URL/,
  );
});

test('publish-review rejects bad input before calling gh, and the command reports it', () => {
  const github = fakeGh();
  for (const [fields, reason] of [
    [{ pr: 'x' }, /--pr must be a pull request number/],
    [{ base: 'abc123' }, /--base must be a full 40-character SHA/],
    [{ head: undefined }, /--head must be a full 40-character SHA/],
  ])
    assert.throws(() => publish(report('APPROVE'), github, fields), reason);
  assert.throws(() => publish('  ', github), /the review report is empty/);
  assert.equal(github.calls.length, 0);
  for (const [args, message] of [
    [['--pr', '7'], /^Review not posted: --report <file> is required/],
    [
      ['--pr', '7', '--report', join(tmpdir(), 'missing-review.md')],
      /^Review not posted: cannot read the report .*missing-review\.md: ENOENT/,
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./agent-policy.mjs', import.meta.url).pathname,
        'publish-review',
        ...args,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

function inBoth(file) {
  return [`.claude/skills/${PREFIX}${file}`, `.agents/skills/${PREFIX}${file}`];
}

test('include inserts a shared source and rejects an unknown one', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  mkdirSync(join(base, '.agents/includes'), { recursive: true });
  writeFileSync(join(base, '.agents/includes/shared-rule.md'), 'Rule.\n');
  assert.equal(include('A {{> shared-rule}} B', base), 'A Rule. B');
  assert.equal(
    substitute(include('A \\{{> shared-rule}} B', base), policy),
    'A {{> shared-rule}} B',
  );
  for (const tag of [
    '{{> missing}}',
    '{{>shared-rule}}',
    '{{> shared_rule}}',
    '{{> ../roles/x}}',
  ])
    assert.throws(
      () => include(`A ${tag} B`, base),
      (error) => error.message === `Unknown include: ${tag}`,
      tag,
    );
  for (const tag of ['{{> shared-rule}', '{{> a}b}}', '{{>']) {
    assert.throws(
      () => include(`A {{> shared-rule}} B ${tag}`, base),
      /Malformed include in source/,
      tag,
    );
    assert.equal(
      substitute(include(`A \\${tag} B`, base), policy),
      `A ${tag} B`,
      tag,
    );
  }
  writeFileSync(
    join(base, '.agents/includes/nested.md'),
    '{{> shared-rule}}\n',
  );
  assert.throws(
    () => include('A {{> nested}} B', base),
    (error) => error.message === 'Nested include in .agents/includes/nested.md',
  );
});

test('render expands includes in skill references and leaves no tag behind', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  mkdirSync(join(base, '.agents/roles'), { recursive: true });
  mkdirSync(join(base, '.agents/includes'), { recursive: true });
  mkdirSync(join(base, '.agents/workflows/flow/references'), {
    recursive: true,
  });
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({ ...policy, roles: {} }),
  );
  writeFileSync(
    join(base, '.agents/includes/shared-rule.md'),
    'Rule for {{label}}.\n',
  );
  writeFileSync(
    join(base, '.agents/workflows/flow.md'),
    '---\nname: flow\ndescription: Flow.\n---\nBody.\n',
  );
  writeFileSync(
    join(base, '.agents/workflows/flow/references/guide.md'),
    'A {{> shared-rule}} B \\{{> shared-rule}}\n',
  );
  const files = render(base);
  for (const target of [
    `.claude/skills/${PREFIX}flow`,
    `.agents/skills/${PREFIX}flow`,
  ])
    assert.equal(
      files.get(`${target}/references/guide.md`),
      `A Rule for ${policy.binding.label}. B {{> shared-rule}}\n`,
      target,
    );
  writeFileSync(
    join(base, '.agents/workflows/flow/references/guide.md'),
    'A {{> missing}} B\n',
  );
  assert.throws(() => render(base), /Unknown include: \{\{> missing\}\}/);
});

test('the review packet has one source that the reviewer, the delivery procedure, and review-code carry', () => {
  const files = render();
  const packet = substitute(
    readFileSync(
      new URL('../.agents/includes/review-packet.md', import.meta.url),
      'utf8',
    ),
    policy,
  ).trimEnd();
  for (const field of [
    '`review_mode=pre_pr|requested`',
    'the acceptance criteria',
    'the immediate base SHA, the pushed head SHA',
    "the reviewer's own `Policy:` line",
    'the accepted decisions',
    'a changed-file summary from `git diff --stat <base>..<head>`',
    'the relevant validation results with the SHA they ran at',
    'verified prerequisites with their SHAs',
    "A re-review packet adds the previous round's base and head SHAs (its `Base/Head:` line) and its complete report verbatim.",
  ])
    assert.ok(packet.includes(field), field);
  for (const path of [
    `.claude/agents/${PREFIX}code-reviewer.md`,
    `.codex/agents/${PREFIX}code-reviewer.toml`,
    ...inBoth('implement/references/delivery.md'),
    ...inBoth('review-code/SKILL.md'),
  ])
    assert.ok(files.get(path).includes(packet), path);
  // No source restates the fields, so the copies cannot drift apart.
  for (const source of [
    'roles/code-reviewer.md',
    'workflows/implement/references/delivery.md',
    'workflows/review-code.md',
  ]) {
    const text = readFileSync(
      new URL(`../.agents/${source}`, import.meta.url),
      'utf8',
    );
    assert.match(text, /\{\{> review-packet\}\}/, source);
    assert.doesNotMatch(
      text,
      /changed-file summary from|remote branch, immediate base SHA|head SHA, the worktree path/,
      source,
    );
  }
  assert.match(
    readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    /A review handoff after the final push sends the review packet in `\.agents\/includes\/review-packet\.md`/,
  );
});

test('the review-code skill resolves #N as a pull request in both tools', () => {
  const files = render();
  for (const path of [
    `.claude/skills/${PREFIX}review-code/SKILL.md`,
    `.agents/skills/${PREFIX}review-code/SKILL.md`,
  ]) {
    const skill = files.get(path);
    assert.match(
      skill,
      /`#N`, a bare number `N`, or a PR URL always names pull request N/,
    );
    assert.match(
      skill,
      /`gh api repos\/\S+\/pulls\/N --jq '[^`]*headRefOid: \.head\.sha[^`]*baseRefOid: \.base\.sha/,
    );
    assert.match(
      skill,
      /REST has no closing-issues read: `gh api graphql [^`]*closingIssuesReferences/,
    );
    assert.match(skill, /If that call is rate-limited, do not wait/);
    assert.doesNotMatch(skill, /gh (pr|issue) view/);
    assert.match(skill, /no pull request #N exists/);
    assert.match(skill, /Do not fall back to reading N as an issue/);
    assert.match(skill, /git fetch origin pull\/N\/head <baseRefName>/);
    assert.match(skill, /criteria come from the request/);
    assert.match(
      skill,
      /fails because `<baseRefName>` no longer exists[^\n]*`git fetch origin <baseRefOid>`[^\n]*`git merge-base origin\/main <headRefOid>`[^\n]*`origin\/main` fallback/,
    );
    assert.match(skill, /combine their acceptance criteria, labeled by issue/);
    assert.match(
      skill,
      /Send the review packet with `review_mode=requested`, every closing issue, and the decisions from their comments; the reviewer follows `\.agents\/review\.md`\./,
    );
    assert.match(
      skill,
      /one or more issue URLs \(or `none` when the criteria come from the request\)/,
    );
    assert.doesNotMatch(skill, /its issue's acceptance criteria/);
    assert.match(
      skill,
      /^description: .*pull request \(open, merged, or closed\) or pushed branch.*always pull request N, never an issue/m,
    );
  }
  assert.match(
    files.get(`.claude/skills/${PREFIX}review-code/SKILL.md`),
    /^argument-hint: "?<#PR \| PR number \| PR URL \| branch>/m,
  );
  for (const path of [
    `.claude/agents/${PREFIX}code-reviewer.md`,
    `.codex/agents/${PREFIX}code-reviewer.toml`,
  ]) {
    const reviewer = files.get(path);
    assert.match(reviewer, /`pull\/<N>\/head` in `requested` mode/);
    assert.match(
      reviewer,
      /description ?[:=] ?"?Independent read-only review of a \S+ pull request or pushed branch/,
    );
    assert.doesNotMatch(reviewer, /review of a pushed \S+ branch/);
    assert.match(reviewer, /one or more issue URLs/);
    assert.match(reviewer, /lists every issue the PR closes/);
    assert.match(
      reviewer,
      /`origin\/main` fallback[^\n]*name the fallback in Limits/,
    );
  }
});

test('the review-code skill posts PR reviews only through publish-review', () => {
  const files = render();
  for (const path of [
    `.claude/skills/${PREFIX}review-code/SKILL.md`,
    `.agents/skills/${PREFIX}review-code/SKILL.md`,
  ]) {
    const skill = files.get(path);
    const publishStep = section(skill, 'Publish');
    assert.match(publishStep, /^A branch target posts nothing\./m, path);
    assert.ok(
      publishStep.includes(
        '`node scripts/agent-policy.mjs publish-review --pr <N> --base <base SHA> --head <head SHA> --report <file>` once, with the base and head SHAs you sent the reviewer',
      ),
      path,
    );
    assert.match(publishStep, /It never approves\./, path);
    assert.match(
      publishStep,
      /Never retry with another event, and never post the feedback another way/,
      path,
    );
    assert.ok(
      section(skill, 'Report').includes(
        "End with one line: `Posted: <event> <url>` from the command's JSON, `Not posted: <reason>` with the reason after `Review not posted:`, or `Posted: none (branch review)`.",
      ),
      path,
    );
    assert.doesNotMatch(skill, /nothing in this flow writes to GitHub/, path);
    assert.doesNotMatch(skill, /never posts/, path);
    assert.match(
      skill,
      /^description: .*posts them as one review on an open PR target through publish-review; never approves or edits\./m,
      path,
    );
  }
  assert.match(
    files.get(`.agents/skills/${PREFIX}review-code/agents/openai.yaml`),
    /short_description: .*post the review to an open PR/,
  );
  for (const path of [
    `.claude/agents/${PREFIX}code-reviewer.md`,
    `.codex/agents/${PREFIX}code-reviewer.toml`,
  ]) {
    const reviewer = files.get(path);
    assert.match(
      reviewer,
      /posts your report as one review through `publish-review` after you return[^\n]*A `pre_pr` report is never posted\./,
      path,
    );
    assert.match(reviewer, /^Base\/Head: <sha>\.\.<sha>$/m, path);
    assert.match(
      reviewer,
      /^tools: Bash, Read, Grep, Glob$|^default_permissions = ":read-only"$/m,
      path,
    );
  }
  for (const path of [
    `.claude/agents/${PREFIX}implementer.md`,
    `.codex/agents/${PREFIX}implementer.toml`,
    ...inBoth('implement/references/delivery.md'),
  ])
    assert.doesNotMatch(files.get(path), /publish-review/, path);
  const agentsMd = readFileSync(
    new URL('../AGENTS.md', import.meta.url),
    'utf8',
  );
  assert.match(
    agentsMd,
    /`prism-code-reviewer` \(read-only, reports to you\); the skill posts the report as one review on an open PR target \|/,
  );
  assert.match(
    readFileSync(new URL('../.agents/README.md', import.meta.url), 'utf8'),
    /`publish-review`, which posts a `prism-review-code` report as one review on an open PR/,
  );
});

test('AGENTS.md holds the code-and-comments rules and the reviewer enforces them', () => {
  const files = render();
  const agentsMd = readFileSync(
    new URL('../AGENTS.md', import.meta.url),
    'utf8',
  );
  const [, section] = agentsMd.split(/^## Code and comments$/m);
  assert.ok(section, 'AGENTS.md: Code and comments section');
  const [rules] = section.split(/^## /m);
  assert.match(
    rules,
    /^- Match the surrounding code's naming, idiom, and comment density\./m,
  );
  assert.match(
    rules,
    /^- Comment only what the code cannot say: a constraint, a workaround, or an invariant\./m,
  );
  assert.match(
    rules,
    /^- Docs, specs, agent instructions, and comments describe the current state\./m,
  );
  for (const root of ['.claude/skills', '.agents/skills']) {
    const prose = files.get(`${root}/${PREFIX}plain-language/SKILL.md`);
    assert.match(prose, /^## Docs and code comments$/m, root);
    assert.match(prose, /^## PR bodies and commit messages$/m, root);
    assert.match(prose, /^The same paragraph written as history:$/m, root);
  }
  const review = readFileSync(
    new URL('../.agents/review.md', import.meta.url),
    'utf8',
  );
  for (const rule of [
    'Docs and comments describe the current state.',
    'Report a code comment that only restates the code it sits on',
    'a check, helper, option, or parameter the change adds that no acceptance criterion or caller needs',
  ])
    assert.ok(review.includes(rule), rule);
  for (const ext of ['md', 'toml']) {
    const dir = ext === 'md' ? '.claude/agents' : '.codex/agents';
    assert.match(
      files.get(`${dir}/${PREFIX}code-reviewer.${ext}`),
      /Read `\.agents\/review\.md`/,
    );
    assert.doesNotMatch(
      files.get(`${dir}/${PREFIX}implementer.${ext}`),
      /describe the current state/,
    );
  }
  for (const path of inBoth('implement/references/delivery.md'))
    assert.doesNotMatch(files.get(path), /describe the current state/, path);
});

test('the agents skill lints Markdown when it verifies', () => {
  const files = render();
  for (const root of ['.claude/skills', '.agents/skills']) {
    const path = `${root}/${PREFIX}agents/SKILL.md`;
    assert.match(
      files.get(path),
      /^npx eslint scripts\/agent-policy\.mjs scripts\/agent-policy\.test\.mjs '\*\*\/\*\.md' --max-warnings 0$/m,
      path,
    );
  }
});

test('generated definitions in the repository are current', () => {
  assert.deepEqual(check(), []);
});

test('generate writes every file and check reports stale or orphaned output', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  mkdirSync(join(base, '.agents/roles'), { recursive: true });
  mkdirSync(join(base, '.agents/workflows'), { recursive: true });
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({
      ...policy,
      roles: { sample: 'code-review' },
    }),
  );
  writeFileSync(join(base, '.agents/roles/sample.md'), source);
  writeFileSync(
    join(base, '.agents/workflows/flow.md'),
    '---\nname: flow\ndescription: Flow.\n---\nBody.\n',
  );
  const written = generate(base);
  assert.deepEqual(written, [
    `.agents/skills/${PREFIX}flow/SKILL.md`,
    `.agents/skills/${PREFIX}flow/agents/openai.yaml`,
    `.claude/agents/${PREFIX}sample.md`,
    `.claude/skills/${PREFIX}flow/SKILL.md`,
    `.codex/agents/${PREFIX}sample.toml`,
  ]);
  assert.deepEqual(check(base), []);
  writeFileSync(join(base, `.codex/agents/${PREFIX}sample.toml`), 'edited');
  writeFileSync(join(base, `.claude/agents/${PREFIX}orphan.md`), 'orphan');
  writeFileSync(join(base, '.claude/agents/personal.md'), 'not ours');
  assert.deepEqual(check(base), [
    `.claude/agents/${PREFIX}orphan.md`,
    `.codex/agents/${PREFIX}sample.toml`,
  ]);
  generate(base);
  assert.deepEqual(check(base), []);
  assert.equal(
    readFileSync(join(base, '.claude/agents/personal.md'), 'utf8'),
    'not ours',
  );
  // Rebinding the same sources renames the output and resolves the text.
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({ ...other, roles: { sample: 'code-review' } }),
  );
  writeFileSync(
    join(base, '.agents/roles/sample.md'),
    source.replace('Shared line.', 'Shared {{label}} line in {{repository}}.'),
  );
  assert.deepEqual(generate(base), [
    '.agents/skills/other-flow/SKILL.md',
    '.agents/skills/other-flow/agents/openai.yaml',
    '.claude/agents/other-sample.md',
    '.claude/skills/other-flow/SKILL.md',
    '.codex/agents/other-sample.toml',
  ]);
  assert.match(
    readFileSync(join(base, '.claude/agents/other-sample.md'), 'utf8'),
    /Shared Other line in example\/other\./,
  );
  assert.match(
    readFileSync(
      join(base, '.agents/skills/other-flow/agents/openai.yaml'),
      'utf8',
    ),
    /display_name: 'Other: flow'/,
  );
});

test('a role without a policy entry or source is rejected', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  mkdirSync(join(base, '.agents/roles'), { recursive: true });
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({ ...policy, roles: { missing: 'code-review' } }),
  );
  assert.throws(() => render(base), /Role missing has no source/);
  writeFileSync(
    join(base, '.agents/roles/extra.md'),
    source.replace('name: sample', 'name: extra'),
  );
  assert.throws(() => render(base), /Role extra has no entry/);
});

test('review entry points share bounded packets and preserve independent coverage', () => {
  const files = render();
  const review = readFileSync(
    new URL('../.agents/review.md', import.meta.url),
    'utf8',
  );
  for (const path of [
    ...DELIVERY,
    `.claude/skills/${PREFIX}review-code/SKILL.md`,
    `.agents/skills/${PREFIX}review-code/SKILL.md`,
    `.claude/agents/${PREFIX}code-reviewer.md`,
    `.codex/agents/${PREFIX}code-reviewer.toml`,
  ]) {
    const content = files.get(path);
    assert.ok(content.includes('.agents/review.md'), path);
    for (const field of [
      'accepted decisions',
      'changed-file summary',
      'validation results',
      'verified prerequisites',
    ])
      assert.ok(content.includes(field), `${path}: ${field}`);
  }
  for (const rule of [
    'full in-scope base/head diff',
    'relevant callers and contracts',
    'Retrieve only missing or stale context',
    'previous base/head SHAs',
    'complete previous report',
    'Expand review when subsequent changes affect additional behavior',
    'including changes introduced by a moved base',
    'missed earlier',
    'exact reviewed base/head pair',
    'otherwise perform a complete initial review',
  ])
    assert.ok(review.includes(rule), rule);
  assert.doesNotMatch(review, /report only defects the fixes introduced/);
});

test('evidence reuse retains complete relevant output and meaningful validation', () => {
  const evidence = readFileSync(
    new URL('../.agents/evidence.md', import.meta.url),
    'utf8',
  );
  for (const rule of [
    'targeted `rg` searches',
    'Read each unchanged file once',
    'A new commit SHA alone does not invalidate',
    'a file from `mktemp` outside tracked paths',
    'keeping the file through delivery',
    'A read-only role, such as a code reviewer, never writes that file',
    'Never let a filter hide a failing exit status',
    'retrieve the missing part',
    'Never act on partial output',
    'never wait for, poll, or rerun remote CI',
  ])
    assert.ok(evidence.includes(rule), rule);
  const files = render();
  for (const path of DELIVERY) {
    const build = section(files.get(path), 'Build');
    assert.match(build, /focused tests/);
    assert.match(build, /every required scope-appropriate check/);
    assert.match(build, /rerun affected checks and broaden validation/);
    assert.match(
      build,
      /Meaningful behavioral tests and required checks remain mandatory/,
    );
    const claim = section(files.get(path), 'Claim');
    assert.match(claim, /Reuse current metadata and verified prerequisites/);
    assert.match(claim, /one useful claim comment/);
    assert.match(claim, /Do not add status-only comments or repeat the claim/);
  }
});

test('queue recomputes and main reads only fixed results until a blocker needs a person', () => {
  const files = render();
  for (const path of QUEUE) {
    const content = files.get(path);
    for (const rule of [
      'scripts/delivery-queue.mjs',
      'refetches',
      'fixed result fields',
      'Do not read source, diffs, or detailed review reports',
      'rerun the script after each result',
      'Ask the person before taking it over',
    ])
      assert.ok(content.includes(rule), `${path}: ${rule}`);
  }
  for (const path of IMPLEMENT) {
    const content = files.get(path);
    const escalation = section(content, 'Later escalation');
    for (const rule of [
      'at most one automatic medium-to-high transition',
      'end the old agent',
      '--effort high',
      'explicit spawn settings',
      'no',
      'two-round',
    ])
      assert.ok(
        (escalation + section(content, 'Settings')).includes(rule),
        `${path}: ${rule}`,
      );
    assert.match(content, /first progress message/);
    assert.match(content, /Implementation effort: medium ->/);
    assert.match(content, /Implementation effort: medium \(default\)/);
    assert.match(content, /reads only the verdict and blocker lines/);
  }
});

test('spec plans require offline validation, triage, confirmation and journaled resume in both tools', () => {
  const files = render();
  for (const tool of ['claude', 'codex']) {
    const directory = tool === 'claude' ? '.claude/skills' : '.agents/skills';
    const path = `${directory}/${PREFIX}spec-to-issues`;
    const skill = files.get(`${path}/SKILL.md`);
    for (const rule of [
      'Before any GitHub write',
      'scripts/spec-to-issues.mjs plan',
      'duplicate Plan IDs or titles',
      'dependency cycles',
      'unknown labels',
      'After pre-flight and before printing the tree',
      'for the whole plan',
      '--role issue-triager',
      'as accepted decisions',
      'never override them',
      'Only the triager forms independence groups',
      '`EDGES` line',
      'scripts/spec-to-issues.mjs edges <drafts.json>',
      'applyEdges(plan, edgesLine)',
      'including every edge the triager returned',
      'Never form, extend, or merge groups yourself',
      'only as context',
      'Wait for explicit confirmation',
      'plan or dry run makes no GitHub writes',
      'phase epic or split-slice container whose direct leaf children',
      'root container gets no record',
      'reuses the saved triager verdict and groups without spawning the triager again',
      'finish every missing independence record',
      'spec change since the confirmed plan requires a new pre-flight, triage, and confirmation',
      'Never edit labels, project settings, or project Status',
      'Never touch an issue this run did not create',
      'issue-triage.mjs --apply --issue N',
      'issue-containers.mjs --apply --issue N',
    ])
      assert.ok(skill.includes(rule), `${path}: ${rule}`);
    const state = files.get(`${path}/references/state.md`);
    for (const rule of [
      'outside the repository',
      'Full triager report',
      'Persist the groups',
      'before sending the POST',
      'at least one second',
      'Never blindly retry a POST',
      'exact marker',
      'without another POST',
      'without spawning the triager again',
      'Resume must finish every record',
      'voids confirmation',
    ])
      assert.ok(state.includes(rule), `${path}/state: ${rule}`);
    const operations = files.get(`${path}/references/github-operations.md`);
    for (const rule of [
      'REST through `gh api`',
      'sub_issue_id',
      'dependencies/blocked_by',
      'Never include Status',
      'Never put a record on the root',
    ])
      assert.ok(operations.includes(rule), `${path}/operations: ${rule}`);
  }
  const role = readFileSync(
    new URL('../.agents/roles/issue-triager.md', import.meta.url),
    'utf8',
  );
  assert.match(role, /spec-to-issues for a whole delivery plan/);
});

test('implementation is medium while every review dispatch has its own high settings', () => {
  for (const tool of TOOLS) {
    const packet = implementationDispatch(policy, { tool, issue: 1 });
    assert.equal(packet.implementer.effort, 'medium');
    assert.equal(packet.reviewer.effort, 'high');
    assert.equal(
      packet.implementer.model,
      tool === 'claude' ? 'opus' : 'gpt-6.1-sol',
    );
    assert.equal(
      packet.reviewer.model,
      tool === 'claude' ? 'opus' : 'gpt-6.1-sol',
    );
    for (const role of ['implementer', 'reviewer']) {
      assert.equal(packet[role].spawn.model, packet[role].model);
      assert.equal(
        packet[role].spawn[tool === 'claude' ? 'effort' : 'reasoning_effort'],
        packet[role].effort,
      );
      if (tool === 'codex') assert.equal(packet[role].spawn.fork_turns, 'none');
    }
    assert.equal(
      packet.announcement,
      'Implementation effort: medium (default)',
    );
  }
  const files = render();
  for (const path of DELIVERY) {
    const review = section(files.get(path), 'Pre-PR review');
    assert.match(review, /--role code-reviewer/);
    if (path.startsWith('.claude'))
      assert.match(review, /`model` and `effort` explicitly/);
    else {
      assert.match(review, /`agent_type`, `model`, and `reasoning_effort`/);
      assert.match(review, /fork_turns: "none"/);
    }
  }
});

const assessment = (rule) => ({
  effort: 'high',
  rule,
  question: 'How do the unresolved constraints preserve correctness?',
  evidence: 'spec §4 and failing case race-1',
  reason: 'The supplied plan leaves the competing write orders unresolved.',
  criteria: Object.fromEntries(
    policy.implementationEffort.rules[rule].requires.map((key) => [key, true]),
  ),
});
for (const rule of [
  'H1-boundary',
  'H2-coupled-design',
  'H3-demonstrated-limit',
]) {
  test(`${rule} requires every criterion and concrete evidence`, () => {
    const decision = assessment(rule);
    assert.equal(implementationEffort(policy, { decision }).effort, 'high');
    for (const key of policy.implementationEffort.rules[rule].requires)
      assert.equal(
        implementationEffort(policy, {
          decision: {
            ...decision,
            criteria: { ...decision.criteria, [key]: false },
          },
        }).effort,
        'medium',
        key,
      );
    for (const key of ['evidence', 'reason', 'question'])
      assert.equal(
        implementationEffort(policy, { decision: { ...decision, [key]: '' } })
          .effort,
        'medium',
        key,
      );
  });
}

test('specified mechanisms and routine corrections fail the high criteria', () => {
  assert.equal(
    implementationEffort(policy, {
      decision: {
        ...assessment('H1-boundary'),
        criteria: {
          ...assessment('H1-boundary').criteria,
          mechanismUnresolved: false,
        },
      },
    }).effort,
    'medium',
  );
  assert.equal(
    implementationEffort(policy, {
      decision: {
        ...assessment('H3-demonstrated-limit'),
        criteria: {
          ...assessment('H3-demonstrated-limit').criteria,
          designRevisionRequired: false,
        },
      },
    }).effort,
    'medium',
  );
});

test('explicit medium prevents escalation and missing inputs remain blockers', () => {
  const packet = implementationDispatch(policy, {
    tool: 'codex',
    issue: 2,
    effort: 'medium',
    decision: assessment('H2-coupled-design'),
  });
  assert.equal(packet.implementer.effort, 'medium');
  assert.equal(packet.selected.rule, 'user override');
  assert.equal(packet.reviewer.effort, 'high');
  for (const blocker of policy.implementationEffort.blockers)
    assert.throws(
      () =>
        implementationDispatch(policy, {
          tool: 'codex',
          blocker,
          decision: assessment('H1-boundary'),
        }),
      new RegExp(blocker),
    );
});

test('later escalation announces evidence and explicitly applies high once without new review rounds', () => {
  for (const tool of TOOLS) {
    const decision = { ...assessment('H3-demonstrated-limit'), later: true };
    const packet = implementationDispatch(policy, {
      tool,
      issue: 7,
      decision,
      transitions: 0,
    });
    assert.equal(
      packet.implementer.spawn[
        tool === 'codex' ? 'reasoning_effort' : 'effort'
      ],
      'high',
    );
    assert.equal(packet.implementer.source.effort, 'override');
    assert.equal(packet.reviewer.effort, 'high');
    assert.equal(packet.announcement, effortAnnouncement(7, decision));
    assert.match(
      packet.announcement,
      /medium -> high; issue: #7; rule: H3-demonstrated-limit; evidence: spec/,
    );
    assert.match(packet.announcement, /reason: The supplied plan/);
    assert.throws(
      () =>
        implementationDispatch(policy, {
          tool,
          issue: 7,
          decision,
          transitions: 1,
        }),
      /Only one automatic/,
    );
  }
});

test('delivery instructions persist later effort decisions and advance after a released blocker', () => {
  const files = render();
  for (const path of IMPLEMENT)
    assert.match(
      section(files.get(path), 'Later escalation'),
      /parent posts exactly one later-escalation.*later:true.*question.*criteria/,
    );
  for (const path of QUEUE) {
    const content = files.get(path);
    assert.match(
      section(content, 'Effort records'),
      /parent posts exactly one new decision comment/,
    );
    assert.match(content, /"later":true/);
    assert.match(
      content,
      /rerun the full ledger rather than blindly using `--next`/,
    );
    assert.match(content, /saved fixed-result file outside tracked paths/);
  }
});
