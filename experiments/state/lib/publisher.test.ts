import { describe, expect, test } from 'vitest';
import { GitHubError } from './github.ts';
import {
  isAuthentic,
  PublisherError,
  requireAuthentic,
  resolveExpectedPublisher,
} from './publisher.ts';
import { accounts, pullRequest } from './testing.ts';

describe('resolveExpectedPublisher', () => {
  test('the Actions GITHUB_TOKEN path resolves the default bot login, not /user', async () => {
    const github = pullRequest().client('github-actions[bot]', 'installation');
    await expect(github.authenticatedUser()).rejects.toThrow(GitHubError);
    await expect(
      resolveExpectedPublisher({ kind: 'actions-token' }, github),
    ).resolves.toEqual({
      login: 'github-actions[bot]',
      id: accounts.actions.id,
      source: 'actions-token',
    });
  });

  test('the configured App path resolves the bot user named by the trusted input', async () => {
    const github = pullRequest().client(
      'prismatic-review[bot]',
      'installation',
    );
    const publisher = await resolveExpectedPublisher(
      { kind: 'app-token', publisherLogin: 'prismatic-review[bot]' },
      github,
    );
    expect(publisher).toEqual({
      login: 'prismatic-review[bot]',
      id: accounts.app.id,
      source: 'app-token',
    });
    // An Actions run with an App token sets the same input.
    await expect(
      resolveExpectedPublisher(
        { kind: 'actions-token', publisherLogin: 'prismatic-review[bot]' },
        github,
      ),
    ).resolves.toMatchObject({ id: accounts.app.id });
  });

  test('the CLI personal-token path resolves the token owner', async () => {
    const github = pullRequest().client('cli-user', 'personal');
    await expect(
      resolveExpectedPublisher({ kind: 'cli-personal-token' }, github),
    ).resolves.toEqual({
      login: 'cli-user',
      id: accounts.personal.id,
      source: 'cli-personal-token',
    });
  });

  test('a CLI run with an App token needs a trusted login', async () => {
    const github = pullRequest().client(
      'prismatic-review[bot]',
      'installation',
    );
    await expect(
      resolveExpectedPublisher({ kind: 'cli-personal-token' }, github),
    ).rejects.toThrow('Resource not accessible by integration');
    await expect(
      resolveExpectedPublisher(
        { kind: 'cli-app-token', publisherLogin: 'prismatic-review[bot]' },
        github,
      ),
    ).resolves.toMatchObject({ id: accounts.app.id, source: 'cli-app-token' });
    await expect(
      resolveExpectedPublisher(
        { kind: 'cli-app-token', publisherLogin: ' ' },
        github,
      ),
    ).rejects.toMatchObject({ code: 'publisher-login-required' });
  });

  test('refuses malformed logins and accounts of the wrong type', async () => {
    const github = pullRequest();
    github.addAccount({ login: 'impostor[bot]', id: 2001, type: 'User' });
    github.addAccount({ login: 'some-org', id: 2002, type: 'Organization' });
    const client = github.client('github-actions[bot]', 'installation');
    for (const login of [
      '../users',
      'a b',
      '-lead',
      'x'.repeat(40),
      'bot[bot][bot]',
    ]) {
      await expect(
        resolveExpectedPublisher(
          { kind: 'app-token', publisherLogin: login },
          client,
        ),
      ).rejects.toMatchObject({ code: 'invalid-login' });
    }
    await expect(
      resolveExpectedPublisher(
        { kind: 'app-token', publisherLogin: 'impostor[bot]' },
        client,
      ),
    ).rejects.toMatchObject({ code: 'unexpected-account-type' });
    await expect(
      resolveExpectedPublisher(
        { kind: 'actions-token', publisherLogin: 'some-org' },
        client,
      ),
    ).rejects.toMatchObject({ code: 'unexpected-account-type' });
    await expect(
      resolveExpectedPublisher(
        { kind: 'actions-token', publisherLogin: 'nobody' },
        client,
      ),
    ).rejects.toMatchObject({ status: 404 });
    // A user login is never an App identity, even though it resolves.
    await expect(
      resolveExpectedPublisher(
        { kind: 'app-token', publisherLogin: 'maya' },
        client,
      ),
    ).rejects.toMatchObject({ code: 'invalid-login' });
    // An Actions run may name a machine user that owns a personal token.
    await expect(
      resolveExpectedPublisher(
        { kind: 'actions-token', publisherLogin: 'maya' },
        client,
      ),
    ).resolves.toMatchObject({ id: accounts.maintainer.id });
    const bot = pullRequest().client('github-actions[bot]', 'personal');
    await expect(
      resolveExpectedPublisher({ kind: 'cli-personal-token' }, bot),
    ).rejects.toBeInstanceOf(PublisherError);
  });
});

describe('isAuthentic', () => {
  test('trusts the author id, through renames, and not the login', async () => {
    const github = pullRequest();
    const publisher = await resolveExpectedPublisher(
      { kind: 'cli-personal-token' },
      github.client('cli-user', 'personal'),
    );
    const original = await github
      .client('cli-user', 'personal')
      .createComment('issue', 'one');
    github.rename(accounts.personal.id, 'cli-user-renamed');
    // Another account takes the freed login.
    github.addAccount({ login: 'cli-user', id: 2003, type: 'User' });
    const squatter = await github
      .client('cli-user', 'personal')
      .createComment('issue', 'two');
    expect(isAuthentic(original, publisher)).toBe(true);
    expect(squatter.author.login).toBe(publisher.login);
    expect(isAuthentic(squatter, publisher)).toBe(false);
    expect(() => requireAuthentic(squatter, publisher)).toThrow(
      expect.objectContaining({ code: 'author-mismatch' }),
    );
    expect(requireAuthentic(original, publisher)).toBe(original);
  });
});
