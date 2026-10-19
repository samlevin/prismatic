import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { workflow, workflowDirectory } from './workflow-test-helpers.mjs';

const repositoryFile = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const security = workflow('ci-security.yml');
const steps = (job) => security.jobs[job].steps;
const runs = (job) =>
  steps(job)
    .map((step) => step.run ?? '')
    .join('\n');

test('every workflow pins each action to a full commit SHA', () => {
  for (const file of readdirSync(workflowDirectory))
    for (const [id, job] of Object.entries(workflow(file).jobs))
      for (const step of job.steps ?? [])
        if (step.uses !== undefined)
          assert.match(
            step.uses,
            /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
            `${file} ${id} ${step.name}`,
          );
});

test('no workflow reads the runner context in a workflow or job env', () => {
  // GitHub rejects the whole workflow file, so none of its jobs run.
  for (const file of readdirSync(workflowDirectory)) {
    const parsed = workflow(file);
    const scopes = [
      ['env', parsed.env],
      ...Object.entries(parsed.jobs).map(([id, job]) => [id, job.env]),
    ];
    for (const [where, env] of scopes)
      for (const [name, value] of Object.entries(env ?? {}))
        assert.doesNotMatch(
          String(value),
          /\$\{\{[^}]*\brunner\./,
          `${file} ${where} ${name}`,
        );
  }
});

test('the supply-chain workflow runs on pull requests, main, a schedule, and by hand', () => {
  assert.deepEqual(Object.keys(security.on).sort(), [
    'pull_request',
    'push',
    'schedule',
    'workflow_dispatch',
  ]);
  assert.deepEqual(security.on.push, { branches: ['main'] });
  assert.equal(security.on.schedule.length, 1);
  assert.deepEqual(security.permissions, { contents: 'read' });
  for (const [id, job] of Object.entries(security.jobs)) {
    assert.equal(job.permissions, undefined, `${id} widens permissions`);
    assert.equal(typeof job['timeout-minutes'], 'number', id);
    for (const step of job.steps)
      if (step.uses?.startsWith('actions/checkout@'))
        assert.equal(step.with['persist-credentials'], false, id);
  }
});

test('dependency review fails pull requests that add a dependency with any advisory', () => {
  assert.equal(
    security.jobs['review-dependencies'].if,
    "${{ github.event_name == 'pull_request' }}",
  );
  const review = steps('review-dependencies').at(-1);
  assert.match(review.uses, /^actions\/dependency-review-action@/);
  assert.equal(review.with['fail-on-severity'], 'low');
});

test('dependency review allows only the advisories npm audit triage accepts', () => {
  const triage = steps('review-dependencies').find(
    (step) => step.id === 'triage',
  );
  assert.match(
    triage.run,
    /^ghsas="\$\(node tooling\/security\/NpmAuditTriage\.ts --allow-ghsas\)"\necho "ghsas=\$ghsas" >> "\$GITHUB_OUTPUT"$/m,
  );
  const review = steps('review-dependencies').at(-1);
  assert.equal(review.with['allow-ghsas'], '${{ steps.triage.outputs.ghsas }}');
});

test('the npm job gates advisories on the triage list and licenses on the policy', () => {
  const script = runs('audit-npm');
  assert.match(
    script,
    /npm audit --json > "\$RUNNER_TEMP\/npm-audit\.json" \|\| true\nnode tooling\/security\/NpmAuditTriage\.ts "\$RUNNER_TEMP\/npm-audit\.json"/,
  );
  assert.match(script, /^node tooling\/security\/LicenseAudit\.ts$/m);
  const license = steps('audit-npm').find((step) =>
    step.run?.includes('LicenseAudit'),
  );
  assert.equal(license.if, '${{ !cancelled() }}');
});

test('the process-pattern audit runs on an install without lifecycle scripts', () => {
  const script = runs('audit-process-patterns');
  assert.match(script, /^npm ci --ignore-scripts$/m);
  assert.match(script, /^node tooling\/security\/ProcessPatternAudit\.ts$/m);
});

test('every locked native artifact is downloaded and checked', () => {
  const script = runs('verify-binaries');
  assert.match(
    script,
    /for lock in docker\/binaries\.lock tooling\/security\/tools\.lock; do/,
  );
  assert.match(
    script,
    /sh docker\/fetch-pinned\.sh "\$lock" "\$name" "\$platform"/,
  );
});

test('the image job installs a checksum-pinned scanner and fails on secrets and fixable vulnerabilities', () => {
  const script = runs('scan-image');
  assert.match(
    script,
    /sh docker\/fetch-pinned\.sh tooling\/security\/tools\.lock trivy linux\/amd64 /,
  );
  assert.match(script, /^docker build --tag "\$IMAGE" \.$/m);
  assert.match(
    script,
    /^npm sbom --sbom-format cyclonedx --package-lock-only > /m,
  );
  assert.match(
    script,
    /^trivy image --cache-dir "\$RUNNER_TEMP\/trivy-cache" --format cyclonedx --output /m,
  );
  assert.match(
    script,
    /^node tooling\/security\/LockedBinariesSbom\.ts "\$RUNNER_TEMP\/sbom\/image\.cdx\.json" linux\/amd64$/m,
  );
  assert.match(
    script,
    /^trivy image --cache-dir "\$RUNNER_TEMP\/trivy-cache" --scanners secret --exit-code 1 "\$IMAGE"$/m,
  );
  assert.match(
    script,
    /^trivy image --cache-dir "\$RUNNER_TEMP\/trivy-cache" --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --ignorefile tooling\/security\/trivy-ignore\.yaml --exit-code 1 "\$IMAGE"$/m,
  );
  for (const line of script.split('\n'))
    if (line.startsWith('trivy image '))
      assert.match(line, / --cache-dir "\$RUNNER_TEMP\/trivy-cache" /, line);
  for (const name of [
    'Scan the image for secrets',
    'Scan the image for fixable high and critical vulnerabilities',
  ])
    assert.equal(
      steps('scan-image').find((step) => step.name === name).if,
      '${{ !cancelled() }}',
      name,
    );
  assert.doesNotMatch(script, /npm (?:install|i) /);
  const upload = steps('scan-image').find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('every image vulnerability ignore explains itself and expires', () => {
  const ignores = parse(repositoryFile('tooling/security/trivy-ignore.yaml'));
  assert.deepEqual(Object.keys(ignores), ['vulnerabilities']);
  assert.ok(Array.isArray(ignores.vulnerabilities));
  for (const entry of ignores.vulnerabilities) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['expired_at', 'id', 'statement'],
      JSON.stringify(entry),
    );
    assert.match(entry.id, /^(?:CVE-\d{4}-\d+|GHSA(?:-[a-z0-9]{4}){3})$/);
    assert.ok(entry.statement.trim().length > 0, entry.id);
    assert.match(String(entry.expired_at), /^\d{4}-\d{2}-\d{2}$/, entry.id);
  }
});

test('tools.lock entries are pinned the way fetch-pinned.sh requires', () => {
  const entries = repositoryFile('tooling/security/tools.lock')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/));
  assert.ok(entries.length > 0);
  for (const fields of entries) {
    assert.equal(fields.length, 5, fields.join(' '));
    assert.match(fields[3], /^[0-9a-f]{64}$/);
    assert.match(fields[4], /^https:\/\//);
  }
  assert.deepEqual(
    entries.map(([name, , platform]) => `${name} ${platform}`),
    ['trivy linux/amd64'],
  );
});

test('Dependabot proposes reviewed npm, Actions, and base image updates', () => {
  const config = parse(repositoryFile('.github/dependabot.yml'));
  const labels = new Set(
    JSON.parse(repositoryFile('.github/labels.json')).labels.map(
      ({ name }) => name,
    ),
  );
  assert.equal(config.version, 2);
  assert.deepEqual(
    config.updates.map((update) => update['package-ecosystem']),
    ['npm', 'github-actions', 'docker'],
  );
  for (const update of config.updates) {
    const where = update['package-ecosystem'];
    assert.equal(update.directory, '/', where);
    assert.equal(update.schedule.interval, 'weekly', where);
    assert.ok(update.cooldown['default-days'] > 0, where);
    assert.match(update['commit-message'].prefix, /^(?:build|ci)$/, where);
    assert.equal(update['commit-message'].include, 'scope', where);
    assert.ok(update.labels.length > 0, where);
    for (const label of update.labels) assert.ok(labels.has(label), label);
  }
});
