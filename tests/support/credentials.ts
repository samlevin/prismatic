// Credential-shaped strings for redaction tests, built at run time so that no
// token-shaped literal is committed for secret scanners to report. The
// characters come from a fixed-seed generator, so every run sees the same
// values.

const alphanumeric =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomText(
  length: number,
  seed = 1,
  alphabet = alphanumeric,
): string {
  let state = seed >>> 0;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    text += alphabet[state % alphabet.length];
  }
  return text;
}

const upperAlphanumeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0234567';

// One example of each token-shaped credential redaction recognizes, keyed by
// the shape it exercises. Both GitHub shapes are masked as `github-token`.
export const credentialExamples: Readonly<Record<string, string>> = {
  'github-token': ['ghp', randomText(36, 2)].join('_'),
  'github-fine-grained-token': ['github', 'pat', randomText(82, 3)].join('_'),
  'openai-key': ['sk', 'proj', randomText(48, 4)].join('-'),
  'stripe-key': ['sk', 'live', randomText(24, 5)].join('_'),
  'slack-token': ['xoxb', randomText(12, 6), randomText(24, 7)].join('-'),
  'google-api-key': `AI${'za'}${randomText(35, 8)}`,
  'aws-access-key-id': `AK${'IA'}${randomText(16, 9, upperAlphanumeric)}`,
  jwt: [
    `ey${'J'}${randomText(20, 10)}`,
    `ey${'J'}${randomText(40, 11)}`,
    randomText(43, 12),
  ].join('.'),
};

export function privateKeyBlock(): string {
  const label = ['RSA', 'PRIVATE', 'KEY'].join(' ');
  const body = [randomText(64, 13), randomText(64, 14), randomText(20, 15)];
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`].join(
    '\n',
  );
}
