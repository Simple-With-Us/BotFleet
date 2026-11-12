import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrivateEnvironment, boundedBody, distinctPorts, stopEveryOwnedProcess, stopOwnedProcess } from './retained-actual-adapters.mjs';

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

test('cleanup stops every owned process and reports the one that would not stop', async () => {
  const stopped = [];
  const closed = [];
  const refuses = { name: 'refuses' };
  const stop = async (child) => { if (child === refuses) throw new Error('synthetic refusal'); stopped.push(child.name); };
  const close = (log) => closed.push(log);
  const commands = new Set([{ name: 'build' }]);
  const live = new Map([['prior', { child: { name: 'runtime' }, log: 7 }]]);
  assert.equal(await stopEveryOwnedProcess(commands, live, { stop, close }), true);
  assert.deepEqual(stopped, ['build', 'runtime']);
  assert.deepEqual(closed, [7]);
  assert.equal(live.size, 0);
  const stuck = new Map([['candidate', { child: refuses, log: 8 }], ['prior', { child: { name: 'second' }, log: 9 }]]);
  assert.equal(await stopEveryOwnedProcess(new Set(), stuck, { stop, close }), false);
  assert.deepEqual([...stuck.keys()], ['candidate']);
  assert.deepEqual(closed, [7, 9]);
});

test('port selection gives up instead of spinning when ports never come back distinct', async () => {
  let calls = 0;
  await assert.rejects(distinctPorts(async () => { calls += 1; return 5000; }, 4), /three distinct free ports/);
  assert.equal(calls, 12);
  let next = 5000;
  assert.deepEqual(await distinctPorts(async () => { next += 1; return next; }), [5001, 5002, 5003]);
});

test('an oversized health response closes its stream before refusing', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(10)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedBody(new Response(body), 5), /oversized/);
  assert.equal(cancelled, true);
});
