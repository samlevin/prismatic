// The ESLint rule that enforces the import boundaries between the modules
// under src/ and the entrypoints under apps/. docs/adr/0002-single-package.md
// describes the rules; eslint.config.mjs turns the rule on for production
// files.
import { isBuiltin } from 'node:module';
import path from 'node:path';
import type { ESLint, Rule } from 'eslint';
import type * as ESTree from 'estree';

export type ModuleKind =
  'shared' | 'core' | 'adapter' | 'domain' | 'pipeline' | 'apps';

// Every module directory under src/ and the kind that decides what it may
// import. A directory missing here fails lint for every file in it.
export const sourceModules: Readonly<Record<string, ModuleKind>> = {
  shared: 'shared',
  core: 'core',
  github: 'adapter',
  repository: 'adapter',
  model: 'adapter',
  evidence: 'domain',
  context: 'domain',
  rules: 'domain',
  rounds: 'domain',
  cache: 'domain',
  prompts: 'domain',
  state: 'domain',
  findings: 'domain',
  presentation: 'domain',
  observability: 'domain',
  config: 'domain',
  pipeline: 'pipeline',
};

// The kinds a file may import from another module. A file may always import
// from its own module. The pipeline reaches adapters only through
// core/ports.ts, so only apps/ imports an adapter.
export const allowedImports: Readonly<
  Record<ModuleKind, readonly ModuleKind[]>
> = {
  shared: ['shared'],
  core: ['shared', 'core'],
  domain: ['shared', 'core', 'domain'],
  adapter: ['shared', 'core', 'domain'],
  pipeline: ['shared', 'core', 'domain', 'pipeline'],
  apps: ['shared', 'core', 'domain', 'adapter', 'pipeline', 'apps'],
};

// Node.js built-in modules that reach the filesystem, processes, the
// network, or the module loader. Only adapters import them.
export const adapterOnlyBuiltins: ReadonlySet<string> = new Set([
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'tls',
  'vm',
  'worker_threads',
]);

export interface BoundaryException {
  // Repository-relative path of the one file the exception covers.
  readonly file: string;
  // Exact import specifiers that file may use despite the rules.
  readonly imports: readonly string[];
}

export interface BoundaryOptions {
  // Absolute repository root. Defaults to ESLint's working directory.
  readonly root?: string;
  // Third-party packages without I/O that any production file may import.
  // Every other package counts as an SDK, and only adapters import SDKs.
  readonly packages?: readonly string[];
  // Narrow per-file allowances, such as a bootstrap descriptor operation.
  readonly exceptions?: readonly BoundaryException[];
}

export interface Location {
  readonly module: string;
  readonly kind: ModuleKind | undefined;
}

// Classifies a repository-relative POSIX path. Returns undefined outside
// src/ and apps/, and a location without a kind for a path in src/ that is
// not inside a known module.
export function locate(relativePath: string): Location | undefined {
  const [top, name, ...rest] = relativePath.split('/');
  if (top === 'apps' && name !== undefined && rest.length > 0)
    return { module: `apps/${name}`, kind: 'apps' };
  if (top !== 'src') return undefined;
  if (name === undefined || rest.length === 0)
    return { module: '', kind: undefined };
  return {
    module: name,
    kind: Object.hasOwn(sourceModules, name) ? sourceModules[name] : undefined,
  };
}

// The npm package an import specifier names: `@scope/name` or `name`.
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return (
    specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
  ).join('/');
}

function relativeTo(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce the import boundaries between src/ modules and apps/.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          packages: { type: 'array', items: { type: 'string' } },
          exceptions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                imports: { type: 'array', items: { type: 'string' } },
              },
              required: ['file', 'imports'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unclassifiedFile:
        '`{{file}}` is not inside a known module. Add its directory to sourceModules in tooling/eslint/importBoundaries.ts.',
      unclassifiedTarget:
        '`{{specifier}}` resolves to `{{target}}`, which is not inside a known module.',
      forbiddenModule:
        'The {{fromKind}} module `{{from}}` may not import the {{toKind}} module `{{to}}`.',
      outsideProduction:
        'Production code may not import `{{specifier}}`: it resolves outside src/ and apps/.',
      adapterOnly:
        'Only the github, repository, and model adapters may import `{{specifier}}`.',
      computedImport:
        'Production code may not import a computed specifier; use a string literal.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as BoundaryOptions;
    const root = options.root ?? context.cwd;
    const file = relativeTo(root, context.filename);
    const from = file === undefined ? undefined : locate(file);
    if (file === undefined || from === undefined) return {};
    const fromKind = from.kind;
    if (fromKind === undefined)
      return {
        Program(node) {
          context.report({
            node,
            messageId: 'unclassifiedFile',
            data: { file },
          });
        },
      };
    const packages = new Set(options.packages ?? []);
    const exempt = new Set(
      (options.exceptions ?? [])
        .filter((exception) => exception.file === file)
        .flatMap((exception) => exception.imports),
    );

    const checkPath = (node: ESTree.Node, specifier: string) => {
      const target = relativeTo(
        root,
        path.resolve(path.dirname(context.filename), specifier),
      );
      const to = target === undefined ? undefined : locate(target);
      if (target === undefined || to === undefined)
        context.report({
          node,
          messageId: 'outsideProduction',
          data: { specifier },
        });
      else if (to.kind === undefined)
        context.report({
          node,
          messageId: 'unclassifiedTarget',
          data: { specifier, target },
        });
      else if (
        to.module !== from.module &&
        !allowedImports[fromKind].includes(to.kind)
      )
        context.report({
          node,
          messageId: 'forbiddenModule',
          data: {
            fromKind,
            from: from.module,
            toKind: to.kind,
            to: to.module,
          },
        });
    };

    const check = (node: ESTree.Node, specifier: string) => {
      if (exempt.has(specifier)) return;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        checkPath(node, specifier);
        return;
      }
      if (fromKind === 'adapter') return;
      const sdk = isBuiltin(specifier)
        ? adapterOnlyBuiltins.has(packageName(specifier.replace(/^node:/, '')))
        : !packages.has(packageName(specifier));
      if (sdk)
        context.report({ node, messageId: 'adapterOnly', data: { specifier } });
    };

    const checkSource = (node: ESTree.Node) => {
      if (node.type === 'Literal' && typeof node.value === 'string')
        check(node, node.value);
      else if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
        check(node, node.quasis.map((quasi) => quasi.value.cooked).join(''));
      else context.report({ node, messageId: 'computedImport' });
    };

    return {
      ImportDeclaration(node) {
        checkSource(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node.source);
      },
      ImportExpression(node) {
        checkSource(node.source);
      },
      CallExpression(node) {
        const [argument] = node.arguments;
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          argument !== undefined
        )
          checkSource(argument);
      },
    };
  },
};

const plugin: ESLint.Plugin = {
  meta: { name: 'prismatic-boundaries' },
  rules: { imports: rule },
};

export default plugin;
