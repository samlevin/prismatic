// Shared CLI declarations use Node's built-in parser; no runtime dependency.
const { parseArgs } = require('node:util');

class CliError extends Error {}
class CliHelp extends Error {}

const definitions = {
  help: { type: 'boolean', alias: 'h', description: 'Show help' },
  actor: {
    type: 'string',
    alias: 'a',
    description: 'Branch owner (defaults to agent)',
  },
  layer: {
    type: 'string',
    alias: 'l',
    description: 'Stack layer (defaults to 1)',
  },
  issue: { type: 'string', alias: 'i', description: 'Positive issue number' },
  'dry-run': {
    type: 'boolean',
    alias: 'n',
    description: 'Preview without writing',
  },
  apply: { type: 'boolean', description: 'Apply tracker changes' },
  next: { type: 'boolean', description: 'Print the next delivery leaf' },
  resume: { type: 'string', description: 'Explicitly resume this issue' },
  tool: {
    type: 'string',
    alias: 't',
    description: 'Agent tool (claude or codex)',
  },
  role: { type: 'string', description: 'Agent role' },
  capability: { type: 'string', description: 'Agent capability' },
  model: {
    type: 'string',
    alias: 'm',
    description: 'Requested model override',
  },
  effort: { type: 'string', description: 'Requested effort override' },
  pr: { type: 'string', description: 'Pull request number' },
  base: { type: 'string', description: 'Full base commit SHA' },
  head: { type: 'string', description: 'Full head commit SHA' },
  report: { type: 'string', description: 'Review report file' },
};

function defineCli(usage, names = []) {
  const options = Object.fromEntries(
    ['help', ...names].map((name) => {
      if (!Object.hasOwn(definitions, name))
        throw new Error(`Undefined option ${name}`);
      return [name, definitions[name]];
    }),
  );
  const aliases = new Map();
  for (const [name, option] of Object.entries(options)) {
    for (const spelling of [
      `--${name}`,
      ...(option.alias ? [`-${option.alias}`] : []),
    ]) {
      if (aliases.has(spelling))
        throw new Error(`Duplicate CLI spelling ${spelling}`);
      aliases.set(spelling, name);
    }
  }
  const help = `${usage}\n\nOptions:\n${Object.entries(options)
    .map(
      ([name, option]) =>
        `  --${name}${option.alias ? `, -${option.alias}` : ''}${option.type === 'string' ? ' <value>' : ''}  ${option.description}`,
    )
    .join(
      '\n',
    )}\n\nString options accept OPTION=value or OPTION value. Use = for values beginning with a dash.\nUse -- to end wrapper options. Short options are exact; they cannot be grouped.`;
  return { options, aliases, help };
}

function cliError(cli, message) {
  return new CliError(`${message}\n\n${cli.help}`);
}

function parseCli(argv, cli) {
  const normalized = [];
  const positionals = [];
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    const equals = token.indexOf('=');
    const spelling = equals < 0 ? token : token.slice(0, equals);
    const name = cli.aliases.get(spelling);
    if (!name) {
      if (token.startsWith('-') && token !== '-')
        throw cliError(cli, `Unknown option ${spelling}`);
      else positionals.push(token);
      continue;
    }
    if (seen.has(name))
      throw cliError(cli, `--${name} is given more than once`);
    seen.add(name);
    const option = cli.options[name];
    if (option.type === 'string' && equals < 0) {
      const value = argv[index + 1];
      if (
        value === undefined ||
        value === '--' ||
        value.startsWith('--') ||
        cli.aliases.has(value.split('=')[0])
      )
        throw cliError(
          cli,
          `${spelling} requires a value; use ${spelling}=<value> for a value beginning with a dash`,
        );
      normalized.push(`--${name}=${value}`);
      index++;
    } else normalized.push(`--${name}${equals < 0 ? '' : token.slice(equals)}`);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: normalized,
      options: Object.fromEntries(
        Object.entries(cli.options).map(([name, option]) => [
          name,
          { type: option.type },
        ]),
      ),
      strict: true,
    }));
  } catch (error) {
    throw cliError(cli, error.message);
  }
  for (const [name, value] of Object.entries(values)) {
    if (cli.options[name].type === 'string' && value === '')
      throw cliError(cli, `--${name} requires a value`);
  }
  if (values.help) throw new CliHelp(cli.help);
  return { options: { ...values }, positionals };
}

exports.CliError = CliError;
exports.CliHelp = CliHelp;
exports.defineCli = defineCli;
exports.parseCli = parseCli;
exports.cliError = cliError;
