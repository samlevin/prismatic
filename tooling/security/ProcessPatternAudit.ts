// Static audit of the code the Action image ships (every non-test script file
// under src/ and apps/) for ways to start a process or run code that
// docker/runtime-policy.md does not allow. The `CI: supply-chain security`
// workflow runs it as `node tooling/security/ProcessPatternAudit.ts`.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const shippedRoots: readonly string[] = ['src', 'apps'];

// The only files that may import node:child_process, and the functions each
// may import. Type-only imports are always allowed.
export const allowedProcessImports: Readonly<
  Record<string, readonly string[]>
> = {
  'src/repository/ReadOnlyProcessRunner.ts': ['spawn'],
  'apps/action/main.ts': ['spawnSync'],
};

const processModules = new Set(['child_process', 'node:child_process']);

// Built-ins that run code or load modules outside the static import graph.
const codeLoadingModules = new Set(
  ['vm', 'worker_threads', 'cluster', 'module', 'repl', 'inspector'].flatMap(
    (name) => [name, `node:${name}`],
  ),
);

// Names that run code from a string or load CommonJS, wherever they are read.
const codeLoadingNames: Readonly<Record<string, ProcessPatternRule>> = {
  eval: 'dynamic-code',
  Function: 'dynamic-code',
  require: 'commonjs-require',
};

// Every function's `constructor` is a Function constructor, so reading it is
// another way to reach Function. Only `x.constructor.name` is allowed.
const constructorMessage =
  'reads constructor, which reaches the Function constructor';

// Strings that name code-loading functions when passed to a call such as
// Reflect.get(globalThis, 'Function').
const reflectedNames: ReadonlyMap<string, ProcessPatternRule> = new Map([
  ...Object.entries(codeLoadingNames),
  ['constructor', 'dynamic-code'],
]);

// Script files the build may ship, and the kind TypeScript parses each as.
const scriptKinds: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

const testFile = /\.test\.[^./]+$/;

const processLoaders = new Set([
  'binding',
  '_linkedBinding',
  'dlopen',
  'getBuiltinModule',
  'execve',
]);

export type ProcessPatternRule =
  | 'process-import'
  | 'code-loading-import'
  | 'remote-import'
  | 'dynamic-import'
  | 'commonjs-require'
  | 'dynamic-code'
  | 'process-loader'
  | 'shell-option'
  | 'symbolic-link';

export interface ProcessPatternFinding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: ProcessPatternRule;
  readonly message: string;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isStringLiteralLike(expression)) return expression.text;
  }
  return undefined;
}

function accessedName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return undefined;
}

const globalObjects = new Set(['globalThis', 'global']);

// A string in an import, export, require, or import type, which the import
// checks already cover.
function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent) ||
    (ts.isCallExpression(parent) &&
      parent.expression.kind === ts.SyntaxKind.ImportKeyword)
  );
}

function isProcessObject(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === 'process') ||
    accessedName(node) === 'process'
  );
}

function withoutParentheses(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

// When an object literal is the target of a destructuring assignment, such as
// `({ a } = value)` or `for ({ a } of values)`, returns the value it reads
// from: `value`, or undefined when the literal is nested in a larger pattern
// or a loop. Returns null for an ordinary object literal.
function assignmentSource(
  literal: ts.ObjectLiteralExpression,
): { readonly value: ts.Expression | undefined } | null {
  let target: ts.Expression = literal;
  let direct = true;
  for (;;) {
    const parent = target.parent;
    if (ts.isParenthesizedExpression(parent)) target = parent;
    else if (ts.isArrayLiteralExpression(parent)) {
      target = parent;
      direct = false;
    } else if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === target &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      target = parent.parent;
      direct = false;
    } else break;
  }
  const parent = target.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return { value: direct ? withoutParentheses(parent.right) : undefined };
  if (
    (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
    parent.initializer === target
  )
    return { value: undefined };
  return null;
}

// An identifier that names a property, a declaration, or a type rather than
// reading a value. `{ eval }` reads eval, so shorthand properties do not count.
function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isTypeReferenceNode(parent)) return true;
  const named = parent as { name?: ts.Node; propertyName?: ts.Node };
  return named.name === node || named.propertyName === node;
}

