import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const workflowDirectory = new URL(
  '../.github/workflows/',
  import.meta.url,
);

// Parse .github/workflows/<file>.
export const workflow = (file) =>
  parse(readFileSync(new URL(file, workflowDirectory), 'utf8'));

// Execute a github-script body with mocked globals (require, context, github,
// core), the way actions/github-script wraps it in an async function.
export const runScript = (script, globals) =>
  new (Object.getPrototypeOf(async function () {}).constructor)(
    ...Object.keys(globals),
    script,
  )(...Object.values(globals));

// Evaluate a GitHub Actions expression as JavaScript. `${{ }}` is optional.
// Job IDs such as `detect-changes` are valid property names in Actions but not
// in JavaScript, so a hyphenated property outside a string literal becomes an
// index access.
export const evaluate = (expression, values) =>
  Function(
    ...Object.keys(values),
    `return (${expression
      .trim()
      .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
      .replace(
        /('(?:[^']|'')*')|\.([A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+)/g,
        (match, literal, name) => literal ?? `['${name}']`,
      )});`,
  )(...Object.values(values));
