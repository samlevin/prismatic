// Repository agent workflows: policy resolution and definition generation.
//
// `resolve` turns a role (or capability) plus optional prompt overrides into
// the exact model and effort a dispatcher must pass when it spawns an agent,
// and refuses unsupported values instead of letting a runtime substitute one.
// `generate` writes the Claude Code and Codex definitions from the shared
// sources under .agents/; `check` fails when a generated file is stale so
// the two tools cannot drift apart.
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
    const source = readFileSync(
      join(base, SOURCES.roles, `${name}.md`),
      'utf8',
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
    const source = readFileSync(
      join(base, SOURCES.workflows, `${name}.md`),
      'utf8',
    );
    const shared = join(base, SOURCES.workflows, name);
    for (const tool of TOOLS) {
      const target = `${OUTPUTS[tool].skills}/${prefix(policy)}${name}`;
      for (const [file, content] of Object.entries(
        renderWorkflow(policy, name, source, tool),
      ))
        files.set(`${target}/${file}`, content);
      // Supporting references are copied into both skills with the same
      // placeholders resolved.
      for (const file of listFiles(shared))
        files.set(
          `${target}/${relative(shared, file)}`,
          substitute(readFileSync(file, 'utf8'), policy),
        );
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

function argument(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function main(args) {
  const [command, ...rest] = args;
  if (command === 'resolve') {
    const resolved = resolve(loadPolicy(), {
      tool: argument(rest, 'tool'),
      role: argument(rest, 'role'),
      capability: argument(rest, 'capability'),
      model: argument(rest, 'model'),
      effort: argument(rest, 'effort'),
    });
    console.log(JSON.stringify(resolved, null, 2));
    return 0;
  }
  if (command === 'generate') {
    for (const path of generate()) console.log(path);
    return 0;
  }
  if (command === 'check') {
    const stale = check();
    if (!stale.length) return 0;
    console.error(
      `Generated agent definitions are out of date. Run \`npm run agents:generate\` and commit:\n${stale.map((path) => `  ${path}`).join('\n')}`,
    );
    return 1;
  }
  console.error(
    'Usage: node scripts/agent-policy.mjs resolve --tool <claude|codex> (--role <role> | --capability <capability>) [--model <model>] [--effort <effort>]\n' +
      '       node scripts/agent-policy.mjs generate\n' +
      '       node scripts/agent-policy.mjs check',
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
