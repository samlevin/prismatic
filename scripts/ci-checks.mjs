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

// Runs every command, one at a time so the logs stay readable, and rejects
// after the last one when any of them failed.
export async function runChecks(commands, run = runCommand) {
  const failed = [];
  for (const [command, args] of commands)
    if ((await run(command, args)) !== 0)
      failed.push([command, ...args].join(' '));
  if (failed.length) throw new Error(`CI checks failed: ${failed.join('; ')}`);
}

function runCommand(command, args) {
  console.log(`::group::${command} ${args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(error);
      console.log('::endgroup::');
      resolve(1);
    });
    child.on('exit', (code) => {
      console.log('::endgroup::');
      resolve(code ?? 1);
    });
  });
}

export function parseFull(value) {
  if (!['true', 'false'].includes(value))
    throw new Error('Expected CI_FULL to be true or false');
  return value === 'true';
}

async function main() {
  const full = parseFull(process.env.CI_FULL);
  const scope = full ? 'every check' : 'format check and Markdown lint only';
  console.log(`Selected: ${scope}`);
  await runChecks(checks({ full }));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Selected ${scope}; every selected check passed.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
