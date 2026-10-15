// Selects the CI checks a pull request needs from its changed paths.
//
// The CI workflow reads this file from the pull request's base commit, so a
// pull request cannot loosen its own selection. Keep the exports pure: tests
// and the workflow call them without a checkout or GitHub access.

// Directories whose files feed lint, the generated agent definitions, or the
// script tests. Markdown under them still selects every check.
const toolingDirectories = [
  '.agents/',
  '.claude/',
  '.codex/',
  '.github/',
  'scripts/',
];

// Returns 'documentation' for a path that only the format check reads, and
// 'full' for everything else, including a path this file does not know.
export function classify(path) {
  if (toolingDirectories.some((directory) => path.startsWith(directory)))
    return 'full';
  if (path === 'LICENSE' || path.endsWith('.md')) return 'documentation';
  return 'full';
}

// `full` selects lint, the agent definition check, and every script test on
// top of the format check, which always runs. An empty list selects every
// check because it means the comparison found nothing to classify.
export function selectScopes(paths) {
  return {
    full:
      paths.length === 0 ||
      paths.some((path) => classify(path) !== 'documentation'),
  };
}
