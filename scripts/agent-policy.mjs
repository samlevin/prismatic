// Repository agent workflows: policy resolution and definition generation.
//
// `resolve` turns a role (or capability) plus optional prompt overrides into
// the exact model and effort a dispatcher must pass when it spawns an agent,
// and refuses unsupported values instead of letting a runtime substitute one.
// `generate` writes the Claude Code and Codex definitions from the shared
// sources under .agents/; `check` fails when a generated file is stale so
// the two tools cannot drift apart. `publish-review` posts a finished manual
// code review to its pull request for the review-code skill.
//
// The sources name no repository. `policy.json` carries a `binding` (the
// namespace prefix, repository, project, tracker documents, and feature
// flags), and every `{{placeholder}}` and `{{#feature}}...{{/feature}}`
// section in a source resolves against it, so another repository reuses the
// same sources with its own policy file.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliHelp, cliError, defineCli, parseCli } from './cli.mjs';
import { failureMessage, ghRest } from './github-api.mjs';

export const TOOLS = ['claude', 'codex'];
// Matches the repository Prettier style so generated YAML passes format:check.
const YAML_STYLE = { singleQuote: true, lineWidth: 0 };
// Only generation needs the yaml package; `resolve` must work from a checkout
// that has not run `npm ci`, so the dependency loads on first use.
const require = createRequire(import.meta.url);
let yamlModule;
function YAML() {
  yamlModule ??= require('yaml');
  return yamlModule;
}
const root = fileURLToPath(new URL('../', import.meta.url));
const SOURCES = {
  policy: '.agents/policy.json',
  roles: '.agents/roles',
  workflows: '.agents/workflows',
  includes: '.agents/includes',
};
const OUTPUTS = {
  claude: { agents: '.claude/agents', skills: '.claude/skills' },
  codex: { agents: '.codex/agents', skills: '.agents/skills' },
};

export function loadPolicy(base = root) {
  const policy = JSON.parse(readFileSync(join(base, SOURCES.policy), 'utf8'));
  binding(policy);
  return policy;
}

// The binding is required in full: a missing key would otherwise surface as
// a literal placeholder inside an agent prompt.
export function binding(policy) {
  const value = policy.binding;
  const missing = (path) => new Error(`policy.json binding is missing ${path}`);
  if (!value) throw missing('binding');
  for (const key of ['namespace', 'label', 'repository'])
    if (typeof value[key] !== 'string' || !value[key]) throw missing(key);
  if (!/^[a-z][a-z0-9]*$/.test(value.namespace))
    throw new Error(
      `policy.json binding.namespace must be lowercase letters and digits, got "${value.namespace}"`,
    );
  const project = value.project ?? {};
  if (typeof project.owner !== 'string' || !project.owner)
    throw missing('project.owner');
  if (!Number.isInteger(project.number) || project.number < 1)
    throw missing('project.number');
  if (typeof project.name !== 'string' || !project.name)
    throw missing('project.name');
  const docs = value.docs ?? {};
  for (const key of ['triage', 'workflow'])
    if (typeof docs[key] !== 'string' || !docs[key])
      throw missing(`docs.${key}`);
  if (!Array.isArray(docs.guides) || docs.guides.length === 0)
    throw missing('docs.guides');
  if (typeof value.features?.infrastructure !== 'boolean')
    throw missing('features.infrastructure');
  return value;
}

export function prefix(policy) {
  return `${binding(policy).namespace}-`;
}

function listPhrase(items) {
  const quoted = items.map((item) => `\`${item}\``);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted.at(-1)}`;
}

// Placeholders a source may use. Anything else is an error, so a typo never
// reaches a generated prompt.
export function placeholders(policy) {
  const value = binding(policy);
  return {
    prefix: prefix(policy),
    label: value.label,
    repository: value.repository,
    'project.owner': value.project.owner,
    'project.number': String(value.project.number),
    'project.name': value.project.name,
    'project.url': `https://github.com/users/${value.project.owner}/projects/${value.project.number}`,
    'docs.triage': value.docs.triage,
    'docs.workflow': value.docs.workflow,
    'docs.guides': listPhrase(value.docs.guides),
  };
}

