import {mkdirSync,statSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {test} from 'node:test';import assert from 'node:assert/strict';
import {reconcile,loggedDeliveryIds} from './github-request-log-reconcile.mjs';
function fixture(fn) {const dir=mkdtempSync(join(tmpdir(),'reconcile-'));try{return fn({org:'Org',hook:'9',log:join(dir,'log'),cursor:join(dir,'cursor')});}finally{rmSync(dir,{recursive:true,force:true});}}
const stamp=()=>new Date('2026-10-24T07:00:00Z');
const d=(id)=>({id,guid:'g-'+id,event:'issue_comment',delivered_at:'2026-10-24T06:00:00Z'});
const detail={request:{payload:{action:'created',repository:{full_name:'o/r'},sender:{login:'bot'},issue:{number:1},comment:{body:'never log me'}}}};
test('Link cursor page two is recovered with GET only',()=>fixture(p=>{
 const calls=[];const get=path=>{calls.push(path);if(path.endsWith('per_page=100'))return {data:[d(2)],next:'https://api.github.com/orgs/Org/hooks/9/deliveries?cursor=abc'};if(path.endsWith('cursor=abc'))return {data:[d(1)]};return {data:detail};};
 const r=reconcile({...p,get,now:stamp});assert.equal(r.recovered,2);assert.ok(calls.some(x=>x.endsWith('cursor=abc')));assert.ok(!calls.some(x=>x.includes('attempts')));assert.ok(!readFileSync(p.log,'utf8').includes('never log me'));
}));
test('dedupe survives more than 64KB after delivery',()=>fixture(p=>{
 writeFileSync(p.log,'- (delivery g-1)\n'+'x'.repeat(100000));assert.ok(loggedDeliveryIds(p.log).has('g-1'));
 const r=reconcile({...p,get:()=>({data:[d(1)]}),now:stamp});assert.equal(r.recovered,0);
}));
test('transient detail failure stays pending and recovers next run',()=>fixture(p=>{
 const first=reconcile({...p,get:path=>{if(path.includes('?'))return {data:[d(1)]};throw Error('503');},now:stamp});assert.equal(first.ok,false);assert.equal(first.pending,1);assert.ok(!JSON.stringify(JSON.parse(readFileSync(p.cursor))).includes('unrecoverable'));
 const second=reconcile({...p,get:path=>({data:path.includes('?')?[d(1)]:detail}),now:stamp});assert.equal(second.recovered,1);assert.equal(second.pending,0);
}));
test('pagination cap leaves checkpoint untouched',()=>fixture(p=>{
 const state={version:1,through:null,pending:{},gaps:{}};writeFileSync(p.cursor,JSON.stringify(state));
 assert.throws(()=>reconcile({...p,maxPages:1,get:()=>({data:[d(1)],next:'https://api.github.com/orgs/Org/hooks/9/deliveries?cursor=x'}),now:stamp}),/pagination/);assert.deepEqual(JSON.parse(readFileSync(p.cursor)),state);
}));
test('invalid cursor fails visibly without replacing it',()=>fixture(p=>{
 writeFileSync(p.cursor,'broken');assert.throws(()=>reconcile({...p,now:stamp,get:()=>({data:[]})}));assert.equal(readFileSync(p.cursor,'utf8'),'broken');
}));
test('retention gap marker states unknown count instead of invented loss',()=>fixture(p=>{
 writeFileSync(p.cursor,JSON.stringify({version:1,through:'2026-10-19T00:00:00Z',pending:{},gaps:{}}));
 reconcile({...p,now:stamp,get:()=>({data:[]})});assert.match(readFileSync(p.log,'utf8'),/potential-gap.*missing count unknown/);
}));
test('repeated recovery is idempotent with persisted log',()=>fixture(p=>{
 const get=path=>({data:path.includes('?')?[d(1)]:detail});reconcile({...p,get,now:stamp});const before=readFileSync(p.log,'utf8');reconcile({...p,get,now:stamp});assert.equal(readFileSync(p.log,'utf8'),before);
}));
test('shared lock prevents a second writer and is never stolen',()=>fixture(p=>{
 const lock=p.log+'.lock';mkdirSync(lock);assert.throws(()=>reconcile({...p,get:()=>({data:[]}),now:stamp}),/EEXIST/);assert.ok(statSync(lock).isDirectory());
}));
