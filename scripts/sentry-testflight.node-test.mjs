import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createReceipt, validateReceipt } from './sentry-testflight-receipt.mjs';
import { reportTestFlight } from './sentry-report-testflight.mjs';
const sha = 'a'.repeat(40);
const fixture = () => ({ archive: { bundleId:'app.botfleet', marketingVersion:'1.0.79', buildNumber:'202610060212' },
  readiness:{ok:true,version:'202610060212',buildId:'asc-build-123',internalBuildState:'IN_BETA_TESTING'},
  sourceCommit:sha,expectedCommit:sha,bundleId:'app.botfleet',marketingVersion:'1.0.79',buildNumber:'202610060212',now:new Date('2026-10-06T02:30:00.000Z') });
const receipt = () => createReceipt(fixture());
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path,root),'utf8');

test('receipt matches Cocoa SDK identity and exact archive, source, ASC build', () => {
  assert.equal(receipt().release, 'app.botfleet@1.0.79+202610060212');
  assert.equal(receipt().milestone, 'testflight-ready');
  for (const field of ['bundleId','marketingVersion','buildNumber']) {
    const f = fixture(); f.archive[field] = 'different'; assert.throws(() => createReceipt(f));
  }
  for (const state of ['PROCESSING','EXPIRED','FAILED','']) {
    const f=fixture(); f.readiness.internalBuildState=state; assert.throws(() => createReceipt(f));
  }
  for (const change of [{sourceCommit:'b'.repeat(40)}, {readiness:{...fixture().readiness,ok:false}},
    {readiness:{...fixture().readiness,version:'202610060211'}}]) assert.throws(() => createReceipt({...fixture(),...change}));
  assert.doesNotThrow(() => createReceipt({...fixture(),readiness:{...fixture().readiness,internalBuildState:'READY_FOR_BETA_TESTING'}}));
});

test('receipt rejects wrong app, forged release, SHA and output injection', () => {
  for (const change of [{bundleId:'app.botfleet.ios'},{release:sha},{sourceCommit:'main'},
    {ascBuildId:'x\nsentry_receipt=oops'}, {buildNumber:'1\n'}, {confirmedAt:'not-a-date'}, {schema:2}]) {
    assert.throws(() => validateReceipt({...receipt(),...change}));
  }
});

function fakeAPI({exists=false, duplicate=false, failAt=0, failStatus=403, ref=sha}={}) {
  const calls=[];
  const fetchImpl=async (url,options) => {
    calls.push({url,...options,body:options.body?JSON.parse(options.body):undefined});
    if (calls.length===failAt) return new Response('secret response never printed',{status:failStatus});
    let result;
    if (options.method==='GET' && !url.endsWith('deploys/')) {
      if (!exists) return new Response('{}',{status:404});
      result={ref,projects:[{slug:'botfleet'}]};
    } else if (options.method==='GET') result=duplicate?[{id:'123',environment:'production',name:'ios-testflight:202610060212'}]:[];
    else result={id:'123'};
    return Response.json(result);
  };
  return {calls,fetchImpl};
}

test('report uses exact Cocoa release, source refs, scoped project and honest distribution name', async () => {
  const api=fakeAPI();
  const result=await reportTestFlight(receipt(), {token:'fixture-value',runId:'123',fetchImpl:api.fetchImpl});
  assert.equal(result.deployId,'123'); assert.equal(api.calls.length,4);
  assert.deepEqual(api.calls[1].body.refs,[{repository:'jaywedgeworth22/BotFleet',commit:sha}]);
  assert.equal(api.calls[1].body.version,receipt().release);
  assert.match(api.calls[0].url,/app.botfleet%401.0.79%2B202610060212/);
  assert.deepEqual(api.calls[3].body.projects,['botfleet']);
  assert.equal(api.calls[3].body.name,'ios-testflight:202610060212');
  assert.equal(api.calls[3].body.dateFinished,receipt().confirmedAt);
  for (const call of api.calls) { assert.equal(call.redirect,'error'); assert.ok(call.signal); assert.ok(call.url.startsWith('https://sentry.io/api/0/organizations/simple-with-us/releases/')); }
});

test('repeated receipt updates source metadata without duplicate deployment', async () => {
  const api=fakeAPI({exists:true,duplicate:true});
  const result=await reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:api.fetchImpl});
  assert.equal(result.alreadyRecorded,true); assert.deepEqual(api.calls.map(c=>c.method),['GET','PUT','GET']);
});

