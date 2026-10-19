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

// Variables that name a program for Git, or a program Git starts, to run.
const programEnvironment = new Set([
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PROXY_COMMAND',
  'SSH_ASKPASS',
  'PAGER',
  'EDITOR',
  'VISUAL',
]);
// Variables that make the dynamic loader run a library in the process.
const loaderEnvironment = new Set([
  'LD_PRELOAD',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
]);
// Colon-separated lists of directories searched for programs or libraries.
const searchPathEnvironment =
  /^(?:PATH|GIT_EXEC_PATH|LD_LIBRARY_PATH|DYLD_.+)$/;
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
  '--attr-source',
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
  // Index of the subcommand in the arguments, or -1 when there is none.
  readonly subcommandIndex: number;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  let subcommandIndex = -1;
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index] ?? '';
    if (valueOptions.has(arg)) index += 1;
    else if (!arg.startsWith('-')) {
      subcommandIndex = index;
      break;
    }
  }
  return { options, subcommandIndex };
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

// Reads `GIT_CONFIG_PARAMETERS`, the list Git hands its child processes for
// `-c`: single-quoted `'key'='value'` entries, or the older `'key=value'`,
// separated by whitespace. Undefined when the text is malformed.
export function parseConfigParameters(
  text: string,
): [string, string][] | undefined {
  const settings: [string, string][] = [];
  let index = 0;
  const atBoundary = (): boolean =>
    index >= text.length || /\s/.test(text[index] ?? '');
  const quoted = (): string | undefined => {
    if (text[index] !== "'") return undefined;
    index += 1;
    let value = '';
    for (;;) {
      const close = text.indexOf("'", index);
      if (close === -1) return undefined;
      value += text.slice(index, close);
      index = close + 1;
      // `'\''` and `'\!'` put a quote or `!` inside a quoted string.
      const escaped = text[index + 1] ?? '';
      if (
        text[index] !== '\\' ||
        (escaped !== "'" && escaped !== '!') ||
        text[index + 2] !== "'"
      ) {
        return value;
      }
      value += escaped;
      index += 3;
    }
  };
  for (;;) {
    while (index < text.length && atBoundary()) index += 1;
    if (index >= text.length) return settings;
    const key = quoted();
    if (key === undefined) return undefined;
    if (text[index] !== '=') settings.push(splitSetting(key));
    else {
      index += 1;
      // `'key'=` with nothing after it means true.
      const value = atBoundary() ? 'true' : quoted();
      if (value === undefined) return undefined;
      settings.push([key, value]);
    }
    if (!atBoundary()) return undefined;
  }
}

interface Settings {
  readonly settings: readonly (readonly [string, string])[];
  // True when GIT_CONFIG_PARAMETERS cannot be read.
  readonly unreadable: boolean;
}

