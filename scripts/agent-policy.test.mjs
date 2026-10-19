import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  binding,
  check,
  generate,
  loadPolicy,
  parseSource,
  placeholders,
  prefix,
  publishReview,
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

test("the implementer sends each handoff that handoff's own Policy line", () => {
  const files = render();
  for (const path of [
    `.claude/agents/${PREFIX}implementer.md`,
    `.codex/agents/${PREFIX}implementer.toml`,
  ]) {
    const implementer = files.get(path);
    assert.ok(
      implementer.includes(
        `\`review_mode=pre_pr\`, and the reviewer's own \`Policy:\` line composed from that resolver output (\`Policy: tool=<tool> role=${PREFIX}code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)\`), never your own.`,
      ),
      path,
    );
    assert.doesNotMatch(
      implementer,
      /`review_mode=pre_pr`, and the `Policy:` line\./,
      path,
    );
    assert.ok(
      implementer.includes(
        `End each ${PREFIX}stack-manager line with the operation you sent it in parentheses, such as \`Requested settings: Policy: <as sent> (link)\`.`,
      ),
      path,
    );
    assert.match(
      implementer,
      /You need APPROVE for that exact base\/head pair\. On REQUEST CHANGES: fix, rerun the affected gates, push, and re-review\. After two rejected rounds, return BLOCKED with the open findings instead of looping\. Any base\/head change before the PR opens invalidates the approval\. Never self-approve\./,
      path,
    );
    assert.match(
      implementer,
      /Echo it in your result as `Requested settings: Policy: <as dispatched>`\./,
      path,
    );
  }
});

