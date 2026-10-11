import assert from 'node:assert/strict';
import test from 'node:test';
import { createGhApi } from './github-rest.mjs';

test('runs gh api with the arguments and returns stdout', () => {
  const calls = [];
  const ghApi = createGhApi((...call) => {
    calls.push(call);
    return 'out';
  });
  assert.equal(ghApi(['repos/x/y']), 'out');
  const [file, args, options] = calls[0];
  assert.equal(file, 'gh');
  assert.deepEqual(args, ['api', 'repos/x/y']);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.encoding, 'utf8');
  assert.equal(options.maxBuffer, 64 * 1024 * 1024);
  assert.equal('input' in options, false);
});

test('passes input through and pipes stdin', () => {
  let options;
  createGhApi((_file, _args, given) => {
    options = given;
    return '';
  })(['--input', '-'], { input: '{}' });
  assert.equal(options.input, '{}');
  assert.equal(options.stdio[0], 'pipe');
});

test('failure hides stderr, keeps the cause, and parses the HTTP status', () => {
  const cause = Object.assign(new Error('spawn'), {
    stderr: 'gh: Not Found (HTTP 404) token ghp_secret',
  });
  const ghApi = createGhApi(() => {
    throw cause;
  });
  assert.throws(
    () => ghApi(['x']),
    (error) => {
      assert.equal(error.message, 'GitHub request failed');
      assert.equal(error.httpStatus, 404);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test('failure without an HTTP status leaves httpStatus unset', () => {
  const ghApi = createGhApi(() => {
    throw new Error('ENOENT');
  });
  assert.throws(
    () => ghApi(['x']),
    (error) => error.httpStatus === undefined,
  );
});
