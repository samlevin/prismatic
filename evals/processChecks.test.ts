import { describe, expect, it } from 'vitest';
import type { ProcessOptions } from './InstrumentedProcessRunner.ts';
import {
  executionProblems,
  gitReadPaths,
  parseConfigParameters,
  resolveObject,
  type MountedObject,
  type RevisionView,
} from './processChecks.ts';

const mounted = 'a'.repeat(40);
const other = 'b'.repeat(40);
const secretsTree = 'c'.repeat(40);
const secretBlob = 'd'.repeat(40);
const rootTree = 'e'.repeat(40);
const commit: MountedObject = { type: 'commit', path: '' };

const view: RevisionView = {
  names: new Map<string, readonly MountedObject[]>([
    ['feature', [commit]],
    ['refs/heads/feature', [commit]],
    [mounted, [commit]],
    ['main', []],
    ['HEAD', []],
    [other, []],
    [secretsTree, [{ type: 'tree', path: 'secrets' }]],
    [
      secretBlob,
      [
        { type: 'blob', path: 'secrets/prod.ts' },
        { type: 'blob', path: 'secrets/copy.ts' },
      ],
    ],
    [rootTree, [{ type: 'tree', path: '' }]],
  ]),
  paths: new Set([
    'src/app.ts',
    'secrets/prod.ts',
    'secrets/copy.ts',
    '.gitattributes',
    'docs/.gitattributes',
  ]),
};

const reads = (args: readonly string[], options: ProcessOptions = {}) =>
  gitReadPaths({ command: 'git', args, options }, view);
const whole = { path: '', excludes: [] };
const file = (path: string) => ({ path, excludes: [] });

describe('resolveObject', () => {
  it('resolves names, abbreviations, suffixes, and ranges', () => {
    expect(resolveObject('feature', view)).toEqual([commit]);
    expect(resolveObject('aaaa', view)).toEqual([commit]);
    expect(resolveObject('AAAAAAA', view)).toEqual([commit]);
    expect(resolveObject('feature~0', view)).toEqual([commit]);
    expect(resolveObject('feature^{commit}', view)).toEqual([commit]);
    expect(resolveObject('feature@{1}', view)).toEqual([commit]);
    expect(resolveObject('feature^{tree}', view)).toEqual([
      { type: 'tree', path: '' },
    ]);
    expect(resolveObject('main..feature', view)).toEqual([commit]);
    expect(resolveObject('^feature', view)).toEqual([commit]);
    expect(resolveObject('main', view)).toEqual([]);
    expect(resolveObject('@', view)).toEqual([]);
    expect(resolveObject('@{-1}', view)).toEqual([]);
  });

  it('resolves paths inside the mounted revision and its trees', () => {
    expect(resolveObject('feature:secrets/prod.ts', view)).toEqual([
      { type: 'blob', path: 'secrets/prod.ts' },
    ]);
    expect(resolveObject('feature~0:./secrets/', view)).toEqual([
      { type: 'tree', path: 'secrets' },
    ]);
    expect(resolveObject('feature:', view)).toEqual([
      { type: 'tree', path: '' },
    ]);
    expect(resolveObject(`${secretsTree.slice(0, 6)}:prod.ts`, view)).toEqual([
      { type: 'blob', path: 'secrets/prod.ts' },
    ]);
    expect(resolveObject(`${secretBlob}:x`, view)).toEqual([]);
    expect(resolveObject('main:secrets/prod.ts', view)).toEqual([]);
  });

  it('leaves names Git would not resolve to be pathspecs', () => {
    for (const name of [
      'src/app.ts',
      'src/a~1.ts',
      'abc',
      '..',
      '',
      ':secrets',
      '-p',
      'ghost:secrets',
      'main..ghost',
    ]) {
      expect(resolveObject(name, view)).toBeUndefined();
    }
  });
});

