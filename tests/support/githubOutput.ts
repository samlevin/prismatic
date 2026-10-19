// Reads a GITHUB_OUTPUT file the way the Actions runner does: each entry is
// either `name=value` on one line, or `name<<DELIMITER`, the value lines, and
// a line holding only the delimiter. A later entry for the same name wins.
export function parseGitHubOutput(text: string): Map<string, string> {
  const outputs = new Map<string, string>();
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heredoc = line.indexOf('<<');
    const equals = line.indexOf('=');
    if (heredoc > 0 && (equals < 0 || heredoc < equals)) {
      const name = line.slice(0, heredoc);
      const delimiter = line.slice(heredoc + 2);
      const end = lines.indexOf(delimiter, index + 1);
      if (end < 0) throw new Error(`Unterminated output ${name}.`);
      outputs.set(name, lines.slice(index + 1, end).join('\n'));
      index = end;
    } else if (equals > 0) {
      outputs.set(line.slice(0, equals), line.slice(equals + 1));
    } else {
      throw new Error(`Malformed output line ${JSON.stringify(line)}.`);
    }
  }
  return outputs;
}
