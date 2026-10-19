import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  binding,
  check,
  generate,
  loadPolicy,
  parseSource,
  placeholders,
  prefix,
  render,
  renderBody,
  renderRole,
  renderWorkflow,
  resolve,
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

test('generated output carries no unresolved placeholder and follows the binding', () => {
  for (const [path, content] of render()) {
    // The prism-agents skill documents the placeholders literally.
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
  display_name: "${policy.binding.label}: Sample"
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
  assert.ok(
    codex['agents/openai.yaml'].includes(
      `display_name: '${policy.binding.label}: Sample'`,
    ),
  );
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
    'review-code',
    'review-security',
    'plain-language',
    'spec-to-issues',
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
  // Tool-only blocks aside, the two renderings of a source are the same text.
  for (const role of Object.keys(policy.roles)) {
    const shared = renderBody(
      parseSource(
        substitute(
          readFileSync(
            new URL(`../.agents/roles/${role}.md`, import.meta.url),
            'utf8',
          ),
          policy,
        ),
      ).body,
      'claude',
    )
      .split('\n')
      .filter(
        (line) =>
          !/^(Spawn|Isolation|You also receive)/.test(line) && line.trim(),
      );
    for (const line of shared.slice(0, 3))
      assert.ok(
        files.get(`.codex/agents/${PREFIX}${role}.toml`).includes(line),
        `${role}: ${line.slice(0, 40)}`,
      );
  }
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
      /gh pr view N --repo \S+ --json [^`]*closingIssuesReferences/,
    );
    assert.match(skill, /no pull request #N exists/);
    assert.match(skill, /Do not fall back to reading N as an issue/);
    assert.match(skill, /git fetch origin pull\/N\/head <baseRefName>/);
    assert.match(skill, /criteria come from the request/);
    assert.match(
      skill,
      /fails because `<baseRefName>` no longer exists[^\n]*`git fetch origin <baseRefOid>`[^\n]*`git merge-base origin\/main <headRefOid>`[^\n]*`origin\/main` fallback/,
    );
    assert.match(skill, /combine their acceptance criteria, labeled by issue/);
    assert.match(skill, /issue URLs \(every closing issue, or `none`/);
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

// The paragraph of a role definition that defines what it returns: the last
// paragraph that starts with "Return".
function returnParagraph(text) {
  return (
    text
      .split(/\n[ \t]*\n/)
      .findLast((paragraph) => /^Return\b/.test(paragraph.trim())) ?? ''
  );
}

// The Return paragraph names a `Requested settings: Policy:` line, inline or
// as a line of its own in a fixed result format.
function returnsRequestedSettings(text) {
  const paragraph = returnParagraph(text);
  return (
    paragraph.includes('`Requested settings: Policy: <as dispatched>`') ||
    /^Requested settings: Policy: <as dispatched>$/m.test(paragraph)
  );
}

// The body of a skill's `## <heading>` section, up to the next heading.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return '';
  const body = text.slice(start + heading.length + 5);
  const end = body.search(/^#{1,2} /m);
  return end === -1 ? body : body.slice(0, end);
}

// A sentence of the skill's report section relays, prints, or returns the
// agent's result and its `Requested settings:` line verbatim.
function relaysResult(text, { heading, result }) {
  return section(text, heading)
    .trim()
    .split(/(?<=\.)\s+/)
    .some(
      (sentence) =>
        result.test(sentence) &&
        /`Requested settings:` lines?\b/.test(sentence) &&
        /\bverbatim\b/.test(sentence),
    );
}

// Each skill's report section, and how its sentence relaying the result opens.
const RELAYED_RESULTS = {
  implement: {
    heading: 'Report',
    result:
      /^Relay the agent's READY FOR REVIEW or BLOCKED result verbatim, including every `Requested settings:` line\./,
  },
  'review-code': {
    heading: 'Report',
    result: /^Print the reviewer's verdict, /,
  },
  'review-security': { heading: 'Report', result: /^Print the verdict, / },
  'create-github-issue': {
    heading: 'Verify and return',
    result: /^Return URLs, /,
  },
};

test('every role returns a Requested settings: Policy: line in both tools', () => {
  const files = render();
  for (const role of Object.keys(policy.roles))
    for (const path of [
      `.claude/agents/${PREFIX}${role}.md`,
      `.codex/agents/${PREFIX}${role}.toml`,
    ]) {
      const text = files.get(path);
      assert.ok(returnsRequestedSettings(text), path);
      // Removing the line from the Return paragraph fails the check, even
      // where the definition still names it elsewhere.
      const paragraph = returnParagraph(text);
      const without = text.replace(paragraph, () =>
        paragraph
          .replace(/^Requested settings: Policy: <as dispatched>$/m, '')
          .replaceAll(
            '`Requested settings: Policy: <as dispatched>`',
            '`Policy:`',
          ),
      );
      assert.notEqual(without, text, path);
      assert.ok(!returnsRequestedSettings(without), path);
    }
});

test('implement, review, and filing skills relay the result and its Requested settings: line verbatim', () => {
  const files = render();
  for (const [skill, rule] of Object.entries(RELAYED_RESULTS))
    for (const root of ['.claude/skills', '.agents/skills']) {
      const path = `${root}/${PREFIX}${skill}/SKILL.md`;
      const text = files.get(path);
      const report = section(text, rule.heading);
      assert.ok(relaysResult(text, rule), path);
      assert.doesNotMatch(report, /summar|paraphras|condens/i, path);
      // Dropping "verbatim", the `Requested settings:` line, or the relay
      // itself fails the check.
      for (const [from, to] of [
        [/ verbatim\b/g, ''],
        [/`Requested settings:` lines?/g, 'settings'],
        [/\b(Relay|Print|Return) /g, 'Mention '],
      ]) {
        const mutated = text.replace(report, () => report.replace(from, to));
        assert.notEqual(mutated, text, `${path} ${from}`);
        assert.ok(!relaysResult(mutated, rule), `${path} ${from}`);
      }
      // The rule counts only inside the report section.
      const moved =
        text.replace(report, () => '\nReport back.\n\n') +
        `\n## Notes\n${report}`;
      assert.ok(!relaysResult(moved, rule), path);
    }
});

test('reports carry requested settings and no runtime model claims', () => {
  const files = render();
  for (const [path, text] of files) {
    assert.doesNotMatch(text, /Runtime:|unverified/, path);
    assert.doesNotMatch(text, /runtime (model|reports)/i, path);
  }
  for (const path of [
    `.claude/agents/${PREFIX}implementer.md`,
    `.codex/agents/${PREFIX}implementer.toml`,
  ])
    assert.match(
      files.get(path),
      new RegExp(
        `one \`Requested settings: Policy: <as sent>\` line per ${PREFIX}code-reviewer or ${PREFIX}stack-manager you spawned, in spawn order`,
      ),
    );
  for (const path of [
    `.claude/agents/${PREFIX}orchestrator.md`,
    `.codex/agents/${PREFIX}orchestrator.toml`,
  ])
    assert.ok(
      files
        .get(path)
        .includes("the implementer's `Requested settings:` lines verbatim"),
      path,
    );
});

test('only automation moves an issue to In review', () => {
  const files = render();
  for (const path of [
    `.claude/agents/${PREFIX}implementer.md`,
    `.codex/agents/${PREFIX}implementer.toml`,
  ]) {
    const implementer = files.get(path);
    assert.match(
      implementer,
      /Move the project item to In progress[^\n]*In progress is the only project status you ever set: never set In review or Done\./,
      path,
    );
    assert.match(
      implementer,
      /Never move the issue to In review: repository automation does that when the PR opens\./,
      path,
    );
    assert.match(
      implementer,
      /report the state you see and leave it unchanged/,
      path,
    );
    assert.match(
      implementer,
      /project state as you found it \(reported, never corrected\)/,
      path,
    );
    assert.doesNotMatch(implementer, /Move the issue to In review/, path);
  }
  for (const path of [
    `.claude/agents/${PREFIX}orchestrator.md`,
    `.codex/agents/${PREFIX}orchestrator.toml`,
    `.claude/skills/${PREFIX}implement/SKILL.md`,
    `.agents/skills/${PREFIX}implement/SKILL.md`,
  ])
    assert.doesNotMatch(files.get(path), /move [^\n.]*In review/i, path);
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