describe('gitReadPaths', () => {
  it('reads the whole tree when a content command has no positive pathspec', () => {
    expect(reads(['diff', 'main', 'feature'])).toEqual([whole]);
    expect(reads(['diff', 'main', mounted.slice(0, 7)])).toEqual([whole]);
    expect(reads(['archive', '--format', 'tar', 'feature'])).toEqual([whole]);
    expect(reads(['blame', 'feature~0'])).toEqual([whole]);
    expect(reads(['checkout', 'feature'])).toEqual([whole]);
    expect(reads(['format-patch', '-o', '/tmp/out', 'main..feature'])).toEqual([
      whole,
    ]);
  });

  it('treats bare arguments that are not revisions as pathspecs', () => {
    expect(reads(['diff', 'main', 'feature', 'secrets', 'src'])).toEqual([
      file('secrets'),
      file('src'),
    ]);
    expect(
      reads(['grep', '-n', 'needle', 'feature', 'src', '--', 'secrets']),
    ).toEqual([file('src'), file('secrets')]);
    expect(reads(['restore', '--source=feature', 'secrets/prod.ts'])).toEqual([
      file('secrets/prod.ts'),
    ]);
    expect(reads(['restore', '-s', 'feature', '--', 'src'])).toEqual([
      file('src'),
    ]);
    expect(reads(['checkout', '-b', 'copy', 'feature', '--', 'src'])).toEqual([
      file('src'),
    ]);
  });

  it('honors pathspec magic and globs', () => {
    expect(
      reads([
        'diff',
        'main',
        'feature',
        '--',
        ':!secrets',
        ':(exclude,top)docs',
        ':^*.md',
      ]),
    ).toEqual([{ path: '', excludes: ['secrets', 'docs'] }]);
    expect(
      reads([
        'diff',
        'feature',
        '--',
        'src/*.ts',
        '*',
        ':(literal)a*b',
        ':(icase)src',
        ':/docs',
        ':(exclude,icase)secrets',
      ]),
    ).toEqual([file('src/'), whole, file('a*b'), file('docs')]);
  });

  it('takes the first argument of git grep as its pattern', () => {
    expect(reads(['grep', 'src', 'feature'])).toEqual([whole]);
    expect(reads(['grep', '--', 'feature'])).toEqual([whole]);
    expect(reads(['grep', '-e', 'x', '-C', '3', 'feature', 'src'])).toEqual([
      file('src'),
    ]);
    expect(reads(['grep', 'x', 'main'])).toEqual([]);
  });

  it('reads a tree or blob named by its ID', () => {
    expect(reads(['grep', 'x', secretsTree.slice(0, 5)])).toEqual([
      file('secrets'),
    ]);
    expect(reads(['grep', 'x', `${secretsTree}`, '--', 'prod.ts'])).toEqual([
      file('secrets/prod.ts'),
    ]);
    expect(reads(['archive', rootTree])).toEqual([whole]);
    expect(reads(['cat-file', '-p', secretBlob.slice(0, 4)])).toEqual([
      file('secrets/prod.ts'),
      file('secrets/copy.ts'),
    ]);
    expect(reads(['unpack-file', secretBlob])).toHaveLength(2);
    expect(reads(['cat-file', '-p', secretsTree])).toEqual([]);
    expect(reads(['cat-file', '-p', 'feature'])).toEqual([]);
    expect(reads(['cat-file', '-p', 'feature:secrets'])).toEqual([]);
  });

  it('limits diffs and logs by the flags that choose their output', () => {
    expect(reads(['log', 'feature'])).toEqual([]);
    expect(reads(['log', '--oneline', '-n', '5', 'feature'])).toEqual([]);
    expect(reads(['log', '-p', 'feature'])).toEqual([whole]);
    expect(reads(['whatchanged', '--stat', 'feature'])).toEqual([whole]);
    expect(reads(['log', '--name-only', '-p', 'feature'])).toEqual([]);
    expect(reads(['log', '--name-only', '-S', 'key', 'feature'])).toEqual([
      whole,
    ]);
    expect(reads(['log', '-L1,2:src/app.ts', 'feature'])).toEqual([whole]);
    expect(reads(['log', '-p', '--all'])).toEqual([whole]);
    expect(reads(['log', '-p', '--stdin'], { input: 'feature\n' })).toEqual([
      whole,
    ]);
    expect(reads(['diff-tree', '-r', 'main', 'feature'])).toEqual([]);
    expect(reads(['diff-tree', '-p', 'main', 'feature'])).toEqual([whole]);
    expect(reads(['diff', '--raw', 'main', 'feature'])).toEqual([]);
    expect(reads(['diff', '--raw', '-p', 'main', 'feature'])).toEqual([whole]);
    expect(reads(['diff', '--stat', '--name-status', 'feature'])).toEqual([]);
    expect(reads(['diff', '--check', '--name-only', 'feature'])).toEqual([
      whole,
    ]);
    expect(reads(['diff', '--no-patch', 'feature'])).toEqual([]);
  });

  it('keeps git show of a blob a read whatever the diff flags say', () => {
    expect(reads(['show', '--name-only', 'feature:secrets/prod.ts'])).toEqual([
      file('secrets/prod.ts'),
    ]);
    expect(reads(['show', '-s', secretBlob.slice(0, 6)])).toHaveLength(2);
    expect(reads(['show', '--name-only', 'feature'])).toEqual([]);
    expect(reads(['show', 'feature^{tree}'])).toEqual([]);
    expect(reads(['show', 'feature'])).toEqual([whole]);
    expect(reads(['show', 'feature', '--', 'src'])).toEqual([file('src')]);
    expect(
      reads(['diff', '--name-only', 'main:a', 'feature:src/app.ts']),
    ).toEqual([]);
  });

  it('reads objects that git cat-file is given on standard input', () => {
    expect(
      reads(['cat-file', '--batch'], {
        input: `feature:secrets/prod.ts\n${secretBlob.slice(0, 7)} extra\n`,
      }),
    ).toEqual([file('secrets/prod.ts'), file('secrets/copy.ts')]);
    expect(
      reads(['cat-file', '--batch-command', '--buffer'], {
        input:
          'info feature:src/app.ts\ncontents feature:secrets/prod.ts\nflush\n',
      }),
    ).toEqual([file('secrets/prod.ts')]);
    expect(
      reads(['cat-file', '--batch=%(objectname) %(rest)'], {
        input: `feature:src/app.ts trailing words\n`,
      }),
    ).toEqual([file('src/app.ts trailing words'), file('src/app.ts')]);
    expect(reads(['cat-file', '--batch', '--batch-all-objects'])).toEqual([
      whole,
    ]);
    expect(
      reads(
        ['cat-file', '--batch-check=%(objectsize)', '--batch-all-objects'],
        {
          input: 'feature:secrets/prod.ts\n',
        },
      ),
    ).toEqual([]);
    expect(reads(['cat-file', '-t', 'feature:secrets/prod.ts'])).toEqual([]);
    expect(reads(['cat-file', 'blob', 'feature:secrets/prod.ts'])).toEqual([
      file('secrets/prod.ts'),
    ]);
    expect(reads(['cat-file', '--textconv', 'feature:src/app.ts'])).toEqual([
      file('src/app.ts'),
    ]);
  });

  it('takes any other command that names the revision to read all of it', () => {
    expect(reads(['bundle', 'create', '/tmp/b', 'feature'])).toEqual([whole]);
    expect(reads(['worktree', 'add', '/tmp/w', mounted.slice(0, 10)])).toEqual([
      whole,
    ]);
    expect(reads(['check-attr', '--source=feature', '-a', 'x'])).toEqual([
      whole,
    ]);
    expect(reads(['fast-export', '--all'])).toEqual([whole]);
    expect(reads(['bundle', 'create', '/tmp/b', 'main'])).toEqual([]);
    expect(reads(['rev-parse', 'feature:secrets/prod.ts'])).toEqual([]);
    expect(reads(['ls-tree', '-r', 'feature'])).toEqual([]);
    expect(reads(['rev-list', '--objects', '--all'])).toEqual([]);
    expect(reads(['--version'])).toEqual([]);
    expect(reads(['archive', '--list'])).toEqual([]);
  });

  it('reads the attribute files of a tree Git takes attributes from', () => {
    const attributes = [file('.gitattributes'), file('docs/.gitattributes')];
    expect(reads(['--attr-source=feature', 'status'])).toEqual(attributes);
    expect(reads(['--attr-source', 'feature', 'ls-files'])).toEqual(attributes);
    expect(reads(['-c', 'attr.tree=feature', 'ls-files'])).toEqual(attributes);
    expect(
      reads(['ls-files'], { env: { GIT_ATTR_SOURCE: `${secretsTree}` } }),
    ).toEqual([file('secrets/.gitattributes')]);
    expect(
      reads(['ls-files'], { env: { GIT_ATTR_SOURCE: secretBlob } }),
    ).toEqual([]);
    expect(reads(['--attr-source=main', 'ls-files'])).toEqual([]);
  });
});

