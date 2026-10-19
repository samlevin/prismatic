// Writes a fixture history, encoded by evals/fixtures/security/
// repositoryObjects.ts, as a bare Git repository without running Git.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { BuiltRepository } from '../../evals/fixtures/security/repositoryObjects.ts';

// Writes the repository as loose objects and loose refs into a new
// directory, which Git can then read like any bare repository.
export function writeBareRepository(
  directory: string,
  built: BuiltRepository,
): void {
  for (const sub of [
    'objects/info',
    'objects/pack',
    'refs/heads',
    'refs/tags',
  ]) {
    mkdirSync(path.join(directory, sub), { recursive: true });
  }
  writeFileSync(
    path.join(directory, 'HEAD'),
    `ref: refs/heads/${built.defaultBranch}\n`,
  );
  writeFileSync(
    path.join(directory, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n',
  );
  for (const id of [...built.objects.keys()].sort()) {
    const file = path.join(directory, 'objects', id.slice(0, 2), id.slice(2));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, deflateSync(built.objects.get(id) ?? Buffer.alloc(0)));
  }
  for (const [ref, id] of Object.entries(built.refs)) {
    const file = path.join(directory, ...ref.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`);
  }
}