// Every configuration setting a request hands Git: `-c`, `--config-env`,
// `GIT_CONFIG_KEY_<n>` with `GIT_CONFIG_VALUE_<n>`, and
// `GIT_CONFIG_PARAMETERS`.
function settingsOf(request: ProcessRequest): Settings {
  const { options } = parseArgs(request.args);
  const env = request.options.env ?? {};
  const settings: (readonly [string, string])[] = [];
  for (const [index, arg] of options.entries()) {
    const next = options[index + 1];
    if (arg === '-c' && next !== undefined) settings.push(splitSetting(next));
    const configEnv = arg.startsWith('--config-env=')
      ? arg.slice('--config-env='.length)
      : arg === '--config-env'
        ? next
        : undefined;
    if (configEnv !== undefined) {
      const [key, variable] = splitSetting(configEnv);
      settings.push([key, env[variable] ?? '']);
    }
  }
  let unreadable = false;
  for (const [name, value = ''] of Object.entries(env)) {
    const match = /^GIT_CONFIG_KEY_(\d+)$/.exec(name);
    if (match !== null) {
      settings.push([value, env[`GIT_CONFIG_VALUE_${match[1]}`] ?? '']);
    }
    if (name === 'GIT_CONFIG_PARAMETERS') {
      const parsed = parseConfigParameters(value);
      if (parsed === undefined) unreadable = true;
      else settings.push(...parsed);
    }
  }
  return { settings, unreadable };
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
  }
  for (const [name, value = ''] of Object.entries(env)) {
    if (value === '') continue;
    if (programEnvironment.has(name)) {
      problems.push(`sets ${name}, which runs a program`);
    }
    if (loaderEnvironment.has(name)) {
      problems.push(`sets ${name}, which loads a library into the process`);
    } else if (
      searchPathEnvironment.test(name) &&
      // An empty entry means the working directory.
      value.split(':').some((entry) => inside(entry === '' ? '.' : entry))
    ) {
      problems.push(`puts the repository tree on ${name}`);
    }
    if (locationEnvironment.has(name) && inside(value)) {
      problems.push(`points ${name} into the repository tree`);
    }
  }
  const { settings, unreadable } = settingsOf(request);
  if (unreadable) {
    problems.push('sets GIT_CONFIG_PARAMETERS in a form the check cannot read');
  }
  for (const [key, value] of settings) {
    const problem = settingProblem(key, value);
    if (problem !== undefined) problems.push(problem);
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

// What a Git object name resolves to in the mounted revision.
export interface MountedObject {
  readonly type: 'commit' | 'tree' | 'blob';
  // Path of the object in the mounted tree; empty for the commit and its
  // root tree.
  readonly path: string;
}

export interface RevisionView {
  // Names Git resolves, such as commit labels, refs, short ref names, HEAD,
  // and full object IDs, each mapped to what it names in the mounted
  // revision. A name of any other commit maps to an empty list.
  readonly names: ReadonlyMap<string, readonly MountedObject[]>;
  // Every path in the mounted tree.
  readonly paths: ReadonlySet<string>;
}

export interface GitRead {
  // Repository path whose contents are read; empty for the whole tree.
  readonly path: string;
  // Paths that exclusion pathspecs leave out of the read.
  readonly excludes: readonly string[];
}

const objectId = /^[0-9a-f]{40}$/;

// Looks a name up as Git does: exactly, or as an object ID abbreviated to
// at least four hex digits. Undefined when Git would not know the name.
function lookUp(
  name: string,
  view: RevisionView,
): readonly MountedObject[] | undefined {
  const exact = view.names.get(name === '' || name === '@' ? 'HEAD' : name);
  if (exact !== undefined) return exact;
  const prefix = name.toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(prefix)) return undefined;
  let found: MountedObject[] | undefined;
  for (const [id, objects] of view.names) {
    if (objectId.test(id) && id.startsWith(prefix)) {
      found = [...(found ?? []), ...objects];
    }
  }
  return found;
}

function joinPath(prefix: string, path: string): string {
  const relative = path.replace(/^(?:\.\/)+/, '');
  if (prefix === '') return relative;
  return relative === '' ? prefix : `${prefix}/${relative}`;
}

function objectAt(
  prefix: string,
  path: string,
  view: RevisionView,
): MountedObject {
  const full = joinPath(prefix, path).replace(/\/+$/, '');
  const directory =
    full === '' ||
    (!view.paths.has(full) &&
      [...view.paths].some((item) => item.startsWith(`${full}/`)));
  return { type: directory ? 'tree' : 'blob', path: full };
}

