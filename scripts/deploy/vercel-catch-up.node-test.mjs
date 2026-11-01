import test from 'node:test';
import assert from 'node:assert/strict';
import { COOLDOWN_MS, classify, assertProject, assertCi, pendingCi, assertReceipt, deploymentSha, request, resolveBaseline } from './vercel-catch-up.mjs';
const A = 'a'.repeat(40), B = 'b'.repeat(40), now = 1_800_000_000_000;
const config = { projectId: 'prj_test', teamId: 'team_test', repoId: 17, rootDirectory: 'site' };
const baseline = { projectId: 'prj_test', target: 'production', readyState: 'READY', created: now - COOLDOWN_MS - 1, gitSource: { sha: A }, url: 'test.vercel.app' };
const old = { projectId: config.projectId, target: 'production', readyState: 'READY', created: now - COOLDOWN_MS - 1 };
const decide = extra => classify({ deployments: [old], baseline, target: B, now, projectId: config.projectId, changed: () => true, ...extra });
const project = { id: 'prj_test', accountId: 'team_test', rootDirectory: 'site', gitProviderOptions: { createDeployments: 'disabled' }, link: { type: 'github', repoId: 17, productionBranch: 'main' } };
test('latest main drains after 3h without another merge', () => assert.equal(decide().deploy, true));
test('skip inside cooldown and allow exactly at boundary', () => {
 assert.equal(decide({ deployments: [{ ...old, created: now - COOLDOWN_MS + 1 }] }).deploy, false);
 assert.equal(decide({ deployments: [{ ...old, created: now - COOLDOWN_MS }] }).deploy, true);
});
test('failed/canceled attempts still consume cooldown', () => {
 for (const state of ['ERROR','CANCELED']) assert.equal(decide({ deployments: [old, { ...old, readyState: state, created: now - 1 }] }).deploy, false);
});
test('inflight production always prevents duplicate deployment', () => {
 for (const state of ['QUEUED','BUILDING','INITIALIZING']) assert.equal(decide({ deployments: [{ ...old, readyState: state }] }).deploy, false);
});
test('compare changes against deployed SHA, not last incoming commit', () => {
 let compared;
 assert.equal(decide({ changed: (from, to) => { compared = [from,to]; return true; } }).deploy, true);
 assert.deepEqual(compared, [A,B]);
 assert.equal(decide({ changed: () => false }).deploy, false);
});
test('already deployed main noops', () => assert.equal(decide({ target: A }).deploy, false));
test('unknown history, timestamp, baseline or metadata fails closed', () => {
 for (const d of [{...old,readyState:'UNKNOWN'},{...old,created:now+1},{...old,created:'123'},{...old,target:'preview'}]) assert.throws(() => decide({deployments:[d]}));
 assert.throws(() => decide({baseline:{...baseline,readyState:'ERROR'}}));
 assert.throws(() => decide({baseline:{...baseline,gitSource:{}}}));
 assert.throws(() => deploymentSha({...baseline,meta:{fleetCommitSha:B}}));
});
test('binding checks stable repo ID and preserves root', () => {
 assert.doesNotThrow(() => assertProject(project,config));
 assert.doesNotThrow(() => assertProject({...project,link:{...project.link,org:'old-owner'}},config));
 for (const p of [{...project,id:'wrong'},{...project,accountId:'wrong'},{...project,rootDirectory:''},{...project,gitProviderOptions:{createDeployments:'enabled'}},{...project,link:{...project.link,repoId:18}},{...project,link:{...project.link,productionBranch:'dev'}}]) assert.throws(() => assertProject(p,config));
});
test('CI requires latest exact main successful trusted event', () => {
 const good = {id:1,name:'CI',head_sha:B,head_branch:'main',event:'push',status:'completed',conclusion:'success'};
 assert.doesNotThrow(() => assertCi([good],['CI'],B));
 for (const change of [{head_sha:A},{event:'pull_request'},{status:'in_progress'},{conclusion:'failure'},{conclusion:'skipped'}]) assert.throws(() => assertCi([{...good,...change}],['CI'],B));
 assert.throws(() => assertCi([good,{...good,id:2,conclusion:'failure'}],['CI'],B));
 assert.throws(() => assertCi([good],['CI','Site CI'],B));
});
test('a still-running exact-main workflow is pending, not a refusal or a pass', () => {
 const good = {id:1,name:'CI',head_sha:B,head_branch:'main',event:'push',status:'completed',conclusion:'success'};
 const lint = {...good,id:2,name:'Node CI'};
 assert.deepEqual(pendingCi([good,lint],['CI','Node CI'],B),[]);
 for (const status of ['queued','in_progress','waiting','requested','pending']) assert.deepEqual(pendingCi([{...good,status,conclusion:null},lint],['CI','Node CI'],B),['CI']);
 assert.deepEqual(pendingCi([{...good,status:'completed',conclusion:'failure'},lint],['CI','Node CI'],B),[]);
 assert.deepEqual(pendingCi([good,{...good,id:3,status:'in_progress',conclusion:null},lint],['CI','Node CI'],B),['CI']);
 assert.deepEqual(pendingCi([{...good,head_sha:A,status:'in_progress'},lint],['CI','Node CI'],B),[]);
 assert.deepEqual(pendingCi([lint],['CI','Node CI'],B),[]);
 assert.throws(() => pendingCi([],[],B));
 assert.throws(() => pendingCi(null,['CI'],B));
});
test('baseline falls back to the serving alias only when the target pointer is not READY', async () => {
 const cfg = { ...config, productionAlias: 'site.example.test' };
 const canceled = { projectId: 'prj_test', target: 'production', readyState: 'CANCELED', created: now - 1000, gitSource: { sha: B } };
 const ready = { ...baseline };
 let aliasCalls = 0;
 const fast = await resolveBaseline({ project: { ...project, targets: { production: { id: 'dpl_ready' } } }, config: cfg, readDeployment: async () => ready, readAlias: async () => { aliasCalls++; throw new Error('must not query alias'); } });
 assert.equal(fast.via, 'target');
 assert.equal(aliasCalls, 0);
 const pointedCanceled = { ...project, targets: { production: { id: 'dpl_canceled' } } };
 const fellBack = await resolveBaseline({ project: pointedCanceled, config: cfg, readDeployment: async id => id === 'dpl_canceled' ? canceled : ready, readAlias: async a => { assert.equal(a, 'site.example.test'); return { projectId: 'prj_test', deploymentId: 'dpl_serving' }; } });
 assert.equal(fellBack.via, 'alias');
 assert.equal(fellBack.baseline, ready);
 await assert.rejects(resolveBaseline({ project: pointedCanceled, config, readDeployment: async () => canceled, readAlias: async () => ({}) }), /alias not configured/);
 await assert.rejects(resolveBaseline({ project: pointedCanceled, config: { ...cfg, productionAlias: 'https://evil.test/x' }, readDeployment: async () => canceled, readAlias: async () => ({}) }), /alias not configured/);
 await assert.rejects(resolveBaseline({ project: pointedCanceled, config: cfg, readDeployment: async () => canceled, readAlias: async () => ({ projectId: 'wrong', deploymentId: 'dpl_serving' }) }), /not bound/);
 await assert.rejects(resolveBaseline({ project: pointedCanceled, config: cfg, readDeployment: async () => canceled, readAlias: async () => ({ projectId: 'prj_test', deploymentId: null }) }), /no deployment/);
 await assert.rejects(resolveBaseline({ project: pointedCanceled, config: cfg, readDeployment: async () => canceled, readAlias: async () => ({ projectId: 'prj_test', deploymentId: 'dpl_serving' }) }), /not READY/);
 await assert.rejects(resolveBaseline({ project: pointedCanceled, config: cfg, readDeployment: async id => id === 'dpl_canceled' ? canceled : { ...ready, projectId: 'wrong' }, readAlias: async () => ({ projectId: 'prj_test', deploymentId: 'dpl_serving' }) }), /Wrong serving/);
});
test('receipt verifies project/target/sha/READY/url, not CLI exit code', () => {
 assert.equal(assertReceipt(baseline,config,A),'https://test.vercel.app');
 for (const d of [{...baseline,projectId:'wrong'},{...baseline,target:'preview'},{...baseline,readyState:'BUILDING'},{...baseline,url:'test.vercel.app.evil.test'},{...baseline,gitSource:{sha:B}}]) assert.throws(() => assertReceipt(d,config,A));
});
test('provider errors fail closed without echoing body or credentials',async () => {
 await assert.rejects(request('https://test.invalid','fixture',async()=>({ok:false,status:403})),/HTTP 403/);
 assert.deepEqual(await request('https://test.invalid','fixture',async()=>({ok:true,json:async()=>({ok:true})})),{ok:true});
});

