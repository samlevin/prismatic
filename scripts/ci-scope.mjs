// Selects the CI checks a pull request needs from its changed paths.
//
// The CI workflow reads this file from the pull request's base commit, so a
// change to this file takes effect only after it merges. Keep the exports pure: tests
// and the workflow call them without a checkout or GitHub access.

// Directories whose files feed lint, the generated agent definitions, the
// script tests, or the product and its tests. Markdown under them, such as
// prompt templates in src/prompts/ and the checksummed snapshots in vendor/,
// still selects every check.
const toolingDirectories = [
  '.agents/',
  '.claude/',
  '.codex/',
  '.github/',
  'scripts/',
  'src/',
  'apps/',
  'tooling/',
  'tests/',
  'evals/',
  'vendor/',
];

// Returns 'documentation' for a path that only the format check and the
// Markdown lint read, and 'full' for everything else, including a path this
// file does not know.
export function classify(path) {
  if (toolingDirectories.some((directory) => path.startsWith(directory)))
    return 'full';
  if (path === 'LICENSE' || path.endsWith('.md')) return 'documentation';
  return 'full';
}

// `full` selects lint of every file, the agent definition check, and every
// script test on top of the format check, which always runs. Otherwise the
// Markdown lint joins the format check. An empty list selects every check
// because it means the comparison found nothing to classify.
export function selectScopes(paths) {
  return {
    full:
      paths.length === 0 ||
      paths.some((path) => classify(path) !== 'documentation'),
  };
}