// Resolves an object name such as `main`, `a1b2c3d`, `rev~1`,
// `rev^{tree}`, `rev:src/app.ts`, `^base`, or `base..rev` to what it names
// in the mounted revision. A revision built on the mounted one, such as
// `rev~1`, counts as naming it, since its ancestors usually hold the same
// files. Undefined when Git would not resolve the name, which makes the
// argument a pathspec.
export function resolveObject(
  name: string,
  view: RevisionView,
): readonly MountedObject[] | undefined {
  if (name.startsWith('-')) return undefined;
  const colon = name.indexOf(':');
  if (colon > 0) {
    return resolveObject(name.slice(0, colon), view)
      ?.filter((holder) => holder.type !== 'blob')
      .map((holder) => objectAt(holder.path, name.slice(colon + 1), view));
  }
  if (colon === 0 || /^(?:\.{2,3})?$/.test(name)) return undefined;
  const found: MountedObject[] = [];
  for (const part of name.split(/\.{2,3}/)) {
    const bare = part.replace(/^\^/, '');
    const suffix = /[~^]|@\{/.exec(bare);
    const objects = lookUp(
      suffix === null ? bare : bare.slice(0, suffix.index),
      view,
    );
    if (objects === undefined) return undefined;
    const peeled = bare.endsWith('^{tree}');
    for (const object of objects) {
      found.push(
        peeled && object.type === 'commit'
          ? { type: 'tree', path: object.path }
          : object,
      );
    }
  }
  return found;
}

// How much of a commit, tree, or blob a command reads:
// - contents: every file in it
// - patch: its diff, unless flags limit the output to names
// - requested-patch: its diff, only when a flag asks for one
// - nothing: names, IDs, or a listing
type Reach = 'contents' | 'patch' | 'requested-patch' | 'nothing';

interface CommandSpec {
  readonly commit: Reach;
  readonly tree: Reach;
  readonly blob: Reach;
  // Options whose value is the next argument.
  readonly values: readonly string[];
  // Options whose value is a revision.
  readonly revisionValues?: readonly string[];
  // `git grep` takes its first argument as the pattern unless `-e` or `-f`
  // gives one.
  readonly pattern?: boolean;
  // Arguments that are not revisions are pathspecs.
  readonly pathspecs: boolean;
  // Every option value may be a revision.
  readonly valuesMayBeRevisions?: boolean;
  // False when the arguments make the command read nothing at all.
  readonly reads?: (args: readonly string[]) => boolean;
}

const diffValues = [
  '-O',
  '-S',
  '-G',
  '-I',
  '--ignore-matching-lines',
  '--diff-filter',
  '--find-object',
  '--word-diff-regex',
  '--src-prefix',
  '--dst-prefix',
  '--line-prefix',
  '--anchored',
  '--inter-hunk-context',
  '--output',
  '--stat-width',
  '--stat-name-width',
  '--stat-graph-width',
  '--stat-count',
];
const logValues = [
  ...diffValues,
  '-n',
  '-L',
  '--max-count',
  '--skip',
  '--since',
  '--after',
  '--until',
  '--before',
  '--author',
  '--committer',
  '--grep',
  '--min-parents',
  '--max-parents',
  '--encoding',
  '--exclude',
  '--decorate-refs',
  '--decorate-refs-exclude',
];
const blameValues = [
  '-L',
  '-S',
  '--contents',
  '--ignore-rev',
  '--ignore-revs-file',
];

const command = (
  commit: Reach,
  tree: Reach,
  blob: Reach,
  values: readonly string[],
): CommandSpec => ({ commit, tree, blob, values, pathspecs: true });
const contentCommand = (values: readonly string[]): CommandSpec =>
  command('contents', 'contents', 'contents', values);
const typeNames = new Set(['blob', 'tree', 'commit', 'tag']);

// Commands that read file contents, by how they treat what they are given.
// Any other command that names the mounted revision is taken to read all of
// it, except the ones in nameCommands.
const contentCommands = new Map<string, CommandSpec>([
  [
    'cat-file',
    {
      ...command('nothing', 'nothing', 'contents', []),
      pathspecs: false,
      // `-t`, `-s`, `-e`, and `--batch-check` print only metadata.
      reads: (args) =>
        args.some(
          (arg) =>
            typeNames.has(arg) ||
            /^(?:-p|--batch(?:=.*)?|--batch-command(?:=.*)?|--textconv|--filters)$/.test(
              arg,
            ),
        ),
    },
  ],
  ['unpack-file', command('nothing', 'nothing', 'contents', [])],
  ['show', command('patch', 'nothing', 'contents', logValues)],
  ['diff', command('patch', 'patch', 'patch', diffValues)],
  [
    'diff-tree',
    command('requested-patch', 'requested-patch', 'nothing', diffValues),
  ],
  ['log', command('requested-patch', 'requested-patch', 'nothing', logValues)],
  [
    'whatchanged',
    command('requested-patch', 'requested-patch', 'nothing', logValues),
  ],
  [
    'format-patch',
    contentCommand([
      ...diffValues,
      '-o',
      '--output-directory',
      '-v',
      '--reroll-count',
      '--to',
      '--cc',
      '--subject-prefix',
      '--in-reply-to',
      '--base',
      '--signature',
      '--signature-file',
      '--suffix',
      '--start-number',
      '--interdiff',
      '--range-diff',
      '--creation-factor',
      '--add-header',
    ]),
  ],
  [
    'grep',
    {
      ...contentCommand([
        '-e',
        '-f',
        '-A',
        '-B',
        '-C',
        '-m',
        '--context',
        '--after-context',
        '--before-context',
        '--max-count',
        '--max-depth',
        '--threads',
      ]),
      pattern: true,
    },
  ],
  ['blame', contentCommand(blameValues)],
  ['annotate', contentCommand(blameValues)],
  [
    'archive',
    {
      ...contentCommand([
        '-o',
        '--output',
        '--format',
        '--prefix',
        '--remote',
        '--exec',
        '--add-file',
        '--add-virtual-file',
        '--mtime',
      ]),
      reads: (args) => !args.includes('--list') && !args.includes('-l'),
    },
  ],
  [
    'checkout',
    contentCommand([
      '-b',
      '-B',
      '--orphan',
      '--conflict',
      '--pathspec-from-file',
    ]),
  ],
  [
    'restore',
    {
      ...contentCommand([
        '-s',
        '--source',
        '--conflict',
        '--pathspec-from-file',
      ]),
      revisionValues: ['-s', '--source'],
    },
  ],
]);

// Commands that print only names, IDs, sizes, or history, whatever
// revision they are given.
const nameCommands = new Set([
  'branch',
  'check-ref-format',
  'cherry',
  'commit-tree',
  'config',
  'count-objects',
  'describe',
  'fetch',
  'for-each-ref',
  'fsck',
  'hash-object',
  'help',
  'init',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'mktree',
  'name-rev',
  'reflog',
  'remote',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show-ref',
  'status',
  'symbolic-ref',
  'tag',
  'update-ref',
  'var',
  'verify-commit',
  'verify-tag',
  'version',
]);
const otherCommand: CommandSpec = {
  ...contentCommand([]),
  pathspecs: false,
  valuesMayBeRevisions: true,
};

// Flags that select every ref, which includes the mounted revision.
const allRefsFlag =
  /^--(?:all|branches|tags|remotes|glob|reflog|alternate-refs)(?:=.*)?$/;
// Flags that turn on a diff of file contents, or a summary computed from one.
const patchFlag =
  /^(?:-[pumcW]|-U\d*|-X.*|--patch(?:-with-stat|-with-raw)?|--cc|--unified(?:=.*)?|--function-context|--word-diff(?:=.*)?|--color-words(?:=.*)?|--stat(?:=.*)?|--numstat|--shortstat|--dirstat(?:=.*)?|--compact-summary|--binary)$/;
// Flags that search file contents, which reads them whatever is printed.
const scanFlag = /^(?:-[SGL].*|--check)$/;
// Git drops every patch and summary format when a name format is asked for.
const nameFlag = /^--name-(?:only|status)$/;
const patchOffFlag = /^(?:-s|--no-patch|--raw|--quiet)$/;

function reaches(reach: Reach, flags: readonly string[]): boolean {
  if (reach === 'contents' || reach === 'nothing') return reach === 'contents';
  if (flags.some((flag) => scanFlag.test(flag))) return true;
  if (flags.some((flag) => nameFlag.test(flag))) return false;
  if (flags.some((flag) => patchFlag.test(flag))) return true;
  return reach === 'patch' && !flags.some((flag) => patchOffFlag.test(flag));
}

interface Pathspec {
  readonly exclude: boolean;
  readonly path: string;
}

// The part of the tree a pathspec covers. `:(exclude)`, `:!`, `:^`,
// `:(literal)`, and `:(icase)` magic is honored. A glob covers the
// directory before its first wildcard, and a case-insensitive pathspec
// covers the whole tree. Exclusions with a wildcard or `icase` are dropped,
// so they leave nothing out.
function readPathspec(spec: string): Pathspec | undefined {
  let path = spec;
  let exclude = false;
  let literal = false;
  let caseless = false;
  const long = /^:\(([^)]*)\)/.exec(spec);
  if (long !== null) {
    path = spec.slice(long[0].length);
    for (const word of (long[1] ?? '').split(',')) {
      if (word === 'exclude') exclude = true;
      else if (word === 'literal') literal = true;
      else if (word === 'icase') caseless = true;
    }
  } else if (spec.startsWith(':')) {
    const short = /^:[/!^]*:?/.exec(spec)?.[0] ?? ':';
    exclude = /[!^]/.test(short);
    path = spec.slice(short.length);
  }
  const wildcard = literal ? -1 : path.search(/[*?[]/);
  if (exclude) {
    return wildcard === -1 && !caseless ? { exclude, path } : undefined;
  }
  if (caseless) return { exclude, path: '' };
  if (wildcard === -1) return { exclude, path };
  return { exclude, path: path.slice(0, path.lastIndexOf('/', wildcard) + 1) };
}

interface Walk {
  readonly flags: string[];
  readonly objects: MountedObject[];
  readonly pathspecs: Pathspec[];
}

// Sorts the arguments after the subcommand into flags, the objects they
// name, and pathspecs.
function walk(
  args: readonly string[],
  spec: CommandSpec,
  view: RevisionView,
): Walk {
  const result: Walk = { flags: [], objects: [], pathspecs: [] };
  const addObject = (name: string): void => {
    result.objects.push(...(resolveObject(name, view) ?? []));
  };
  let patternPending =
    spec.pattern === true &&
    !args.some((arg) => /^(?:-[ef].*|--file(?:=.*)?)$/.test(arg));
  let separated = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (separated) {
      const pathspec = spec.pathspecs ? readPathspec(arg) : undefined;
      if (pathspec !== undefined) result.pathspecs.push(pathspec);
    } else if (patternPending && (arg === '--' || !arg.startsWith('-'))) {
      // Git takes the first argument as the pattern, even `--`.
      patternPending = false;
    } else if (arg === '--') {
      separated = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      result.flags.push(arg);
      const equals = arg.indexOf('=');
      const option = equals === -1 ? arg : arg.slice(0, equals);
      let value: string | undefined;
      if (equals !== -1) value = arg.slice(equals + 1);
      else if (spec.values.includes(arg)) {
        index += 1;
        value = args[index];
      }
      if (
        value !== undefined &&
        (spec.valuesMayBeRevisions === true ||
          spec.revisionValues?.includes(option) === true)
      ) {
        addObject(value);
      }
      if (allRefsFlag.test(arg))
        result.objects.push({ type: 'commit', path: '' });
    } else if (resolveObject(arg, view) !== undefined) {
      addObject(arg);
    } else if (spec.pathspecs) {
      const pathspec = readPathspec(arg);
      if (pathspec !== undefined) result.pathspecs.push(pathspec);
    }
  }
  return result;
}

