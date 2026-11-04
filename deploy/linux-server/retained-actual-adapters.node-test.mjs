import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrivateEnvironment, stopOwnedProcess } from './retained-actual-adapters.mjs';

test('the namespace PWD is allowed only for the actual lane cwd and no inherited credential variable', () => {
  const root = '/owned-lane/private-fixture';
  const cwd = '/owned-lane';
  const env = { HOME: `${root}/private-home`, VITEST: 'true', PWD: cwd };
  assert.doesNotThrow(() => assertPrivateEnvironment(root, { env, cwd }));
  for (const changed of [
    { ...env, PWD: '/different-lane' }, { ...env, HOME: '/host-home' },
    { ...env, VITEST: 'false' }, { ...env, GITHUB_TOKEN: 'synthetic-forbidden' },
  ]) assert.throws(() => assertPrivateEnvironment(root, { env: changed, cwd }), /private allowlisted environment/);
  assert.throws(() => assertPrivateEnvironment(root, { env: { ...env, PWD: '/different-lane' }, cwd: '/different-lane' }), /private allowlisted environment/);
});

test('a joined leader does not excuse an unconfirmed descendant process group', async () => {
  const signals = [];
  let joined = false;
  await assert.rejects(stopOwnedProcess({ pid: 412, exitCode: 0 }, {
    signal: (pid, signal) => { assert.equal(pid, 412); signals.push(signal); return true; },
    waitGroup: async () => false,
    waitChild: async () => { joined = true; return true; },
    timeoutMs: 1,
  }), /group did not stop/);
  assert.deepEqual(signals, [0, 'SIGTERM', 'SIGKILL']);
  assert.equal(joined, false);
});

test('termination confirms both descendant-group exit and the direct child join', async () => {
  const signals = [];
  let waits = 0;
  let joined = false;
  const dependencies = {
    signal: (pid, signal) => { signals.push(signal); return true; },
    waitGroup: async () => ++waits === 2,
    waitChild: async () => { joined = true; return true; },
    timeoutMs: 1,
  };
  await stopOwnedProcess({ pid: 413 }, dependencies);
  assert.deepEqual(signals, [0, 'SIGTERM', 'SIGKILL']);
  assert.equal(waits, 2);
  assert.equal(joined, true);
  await assert.rejects(stopOwnedProcess({ pid: 414 }, { ...dependencies, waitGroup: async () => true, waitChild: async () => false }), /child did not join/);
});

test('no signal is issued without an owned positive PID', async () => {
  for (const pid of [undefined, 0, -1, NaN]) {
    await assert.rejects(stopOwnedProcess({ pid }, { signal: () => { assert.fail('Unowned PID signalled'); } }), /owned PID/);
  }
});
