import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  allowedProcessImports,
  auditSource,
  main,
  shippedFiles,
  type ProcessPatternFinding,
} from './ProcessPatternAudit.ts';

const auditFile = fileURLToPath(
  new URL('ProcessPatternAudit.ts', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const rules = (source: string, file = 'src/core/example.ts') =>
  auditSource(file, source).map((finding) => finding.rule);

describe('auditSource', () => {
  test('allows the spawn functions each allowed file names', () => {
    expect(
      rules(
        "import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';",
        'src/repository/ReadOnlyProcessRunner.ts',
      ),
    ).toEqual([]);
    expect(
      rules(
        "import { spawnSync } from 'node:child_process';",
        'apps/action/main.ts',
      ),
    ).toEqual([]);
    expect(Object.keys(allowedProcessImports).sort()).toEqual([
      'apps/action/main.ts',
      'src/repository/ReadOnlyProcessRunner.ts',
    ]);
  });

  test('refuses node:child_process outside the allowed files', () => {
    expect(rules("import { spawn } from 'node:child_process';")).toEqual([
      'process-import',
    ]);
    expect(rules("import { spawn } from 'child_process';")).toEqual([
      'process-import',
    ]);
    expect(rules("import 'node:child_process';")).toEqual(['process-import']);
    expect(rules("export { spawn } from 'node:child_process';")).toEqual([
      'process-import',
    ]);
    expect(rules("export * from 'node:child_process';")).toEqual([
      'process-import',
    ]);
  });

  test('refuses other functions and whole-module imports in allowed files', () => {
    const file = 'src/repository/ReadOnlyProcessRunner.ts';
    expect(
      rules("import { exec, spawn } from 'node:child_process';", file),
    ).toEqual(['process-import']);
    expect(
      rules("import { execFile as spawn } from 'node:child_process';", file),
    ).toEqual(['process-import']);
    expect(rules("import * as cp from 'node:child_process';", file)).toEqual([
      'process-import',
    ]);
    expect(rules("import cp from 'node:child_process';", file)).toEqual([
      'process-import',
    ]);
    expect(
      rules("import cp, { spawn } from 'node:child_process';", file),
    ).toEqual(['process-import']);
    expect(rules("import {} from 'node:child_process';", file)).toEqual([]);
  });

  test('allows type-only imports anywhere', () => {
    expect(
      rules("import type { ChildProcess } from 'node:child_process';"),
    ).toEqual([]);
    expect(
      rules("export type { ChildProcess } from 'node:child_process';"),
    ).toEqual([]);
    expect(
      rules(
        "import { type ChildProcess } from 'node:child_process';",
        'apps/action/main.ts',
      ),
    ).toEqual([]);
  });

  test('refuses dynamic imports of child_process, computed names, and URLs', () => {
    expect(rules("await import('node:child_process');")).toEqual([
      'process-import',
    ]);
    expect(rules('await import(name);')).toEqual(['dynamic-import']);
    expect(rules('await import(`node:${name}`);')).toEqual(['dynamic-import']);
    expect(rules('await import(`node:path`);')).toEqual([]);
    expect(rules("await import('https://example.test/x.js');")).toEqual([
      'remote-import',
    ]);
    expect(rules("import x from 'data:text/javascript,1';")).toEqual([
      'remote-import',
    ]);
    expect(rules("import path from 'node:path';")).toEqual([]);
    expect(rules("import { a } from '../shared/a.ts';")).toEqual([]);
  });

  test('refuses built-ins that load or run code', () => {
    for (const name of ['vm', 'node:worker_threads', 'node:module', 'cluster'])
      expect(rules(`import x from '${name}';`)).toEqual([
        'code-loading-import',
      ]);
    expect(rules("await import('node:vm');")).toEqual(['code-loading-import']);
  });

  test('refuses eval, Function, and require however they are reached', () => {
    expect(rules('eval(code);')).toEqual(['dynamic-code']);
    expect(rules('(0, eval)(code);')).toEqual(['dynamic-code']);
    expect(rules('globalThis.eval(code);')).toEqual(['dynamic-code']);
    expect(rules("globalThis['eval'](code);")).toEqual(['dynamic-code']);
    expect(rules('new Function(code)();')).toEqual(['dynamic-code']);
    expect(rules('Function(code)();')).toEqual(['dynamic-code']);
    expect(rules('const F = Function;')).toEqual(['dynamic-code']);
    expect(rules('const run = { eval };')).toEqual(['dynamic-code']);
    expect(rules("require('fs');")).toEqual(['commonjs-require']);
    expect(rules('const load = require;')).toEqual(['commonjs-require']);
    expect(rules("process.mainModule?.require('fs');")).toEqual([
      'commonjs-require',
    ]);
    expect(rules("import fs = require('fs');")).toEqual(['commonjs-require']);
  });

  test('refuses the Function constructor reached through constructor', () => {
    expect(rules('(async () => {}).constructor(code)();')).toEqual([
      'dynamic-code',
    ]);
    expect(rules("new (function () {})['constructor'](code)();")).toEqual([
      'dynamic-code',
    ]);
    expect(rules('const F = Object.getPrototypeOf(f)?.constructor;')).toEqual([
      'dynamic-code',
    ]);
    expect(rules('const { constructor: F } = f;')).toEqual(['dynamic-code']);
    expect(rules("const { 'constructor': F } = f;")).toEqual(['dynamic-code']);
    expect(rules('const { constructor } = f;')).toEqual(['dynamic-code']);
    expect(rules("Reflect.get(f, 'constructor')(code);")).toEqual([
      'dynamic-code',
    ]);
    expect(rules("Reflect.get(globalThis, 'Function')(code);")).toEqual([
      'dynamic-code',
    ]);
    expect(rules("Reflect.get(globalThis, 'require')('fs');")).toEqual([
      'commonjs-require',
    ]);
  });

  test('allows the constructor name and constructor declarations', () => {
    expect(rules('const kind = error.constructor.name;')).toEqual([]);
    expect(rules('class A { constructor() {} }')).toEqual([]);
    expect(rules('const a = { constructor: 1 };')).toEqual([]);
    expect(rules('const [constructor] = list;')).toEqual([]);
    expect(rules("const keys = new Set(['constructor']);")).toEqual([]);
    expect(rules("log('constructor', 'eval');")).toEqual([
      'dynamic-code',
      'dynamic-code',
    ]);
  });

  test('ignores names that only label a property, declaration, or type', () => {
    expect(rules('const options = { eval: false, require: true };')).toEqual(
      [],
    );
    expect(rules('class A { eval() {} }')).toEqual([]);
    expect(rules('type F = Function;')).toEqual([]);
    expect(rules("import { eval as evaluate } from './math.ts';")).toEqual([]);
  });

  test('refuses process loaders on process, however it is reached', () => {
    expect(rules("process.binding('fs');")).toEqual(['process-loader']);
    expect(rules("process['dlopen'](module, file);")).toEqual([
      'process-loader',
    ]);
    expect(rules("globalThis.process.getBuiltinModule('fs');")).toEqual([
      'process-loader',
    ]);
    expect(rules('process.execve(file);')).toEqual(['process-loader']);
    expect(rules('const { _linkedBinding: b } = process;')).toEqual([
      'process-loader',
    ]);
    expect(rules('const { binding } = globalThis.process;')).toEqual([
      'process-loader',
    ]);
    expect(rules("const { 'dlopen': d } = process;")).toEqual([
      'process-loader',
    ]);
    expect(rules('const { env, ...rest } = process;')).toEqual([]);
    expect(rules('const [first] = process.argv;')).toEqual([]);
    expect(rules('element.binding(value);')).toEqual([]);
    expect(rules('process.kill(-pid, "SIGKILL");')).toEqual([]);
  });

  test('refuses any shell option other than false', () => {
    expect(rules('spawn(file, args, { shell: false });')).toEqual([]);
    expect(rules('spawn(file, args, { shell: true });')).toEqual([
      'shell-option',
    ]);
    expect(rules("spawn(file, args, { 'shell': '/bin/sh' });")).toEqual([
      'shell-option',
    ]);
    expect(rules("spawn(file, args, { ['shell']: useShell });")).toEqual([
      'shell-option',
    ]);
    expect(rules('spawn(file, args, { shell });')).toEqual(['shell-option']);
    expect(rules('spawn(file, args, { [key]: true });')).toEqual([]);
  });

  test('reports the line and column of each finding', () => {
    expect(auditSource('src/a.ts', 'const a = 1;\n  eval(a);\n')).toEqual<
      ProcessPatternFinding[]
    >([
      {
        file: 'src/a.ts',
        line: 2,
        column: 3,
        rule: 'dynamic-code',
        message: 'refers to eval',
      },
    ]);
  });
});

describe('main', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test('audits the working directory and logs to the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main()).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^No dangerous process patterns in \d+ shipped files\.$/,
      ),
    );
  });

  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-audit-'));
    directories.push(root);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    return root;
  };

  const io = (root: string) => ({
    root,
    log: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  });

  test('audits shipped script files only and passes clean code', () => {
    const root = tree({
      'src/core/a.ts': "import path from 'node:path';",
      'src/core/a.test.ts': "import { exec } from 'node:child_process';",
      'src/core/b.test.mts': "import { exec } from 'node:child_process';",
      'src/core/data.json': '{"eval": 1}',
      'apps/action/main.ts': "import { spawnSync } from 'node:child_process';",
      'src/core/notes.md': 'eval(x)',
      'tooling/x.ts': "import { exec } from 'node:child_process';",
    });
    const files: ProcessPatternFinding[] = [];
    expect(shippedFiles(root, files)).toEqual([
      'apps/action/main.ts',
      'src/core/a.ts',
    ]);
    const output = io(root);
    expect(main(output)).toBe(0);
    expect(output.log).toHaveBeenCalledWith(
      'No dangerous process patterns in 2 shipped files.',
    );
  });

  test('audits every script extension the build could ship', () => {
    const extensions = [
      'cjs',
      'cts',
      'd.ts',
      'js',
      'jsx',
      'mjs',
      'mts',
      'ts',
      'tsx',
    ];
    const root = tree(
      Object.fromEntries(
        extensions.map((extension) => [`src/core/a.${extension}`, 'eval(x);']),
      ),
    );
    expect(shippedFiles(root, [])).toEqual(
      extensions.map((extension) => `src/core/a.${extension}`),
    );
    const output = io(root);
    expect(main(output)).toBe(1);
    expect(output.error).toHaveBeenCalledTimes(extensions.length + 1);
    expect(
      auditSource(
        'src/a.tsx',
        'const view = <div>{run}</div>;\nnew Function(code);',
      ).map((finding) => finding.rule),
    ).toEqual(['dynamic-code']);
    expect(
      auditSource('src/a.jsx', "const view = <div />;\nrequire('fs');").map(
        (finding) => finding.rule,
      ),
    ).toEqual(['commonjs-require']);
  });

  test('skips a missing shipped root', () => {
    const root = tree({ 'src/a.ts': '' });
    expect(shippedFiles(root, [])).toEqual(['src/a.ts']);
  });

  test('reports every finding and returns 1', () => {
    const root = tree({
      'src/core/a.ts': "import { exec } from 'node:child_process';\neval(x);",
    });
    const output = io(root);
    expect(main(output)).toBe(1);
    expect(output.error.mock.calls.map(([message]) => message)).toEqual([
      'src/core/a.ts:1:1 process-import: imports node:child_process',
      'src/core/a.ts:2:1 dynamic-code: refers to eval',
      '2 dangerous process pattern(s) in shipped code. docker/runtime-policy.md lists what is allowed.',
    ]);
  });

  test('reports a symbolic link instead of following it', () => {
    const outside = tree({
      'evil.ts': "import { exec } from 'node:child_process';",
    });
    const root = tree({ 'src/core/a.ts': '' });
    symlinkSync(
      path.join(outside, 'evil.ts'),
      path.join(root, 'src/core/b.ts'),
    );
    symlinkSync(outside, path.join(root, 'src/linked'));
    const output = io(root);
    expect(main(output)).toBe(1);
    expect(output.error.mock.calls.map(([message]) => message)).toEqual([
      'src/core/b.ts:1:1 symbolic-link: is a symbolic link, which the audit does not follow',
      'src/linked:1:1 symbolic-link: is a symbolic link, which the audit does not follow',
      '2 dangerous process pattern(s) in shipped code. docker/runtime-policy.md lists what is allowed.',
    ]);
  });

  test('passes on this repository from the command line', () => {
    const result = spawnSync(process.execPath, [auditFile], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^No dangerous process patterns in \d+ shipped files\.\n$/,
    );
  });
});