// Objects named on standard input: `git cat-file --batch` object names,
// `--batch-command` `contents` lines, and revisions for any other command.
function inputObjects(
  subcommand: string,
  flags: readonly string[],
  input: string,
  view: RevisionView,
): MountedObject[] {
  const objects: MountedObject[] = [];
  const add = (name: string): void => {
    objects.push(...(resolveObject(name, view) ?? []));
  };
  const commands = flags.some((flag) => flag.startsWith('--batch-command'));
  for (const line of input.split(/[\n\0]/)) {
    if (subcommand !== 'cat-file') add(line);
    else if (commands) {
      const contents = /^contents (.*)$/.exec(line);
      if (contents !== null) add(contents[1] ?? '');
    } else {
      // With `%(rest)` in the format the object name ends at the first
      // whitespace; without it, the whole line is the name.
      add(line);
      add(line.split(/\s/)[0] ?? '');
    }
  }
  return objects;
}

// Every `.gitattributes` file in a tree, which Git reads when it takes
// attributes from that tree through `--attr-source`, `GIT_ATTR_SOURCE`, or
// `attr.tree`.
function attributeFiles(object: MountedObject, view: RevisionView): string[] {
  const files = [...view.paths].filter(
    (path) =>
      (object.path === '' || path.startsWith(`${object.path}/`)) &&
      /(?:^|\/)\.gitattributes$/.test(path),
  );
  return files.length > 0 ? files : [joinPath(object.path, '.gitattributes')];
}