test('validate all rows even after an active entry, including project and baseline time', () => {
 assert.throws(() => decide({ deployments: [{...old,readyState:'BUILDING'}, {...old,projectId:'wrong'}] }));
 assert.throws(() => decide({ deployments: [] }));
 assert.throws(() => decide({ baseline: {...baseline,created: undefined} }));
 assert.equal(decide({ baseline: {...baseline,created: now-1} }).deploy,false);
 assert.throws(() => assertCi([],[],B));
});

// Exercise the real entrypoint with a temporary git repo and deterministic GETs.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
test('entrypoint reconciles skipped site changes behind docs, rechecks and verifies receipt', () => {
 const dir = mkdtempSync(join(tmpdir(),'vercel-catch-up-'));
 const runGit = (...args) => execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
 try {
  mkdirSync(join(dir,'scripts/deploy'),{recursive:true});
  mkdirSync(join(dir,'site'));
  copyFileSync(new URL('./vercel-catch-up.mjs',import.meta.url),join(dir,'scripts/deploy/vercel-catch-up.mjs'));
  writeFileSync(join(dir,'scripts/deploy/vercel-config.json'),JSON.stringify({...config,repository:'owner/repo',ciWorkflows:['CI'],watch:['site/**']}));
  runGit('init','-q');runGit('config','user.email','test@localhost');runGit('config','user.name','Fixture');
  writeFileSync(join(dir,'site/index.html'),'old');runGit('add','.');runGit('commit','-qm','baseline');const first=runGit('rev-parse','HEAD');
  writeFileSync(join(dir,'site/index.html'),'new');runGit('add','.');runGit('commit','-qm','site change skipped inside window');
  writeFileSync(join(dir,'README.md'),'docs');runGit('add','.');runGit('commit','-qm','later docs');const latest=runGit('rev-parse','HEAD');
  const fixture={project:{...project,targets:{production:{id:'dpl_fixture'}}},baseline:{...baseline,gitSource:{sha:first},created:Date.now()-COOLDOWN_MS-60_000},history:{deployments:[{...old,created:Date.now()-COOLDOWN_MS-60_000}],pagination:{}},head:latest,ci:{total_count:1,workflow_runs:[{id:1,name:'CI',head_sha:latest,head_branch:'main',event:'push',status:'completed',conclusion:'success'}]}};
  const fixtureFile=join(dir,'fixture.json');const output=join(dir,'output');const receipt=join(dir,'receipt.json');
  writeFileSync(receipt,JSON.stringify({status:'ok',deployment:{id:'dpl_fixture'}}));
  writeFileSync(join(dir,'mock.mjs'),`import {readFileSync} from 'node:fs';const f=JSON.parse(readFileSync(process.env.FIXTURE));globalThis.fetch=async(url,options)=>{if(options.method && options.method!=='GET')throw new Error('write forbidden');const u=new URL(url);let body;if(u.pathname.endsWith('/git/ref/heads/main'))body={object:{sha:f.head}};else if(u.pathname.endsWith('/actions/runs'))body=f.ci;else if(u.pathname.startsWith('/v9/projects/'))body=f.project;else if(u.pathname.startsWith('/v13/deployments/'))body=(f.byId||{})[u.pathname.split('/')[3]]||f.baseline;else if(u.pathname.startsWith('/v4/aliases/'))body=f.alias;else if(u.pathname==='/v7/deployments')body=f.history;else throw new Error('unexpected URL');return {ok:true,json:async()=>body}};`);
  const execute=(...args)=>{writeFileSync(fixtureFile,JSON.stringify(fixture));writeFileSync(output,'');return spawnSync(process.execPath,['--import',join(dir,'mock.mjs'),'scripts/deploy/vercel-catch-up.mjs',...args],{cwd:dir,encoding:'utf8',env:{...process.env,GITHUB_REPOSITORY:'owner/repo',GH_TOKEN:'fixture',VERCEL_TOKEN:'fixture',FIXTURE:fixtureFile,GITHUB_OUTPUT:output}});};
  let result=execute('prepare');assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(output,'utf8'),'deploy=true\n');
  fixture.head=A;result=execute();assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(output,'utf8'),'deploy=false\n');fixture.head=latest;
  fixture.ci.workflow_runs[0].conclusion='failure';result=execute();assert.equal(result.status,1);assert.match(result.stderr,/Exact-main CI/);fixture.ci.workflow_runs[0].conclusion='success';
  fixture.ci.workflow_runs[0].status='in_progress';fixture.ci.workflow_runs[0].conclusion=null;result=execute();assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(output,'utf8'),'deploy=false\n');assert.match(result.stdout,/CI still running: CI/);fixture.ci.workflow_runs[0].status='completed';fixture.ci.workflow_runs[0].conclusion='success';
  fixture.ci.workflow_runs=[];result=execute();assert.equal(result.status,1);assert.match(result.stderr,/Exact-main CI/);fixture.ci.workflow_runs=[{id:1,name:'CI',head_sha:latest,head_branch:'main',event:'push',status:'completed',conclusion:'success'}];
  fixture.history.pagination.next=1;fixture.history.deployments[0].created=Date.now()-1;result=execute();assert.equal(result.status,1);assert.match(result.stderr,/history truncated/);fixture.history.pagination={};fixture.history.deployments[0].created=Date.now()-COOLDOWN_MS-60_000;
  writeFileSync(join(dir,'scripts/deploy/vercel-config.json'),JSON.stringify({...config,productionAlias:'site.example.test',repository:'owner/repo',ciWorkflows:['CI'],watch:['site/**']}));
  fixture.byId={'dpl_canceled':{projectId:'prj_test',target:'production',readyState:'CANCELED',created:Date.now()-1000,gitSource:{sha:first}},'dpl_serving':{...baseline,gitSource:{sha:first},created:Date.now()-COOLDOWN_MS-60_000}};
  fixture.project.targets.production.id='dpl_canceled';
  fixture.alias={projectId:'prj_test',deploymentId:'dpl_serving'};
  result=execute('prepare');assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(output,'utf8'),'deploy=true\n');assert.match(result.stdout,/via alias/);
  delete fixture.byId;delete fixture.alias;fixture.project.targets.production.id='dpl_fixture';
  fixture.baseline.gitSource.sha=latest;result=execute('receipt',receipt);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/https:\/\/test.vercel.app/);
  fixture.project.targets.production.id='dpl_other';result=execute('receipt',receipt);assert.equal(result.status,1);assert.match(result.stderr,/current production target/);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
