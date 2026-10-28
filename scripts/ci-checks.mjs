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
      // Generated agent definitions and synced files must match what the
      // pinned @agenticool/agents writes from .agents/policy.json.
      ['npm', ['run', 'agents:check']],
      ['npm', ['run', 'workflows:lint']],
      ['node', ['--test', ...testFiles()]],
      // Vitest with coverage, then the 90% coverage gate.
      ['npm', ['run', 'test:unit']],
    );
  // Prettier ignores Markdown, so a documentation change gets the Markdown
  // lint on its own.
  else commands.push(['npm', ['run', 'lint:md']]);
  return commands;
}

function commandLine(command, args) {
  return [command, ...args].join(' ');
}

// Checks run in parallel, so each one's output is buffered and printed in its
// own log group when that check ends. A `Started` line outside any group marks
// each check's start, so a timed-out or cancelled run still shows which checks
// were running. Every check settles before the gate fails, and the error names
// each failed command with its exit code.
export async function runChecks(
  commands,
  run = runCommand,
  write = (text) => process.stdout.write(text),
) {
  const results = await Promise.all(
    commands.map(async ([command, args]) => {
      const line = commandLine(command, args);
      write(`Started ${line}\n`);
      const { code, output } = await run(command, args);
      write(`::group::${line}\n`);
      if (output) write(output.endsWith('\n') ? output : `${output}\n`);
      write('::endgroup::\n');
      return { line, code };
    }),
  );
  const failed = results.filter(({ code }) => code !== 0);
  if (failed.length > 0)
    throw new Error(
      [
        `${failed.length} of ${results.length} CI checks failed:`,
        ...failed.map(({ line, code }) => `  ${line} (exit code ${code})`),
      ].join('\n'),
    );
}

// Collects stdout and stderr together in the order they arrive.
function runCommand(command, args) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, output: Buffer.concat(chunks).toString() });
    };
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      chunks.push(Buffer.from(`${error.stack ?? error}\n`));
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export function parseFull(value) {
  if (!['true', 'false'].includes(value))
    throw new Error('Expected CI_FULL to be true or false');
  return value === 'true';
}

async function main() {
  const full = parseFull(process.env.CI_FULL);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary === '')
    throw new Error('Expected GITHUB_STEP_SUMMARY to name a file when set');
  const scope = full ? 'every check' : 'format check and Markdown lint only';
  console.log(`Selected: ${scope}`);
  await runChecks(checks({ full }));
  if (summary)
    appendFileSync(
      summary,
      `Selected ${scope}; every selected check passed.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    await main();
  } catch (error) {
    // End the log with the failure summary instead of a stack trace.
    console.error(error.message);
    process.exitCode = 1;
  }