// `{{#feature}}...{{/feature}}` keeps its content only when the binding
// enables that feature; `{{name}}` becomes the bound value; `\{{` is a
// literal `{{` for text that documents the placeholders themselves.
export function substitute(text, policy) {
  const values = placeholders(policy);
  const features = binding(policy).features;
  const literal = '\u0000';
  const sections = text
    .replaceAll('\\{{', literal)
    .replace(/\{\{#([a-z]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name, content) => {
      if (!(name in features))
        throw new Error(`Unknown feature section: ${name}`);
      return features[name] ? content : '';
    });
  if (/\{\{[#/]/.test(sections))
    throw new Error('Unbalanced feature section in source');
  return sections
    .replace(/\{\{([a-z.]+)\}\}/g, (_, name) => {
      if (!(name in values)) throw new Error(`Unknown placeholder: ${name}`);
      return values[name];
    })
    .replaceAll(literal, '{{');
}

// Includes share text across sources, cannot nest, and stay literal when escaped.
export function include(text, base = root) {
  const expanded = text.replace(/(?<!\\)\{\{>([^}]*)\}\}/g, (tag, name) => {
    const path = join(base, SOURCES.includes, `${name.trim()}.md`);
    if (!/^ [a-z-]+$/.test(name) || !existsSync(path))
      throw new Error(`Unknown include: ${tag}`);
    const content = readFileSync(path, 'utf8').trimEnd();
    if (/(?<!\\)\{\{>/.test(content))
      throw new Error(
        `Nested include in ${SOURCES.includes}/${name.trim()}.md`,
      );
    return content;
  });
  if (/(?<!\\)\{\{>/.test(expanded))
    throw new Error('Malformed include in source');
  return expanded;
}

function supportedEfforts(policy, tool, model) {
  const supported = policy.supported[tool];
  if (supported.models[model]) return supported.models[model];
  if (
    supported.modelIdPattern &&
    new RegExp(supported.modelIdPattern).test(model)
  )
    return supported.models[Object.keys(supported.models)[0]];
  return null;
}

// Prompt overrides win over the policy, one setting at a time. Anything the
// repository does not list is an error, never a fallback.
export function resolve(
  policy,
  { tool, role, capability, model, effort } = {},
) {
  if (!TOOLS.includes(tool)) throw new Error(`Unknown tool: ${tool}`);
  if (role && !policy.roles[role]) throw new Error(`Unknown role: ${role}`);
  const capabilityName = capability ?? (role ? policy.roles[role] : undefined);
  const entry = policy.capabilities[capabilityName];
  if (!entry) throw new Error(`Unknown capability: ${capabilityName}`);
  const defaults = entry[tool];
  const resolved = {
    tool,
    role: role ?? null,
    capability: capabilityName,
    model: model ?? defaults.model,
    effort: effort ?? defaults.effort,
    source: {
      model: model ? 'override' : 'policy',
      effort: effort ? 'override' : 'policy',
    },
  };
  const efforts = supportedEfforts(policy, tool, resolved.model);
  if (!efforts)
    throw new Error(
      `Unsupported ${tool} model "${resolved.model}". Supported: ${Object.keys(policy.supported[tool].models).join(', ')}.`,
    );
  if (!efforts.includes(resolved.effort))
    throw new Error(
      `Unsupported ${tool} effort "${resolved.effort}" for model "${resolved.model}". Supported: ${efforts.join(', ')}.`,
    );
  resolved.spawn =
    tool === 'claude'
      ? {
          subagent_type: role ? prefix(policy) + role : null,
          model: resolved.model,
          effort: resolved.effort,
        }
      : {
          agent_type: role ? prefix(policy) + role : null,
          model: resolved.model,
          reasoning_effort: resolved.effort,
          fork_turns: 'none',
        };
  return resolved;
}

// Recorded effort assessments contain evidence, never a score derived from labels.
export function implementationEffort(
  policy,
  { override, decision, transitions = 0, blocker } = {},
) {
  const rubric = policy.implementationEffort;
  const ordinary = {
    effort: rubric.default,
    rule: 'default',
    evidence: 'ticket/spec',
    reason: 'The written plan resolves the design.',
  };
  if (blocker) return { ...ordinary, blocker };
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
      !decision.evidence?.trim() ||
      !decision.reason?.trim() ||
      !decision.effort
    )
      throw new Error(
        'An effort override record needs effort, evidence, and reason',
      );
    return { ...decision };
  }
  const rule = rubric.rules[decision.rule];
  if (!rule || decision.effort !== rubric.automaticMaximum) return ordinary;
  if (
    !decision.evidence?.trim() ||
    !decision.reason?.trim() ||
    !decision.question?.trim()
  )
    return ordinary;
  if (!rule.requires.every((key) => decision.criteria?.[key] === true))
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

// Each role gets its own resolver call and spawn object, including on escalation.
export function implementationDispatch(
  policy,
  {
    tool,
    issue,
    model,
    effort,
    reviewer = {},
    decision,
    transitions = 0,
    blocker,
  } = {},
) {
  const selected = implementationEffort(policy, {
    override: effort,
    decision,
    transitions,
    blocker,
  });
  if (selected.blocker) throw new Error(selected.blocker);
  const implementer = resolve(policy, {
    tool,
    role: 'implementer',
    model,
    ...(selected.rule === 'default' ? {} : { effort: selected.effort }),
  });
  const review = resolve(policy, { tool, role: 'code-reviewer', ...reviewer });
  return {
    selected,
    implementer,
    reviewer: review,
    announcement: effortAnnouncement(issue, selected),
  };
}

// Shared Markdown sources carry YAML frontmatter plus optional blocks that
// belong to one tool: <!-- claude-only --> ... <!-- /claude-only -->.
export function parseSource(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error('Source is missing frontmatter');
  // A plain (unquoted) scalar ends at ` #`, which YAML reads as a comment, so
  // `Use for "implement #N"` would lose everything after `implement` in both
  // tools without any error. Refuse the source instead of generating it.
  const truncated = match[1]
    .split('\n')
    .find((line) => /^\s*[\w-]+:\s+[^"'|>\s].*\s#/.test(line));
  if (truncated)
    throw new Error(
      `Quote the frontmatter value of ${truncated.trim().split(':')[0]}: a plain value ends at " #"`,
    );
  return { meta: YAML().parse(match[1]), body: text.slice(match[0].length) };
}

export function renderBody(body, tool) {
  const other = TOOLS.find((name) => name !== tool);
  return body
    .replace(
      new RegExp(
        `<!-- ${other}-only -->\\n[\\s\\S]*?<!-- /${other}-only -->\\n?`,
        'g',
      ),
      '',
    )
    .replace(new RegExp(`<!-- /?${tool}-only -->\\n`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

function generated(sourcePath) {
  return `Generated from ${sourcePath} by scripts/agent-policy.mjs. Edit the source and run \`npm run agents:generate\`.`;
}

function tomlString(value) {
  if (value.includes("'''"))
    throw new Error('Developer instructions cannot contain three quotes');
  return `'''\n${value}'''`;
}

function tomlValue(value) {
  return JSON.stringify(value);
}

export function renderRole(policy, name, source, tool) {
  const { meta, body } = parseSource(substitute(source, policy));
  if (meta.name !== name)
    throw new Error(`Role ${name} declares name ${meta.name}`);
  const settings = resolve(policy, { tool, role: name });
  const sourcePath = `${SOURCES.roles}/${name}.md`;
  const text = renderBody(body, tool);
  if (tool === 'claude') {
    // Claude resolves a per-invocation model or effort above frontmatter, so
    // pinning the policy here keeps the repository default without blocking
    // a prompt override.
    const frontmatter = {
      name: prefix(policy) + name,
      description: meta.description,
      ...(meta.claude ?? {}),
      model: settings.model,
      effort: settings.effort,
    };
    return `---\n${YAML().stringify(frontmatter, YAML_STYLE).trimEnd()}\n---\n<!-- ${generated(sourcePath)} -->\n\n${text}`;
  }
  // A Codex agent file that sets model or model_reasoning_effort beats every
  // spawn-time value, which would defeat prompt overrides. The dispatcher
  // passes the resolved policy to spawn_agent instead.
  const lines = [
    `# ${generated(sourcePath)}`,
    `# Model and reasoning effort are intentionally absent: ${binding(policy).namespace} skills pass the`,
    `# repository policy (${settings.model}, ${settings.effort}) or a prompt override to spawn_agent.`,
    `name = ${tomlValue(prefix(policy) + name)}`,
    `description = ${tomlValue(meta.description)}`,
  ];
  for (const [key, value] of Object.entries(meta.codex ?? {}))
    lines.push(`${key} = ${tomlValue(value)}`);
  lines.push(`developer_instructions = ${tomlString(text)}`);
  return lines.join('\n') + '\n';
}

export function renderWorkflow(policy, name, source, tool) {
  const { meta, body } = parseSource(substitute(source, policy));
  if (meta.name !== name)
    throw new Error(`Workflow ${name} declares name ${meta.name}`);
  const sourcePath = `${SOURCES.workflows}/${name}.md`;
  const text = renderBody(body, tool);
  const files = {};
  if (tool === 'claude') {
    const frontmatter = {
      name: prefix(policy) + name,
      description: meta.description,
      ...(meta['argument-hint']
        ? { 'argument-hint': meta['argument-hint'] }
        : {}),
      ...(meta.claude ?? {}),
    };
    if (meta.capability) {
      // A skill runs in the main thread; Claude lets its frontmatter pin the
      // model and effort for that turn, so the policy applies here directly.
      const settings = resolve(policy, { tool, capability: meta.capability });
      frontmatter.model = settings.model;
      frontmatter.effort = settings.effort;
    }
    files['SKILL.md'] =
      `---\n${YAML().stringify(frontmatter, YAML_STYLE).trimEnd()}\n---\n<!-- ${generated(sourcePath)} -->\n\n${text}`;
    return files;
  }
  const codex = meta.codex ?? {};
  files['SKILL.md'] =
    `---\nname: ${prefix(policy) + name}\ndescription: ${JSON.stringify(meta.description)}\n---\n<!-- ${generated(sourcePath)} -->\n\n${text}`;
  const manifest = {
    interface: {
      display_name: codex.display_name ?? `${binding(policy).label}: ${name}`,
      short_description: codex.short_description ?? meta.description,
      default_prompt:
        codex.default_prompt ??
        `Use $${prefix(policy) + name} for this request.`,
    },
    policy: {
      allow_implicit_invocation: codex.allow_implicit_invocation ?? true,
    },
  };
  files['agents/openai.yaml'] =
    `# ${generated(sourcePath)}\n${YAML().stringify(manifest, YAML_STYLE)}`;
  return files;
}

function listSources(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.slice(0, -3))
    .sort();
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

// Everything the generator owns, keyed by repository-relative path.
export function render(base = root) {
  const policy = loadPolicy(base);
  for (const [name, capability] of Object.entries(policy.roles))
    for (const tool of TOOLS) resolve(policy, { tool, role: name, capability });
  for (const name of Object.keys(policy.capabilities))
    for (const tool of TOOLS) resolve(policy, { tool, capability: name });
  const files = new Map();
  const roles = listSources(join(base, SOURCES.roles));
  for (const name of roles) {
    if (!policy.roles[name])
      throw new Error(`Role ${name} has no entry in ${SOURCES.policy}`);
    const source = include(
      readFileSync(join(base, SOURCES.roles, `${name}.md`), 'utf8'),
      base,
    );
    files.set(
      `${OUTPUTS.claude.agents}/${prefix(policy)}${name}.md`,
      renderRole(policy, name, source, 'claude'),
    );
    files.set(
      `${OUTPUTS.codex.agents}/${prefix(policy)}${name}.toml`,
      renderRole(policy, name, source, 'codex'),
    );
  }
  for (const name of Object.keys(policy.roles))
    if (!roles.includes(name))
      throw new Error(`Role ${name} has no source in ${SOURCES.roles}`);
  for (const name of listSources(join(base, SOURCES.workflows))) {
    const source = include(
      readFileSync(join(base, SOURCES.workflows, `${name}.md`), 'utf8'),
      base,
    );
    const shared = join(base, SOURCES.workflows, name);
    for (const tool of TOOLS) {
      const target = `${OUTPUTS[tool].skills}/${prefix(policy)}${name}`;
      for (const [file, content] of Object.entries(
        renderWorkflow(policy, name, source, tool),
      ))
        files.set(`${target}/${file}`, content);
      // Supporting references are copied into both skills with the same
      // includes and placeholders resolved. Markdown references keep only this
      // tool's tool-only blocks, so one reference can carry both tools' steps.
      for (const file of listFiles(shared)) {
        const text = substitute(
          include(readFileSync(file, 'utf8'), base),
          policy,
        );
        files.set(
          `${target}/${relative(shared, file)}`,
          file.endsWith('.md') ? renderBody(text, tool) : text,
        );
      }
    }
  }
  return files;
}

function ownedFiles(base, policy) {
  const owned = [];
  const own = prefix(policy);
  for (const tool of TOOLS) {
    for (const file of listFiles(join(base, OUTPUTS[tool].agents)))
      if (relative(join(base, OUTPUTS[tool].agents), file).startsWith(own))
        owned.push(relative(base, file));
    const skills = join(base, OUTPUTS[tool].skills);
    if (existsSync(skills))
      for (const entry of readdirSync(skills))
        if (entry.startsWith(own))
          for (const file of listFiles(join(skills, entry)))
            owned.push(relative(base, file));
  }
  return owned.sort();
}

export function generate(base = root) {
  const files = render(base);
  for (const path of ownedFiles(base, loadPolicy(base)))
    if (!files.has(path)) rmSync(join(base, path));
  for (const [path, content] of files) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return [...files.keys()].sort();
}

export function check(base = root) {
  const files = render(base);
  const stale = [];
  for (const [path, content] of files) {
    const target = join(base, path);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content)
      stale.push(path);
  }
  for (const path of ownedFiles(base, loadPolicy(base)))
    if (!files.has(path)) stale.push(path);
  return stale.sort();
}

// Manual review publication. The code-reviewer agent stays read-only. The
// review-code skill passes its finished report here, and this posts exactly
// one review to the pull request it reviewed, or posts nothing and says why.
export const REVIEW_VERDICTS = ['APPROVE', 'REQUEST CHANGES', 'BLOCKED'];
const FULL_SHA = /^[0-9a-f]{40}$/;

export class ReviewNotPosted extends Error {
  constructor(message) {
    super(`Review not posted: ${message}`);
    this.name = 'ReviewNotPosted';
  }
}

// Reads the verdict and the reviewed SHAs from a code-reviewer report, which
// has `Verdict: <verdict>` and `Base/Head: <sha>..<sha>` lines. Light
// Markdown around either is tolerated. Two different verdicts are an error,
// and so is a missing pair: a review binds to the commits it read, so a
// report that does not name them is never posted.
export function parseReviewReport(text) {
  const verdicts = new Set(
    [
      ...String(text).matchAll(
        /^[\s>*_`-]*Verdict:[\s*_`]*(APPROVE|REQUEST CHANGES|BLOCKED)\b/gm,
      ),
    ].map((match) => match[1]),
  );
  if (verdicts.size !== 1)
    throw new ReviewNotPosted(
      verdicts.size
        ? `the report has conflicting verdicts (${[...verdicts].join(', ')})`
        : `the report has no Verdict: line with ${REVIEW_VERDICTS.join(', ')}`,
    );
  const pair =
    /^[\s>*_`-]*Base\/Head:[\s*_`]*([0-9a-f]{7,40})`?\s*\.\.\s*`?([0-9a-f]{7,40})\b/m.exec(
      String(text),
    );
  if (!pair)
    throw new ReviewNotPosted(
      'the report has no Base/Head: <sha>..<sha> line naming the reviewed commits',
    );
  return { verdict: [...verdicts][0], base: pair[1], head: pair[2] };
}

// GitHub rejects REQUEST_CHANGES and APPROVE from a pull request's own
// author, so a change request goes out only when the publishing account is
// known and differs from the author. Logins compare case-insensitively, as
// GitHub treats them. Every other case is a COMMENT review, and nothing here
// ever approves.
export function reviewEvent({ verdict, viewer, author }) {
  if (!REVIEW_VERDICTS.includes(verdict))
    throw new Error(`Unknown review verdict: ${verdict}`);
  if (verdict === 'APPROVE')
    return {
      event: 'COMMENT',
      note: 'Verdict APPROVE is posted as a comment because agent reviews never approve.',
    };
  if (verdict === 'BLOCKED')
    return {
      event: 'COMMENT',
      note: 'Verdict BLOCKED is posted as a comment because it is not a review decision.',
    };
  if (!viewer || !author)
    return {
      event: 'COMMENT',
      note: 'Verdict REQUEST CHANGES is posted as a comment because the posting account could not be identified and may be the pull request author.',
    };
  if (viewer.toLowerCase() === author.toLowerCase())
    return {
      event: 'COMMENT',
      note: `Verdict REQUEST CHANGES is posted as a comment because GitHub does not let ${author} request changes on their own pull request.`,
    };
  return { event: 'REQUEST_CHANGES', note: null };
}

// Posts a code review report to an open pull request as one review pinned to
// the reviewed head, after checking that the PR still has the reviewed pair.
export function publishReview(
  policy,
  { pr, base, head, report },
  { run } = {},
) {
  const { repository } = binding(policy);
  if (!/^[1-9][0-9]*$/.test(String(pr ?? '')))
    throw new ReviewNotPosted('--pr must be a pull request number');
  for (const [name, sha] of Object.entries({ base, head }))
    if (!FULL_SHA.test(sha ?? ''))
      throw new ReviewNotPosted(`--${name} must be a full 40-character SHA`);
  if (!String(report ?? '').trim())
    throw new ReviewNotPosted('the review report is empty');
  const reviewed = parseReviewReport(report);
  if (!base.startsWith(reviewed.base) || !head.startsWith(reviewed.head))
    throw new ReviewNotPosted(
      `the report names ${reviewed.base}..${reviewed.head}, not the reviewed ${base}..${head}`,
    );
  const api = (args, input) => {
    try {
      return JSON.parse(ghRest(args, { run, input }));
    } catch (error) {
      throw new ReviewNotPosted(failureMessage(error));
    }
  };
  const pull = api([`repos/${repository}/pulls/${pr}`]);
  if (pull.state !== 'open')
    throw new ReviewNotPosted(
      `pull request #${pr} is ${pull.merged_at ? 'merged' : 'closed'}; reviews post only to open pull requests`,
    );
  if (pull.head.sha !== head)
    throw new ReviewNotPosted(
      `pull request #${pr} head is now ${pull.head.sha}, not the reviewed ${head}`,
    );
  // The skill's `git merge-base <base_sha> <head_sha>`; --jq drops the file
  // patches. Comparing the merge base lets the review post after the base
  // branch tip moves, as long as the reviewed diff is unchanged.
  const mergeBase = api([
    `repos/${repository}/compare/${pull.base.sha}...${head}?per_page=1`,
    '--jq',
    '{sha: .merge_base_commit.sha}',
  ]).sha;
  if (mergeBase !== base)
    throw new ReviewNotPosted(
      `pull request #${pr} now has merge base ${mergeBase} with ${pull.base.ref}, not the reviewed ${base}`,
    );
  let viewer;
  try {
    viewer = JSON.parse(ghRest(['user'], { run })).login;
  } catch {
    viewer = undefined;
  }
  const author = pull.user?.login;
  const { event, note } = reviewEvent({
    verdict: reviewed.verdict,
    viewer,
    author,
  });
  const posted = api(
    [
      '--method',
      'POST',
      `repos/${repository}/pulls/${pr}/reviews`,
      '--input',
      '-',
    ],
    JSON.stringify({
      commit_id: head,
      event,
      body: note ? `${note}\n\n${report}` : report,
    }),
  );
  if (!posted?.html_url)
    throw new ReviewNotPosted(
      'GitHub returned no review URL, so the review cannot be confirmed as posted. Check the pull request before retrying.',
    );
  return {
    posted: true,
    event,
    verdict: reviewed.verdict,
    note,
    url: posted.html_url,
    reviewer: viewer ?? null,
    author: author ?? null,
    base,
    head,
  };
}

const COMMAND_OPTIONS = {
  resolve: ['tool', 'role', 'capability', 'model', 'effort'],
  dispatch: [
    'tool',
    'issue',
    'model',
    'effort',
    'reviewer-model',
    'reviewer-effort',
    'decision',
  ],
  generate: [],
  check: [],
  'publish-review': ['pr', 'base', 'head', 'report'],
};
const USAGE =
  'Usage: node scripts/agent-policy.mjs <resolve|dispatch|generate|check|publish-review> [options]';

function main(args) {
  const [command, ...rest] = args;
  const commandHelp = defineCli(USAGE, Object.values(COMMAND_OPTIONS).flat());
  if (command === '--help' || command === '-h')
    throw new CliHelp(commandHelp.help);
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    console.error(
      cliError(
        commandHelp,
        command ? `Unknown command ${command}` : 'Name a command',
      ).message,
    );
    return 2;
  }
  const cli = defineCli(USAGE, COMMAND_OPTIONS[command]);
  const { options, positionals } = parseCli(rest, cli);
  if (positionals.length) throw cliError(cli, 'Unexpected positional argument');
  if (command === 'resolve') {
    if (options.role && options.capability)
      throw cliError(cli, 'Use --role or --capability, not both');
    const resolved = resolve(loadPolicy(), {
      tool: options.tool,
      role: options.role,
      capability: options.capability,
      model: options.model,
      effort: options.effort,
    });
    console.log(JSON.stringify(resolved, null, 2));
    return 0;
  }
  if (command === 'dispatch') {
    if (!/^[1-9]\d*$/.test(options.issue ?? ''))
      throw cliError(cli, '--issue needs a positive issue number');
    let decision;
    if (options.decision)
      try {
        decision = JSON.parse(readFileSync(options.decision, 'utf8'));
      } catch (error) {
        throw new Error(
          `cannot read the decision ${options.decision}: ${error.message}`,
          { cause: error },
        );
      }
    const packet = implementationDispatch(loadPolicy(), {
      tool: options.tool,
      issue: Number(options.issue),
      model: options.model,
      effort: options.effort,
      reviewer: {
        model: options['reviewer-model'],
        effort: options['reviewer-effort'],
      },
      decision,
    });
    console.log(JSON.stringify(packet, null, 2));
    return 0;
  }
  if (command === 'generate') {
    for (const path of generate()) console.log(path);
    return 0;
  }
  if (command === 'publish-review') {
    const reportPath = options.report;
    if (!reportPath) throw new ReviewNotPosted('--report <file> is required');
    let report;
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch (error) {
      throw new ReviewNotPosted(
        `cannot read the report ${reportPath}: ${error.code}`,
      );
    }
    const result = publishReview(loadPolicy(), {
      pr: options.pr,
      base: options.base,
      head: options.head,
      report,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const stale = check();
  if (!stale.length) return 0;
  console.error(
    `Generated agent definitions are out of date. Run \`npm run agents:generate\` and commit:\n${stale.map((path) => `  ${path}`).join('\n')}`,
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