test('missing token, bad receipt, conflicting source or invalid run make no deploy', async () => {
  for (const options of [{token:''},{runId:'https://attacker.invalid'}]) {
    const api=fakeAPI(); await assert.rejects(reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:api.fetchImpl,...options})); assert.equal(api.calls.length,0);
  }
  const api=fakeAPI({exists:true,ref:'b'.repeat(40)});
  await assert.rejects(reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:api.fetchImpl}),/different source/);
  assert.equal(api.calls.length,1);
});

test('API/transport failures are loud and never retry an ambiguous write or print response', async () => {
  for (const failAt of [1,2,3,4]) {
    const api=fakeAPI({failAt});
    await assert.rejects(reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:api.fetchImpl}),error=>/HTTP 403/.test(error.message)&&!error.message.includes('secret'));
    assert.equal(api.calls.length,failAt);
  }
  await assert.rejects(reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:()=>{throw Error('secret bearer value');}}),error=>!error.message.includes('secret bearer'));
});

test('ship receipt follows recorded success only after exact ASC readiness; skipped states produce none', () => {
  const source=read('scripts/ios-fleet/ship-testflight.sh');
  const ensure=source.slice(source.indexOf('TF_READY_CONFIRMED=0'),source.indexOf('SENTRY_ARCHIVE_COMMIT="$(repo_head_sha)"'));
  const emit=source.slice(source.indexOf('emit_sentry_deployment_receipt() {'),source.indexOf('\nacquire_archive_lock\nlog "archiving..."'));
  const dir=mkdtempSync(join(tmpdir(),'sentry-testflight-'));
  try {
    for (const status of [0,2,3,4]) {
      const out=join(dir,`out-${status}`); writeFileSync(out,'');
      const script=`set -euo pipefail\nlog(){ :; }\nnode(){ if [[ "$1" == *asc-api.mjs ]]; then printf '{"ok":true}'; return ${status}; else echo emitted >> "$GITHUB_OUTPUT"; fi; }\n${ensure}\n${emit}\nensure_tf_ready\nemit_sentry_deployment_receipt\n`;
      const result=spawnSync('bash',['-c',script],{env:{PATH:process.env.PATH,APP_KEY:'botfleet',GITHUB_OUTPUT:out,BUNDLE_ID:'app.botfleet',BUILD_NUM:'202610060212',MARKETING:'1.0.79',REPO_ROOT:dir,PREV_SHIP_SHA:sha,DISPLAY_NAME:'BotFleet',IOS_PATH_PREFIX:'ios',FLEET_DIR:dir,LOG_DIR:dir,ARCHIVE_PATH:dir,SENTRY_ARCHIVE_COMMIT:sha},encoding:'utf8'});
      assert.equal(result.status,0,result.stderr); assert.equal(readFileSync(out,'utf8'),status===0?'emitted\n':'');
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
  assert.equal((source.match(/record_successful_ship\n\s*emit_sentry_deployment_receipt/g)||[]).length,2);
  assert.equal((source.match(/TF_READY_CONFIRMED=1/g)||[]).length,1);
  const workflow=read('.github/workflows/sentry-deploy.yml');
  assert.match(workflow,/workflow_call:/); assert.doesNotMatch(workflow,/workflow_run:|workflow_dispatch:|continue-on-error|exit 0/);
  assert.match(workflow,/required: SENTRY_AUTH_TOKEN/);
  assert.match(workflow,/receipt.sourceCommit !== process.env.GITHUB_SHA/);
  const ship=read('.github/workflows/ios-ship.yml');
  assert.match(ship,/needs.ship.outputs.sentry_receipt != ''/);
  assert.match(ship,/uses: .\/.github\/workflows\/sentry-deploy.yml/);
  assert.doesNotMatch(ship,/--force-ship/);
});

test('wrong-project releases and malformed API payloads cannot produce deployment writes', async () => {
  for (const payload of [{ref:sha,projects:[{slug:'another-app'}]}, {ref:sha,projects:[]}]) {
    const calls=[];
    await assert.rejects(reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:async (url,options)=>{calls.push(options.method);return Response.json(payload);}}),/does not belong/);
    assert.deepEqual(calls,['GET']);
  }
  await assert.rejects(reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:async ()=>new Response('private response not JSON')}),error=>error.message==='Sentry returned invalid JSON');
});

test('CLI malformed JSON error does not echo provided input or token', () => {
  const secret=['synthetic','private','fixture'].join('-');
  const result=spawnSync(process.execPath,[new URL('./sentry-report-testflight.mjs',import.meta.url).pathname],{
    env:{PATH:process.env.PATH,SENTRY_DEPLOY_RECEIPT:`{${secret}`,SENTRY_AUTH_TOKEN:secret,GITHUB_RUN_ID:'123'},encoding:'utf8'});
  assert.equal(result.status,1); assert.match(result.stderr,/Invalid TestFlight receipt JSON/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});
