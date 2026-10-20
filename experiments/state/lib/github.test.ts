import { describe, expect, test } from 'vitest';
import { FakeGitHub, GitHubError, LostResponseError } from './github.ts';
import { accounts, headA, pullRequest } from './testing.ts';

describe('FakeGitHub', () => {
  test('lets only the author edit through the API, and anyone with access in the UI', async () => {
    const github = pullRequest();
    const bot = github.client('github-actions[bot]', 'installation');
    const mallory = github.client('mallory', 'personal');
    const comment = await bot.createComment('issue', 'one');
    await expect(
      mallory.updateComment('issue', comment.id, 'two'),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      bot.updateComment('review', comment.id, 'two'),
    ).rejects.toMatchObject({
      status: 404,
    });
    github.edit(comment.id, 'edited by a maintainer');
    expect(github.comments('issue')[0]).toMatchObject({
      author: accounts.actions,
      body: 'edited by a maintainer',
    });
    github.delete(comment.id);
    expect(() => github.delete(comment.id)).toThrow(GitHubError);
  });

  test('loses the response of a later write, after applying it', async () => {
    const github = pullRequest();
    const bot = github.client('github-actions[bot]', 'installation');
    github.loseResponse(1);
    await bot.createComment('issue', 'kept');
    await expect(bot.createComment('issue', 'applied')).rejects.toThrow(
      LostResponseError,
    );
    await bot.createComment('issue', 'after');
    expect(github.comments('issue').map((comment) => comment.body)).toEqual([
      'kept',
      'applied',
      'after',
    ]);
    expect(github.writes).toBe(3);
  });

  test('reports accounts, permissions and the head', async () => {
    const github = new FakeGitHub(headA);
    github.addAccount(accounts.maintainer, 'maintain');
    github.addAccount(accounts.mallory);
    const client = github.client('maya', 'personal');
    await expect(client.permissionOf('maya')).resolves.toEqual({
      account: accounts.maintainer,
      permission: 'maintain',
    });
    await expect(client.permissionOf('mallory')).resolves.toMatchObject({
      permission: 'read',
    });
    await expect(client.permissionOf('nobody')).rejects.toMatchObject({
      status: 404,
    });
    expect(github.permission(9_999)).toBe('read');
    await expect(client.headSha()).resolves.toBe(headA);
    expect(() => github.client('nobody', 'personal')).toThrow(
      'No account nobody.',
    );
    expect(() => github.rename(9_999, 'x')).toThrow('No account 9999.');
  });
});
