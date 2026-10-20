// The ESLint rule that keeps ReadOnlyProcessRunner's spawner seam out of
// production code. tests/support/processHarness.ts uses the seam to run local
// binaries and allow the file transport; eslint.config.mjs turns the rule on
// for production files, so only tests can reach it.
import path from 'node:path';
import type { ESLint, Rule } from 'eslint';
import type * as ESTree from 'estree';

// Repository-relative, without the extension.
export const runnerModule = 'src/repository/ReadOnlyProcessRunner';

// The exports that start a process or describe a start.
export const seamExports: ReadonlySet<string> = new Set([
  'nodeProcessSpawner',
  'ProcessSpawner',
  'SpawnRequest',
  'SpawnOutcome',
]);

// Everything production code may pass to the runner's constructor.
export const productionDependencies: ReadonlySet<string> = new Set([
  'home',
  'redactor',
]);

export interface SeamOptions {
  // Absolute repository root. Defaults to ESLint's working directory.
  readonly root?: string;
}

function moduleOf(root: string, file: string): string {
  return path
    .relative(root, file)
    .split(path.sep)
    .join('/')
    .replace(/\.[cm]?[jt]s$/, '');
}

function literalSpecifier(node: ESTree.Node): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis.map((quasi) => quasi.value.cooked).join('');
  return undefined;
}

// An identifier or a string or number literal, as in `{ 'home': x }`.
function nameOf(node: ESTree.Node): string {
  return node.type === 'Identifier'
    ? node.name
    : String((node as ESTree.Literal).value);
}

// A spread, a computed key, or any key but home and redactor could carry a
// spawner, so only a plain object literal of those two passes.
function productionArgument(args: ESTree.NewExpression['arguments']): boolean {
  const [argument] = args;
  if (args.length !== 1 || argument?.type !== 'ObjectExpression') return false;
  return argument.properties.every(
    (property) =>
      property.type === 'Property' &&
      !property.computed &&
      productionDependencies.has(nameOf(property.key)),
  );
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Keep ReadOnlyProcessRunner's spawner seam out of production code.",
    },
    schema: [
      {
        type: 'object',
        properties: { root: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      seam: 'Production code may not import or re-export `{{name}}`: the process spawner is the test harness seam.',
      wholeModule:
        'Production code may not take ReadOnlyProcessRunner.ts as a whole; import the names it needs.',
      reexportRunner:
        'Production code may not re-export ReadOnlyProcessRunner; import it from ReadOnlyProcessRunner.ts.',
      runnerUse:
        'Production code may use ReadOnlyProcessRunner only as `new ReadOnlyProcessRunner({ home, redactor })`, so it never passes a spawner.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as SeamOptions;
    const root = options.root ?? context.cwd;
    if (moduleOf(root, context.filename) === runnerModule) return {};

    const isRunner = (source: ESTree.Node) => {
      const specifier = literalSpecifier(source);
      return (
        specifier !== undefined &&
        (specifier.startsWith('.') || specifier.startsWith('/')) &&
        moduleOf(
          root,
          path.resolve(path.dirname(context.filename), specifier),
        ) === runnerModule
      );
    };

    // Type references are harmless; a value reference anywhere but the
    // callee of a production `new` could alias, subclass, or pass the class.
    const checkRunnerReferences = (specifier: ESTree.ImportSpecifier) => {
      for (const variable of context.sourceCode.getDeclaredVariables(specifier))
        for (const reference of variable.references) {
          if (
            (reference as { isValueReference?: boolean }).isValueReference ===
            false
          )
            continue;
          const identifier = reference.identifier as ESTree.Identifier &
            Rule.NodeParentExtension;
          const parent = identifier.parent;
          if (
            parent.type !== 'NewExpression' ||
            parent.callee !== identifier ||
            !productionArgument(parent.arguments)
          )
            context.report({ node: identifier, messageId: 'runnerUse' });
        }
    };

    const reportWholeModule = (node: ESTree.Node, source: ESTree.Node) => {
      if (isRunner(source)) context.report({ node, messageId: 'wholeModule' });
    };

    return {
      ImportDeclaration(node) {
        if (!isRunner(node.source)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier')
            context.report({ node: specifier, messageId: 'wholeModule' });
          if (specifier.type !== 'ImportSpecifier') continue;
          const name = nameOf(specifier.imported);
          if (seamExports.has(name))
            context.report({
              node: specifier,
              messageId: 'seam',
              data: { name },
            });
          else if (name === 'ReadOnlyProcessRunner')
            checkRunnerReferences(specifier);
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source || !isRunner(node.source)) return;
        for (const specifier of node.specifiers) {
          const name = nameOf(specifier.local);
          if (seamExports.has(name))
            context.report({
              node: specifier,
              messageId: 'seam',
              data: { name },
            });
          else if (name === 'ReadOnlyProcessRunner')
            context.report({ node: specifier, messageId: 'reexportRunner' });
        }
      },
      ExportAllDeclaration(node) {
        reportWholeModule(node, node.source);
      },
      ImportExpression(node) {
        reportWholeModule(node, node.source);
      },
      CallExpression(node) {
        const [argument] = node.arguments;
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          argument !== undefined
        )
          reportWholeModule(node, argument);
      },
    };
  },
};

const plugin: ESLint.Plugin = {
  meta: { name: 'prismatic-process-runner' },
  rules: { seam: rule },
};

export default plugin;
