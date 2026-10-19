// The review fixture most scenarios share: a base branch, a PR with a
// reviewed prior head and five later commits, a force-pushed rewrite of the
// PR, and a base that moved on after the PR branched. The PR touches every
// kind of path §5.1 has a rule for.
import { sourceText } from '../lib/fixtures.ts';
import type { FixtureChange, FixtureCommit } from '../lib/fixtures.ts';

export const marks = {
  mergeBase: 1,
  priorHead: 2,
  head: 7,
  rewrittenHead: 8,
  baseTip: 9,
} as const;

// Names that mean something in sparse-pattern syntax, each with a decoy that
// an unescaped pattern would also match.
export const specialNames: readonly { name: string; decoys: string[] }[] = [
  { name: 'src/we*ird.ts', decoys: ['src/weXird.ts'] },
  { name: 'src/q?.ts', decoys: ['src/q1.ts'] },
  { name: 'src/[br].ts', decoys: ['src/b.ts', 'src/r.ts'] },
  { name: 'src/!bang.ts', decoys: [] },
  { name: 'src/#hash.ts', decoys: [] },
  { name: 'src/trailing.ts ', decoys: ['src/trailing.ts'] },
  { name: 'src/sp ace.ts', decoys: [] },
  { name: 'src/café.ts', decoys: [] },
];

export const newlineName = 'src/new\nline.ts';
export const nonUtf8Name = Buffer.from([
  ...Buffer.from('src/'),
  0xff,
  ...Buffer.from('.ts'),
]);

const lfsPointer = [
  'version https://git-lfs.github.com/spec/v1',
  'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393',
  'size 12345',
  '',
].join('\n');

function binary(seed: number): Buffer {
  const bytes = Buffer.alloc(2048);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = (index * 31 + seed) % 256;
  bytes[10] = 0;
  return bytes;
}

const file = (path: string, content: string | Buffer): FixtureChange => ({
  path,
  content,
});

function baseFiles(): FixtureChange[] {
  const changes: FixtureChange[] = [
    file('.gitignore', 'generated/\n*.local.ts\n'),
    file('src/app.ts', sourceText('app', 3000)),
    file('src/util.ts', sourceText('util', 2000)),
    file('src/hidden.ts', sourceText('hidden', 1500)),
    file('src/settings.local.ts', sourceText('settings', 800)),
    file('generated/api.ts', sourceText('api', 1200)),
    file('docs/guide.md', '# Guide\n'),
    file('src/blob.ts', binary(1)),
    file('src/model.ts', lfsPointer),
    file('src/big.ts', sourceText('big', 300 * 1024)),
    { path: 'src/link.ts', mode: '120000', content: 'app.ts' },
    { path: 'vendor/sub', gitlink: '1111111111111111111111111111111111111111' },
    file(newlineName, sourceText('newline', 300)),
    { path: nonUtf8Name, content: sourceText('nonutf8', 300) },
  ];
  for (let index = 1; index <= 5; index += 1)
    changes.push(file(`src/f${index}.ts`, sourceText(`f${index}`, 1000)));
  for (const { name, decoys } of specialNames) {
    changes.push(file(name, sourceText(`special ${name}`, 400)));
    for (const decoy of decoys)
      changes.push(file(decoy, sourceText(`decoy ${decoy}`, 400)));
  }
  return changes;
}

function prFirstCommit(): FixtureChange[] {
  const changes: FixtureChange[] = [
    file('src/app.ts', `${sourceText('app', 3000)}export const added = 1;\n`),
    file('src/util.ts', `${sourceText('util', 2000)}// reviewed\n`),
    file('src/f1.ts', `${sourceText('f1', 1000)}// one\n// two\n// three\n`),
    // Ignored at every revision.
    file('src/settings.local.ts', sourceText('settings v2', 800)),
    // Hidden by a rule this PR adds.
    file('.gitignore', 'generated/\n*.local.ts\nsrc/hidden.ts\n'),
    file('src/hidden.ts', sourceText('hidden v2', 1500)),
    file('generated/api.ts', sourceText('api v2', 1200)),
    file('docs/guide.md', '# Guide\n\nChanged.\n'),
    file('src/blob.ts', binary(2)),
    file('src/model.ts', lfsPointer.replace('12345', '12346')),
    file('src/big.ts', sourceText('big v2', 300 * 1024)),
    { path: 'src/link.ts', mode: '120000', content: 'util.ts' },
    { path: 'vendor/sub', gitlink: '2222222222222222222222222222222222222222' },
    // A rename, which --no-renames reports as a delete and an add.
    { path: 'src/f2.ts', deleted: true },
    file('src/f2-renamed.ts', sourceText('f2', 1000)),
    file(newlineName, sourceText('newline v2', 300)),
    { path: nonUtf8Name, content: sourceText('nonutf8 v2', 300) },
  ];
  for (const { name } of specialNames)
    changes.push(file(name, sourceText(`special v2 ${name}`, 400)));
  return changes;
}

export function reviewFixture(): FixtureCommit[] {
  const commits: FixtureCommit[] = [
    {
      mark: marks.mergeBase,
      ref: 'refs/heads/main',
      parents: [],
      message: 'base',
      changes: baseFiles(),
    },
    {
      mark: marks.priorHead,
      ref: 'refs/heads/pr',
      parents: [marks.mergeBase],
      message: 'pr: reviewed head',
      changes: prFirstCommit(),
    },
  ];
  // Five more commits, each changing f3, so the reviewed head is five
  // commits below the current head.
  for (let index = 1; index <= 5; index += 1) {
    const mark = marks.priorHead + index;
    commits.push({
      mark,
      ref: 'refs/heads/pr',
      parents: [mark - 1],
      message: `pr: follow-up ${index}`,
      changes: [
        file('src/f3.ts', `${sourceText('f3', 1000)}// follow-up ${index}\n`),
      ],
    });
  }
  commits.push(
    {
      mark: marks.rewrittenHead,
      ref: 'refs/heads/rewritten',
      parents: [marks.mergeBase],
      message: 'pr: force-pushed rewrite',
      changes: [file('src/f4.ts', `${sourceText('f4', 1000)}// rewritten\n`)],
    },
    {
      mark: marks.baseTip,
      ref: 'refs/heads/main',
      parents: [marks.mergeBase],
      message: 'base: moved on',
      changes: [file('src/f5.ts', `${sourceText('f5', 1000)}// base moved\n`)],
    },
  );
  return commits;
}
