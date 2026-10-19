// Runs the live cache and request spike and prints the results as JSON on
// stdout. Progress goes to stderr.
//
// Usage:
//   node experiments/cache/spike/main.ts --dry-run
//   OPENAI_API_KEY=... node experiments/cache/spike/main.ts --budget-usd <usd>
//     [--model gpt-6.1-sol] [--max-output-tokens 8000] [--settle-ms 3000]
//     [--only <scenario-id>,...]
//
// A live run needs an explicit --budget-usd. Each request reserves its worst
// case before it is sent and is skipped when the reservation does not fit.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSecretRedactor } from '../../../src/shared/redaction.ts';
import { EvaluationBudget } from '../lib/budget.ts';
import { pricesFor } from '../lib/pricing.ts';
import { totalsByScenario } from '../lib/record.ts';
import { runScenarios } from '../lib/runner.ts';
import { scenarios } from '../lib/scenarios.ts';
import {
  selectTokenizer,
  summarizeMargin,
  tokenizerCandidates,
} from '../lib/tokens.ts';
import { openAIProvider } from '../lib/openaiProvider.ts';

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function sdkVersion(): string {
  const url = new URL(
    '../../../node_modules/openai/package.json',
    import.meta.url,
  );
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
}

async function main(argv: readonly string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const model = option(argv, '--model') ?? 'gpt-6.1-sol';
  const maxOutputTokens = Number(option(argv, '--max-output-tokens') ?? 8000);
  const settleMs = Number(option(argv, '--settle-ms') ?? 3000);
  const only = option(argv, '--only')?.split(',');
  const budgetUsd = Number(option(argv, '--budget-usd') ?? (dryRun ? 1 : NaN));
  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  const log = (message: string): void => {
    process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  };
  if (!dryRun && !(budgetUsd > 0)) {
    log('A live run needs --budget-usd <positive amount>.');
    return 2;
  }
  if (!dryRun && apiKey === '') {
    log('A live run needs OPENAI_API_KEY.');
    return 2;
  }
  const selected = scenarios.filter(
    (scenario) => only === undefined || only.includes(scenario.id),
  );
  const prices = pricesFor(model);
  const budget = new EvaluationBudget(budgetUsd);
  const [planner] = tokenizerCandidates;
  if (planner === undefined) throw new Error('No tokenizer candidates.');
  const started = new Date();
  const result = await runScenarios(selected, {
    runId: randomUUID(),
    model,
    prices,
    maxOutputTokens,
    budget,
    tokenizer: planner,
    candidates: tokenizerCandidates,
    inputMargin: 1.1,
    attributionTolerance: 0.02,
    settleMs,
    provider: dryRun ? null : openAIProvider(apiKey),
    redactor: createSecretRedactor([apiKey]),
    now: () => performance.now(),
    sleep: (ms) => sleep(ms),
    log,
  });
  const margins = Object.entries(result.countSamples)
    .filter(([, samples]) => samples.length > 0)
    .map(([id, samples]) => summarizeMargin(id, samples));
  const plannedWorstCaseUsd = result.records.reduce(
    (sum, record) => sum + record.reservationUsd,
    0,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        spike: 'P0.9 live cache and request feasibility (#142)',
        dryRun,
        model,
        openaiSdk: sdkVersion(),
        node: process.version,
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        priceCatalog: {
          version: prices.catalogVersion,
          source: prices.source,
        },
        maxOutputTokens,
        settleMs,
        plannerTokenizer: planner.id,
        plannedWorstCaseUsd,
        budget: budget.snapshot(),
        tokenizerMargins: margins,
        selectedTokenizer: selectTokenizer(margins)?.tokenizer ?? null,
        totals: totalsByScenario(result.records),
        scenarios: selected.map(({ id, criteria, title, hypothesis }) => ({
          id,
          criteria,
          title,
          hypothesis,
        })),
        steps: result.records,
      },
      null,
      2,
    )}\n`,
  );
  return result.records.some((r) => r.status === 'error') ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