describe('parseConfigParameters', () => {
  it('reads the quoted forms Git writes', () => {
    expect(
      parseConfigParameters(
        `'core.pager'='less' 'alias.x=!echo' 'core.fsmonitor'= 'a.b'='it'\\''s' 'c.d'='x'\\!'y'`,
      ),
    ).toEqual([
      ['core.pager', 'less'],
      ['alias.x', '!echo'],
      ['core.fsmonitor', 'true'],
      ['a.b', "it's"],
      ['c.d', 'x!y'],
    ]);
    expect(parseConfigParameters(" 'core.bare' ")).toEqual([
      ['core.bare', 'true'],
    ]);
    expect(parseConfigParameters('')).toEqual([]);
  });

  it('rejects malformed text', () => {
    for (const text of [
      'core.pager=less',
      "'core.pager",
      "'core.pager'='less",
      "'core.pager'=less",
      "'a''b'",
    ]) {
      expect(parseConfigParameters(text)).toBeUndefined();
    }
  });
});

describe('executionProblems', () => {
  const context = {
    root: '/repo',
    trustedExecutables: new Set(['git']),
    repositoryPaths: new Set<string>(),
    canaries: [],
  };
  const problems = (env: Record<string, string>, cwd?: string) =>
    executionProblems(
      {
        command: 'git',
        args: ['status'],
        options: cwd === undefined ? { env } : { env, cwd },
      },
      context,
    );

  it('catches search paths that reach into the repository tree', () => {
    expect(
      problems({
        PATH: '/usr/bin:/repo/bin',
        GIT_EXEC_PATH: '/repo/.git-core',
        LD_LIBRARY_PATH: '/lib:/repo/lib',
        DYLD_FALLBACK_LIBRARY_PATH: '/repo',
        DYLD_FRAMEWORK_PATH: '/System/Library/Frameworks',
      }),
    ).toEqual([
      'puts the repository tree on PATH',
      'puts the repository tree on GIT_EXEC_PATH',
      'puts the repository tree on LD_LIBRARY_PATH',
      'puts the repository tree on DYLD_FALLBACK_LIBRARY_PATH',
    ]);
    expect(problems({ PATH: 'bin::/usr/bin' }, '/tmp')).toEqual([]);
    expect(problems({ PATH: '/usr/bin:' }, '/repo/src')).toEqual([
      'runs inside the repository tree, where Git would find its configuration',
      'puts the repository tree on PATH',
    ]);
  });

  it('catches loader and editor variables whenever they are set', () => {
    expect(
      problems({
        LD_PRELOAD: '/tmp/x.so',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
        GIT_SEQUENCE_EDITOR: 'true',
        EDITOR: '',
      }),
    ).toEqual([
      'sets LD_PRELOAD, which loads a library into the process',
      'sets DYLD_INSERT_LIBRARIES, which loads a library into the process',
      'sets GIT_SEQUENCE_EDITOR, which runs a program',
    ]);
  });

  it('checks every setting in GIT_CONFIG_PARAMETERS', () => {
    expect(
      problems({
        GIT_CONFIG_PARAMETERS:
          "'core.fsmonitor'='touch x' 'include.path=/repo/.gitconfig' 'core.hookspath'='/dev/null' 'color.ui'='auto'",
      }),
    ).toEqual([
      'sets "core.fsmonitor", which runs a program',
      'sets "include.path", which loads configuration from a file',
    ]);
    expect(problems({ GIT_CONFIG_PARAMETERS: 'core.fsmonitor=x' })).toEqual([
      'sets GIT_CONFIG_PARAMETERS in a form the check cannot read',
    ]);
  });
});
