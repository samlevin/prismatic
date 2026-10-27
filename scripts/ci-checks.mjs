// Runs the CI checks that the scope job selected. CI_FULL is the `full`
// output of scripts/ci-scope.mjs as the workflow computed it: `false` runs
// only the format check and the Markdown lint, and `true` runs every check.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every scripts/*.test.mjs, listed so a new test file joins without an edit.
export function testFiles(
  directory = fileURLToPath(new URL('.', import.meta.url)),
) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `scripts/${name}`)
    .sort();
}

export function checks({ full }) {
  const commands = [['npm', ['run', 'format:check']]];
  if (full)
    commands.push(
      // Lints JavaScript, TypeScript, including the import boundaries, and
      // Markdown.
      ['npm', ['run', 'lint']],
      // Strict TypeScript over the product modules, tooling, and tests.
      ['npm', ['run', 'typecheck']],
      // Generated agent definitions must match their sources under .agents/.
      ['npm', ['run', 'agents:check']],
      ['node', ['--test', ...testFiles()]],
      // Vitest with coverage, then the 90% coverage gate.
      ['npm', ['run', 'test:unit']],
    );
  // Prettier ignores Markdown, so a documentation change gets the Markdown
  // lint on its own.
  else commands.push(['npm', ['run', 'lint:md']]);
  return commands;
}

// Prints each check's buffered output in one group as soon as it finishes.
export async function runChecks(commands, run = runCommand, log = console.log) {
  const results = await Promise.all(
    commands.map(([command, args]) => {
      const line = [command, ...args].join(' ');
      log(`Started ${line}`);
      return run(command, args).then((result) => {
        log(`::group::${line}`);
        if (result.output) log(result.output.trimEnd());
        log('::endgroup::');
        return { line, ...result };
      });
    }),
  );
  return results.filter(({ code }) => code !== 0);
}

export function failureReport(failed, total) {
  return [
    `${failed.length} of ${total} CI checks failed:`,
    ...failed.map(({ line, code }) => `  ${line} exited with ${code}`),
  ].join('\n');
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Decoding per stream keeps a character split across chunks intact.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    // A command that cannot start emits error before close, so the error wins.
    child.on('error', (error) => {
      resolve({ code: error.code, output: `${output}${error.message}\n` });
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? signal, output });
    });
  });
}

export function readEnv(env) {
  if (env.CI_FULL === undefined)
    throw new Error('CI_FULL is not set; expected true or false');
  if (!['true', 'false'].includes(env.CI_FULL))
    throw new Error(
      `CI_FULL is ${JSON.stringify(env.CI_FULL)}; expected true or false`,
    );
  if (env.GITHUB_STEP_SUMMARY === '')
    throw new Error('GITHUB_STEP_SUMMARY is empty; expected a file path');
  return { full: env.CI_FULL === 'true', summary: env.GITHUB_STEP_SUMMARY };
}

async function main() {
  const { full, summary } = readEnv(process.env);
  const scope = full ? 'every check' : 'format check and Markdown lint only';
  console.log(`Selected: ${scope}`);
  const commands = checks({ full });
  const failed = await runChecks(commands);
  if (failed.length) {
    console.error(failureReport(failed, commands.length));
    return 1;
  }
  if (summary)
    appendFileSync(
      summary,
      `Selected ${scope}; every selected check passed.\n`,
    );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
