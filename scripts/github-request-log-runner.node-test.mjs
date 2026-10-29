import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';import {test} from 'node:test';
import {checkStatus,runConfigured} from './github-request-log-runner.mjs';
test('runner records failure durably and retains last successful checkpoint',()=>{
 const dir=mkdtempSync(join(tmpdir(),'runner-'));try{
 const config={statusPath:join(dir,'status'),hooks:[{hook:9}]};const now=()=>new Date('2026-10-24T07:00:00Z');
 runConfigured(config,{now,run:()=>({ok:true,pending:0})});
 runConfigured(config,{now,run:()=>{throw Error('private diagnostic must not leak');}});
 const s=JSON.parse(readFileSync(config.statusPath));assert.equal(s.consecutiveFailures,1);assert.equal(s.lastSuccess,now().toISOString());assert.ok(!JSON.stringify(s).includes('private diagnostic'));assert.equal(checkStatus(s,now().getTime()),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('status monitor rejects missing or stale success',()=>{
 assert.equal(checkStatus({},Date.now()),false);assert.equal(checkStatus({lastSuccess:'2026-10-24T07:00:00Z',consecutiveFailures:0},Date.parse('2026-10-24T08:00:00Z')),false);assert.equal(checkStatus({lastSuccess:'2026-10-24T07:00:00Z',consecutiveFailures:0},Date.parse('2026-10-24T07:10:00Z')),true);
});
test('status monitor rejects future and malformed success timestamps',()=>{
 assert.equal(checkStatus({lastSuccess:'2026-10-24T08:00:00Z',consecutiveFailures:0},Date.parse('2026-10-24T07:00:00Z')),false);
 assert.equal(checkStatus({lastSuccess:'invalid',consecutiveFailures:0},Date.now()),false);
});
