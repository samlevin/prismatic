// Credential samples for every §5.5 detector row, one credential-shaped and
// one benign example each. Values are built at run time from a fixed seed,
// so the repository commits no token-shaped literal for secret scanners to
// report, and every build produces the same values. None of them was ever a
// real credential.
import { createPrivateKey } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { randomText } from '../../../tests/support/credentials.ts';

// Rows of the §5.5 publication table.
export type DetectorRow =
  | 'github-token'
  | 'saas-secret'
  | 'aws-access-key-id'
  | 'private-key'
  | 'connection-string'
  | 'masked-only';

export interface CredentialSample {
  readonly name: string;
  readonly row: DetectorRow;
  // `credential` matches the row's structural check; `benign` resembles it
  // but must not be published as a finding.
  readonly shape: 'credential' | 'benign';
  readonly value: string;
}

const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const upperAlphanumeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase62(value: number, width: number): string {
  let text = '';
  let rest = value;
  while (rest > 0) {
    text = (base62[rest % 62] ?? '') + text;
    rest = Math.floor(rest / 62);
  }
  return text.padStart(width, '0');
}

// A classic GitHub token: prefix, 30 random characters, and the base62
// CRC32 of those 30 characters as a 6-character suffix.
export function githubToken(seed: number, prefix = 'ghp'): string {
  const random = randomText(30, seed);
  return `${prefix}_${random}${toBase62(crc32(random), 6)}`;
}

export function hasValidGitHubChecksum(token: string): boolean {
  const match = /^gh[pousr]_([A-Za-z0-9]{30})([A-Za-z0-9]{6})$/.exec(token);
  if (match === null) return false;
  return toBase62(crc32(match[1] ?? ''), 6) === match[2];
}

// An Ed25519 private key in PKCS #8 PEM, derived from a fixed seed so that it
// parses as a real key and is the same on every build.
export function privateKeyPem(seed: number): string {
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const secret = Buffer.from(randomText(32, seed).slice(0, 32), 'latin1');
  const pem = createPrivateKey({
    key: Buffer.concat([prefix, secret]),
    format: 'der',
    type: 'pkcs8',
  }).export({ format: 'pem', type: 'pkcs8' });
  return String(pem).trimEnd();
}

const label = ['PRIVATE', 'KEY'].join(' ');

export const awsSecretAccessKey = randomText(40, 31);

export const credentialSamples: readonly CredentialSample[] = [
  {
    name: 'github token, valid checksum',
    row: 'github-token',
    shape: 'credential',
    value: githubToken(21),
  },
  {
    name: 'github token, wrong checksum',
    row: 'github-token',
    shape: 'benign',
    value: `${githubToken(22).slice(0, -6)}000000`,
  },
  {
    name: 'slack bot token',
    row: 'saas-secret',
    shape: 'credential',
    value: ['xoxb', randomText(12, 23), randomText(24, 24)].join('-'),
  },
  {
    name: 'openai key',
    row: 'saas-secret',
    shape: 'credential',
    value: ['sk', 'proj', randomText(48, 25)].join('-'),
  },
  {
    name: 'stripe live key',
    row: 'saas-secret',
    shape: 'credential',
    value: ['sk', 'live', randomText(24, 26)].join('_'),
  },
  {
    name: 'google api key',
    row: 'saas-secret',
    shape: 'credential',
    value: `AI${'za'}${randomText(35, 27)}`,
  },
  {
    name: 'stripe test-mode key',
    row: 'saas-secret',
    shape: 'benign',
    value: ['sk', 'test', randomText(24, 28)].join('_'),
  },
  {
    name: 'aws access key id',
    row: 'aws-access-key-id',
    shape: 'credential',
    value: `AK${'IA'}${randomText(16, 29, upperAlphanumeric)}`,
  },
  {
    name: 'aws documentation example key id',
    row: 'aws-access-key-id',
    shape: 'benign',
    value: `AK${'IA'}IOSFODNN7${'EXAMPLE'}`,
  },
  {
    name: 'ed25519 private key',
    row: 'private-key',
    shape: 'credential',
    value: privateKeyPem(32),
  },
  {
    name: 'private key armor around prose',
    row: 'private-key',
    shape: 'benign',
    value: [
      `-----BEGIN ${label}-----`,
      'paste the key here',
      `-----END ${label}-----`,
    ].join('\n'),
  },
  {
    name: 'connection string with password',
    row: 'connection-string',
    shape: 'credential',
    value: `postgres://app:${randomText(20, 33)}@db.internal.test:5432/app`,
  },
  {
    name: 'connection string with a placeholder',
    row: 'connection-string',
    shape: 'benign',
    value: 'postgres://app@db.internal.test:5432/app',
  },
  {
    name: 'jwt',
    row: 'masked-only',
    shape: 'credential',
    value: [
      `ey${'J'}${randomText(20, 34)}`,
      `ey${'J'}${randomText(40, 35)}`,
      randomText(43, 36),
    ].join('.'),
  },
  {
    name: 'high-entropy literal under a secret-like name',
    row: 'masked-only',
    shape: 'credential',
    value: randomText(40, 37),
  },
  {
    // The scenario assigns it to a name that does not look secret, such as a
    // build hash.
    name: 'random literal under an ordinary name',
    row: 'masked-only',
    shape: 'benign',
    value: randomText(40, 38),
  },
];

export function credentialSample(name: string): CredentialSample {
  const sample = credentialSamples.find((item) => item.name === name);
  if (sample === undefined) throw new Error(`No credential sample ${name}.`);
  return sample;
}
