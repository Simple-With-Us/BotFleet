import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSharedBuild as next} from './shared-build.mjs';

// The merge stamp S is set explicitly on every case, so no test depends on
// the clock or on a git checkout.
const STAMP = '202610290000';
const input = {iosBuilds: [], macBuilds: [], complete: true, mergeStamp: STAMP};

test('a fresh app plans the merge stamp itself', () => {
  assert.deepEqual(next(input), {build: STAMP});
});

test('existing builds below the stamp still plan the stamp', () => {
  assert.deepEqual(next({...input, iosBuilds: ['1000']}), {build: STAMP});
  assert.deepEqual(next({...input, macBuilds: ['202610280000']}), {build: STAMP});
  assert.deepEqual(next({...input, iosBuilds: ['1000'], macBuilds: ['202610280000']}), {build: STAMP});
});

test('an existing build at or above the stamp plans one above the max', () => {
  // A rebuild of the same commit goes up: the stamp itself is taken.
  assert.deepEqual(next({...input, iosBuilds: [STAMP]}), {build: '202610290001'});
  assert.deepEqual(next({...input, macBuilds: [STAMP]}), {build: '202610290001'});
  assert.deepEqual(next({...input, iosBuilds: ['209912312359']}), {build: '209912312360'});
  assert.deepEqual(next({...input, macBuilds: ['209912312359']}), {build: '209912312360'});
});

test('iOS timestamp builds count now (nothing is ignored)', () => {
  // Below the stamp they lose to it; above it they hold the floor up.
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645', '202610180127']}),
    {build: STAMP}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645'], mergeStamp: '202610010000'}),
    {build: '202610190646'}
  );
});

test('a mac-only higher build holds the floor up', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['1100'], macBuilds: ['202610290005']}),
    {build: '202610290006'}
  );
});

test('paired union: both platforms of both apps join one max', () => {
  // iosBuilds = IOS(app) + IOS(paired), macBuilds = MAC_OS(app) + MAC_OS(paired).
  assert.deepEqual(
    next({iosBuilds: ['1100', '202610290007'], macBuilds: ['1200', '1400'], complete: true, mergeStamp: STAMP}),
    {build: '202610290008'}
  );
  assert.deepEqual(
    next({iosBuilds: ['1100', '1150'], macBuilds: ['1200', '202610290009'], complete: true, mergeStamp: STAMP}),
    {build: '202610290010'}
  );
});

test('extra floors join the max as digit strings of any length', () => {
  assert.deepEqual(next({...input, extraFloors: ['986']}), {build: STAMP});
  assert.deepEqual(next({...input, extraFloors: ['202610290003']}), {build: '202610290004'});
  assert.deepEqual(next({...input, extraFloors: [986]}), {build: STAMP});
  // The 202610290003 floor above pins a 12-digit floor travelling exactly
  // through the BigInt max; anything past 12 digits is covered by the cap
  // test below.
});

test('a result past 12 digits fails closed instead of planning an unshippable build', () => {
  // The ship's 12-digit gate rejects anything else, so the planner throws.
  assert.throws(() => next({...input, extraFloors: ['999999999999']}), /planned build exceeds 12 digits/);
  assert.throws(() => next({...input, iosBuilds: ['999999999999']}), /planned build exceeds 12 digits/);
  assert.throws(() => next({...input, macBuilds: ['999999999999']}), /planned build exceeds 12 digits/);
  // An 18-digit Sparkle floor (past Number's safe range, so still a string
  // into the BigInt max) throws rather than emitting a 19-digit build.
  assert.throws(() => next({...input, extraFloors: ['999999999999999999']}), /planned build exceeds 12 digits/);
  // Twelve nines exactly still plans: the cap is on the result's digits.
  assert.deepEqual(next({...input, extraFloors: ['999999999998']}), {build: '999999999999'});
});

test('dotted builds count by their first numeric component', () => {
  assert.deepEqual(next({...input, iosBuilds: ['0.1.3', '1.1.2']}), {build: STAMP});
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290004.1'], mergeStamp: '202610010000'}),
    {build: '202610290005'}
  );
});

test('malformed inventory throws before computing', () => {
  for (const bad of [null, 'NaN', '1.2.3.4', 42, '', ' 1000', 'v1']) {
    assert.throws(() => next({...input, iosBuilds: [bad]}), /malformed build inventory/);
    assert.throws(() => next({...input, macBuilds: [bad]}), /malformed build inventory/);
  }
  for (const bad of [-1, 1.5, NaN, '15x0', '', null]) {
    assert.throws(() => next({...input, extraFloors: [bad]}), /malformed build inventory/);
  }
  assert.throws(() => next({...input, extraFloors: '1500'}), /malformed build inventory/);
  // A malformed entry is reported even when the max would also apply.
  assert.throws(() => next({...input, iosBuilds: ['209912312359', 'NaN']}), /malformed build inventory/);
});

test('a bad merge stamp throws', () => {
  for (const bad of [undefined, null, '', '20261029000', '2026102900001', '022610290000', 202610290000, '2026-10-29']) {
    assert.throws(() => next({...input, mergeStamp: bad}), /merge stamp/);
  }
});

test('incomplete inventory refuses', () => {
  assert.throws(() => next({...input, complete: false}), /complete build inventory required/);
  assert.throws(() => next({...input, complete: undefined}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: '1000', macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
});