function attributeSources(request: ProcessRequest, top: readonly string[]) {
  const sources = [request.options.env?.GIT_ATTR_SOURCE ?? ''];
  for (const [key, value] of settingsOf(request).settings) {
    if (key.toLowerCase() === 'attr.tree') sources.push(value);
  }
  for (const [index, arg] of top.entries()) {
    if (arg.startsWith('--attr-source=')) {
      sources.push(arg.slice('--attr-source='.length));
    } else if (arg === '--attr-source') sources.push(top[index + 1] ?? '');
  }
  return sources;
}

// Repository paths whose contents a Git request reads in the mounted
// revision, through any name Git resolves to it or to an object in it.
export function gitReadPaths(
  request: ProcessRequest,
  view: RevisionView,
): GitRead[] {
  const { options, subcommandIndex } = parseArgs(request.args);
  const reads = new Map<string, GitRead>();
  const add = (path: string, excludes: readonly string[] = []): void => {
    reads.set(JSON.stringify([path, excludes]), { path, excludes });
  };
  const top =
    subcommandIndex === -1 ? options : options.slice(0, subcommandIndex);
  for (const source of attributeSources(request, top)) {
    for (const object of resolveObject(source, view) ?? []) {
      if (object.type === 'blob') continue;
      for (const path of attributeFiles(object, view)) add(path);
    }
  }
  const subcommand = request.args[subcommandIndex];
  const spec =
    subcommand === undefined || nameCommands.has(subcommand)
      ? undefined
      : (contentCommands.get(subcommand) ?? otherCommand);
  const args = request.args.slice(subcommandIndex + 1);
  if (
    subcommand === undefined ||
    spec === undefined ||
    spec.reads?.(args) === false
  ) {
    return [...reads.values()];
  }
  const { flags, objects, pathspecs } = walk(args, spec, view);
  objects.push(
    ...inputObjects(subcommand, flags, request.options.input ?? '', view),
  );
  // `cat-file --batch-all-objects` prints every object in the store.
  if (subcommand === 'cat-file' && flags.includes('--batch-all-objects')) {
    add('');
  }
  const excludes = pathspecs
    .filter((pathspec) => pathspec.exclude)
    .map((pathspec) => pathspec.path);
  const included = pathspecs.filter((pathspec) => !pathspec.exclude);
  for (const object of objects) {
    if (!reaches(spec[object.type], flags)) continue;
    if (object.type === 'blob') add(object.path);
    // Without a positive pathspec, a command reads the whole tree.
    else if (included.length === 0) add(object.path, excludes);
    else {
      for (const pathspec of included) {
        add(joinPath(object.path, pathspec.path), excludes);
      }
    }
  }
  return [...reads.values()];
}
