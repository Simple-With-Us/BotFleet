import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { assembleBundle, localSpecifiers, publishHelper, verifyBundle } from './update-botfleet-bootstrap.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bf-stable-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), checkout = join(root, 'checkout');
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git(['init','--bare',remote]); git(['clone',remote,checkout]);
  const g = (...args) => git(['-C',checkout,...args]);
  g('config','user.email','fixture@example.invalid'); g('config','user.name','Updater fixture');
  g('checkout','-b','main');
  const put = (path, text) => { const p=join(checkout,path); mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,text); };
  put('scripts/update-botfleet-bootstrap.mjs', readFileSync(new URL('./update-botfleet-bootstrap.mjs', import.meta.url)));
  put('scripts/update-botfleet-policy.sh', `#!/bin/bash
set -euo pipefail
commit=$(git -C "$BOTFLEET_CHECKOUT" rev-parse origin/main)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
node "$BOTFLEET_BOOTSTRAP_DRIVER" --assemble "$BOTFLEET_CHECKOUT" "$commit" "$stage" scripts/update-botfleet-mac.mjs
node "$stage/scripts/update-botfleet-mac.mjs"
node "$(dirname "$BOTFLEET_BOOTSTRAP_DRIVER")/update-botfleet-runtime-commit.mjs"
`);
  put('scripts/update-botfleet-mac.mjs', 'console.log("first graph");\n');
  put('scripts/update-botfleet-runtime-commit.mjs', 'console.log("runtime helper present");\n');
  put('scripts/ci-build-resolver.mjs','export const fixture = true;\n');
  const commit = () => { g('add','.'); g('commit','-m','fixture'); g('push','origin','main'); g('fetch','origin','main'); return g('rev-parse','HEAD'); };
  const first = commit();
  const installed = join(root,'OLD-installed-wrapper.sh');
  copyFileSync(new URL('./update-botfleet.sh',import.meta.url), installed);
  const env = { ...process.env, PATH: dirname(process.execPath)+':'+process.env.PATH, BOTFLEET_CHECKOUT: checkout, BOTFLEET_HELPER_CACHE:join(root,'helper-cache') };
  return { root,checkout,g,put,commit,first,installed,env };
}

test('scanner follows static, side-effect and literal dynamic imports, not quoted/comment instructions', () => {
  assert.deepEqual(localSpecifiers(`// import './fake.mjs';
const message="import './fake2.mjs'";
import './one.mjs'; export {x} from '../shared/two.mjs';
const p=import('./three.mjs'); import {x} from 'node:fs';`), ['./one.mjs','../shared/two.mjs','./three.mjs','node:fs']);
  assert.throws(() => localSpecifiers('const p=import(path);'), /Computed import/);
  assert.throws(() => localSpecifiers('const p=import(`./template.mjs`);'), /Computed import/);
  assert.throws(() => localSpecifiers("const p=import('./data.json', {with:{type:'json'}});"), /Computed import/);
});

test('OLD installed stable wrapper runs NEW updater transitive graph without refreshing the machine helper', {skip:process.platform==='win32'}, (t) => {
  const f=fixture(t);
  const original=readFileSync(f.installed,'utf8');
  f.put('scripts/update-botfleet-mac.mjs', `import {value} from '../shared/new.mjs'; console.log(value);\n`);
  f.put('shared/new.mjs', `export {value} from './deep/newer.mjs';\n`);
  f.put('shared/deep/newer.mjs', `export const value = 'new graph loaded';\n`);
  const next=f.commit();
  const result=spawnSync('/bin/bash',[f.installed],{encoding:'utf8',env:f.env,timeout:60_000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/new graph loaded/);
  assert.match(result.stdout,/runtime helper present/);
  assert.equal(readFileSync(f.installed,'utf8'),original,'installed entrypoint remains unchanged');
  const receipt=JSON.parse(readFileSync(join(f.env.BOTFLEET_HELPER_CACHE,'current.json')));
  assert.equal(receipt.commit,next);
  const manifest=verifyBundle(receipt.directory,next);
  assert.ok(manifest.files.some(file=>file.path==='shared/deep/newer.mjs'));
  assert.ok(manifest.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256)));
});

test('publishing is atomic and corrupted/missing modules never replace the current helper receipt', (t) => {
  const f=fixture(t),cache=join(f.root,'cache');
  const directory=publishHelper(f.checkout,f.first,cache);
  const before=readFileSync(join(cache,'current.json'),'utf8');
  assert.equal(publishHelper(f.checkout,f.first,cache+'/'),directory,'verified same-commit helpers are reused');
  writeFileSync(join(directory,'scripts/update-botfleet-mac.mjs'),'tampered');
  assert.throws(()=>verifyBundle(directory,f.first),/hash mismatch/);
  f.put('scripts/update-botfleet-mac.mjs',`import './missing.mjs';`);
  const bad=f.commit();
  assert.throws(()=>publishHelper(f.checkout,bad,cache),/missing or not a regular/);
  assert.equal(readFileSync(join(cache,'current.json'),'utf8'),before);
});

test('unmerged code cannot supply any updater module', (t) => {
  const f=fixture(t);f.g('checkout','-b','unmerged');
  f.put('scripts/update-botfleet-mac.mjs','throw new Error("must never execute");');
  f.g('add','.'); f.g('commit','-m','unmerged');
  assert.throws(()=>assembleBundle(f.checkout,f.g('rev-parse','HEAD'),join(f.root,'stage'),['scripts/update-botfleet-mac.mjs']));
});

for (const command of ['update', 'prepare']) {
test(`pre-progress ${command} failure reports its real error and exits once under old launchd submit`, {skip:process.platform==='win32'}, (t) => {
  const f=fixture(t);
  f.put('scripts/update-botfleet-mac.mjs',`import './not-present.mjs';`);f.commit();
  const progress=join(f.root,'runs','failure.json');
  const result=spawnSync('/bin/bash',[f.installed,...(command === 'update' ? [] : [command]),'--progress',progress,'--run-id','fixture_failure'],{encoding:'utf8',env:f.env,timeout:60_000});
  assert.equal(result.status,0,'managed launcher must not trigger keep-alive-on-failure');
  const record=JSON.parse(readFileSync(progress));
  assert.equal(record.command,command);
  assert.equal(record.runId,'fixture_failure');assert.equal(record.outcome,'failed');
  assert.ok(record.finishedAt);assert.match(record.message,/not-present\.mjs/);
  assert.match(result.stderr,/not-present\.mjs/);
});

}
