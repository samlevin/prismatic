// Judges recorded process requests for SecurityScenarioRunner: what in a
// request could run a program the repository controls, and which repository
// paths a Git request reads the contents of.
import { lexicalPath } from './InstrumentedFileSystem.ts';
import type { ProcessRequest } from './InstrumentedProcessRunner.ts';

// Git settings whose value names a program for Git to run.
const programSetting =
  /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)|diff\.external|credential\.(?:.+\.)?helper|filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:textconv|command)|merge\..+\.driver|uploadpack\.packobjectshook|sequence\.editor|gpg\.(?:.+\.)?program|remote\..+\.(?:uploadpack|receivepack|vcs)|submodule\..+\.update|alias\..+)$/i;
// Settings that load more configuration from a file.
const includeSetting = /^(?:include\.path|includeif\..+\.path)$/i;
// `protocol.allow` and `protocol.ext.allow` can enable the `ext::` transport,
// which runs a command. Other protocols, such as https, run no program.
const transportSetting = /^protocol\.(?:ext\.)?allow$/i;
const disabledValues = new Set(['', '/dev/null', 'false', 'never']);

const programEnvironment = new Set([
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_PROXY_COMMAND',
]);
// Variables that tell Git where to find configuration, hooks, or a
// repository. Pointing one into the repository tree hands it control.
const locationEnvironment = new Set([
  'HOME',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_TEMPLATE_DIR',
]);
const programOptions = [
  '--ext-diff',
  '--textconv',
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--open-files-in-pager',
];
const locationOptions = ['--git-dir', '--work-tree', '--template', '-C'];
// Git options before the subcommand that take the next argument as a value.
const valueOptions = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

// Subcommands that read file contents, each with the flags that limit it to
// names, types, or sizes.
const nameOnly = ['--name-only', '--name-status', '--raw'];
const contentCommands = new Map<string, readonly string[]>([
  ['cat-file', ['--batch-check', '-t', '-s', '-e']],
  ['show', nameOnly],
  ['diff', nameOnly],
  ['diff-tree', nameOnly],
  ['log', nameOnly],
  // A search reads every blob it scans, whatever it prints.
  ['grep', []],
  ['blame', []],
  ['archive', []],
  ['checkout', []],
  ['restore', []],
]);

const quote = (value: string): string => JSON.stringify(value);

export interface InvocationContext {
  readonly root: string;
  readonly trustedExecutables: ReadonlySet<string>;
  // Every name the repository and its payloads hold.
  readonly repositoryPaths: ReadonlySet<string>;
  readonly canaries: readonly string[];
}

interface ParsedArgs {
  // Arguments before `--`.
  readonly options: readonly string[];
  readonly pathspecs: readonly string[];
  readonly subcommand: string | undefined;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  const pathspecs = separator === -1 ? [] : args.slice(separator + 1);
  let subcommand: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index] ?? '';
    if (valueOptions.has(arg)) index += 1;
    else if (!arg.startsWith('-')) {
      subcommand = arg;
      break;
    }
  }
  return { options, pathspecs, subcommand };
}

// `<rev>:<path>` names a path at a revision; the path is data.
const revisionPath = (arg: string): string | undefined => {
  const colon = arg.indexOf(':');
  return colon > 0 && !arg.startsWith('-') ? arg.slice(colon + 1) : undefined;
};

function settingProblem(key: string, value: string): string | undefined {
  if (disabledValues.has(value)) return undefined;
  if (programSetting.test(key)) {
    return `sets ${quote(key)}, which runs a program`;
  }
  if (includeSetting.test(key)) {
    return `sets ${quote(key)}, which loads configuration from a file`;
  }
  if (transportSetting.test(key)) {
    return `sets ${quote(key)}, which allows a transport that runs a program`;
  }
  return undefined;
}

function splitSetting(setting: string): [string, string] {
  const equals = setting.indexOf('=');
  // `-c name` without a value means true.
  return equals === -1
    ? [setting, 'true']
    : [setting.slice(0, equals), setting.slice(equals + 1)];
}