// Audits one file. `file` is the repository-relative POSIX path, which
// decides whether node:child_process is allowed.
export function auditSource(
  file: string,
  text: string,
): ProcessPatternFinding[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKinds[path.posix.extname(file)] ?? ts.ScriptKind.TS,
  );
  const findings: ProcessPatternFinding[] = [];
  const report = (node: ts.Node, rule: ProcessPatternRule, message: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    findings.push({
      file,
      line: line + 1,
      column: character + 1,
      rule,
      message,
    });
  };
  const allowed = allowedProcessImports[file];

  const checkSpecifier = (node: ts.Node, specifier: string) => {
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(specifier) &&
      !specifier.startsWith('node:')
    )
      report(node, 'remote-import', `imports the URL ${specifier}`);
    if (codeLoadingModules.has(specifier))
      report(node, 'code-loading-import', `imports ${specifier}`);
  };

  const checkProcessImport = (
    node: ts.ImportDeclaration | ts.ExportDeclaration,
  ) => {
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly)
        report(node, 'process-import', 're-exports node:child_process');
      return;
    }
    const clause = node.importClause;
    if (clause === undefined) {
      report(node, 'process-import', 'imports node:child_process for effect');
      return;
    }
    if (clause.isTypeOnly) return;
    if (allowed === undefined) {
      report(node, 'process-import', 'imports node:child_process');
      return;
    }
    if (clause.name !== undefined)
      report(node, 'process-import', 'imports node:child_process as a whole');
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      report(node, 'process-import', 'imports node:child_process as a whole');
      return;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      if (!allowed.includes(name))
        report(
          element,
          'process-import',
          `imports ${name} from node:child_process`,
        );
    }
  };

  // A property read by a destructuring assignment, which TypeScript parses as
  // an object literal rather than a binding pattern.
  const checkAssignedProperty = (
    node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  ) => {
    if (!ts.isObjectLiteralExpression(node.parent)) return;
    const source = assignmentSource(node.parent);
    const name = propertyName(node.name);
    if (source === null || name === undefined) return;
    if (name === 'constructor')
      report(node, 'dynamic-code', constructorMessage);
    else if (
      processLoaders.has(name) &&
      source.value !== undefined &&
      isProcessObject(source.value)
    )
      report(node, 'process-loader', `uses process.${name}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
      checkAssignedProperty(node);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      checkSpecifier(node, specifier);
      if (processModules.has(specifier)) checkProcessImport(node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      report(node, 'commonjs-require', 'uses import = require()');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          checkSpecifier(node, argument.text);
          if (processModules.has(argument.text))
            report(
              node,
              'process-import',
              'imports node:child_process dynamically',
            );
        } else
          report(
            node,
            'dynamic-import',
            'imports a module whose name is computed',
          );
      }
    } else if (
      ts.isIdentifier(node) &&
      Object.hasOwn(codeLoadingNames, node.text) &&
      !isNameOnly(node)
    ) {
      report(node, codeLoadingNames[node.text]!, `refers to ${node.text}`);
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const name = accessedName(node);
      if (name === undefined && ts.isElementAccessExpression(node)) {
        if (isProcessObject(node.expression))
          report(node, 'process-loader', 'reads process by a computed name');
        else if (
          ts.isIdentifier(node.expression) &&
          globalObjects.has(node.expression.text)
        )
          report(node, 'dynamic-code', 'reads a global by a computed name');
      } else if (name !== undefined && Object.hasOwn(codeLoadingNames, name))
        report(node, codeLoadingNames[name]!, `refers to ${name}`);
      else if (
        name === 'constructor' &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          node.parent.name.text === 'name'
        )
      )
        report(node, 'dynamic-code', constructorMessage);
      else if (
        name !== undefined &&
        processLoaders.has(name) &&
        isProcessObject(node.expression)
      )
        report(node, 'process-loader', `uses process.${name}`);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isProcessObject(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const name =
          element.propertyName === undefined
            ? ts.isIdentifier(element.name)
              ? element.name.text
              : undefined
            : propertyName(element.propertyName);
        if (name !== undefined && processLoaders.has(name))
          report(element, 'process-loader', `uses process.${name}`);
      }
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      (node.propertyName === undefined
        ? ts.isIdentifier(node.name) && node.name.text === 'constructor'
        : propertyName(node.propertyName) === 'constructor')
    ) {
      report(node, 'dynamic-code', constructorMessage);
    } else if (ts.isPropertyAssignment(node)) {
      if (
        propertyName(node.name) === 'shell' &&
        node.initializer.kind !== ts.SyntaxKind.FalseKeyword
      )
        report(
          node,
          'shell-option',
          'sets shell to something other than false',
        );
    } else if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === 'shell'
    ) {
      report(node, 'shell-option', 'sets shell from a variable');
    } else if (
      ts.isStringLiteralLike(node) &&
      reflectedNames.has(node.text) &&
      ts.isCallExpression(node.parent) &&
      node.parent.arguments.some((argument) => argument === node)
    ) {
      report(
        node,
        reflectedNames.get(node.text)!,
        `names ${node.text} in a call`,
      );
    } else if (
      ts.isStringLiteralLike(node) &&
      processModules.has(node.text) &&
      !isModuleSpecifier(node)
    ) {
      report(node, 'process-import', 'names node:child_process');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export interface ProcessPatternAuditIo {
  readonly root: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

// Every non-test script file under the shipped roots, as sorted repository-
// relative POSIX paths. A symbolic link is reported instead of followed.
export function shippedFiles(
  root: string,
  findings: ProcessPatternFinding[],
): string[] {
  const files: string[] = [];
  const walk = (relative: string) => {
    const entries = readdirSync(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink())
        findings.push({
          file: child,
          line: 1,
          column: 1,
          rule: 'symbolic-link',
          message: 'is a symbolic link, which the audit does not follow',
        });
      else if (entry.isDirectory()) walk(child);
      else if (
        entry.isFile() &&
        Object.hasOwn(scriptKinds, path.posix.extname(child)) &&
        !testFile.test(child)
      )
        files.push(child);
    }
  };
  for (const shipped of shippedRoots)
    if (lstatSync(path.join(root, shipped), { throwIfNoEntry: false }))
      walk(shipped);
  return files.sort();
}

const processIo: ProcessPatternAuditIo = {
  root: process.cwd(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

// Returns the process exit code: 0 when no file breaks a rule.
export function main(io: ProcessPatternAuditIo = processIo): number {
  const findings: ProcessPatternFinding[] = [];
  const files = shippedFiles(io.root, findings);
  for (const file of files)
    findings.push(
      ...auditSource(file, readFileSync(path.join(io.root, file), 'utf8')),
    );
  for (const finding of findings)
    io.error(
      `${finding.file}:${finding.line}:${finding.column} ${finding.rule}: ${finding.message}`,
    );
  if (findings.length > 0) {
    io.error(
      `${findings.length} dangerous process pattern(s) in shipped code. docker/runtime-policy.md lists what is allowed.`,
    );
    return 1;
  }
  io.log(`No dangerous process patterns in ${files.length} shipped files.`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
