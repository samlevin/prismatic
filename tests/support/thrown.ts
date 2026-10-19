// Runs an action that must throw and returns what it threw, so a test can
// inspect the error's code and message.
export function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw.');
}