test('Codex issue filing states its policy as advisory; Claude pins it', () => {
  const files = render();
  for (const skill of ['create-github-issue', 'spec-to-issues']) {
    const codex = files.get(`.agents/skills/${PREFIX}${skill}/SKILL.md`);
    assert.ok(
      codex.includes(
        'Codex skills cannot set the session model, and nothing dispatched this session, so the `issue-creation` policy is advisory: the session keeps whatever model and effort Codex started with.',
      ),
      skill,
    );
    assert.ok(
      codex.includes(
        'state it in your first message as `Advisory policy: tool=codex capability=issue-creation model=<model> effort=<effort>`. Never present it as `Requested settings:`, because no dispatcher requested it.',
      ),
      skill,
    );
    assert.doesNotMatch(codex, /^model:/m, skill);
    const claude = files.get(`.claude/skills/${PREFIX}${skill}/SKILL.md`);
    assert.doesNotMatch(claude, /Advisory policy|advisory/, skill);
    assert.match(
      claude,
      new RegExp(
        `^model: ${policy.capabilities['issue-creation'].claude.model}$`,
        'm',
      ),
      skill,
    );
    assert.ok(
      claude.includes(
        'This skill pins the main-thread model and effort for the turn from `.agents/policy.json` (`issue-creation`).',
      ),
      skill,
    );
  }
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
    assert.match(prose, /^## Docs$/m, root);
    assert.match(prose, /^The same paragraph written as history:$/m, root);
    assert.doesNotMatch(prose, /code comment/i, root);
  }
  for (const ext of ['md', 'toml']) {
    const dir = ext === 'md' ? '.claude/agents' : '.codex/agents';
    assert.match(
      files.get(`${dir}/${PREFIX}code-reviewer.${ext}`),
      /Report as defects any breach of the `AGENTS\.md` code-and-comments rules: comments that restate the code, doc or comment text that narrates history/,
    );
    assert.doesNotMatch(
      files.get(`${dir}/${PREFIX}implementer.${ext}`),
      /describe the current state/,
    );
  }
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

test('the issue triager uses reported facts and writes no label-evidence report', () => {
  const files = render();
  for (const path of [
    `.claude/agents/${PREFIX}issue-triager.md`,
    `.codex/agents/${PREFIX}issue-triager.toml`,
  ]) {
    const triager = files.get(path);
    assert.match(
      triager,
      /classify from reported facts only, meaning the drafts, the accepted decisions, and what you read in the repository\./,
      path,
    );
    assert.match(
      triager,
      /Do not invent impact, affected users, repro steps, or causes\./,
      path,
    );
    assert.match(
      triager,
      /When a missing fact would change severity, Priority, Size, or scope, name it in the unknowns field instead of assuming it\./,
      path,
    );
    assert.match(
      triager,
      /Do not write a separate label-evidence report: the labels field and the rationale are the only justification you return\./,
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

const REPO = policy.binding.repository;
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const URL_POSTED = `https://github.com/${REPO}/pull/7#pullrequestreview-1`;

function reviewReport(verdict, pair = `${BASE}..${HEAD}`) {
  return `Verdict: ${verdict}\nBase/Head: ${pair}\nAcceptance: met\nFindings: none\nLimits: tests read, not run.\nRequested settings: Policy: tool=claude role=${PREFIX}code-reviewer model=opus effort=high (model: policy, effort: policy)\n`;
}

function reportFile(text) {
  const path = join(mkdtempSync(join(tmpdir(), 'publish-review-')), 'r.md');
  writeFileSync(path, text);
  return path;
}

// A gh stand-in keyed by the REST path. A function value receives the gh
// arguments; `null` makes the call fail with an HTTP 404 or the given status.
function fakeGh(overrides = {}) {
  const routes = {
    [`repos/${REPO}/pulls/7`]: {
      state: 'open',
      merged_at: null,
      head: { sha: HEAD },
      base: { sha: 'c'.repeat(40), ref: 'main' },
      user: { login: 'author' },
    },
    [`repos/${REPO}/compare/${'c'.repeat(40)}...${HEAD}?per_page=1`]: {
      sha: BASE,
    },
    user: { login: 'reviewer' },
    [`repos/${REPO}/pulls/7/reviews`]: {
      html_url: URL_POSTED,
      state: 'COMMENTED',
    },
    ...overrides,
  };
  const calls = [];
  const run = (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 2), ['api', '--include']);
    const rest = args.slice(2);
    const path = rest.find((arg) => arg === 'user' || arg.startsWith('repos/'));
    calls.push(rest);
    const route = routes[path];
    if (route === undefined) assert.fail(`unexpected gh call: ${path}`);
    if (route === null || typeof route === 'number')
      throw Object.assign(new Error('gh failed'), {
        status: 1,
        stdout: `HTTP/2.0 ${route ?? 404} Error\n\n${JSON.stringify({ message: route ? 'Unprocessable Entity' : 'Not Found' })}`,
      });
    const body = typeof route === 'function' ? route(rest) : route;
    return `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}`;
  };
  return Object.assign(run, { calls });
}

function publish(report, run, extra = []) {
  return publishReview(
    [
      '--pr',
      '7',
      '--base',
      BASE,
      '--head',
      HEAD,
      '--report',
      reportFile(report),
      ...extra,
    ],
    { run },
  );
}

// The fields of the review submission, from the `-f name=value` arguments.
function submitted(run) {
  const call = run.calls.find((args) => args.includes('POST'));
  if (!call) return undefined;
  const fields = {};
  for (let i = 0; i < call.length; i += 1)
    if (call[i] === '-f') {
      const [name, ...value] = call[i + 1].split('=');
      fields[name] = value.join('=');
    }
  return fields;
}

test('publish-review requests changes only when the poster is not the PR author', () => {
  const run = fakeGh();
  const report = reviewReport('REQUEST CHANGES');
  assert.deepEqual(publish(report, run), {
    status: 0,
    line: `Posted: REQUEST_CHANGES ${URL_POSTED}`,
  });
  assert.deepEqual(
    run.calls.map((args) =>
      args.find((arg) => arg === 'user' || arg.startsWith('repos/')),
    ),
    [
      `repos/${REPO}/pulls/7`,
      `repos/${REPO}/compare/${'c'.repeat(40)}...${HEAD}?per_page=1`,
      'user',
      `repos/${REPO}/pulls/7/reviews`,
    ],
  );
  // gh filters the compare response so its file patches never reach the buffer.
  assert.deepEqual(run.calls[1].slice(1), [
    '--jq',
    '{sha: .merge_base_commit.sha}',
  ]);
  assert.deepEqual(submitted(run), {
    commit_id: HEAD,
    event: 'REQUEST_CHANGES',
    body: report,
  });

  const own = fakeGh({ user: { login: 'author' } });
  assert.deepEqual(publish(report, own), {
    status: 0,
    line: `Posted: COMMENT ${URL_POSTED}`,
  });
  assert.equal(submitted(own).event, 'COMMENT');
  assert.equal(
    submitted(own).body,
    `Verdict REQUEST CHANGES is posted as a comment because GitHub does not let author request changes on their own pull request.\n\n${report}`,
  );
});

test('publish-review comments when the posting identity is unknown', () => {
  for (const user of [null, 403, {}]) {
    const run = fakeGh({ user });
    assert.deepEqual(publish(reviewReport('REQUEST CHANGES'), run), {
      status: 0,
      line: `Posted: COMMENT ${URL_POSTED}`,
    });
    assert.match(
      submitted(run).body,
      /^Verdict REQUEST CHANGES is posted as a comment because the posting account could not be identified/,
    );
  }
});

test('publish-review never approves and says why the event differs', () => {
  for (const [verdict, reason] of [
    ['APPROVE', /because agent reviews never approve\./],
    ['BLOCKED', /because it is not a review decision\./],
  ]) {
    const run = fakeGh();
    assert.deepEqual(publish(reviewReport(verdict), run), {
      status: 0,
      line: `Posted: COMMENT ${URL_POSTED}`,
    });
    const fields = submitted(run);
    assert.equal(fields.event, 'COMMENT');
    assert.equal(fields.commit_id, HEAD);
    assert.match(fields.body.split('\n')[0], reason);
    assert.ok(fields.body.endsWith(reviewReport(verdict)));
    assert.ok(!run.calls.flat().includes('event=APPROVE'));
  }
});

test('publish-review posts nothing to a merged or closed pull request', () => {
  for (const [merged, word] of [
    ['2026-10-01T00:00:00Z', 'merged'],
    [null, 'closed'],
  ]) {
    const run = fakeGh({
      [`repos/${REPO}/pulls/7`]: {
        state: 'closed',
        merged_at: merged,
        head: { sha: HEAD },
        base: { sha: 'c'.repeat(40), ref: 'gone' },
        user: { login: 'author' },
      },
    });
    assert.deepEqual(publish(reviewReport('REQUEST CHANGES'), run), {
      status: 1,
      line: `Review not posted: pull request #7 is ${word}; reviews post only to open pull requests`,
    });
    assert.equal(submitted(run), undefined);
  }
});

test('publish-review posts nothing when the head or merge base moved', () => {
  const pull = {
    state: 'open',
    merged_at: null,
    head: { sha: 'd'.repeat(40) },
    base: { sha: 'c'.repeat(40), ref: 'main' },
    user: { login: 'author' },
  };
  const headMoved = fakeGh({ [`repos/${REPO}/pulls/7`]: pull });
  assert.deepEqual(publish(reviewReport('APPROVE'), headMoved), {
    status: 1,
    line: `Review not posted: pull request #7 head is now ${'d'.repeat(40)}, not the reviewed ${HEAD}`,
  });
  assert.equal(headMoved.calls.length, 1);
  const baseMoved = fakeGh({
    [`repos/${REPO}/compare/${'c'.repeat(40)}...${HEAD}?per_page=1`]: {
      sha: 'e'.repeat(40),
    },
  });
  assert.deepEqual(publish(reviewReport('APPROVE'), baseMoved), {
    status: 1,
    line: `Review not posted: pull request #7 now has merge base ${'e'.repeat(40)} with main, not the reviewed ${BASE}`,
  });
  assert.equal(submitted(baseMoved), undefined);
});

test('publish-review posts nothing for a report without the reviewed pair', () => {
  for (const [report, reason] of [
    [
      reviewReport('APPROVE').replace(/^Base\/Head:.*\n/m, ''),
      'the report has no readable Base/Head line',
    ],
    [
      reviewReport('APPROVE', `${BASE} to ${HEAD}`),
      'the report has no readable Base/Head line',
    ],
    [
      reviewReport('APPROVE', `${BASE}..${'f'.repeat(40)}`),
      `the report names ${BASE}..${'f'.repeat(40)}, not the reviewed ${BASE}..${HEAD}`,
    ],
    [
      reviewReport('APPROVE').replace(/^Verdict:.*\n/m, ''),
      'the report has no readable Verdict line',
    ],
  ]) {
    const run = fakeGh();
    assert.deepEqual(publish(report, run), {
      status: 1,
      line: `Review not posted: ${reason}`,
    });
    assert.equal(run.calls.length, 0);
  }
});

test('publish-review reports a failed submission without retrying', () => {
  const run = fakeGh({ [`repos/${REPO}/pulls/7/reviews`]: 422 });
  const result = publish(reviewReport('REQUEST CHANGES'), run);
  assert.equal(result.status, 1);
  assert.equal(
    result.line,
    'Review not posted: GitHub API request failed: HTTP 422: Unprocessable Entity.',
  );
  assert.equal(run.calls.filter((args) => args.includes('POST')).length, 1);
});

test('publish-review prefixes every early failure and calls no gh', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  mkdirSync(join(base, '.agents'), { recursive: true });
  writeFileSync(join(base, '.agents/policy.json'), '{}');
  const run = fakeGh();
  const args = ['--pr', '7', '--base', BASE, '--head', HEAD, '--report', 'r'];
  assert.deepEqual(publishReview(args, { base, run }), {
    status: 1,
    line: 'Review not posted: policy.json binding is missing binding',
  });
  for (const bad of [
    args.slice(2),
    ['--pr', 'x', ...args.slice(2)],
    [...args.slice(0, 3), 'abc123', ...args.slice(4)],
    args.slice(0, 6),
  ])
    assert.match(
      publishReview(bad, { run }).line,
      /^Review not posted: usage: publish-review --pr <N>/,
    );
  assert.match(
    publishReview([...args.slice(0, 7), join(base, 'missing.md')], { run })
      .line,
    /^Review not posted: cannot read the report .*missing\.md: ENOENT$/,
  );
  assert.equal(run.calls.length, 0);
  let failure;
  try {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./agent-policy.mjs', import.meta.url)),
        'publish-review',
        '--pr',
        '7',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.status, 1);
  assert.match(failure.stderr, /^Review not posted: usage: publish-review/);
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
        'End with one line: `Posted: <event> <url>` as the command printed it, `Not posted: <reason>` with the reason after `Review not posted:`, or `Posted: none (branch review)`.',
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

const STACK_CHECK =
  'run `gh stack --help`. If it exits non-zero, run `gh --version`';

test('stacking checks for gh stack and only the implement skill prompts the install', () => {
  const files = render();
  for (const role of ['implementer', 'stack-manager', 'orchestrator'])
    for (const path of [
      `.claude/agents/${PREFIX}${role}.md`,
      `.codex/agents/${PREFIX}${role}.toml`,
    ]) {
      const text = files.get(path);
      assert.ok(text.includes(STACK_CHECK), path);
      assert.ok(text.includes('`BLOCKED: gh stack not installed`'), path);
      assert.match(
        returnParagraph(text),
        /BLOCKED: gh stack not installed/,
        path,
      );
      assert.match(text, /never install the extension/i, path);
    }
  for (const path of [
    `.claude/agents/${PREFIX}implementer.md`,
    `.codex/agents/${PREFIX}implementer.toml`,
  ]) {
    const implementer = files.get(path);
    assert.match(
      implementer,
      /before you create a branch on an unmerged base or when you decide to split, run `gh stack --help`/,
      path,
    );
    assert.match(
      implementer,
      /Do not create, rebase, or push a branch or open a PR first/,
      path,
    );
    assert.match(implementer, /resume with the same claim and worktree/, path);
  }
  for (const root of ['.claude/skills', '.agents/skills']) {
    const skill = files.get(`${root}/${PREFIX}implement/SKILL.md`);
    const check = section(skill, 'Check gh stack');
    assert.ok(check.includes('`gh stack --help`'), root);
    assert.ok(
      check.includes('Run `! gh extension install github/gh-stack` here'),
      root,
    );
    assert.match(
      check,
      /Wait for the user to confirm; do not rely on reading the install output\./,
      root,
    );
    assert.match(
      check,
      /Then run `gh stack --help` again\. Continue only when it exits zero, and otherwise give the prompt again\./,
      root,
    );
    assert.match(check, /Never run `gh extension install` yourself\./, root);
    assert.match(check, /continue that same agent/, root);
    assert.ok(
      skill.indexOf('## Check gh stack') < skill.indexOf('## Dispatch'),
      root,
    );
  }
  for (const [path, text] of files)
    if (!path.includes(`/${PREFIX}implement/`))
      assert.doesNotMatch(text, /! gh extension install/, path);
});

test('no role or skill describes a manual stacking fallback', () => {
  const files = render();
  for (const [path, text] of files) {
    assert.doesNotMatch(
      text,
      /updateRefs|force-with-lease|git push --force|fall back to fetching/,
      path,
    );
    for (const line of text.split('\n').filter((l) => l.includes('gh pr edit')))
      assert.match(line, /Never set a PR base with `gh pr edit --base`/, path);
  }
  for (const path of [
    `.claude/agents/${PREFIX}stack-manager.md`,
    `.codex/agents/${PREFIX}stack-manager.toml`,
  ]) {
    const manager = files.get(path);
    assert.match(
      manager,
      /Every build, link, cascade, and push goes through `gh stack`\./,
      path,
    );
    assert.match(
      manager,
      /never rebase, reset, or force-push a stacked branch with plain `git`/,
      path,
    );
    assert.doesNotMatch(manager, /fallback/i, path);
  }
  for (const path of [
    `.claude/agents/${PREFIX}implementer.md`,
    `.codex/agents/${PREFIX}implementer.toml`,
  ])
    assert.match(
      files.get(path),
      /Build, link, and cascade it only through \S+stack-manager with `gh stack`\. Never set a PR base with `gh pr edit --base` or the API, and never rebase a stacked branch yourself\./,
      path,
    );
});