// Everything in one request that could run a program the repository
// controls.
export function executionProblems(
  request: ProcessRequest,
  context: InvocationContext,
): string[] {
  const problems: string[] = [];
  const { options } = parseArgs(request.args);
  const env = request.options.env ?? {};
  const inside = (path: string): boolean => {
    const resolved = lexicalPath(path, request.options.cwd ?? '/');
    return resolved === context.root || resolved.startsWith(`${context.root}/`);
  };
  if (request.options.shell !== undefined && request.options.shell !== false) {
    problems.push('runs through a shell');
  }
  if (!context.trustedExecutables.has(request.command)) {
    problems.push('runs an executable outside the trusted list');
  }
  if (request.options.cwd !== undefined && inside(request.options.cwd)) {
    problems.push(
      'runs inside the repository tree, where Git would find its configuration',
    );
  }
  for (const [index, arg] of options.entries()) {
    const next = options[index + 1];
    if (arg.startsWith('-') && context.repositoryPaths.has(arg)) {
      problems.push(`passes the repository name ${quote(arg)} as an option`);
    }
    if (programOptions.some((option) => arg.startsWith(option))) {
      problems.push(`passes ${quote(arg)}, which runs a program`);
    }
    for (const option of locationOptions) {
      const value = arg.startsWith(`${option}=`)
        ? arg.slice(option.length + 1)
        : arg === option
          ? next
          : undefined;
      if (value !== undefined && inside(value)) {
        problems.push(`points ${option} into the repository tree`);
      }
    }
    if (arg === '-c' && next !== undefined) {
      const problem = settingProblem(...splitSetting(next));
      if (problem !== undefined) problems.push(problem);
    }
    const configEnv = arg.startsWith('--config-env=')
      ? arg.slice('--config-env='.length)
      : arg === '--config-env'
        ? next
        : undefined;
    if (configEnv !== undefined) {
      const [key, variable] = splitSetting(configEnv);
      const problem = settingProblem(key, env[variable] ?? '');
      if (problem !== undefined) problems.push(problem);
    }
  }
  for (const [name, value = ''] of Object.entries(env)) {
    if (programEnvironment.has(name) && value !== '') {
      problems.push(`sets ${name}, which runs a program`);
    }
    if (locationEnvironment.has(name) && value !== '' && inside(value)) {
      problems.push(`points ${name} into the repository tree`);
    }
    const match = /^GIT_CONFIG_KEY_(\d+)$/.exec(name);
    if (match !== null) {
      const problem = settingProblem(
        value,
        env[`GIT_CONFIG_VALUE_${match[1]}`] ?? '',
      );
      if (problem !== undefined) problems.push(problem);
    }
  }
  // A canary in a repository name or a `<rev>:<path>` argument or input line
  // is data; in any other argument, input line, the command, or the
  // environment it is a command someone is about to run.
  const isPath = (token: string): boolean =>
    context.repositoryPaths.has(token) ||
    context.repositoryPaths.has(revisionPath(token) ?? '');
  const carriers = [
    request.command,
    ...Object.values(env).map((value) => value ?? ''),
    ...options.filter((arg) => !isPath(arg)),
    ...(request.options.input ?? '')
      .split(/[\n\0]/)
      .filter((line) => !isPath(line)),
  ];
  for (const canary of context.canaries) {
    if (carriers.some((value) => value.includes(canary))) {
      problems.push(`carries the planted command ${quote(canary)}`);
    }
  }
  return problems;
}

// Strips `^{tree}`, `~2`, and similar suffixes, and splits ranges.
function revisionsIn(arg: string): string[] {
  return arg
    .split(/\.{2,3}/)
    .map((part) => part.split(/[\^~]/)[0] ?? '')
    .filter((part) => part !== '');
}

const stripMagic = (pathspec: string): string | undefined => {
  if (pathspec.startsWith(':!') || pathspec.startsWith(':^')) return undefined;
  const magic = /^:\([^)]*\)/.exec(pathspec);
  return magic === null ? pathspec : pathspec.slice(magic[0].length);
};

// Repository paths whose contents a Git request reads at one of the given
// revisions: `<rev>:<path>` arguments and input lines, and the pathspecs of
// a content command that names the revision.
export function gitReadPaths(
  request: ProcessRequest,
  revisionNames: ReadonlySet<string>,
): string[] {
  const { options, pathspecs, subcommand } = parseArgs(request.args);
  const limits =
    subcommand === undefined ? undefined : contentCommands.get(subcommand);
  if (limits === undefined) return [];
  if (request.args.some((arg) => limits.includes(arg))) return [];
  const named = (revision: string): boolean => revisionNames.has(revision);
  const paths: string[] = [];
  const lines = (request.options.input ?? '').split(/[\n\0]/);
  for (const token of [...options, ...lines]) {
    const path = revisionPath(token);
    // An empty path names the root tree, which is a listing, not contents.
    if (path && named(token.slice(0, token.indexOf(':')))) {
      paths.push(path);
    }
  }
  const namesRevision = options.some(
    (arg) => !arg.startsWith('-') && revisionsIn(arg).some(named),
  );
  if (namesRevision) {
    for (const pathspec of pathspecs) {
      const path = stripMagic(pathspec);
      if (path !== undefined) paths.push(path);
    }
  }
  return paths;
}
