import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createReceipt, validateReceipt } from './sentry-testflight-receipt.mjs';
import { reportTestFlight } from './sentry-report-testflight.mjs';
const sha = 'a'.repeat(40);
const fixture = () => ({ archive: { bundleId:'app.botfleet.ios', marketingVersion:'1.0.79', buildNumber:'202610060212' },
  readiness:{ok:true,version:'202610060212',buildId:'asc-build-123',internalBuildState:'IN_BETA_TESTING'},
  sourceCommit:sha,expectedCommit:sha,bundleId:'app.botfleet.ios',marketingVersion:'1.0.79',buildNumber:'202610060212',now:new Date('2026-10-06T02:30:00.000Z') });
const receipt = () => createReceipt(fixture());
const root = new URL('../', import.meta.url);
// Git checks shell sources out with CRLF on Windows.  Extract the same shell
// functions on every host instead of accidentally including the script tail.
const read = path => readFileSync(new URL(path,root),'utf8').replace(/\r\n/g,'\n');
const shellPath = path => path.replaceAll('\\', '/');

test('receipt matches Cocoa SDK identity and exact archive, source, ASC build', () => {
  assert.equal(receipt().release, 'app.botfleet.ios@1.0.79+202610060212');
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
  for (const change of [{bundleId:'app.botfleet'},{release:sha},{sourceCommit:'main'},
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
  assert.deepEqual(api.calls[1].body.refs,[{repository:'Simple-With-Us/BotFleet',commit:sha}]);
  assert.equal(api.calls[1].body.version,receipt().release);
  assert.match(api.calls[0].url,/app.botfleet.ios%401.0.79%2B202610060212/);
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

// A stale repository name is not a syntax error: Sentry accepts the request and
// rejects the whole write with HTTP 400 {"refs":["Invalid repository names: ..."]},
// which turned every main push red while the TestFlight upload itself succeeded.
// Pin the one name Sentry has registered, and pin the single-constant shape, so a
// future transfer cannot reintroduce a second spelling behind a stale comment.
test('refs carry exactly the repository name Sentry has registered, with no second spelling', async () => {
  const api=fakeAPI();
  await reportTestFlight(receipt(), {token:'fixture-value',runId:'123',fetchImpl:api.fetchImpl});
  const refs=api.calls[1].body.refs;
  assert.equal(refs.length,1);
  assert.equal(refs[0].repository,'Simple-With-Us/BotFleet');
  assert.ok(!/jaywedgeworth22\//.test(JSON.stringify(api.calls[1].body)),'no pre-transfer repository name may reach Sentry');
  const source=read('scripts/sentry-report-testflight.mjs');
  assert.ok(!source.includes('SENTRY_REPOSITORY'),'a second repository constant is how the two names drifted apart');
});

// Discarding the response body is what cost three fixes: each cleared one layer
// and the same bare "HTTP 400" hid the next.  Sentry's own validation error must
// be visible -- but a non-JSON body (gateway page, proxy string) is the shape
// that can echo something sensitive, so it stays suppressed.
test('a failed write reports the JSON reason Sentry gave, with credentials scrubbed', async () => {
  const token='sntr_fixture_token_value';
  const jsonFailure=async (url,options)=>{
    if (options.method==='GET'&&url.endsWith('/deploys/')) return Response.json([]);
    if (options.method==='GET') return Response.json({ref:null,projects:[{slug:'botfleet'}]});
    return new Response(JSON.stringify({refs:[`Invalid repository names: ${token}`],detail:`token ${token}`}),
      {status:400,headers:{'Content-Type':'application/json'}});
  };
  await assert.rejects(
    reportTestFlight(receipt(),{token,runId:'123',fetchImpl:jsonFailure}),
    error=>/HTTP 400/.test(error.message)
      &&/Invalid repository names/.test(error.message)
      &&!error.message.includes(token),
  );

  const opaqueBody='<html>upstream failed for token '+token+'</html>';
  const opaqueFailure=async (url,options)=>{
    if (options.method==='GET'&&url.endsWith('/deploys/')) return Response.json([]);
    if (options.method==='GET') return Response.json({ref:null,projects:[{slug:'botfleet'}]});
    return new Response(opaqueBody,{status:400});
  };
  await assert.rejects(
    reportTestFlight(receipt(),{token,runId:'123',fetchImpl:opaqueFailure}),
    error=>/HTTP 400/.test(error.message)
      &&!error.message.includes(token)
      &&!error.message.includes('upstream failed'),
  );

  // A JSON array (or scalar) body is not the object shape Sentry documents:
  // the plain-object gate must keep it out of the error the same way (Kody
  // review, PR #1252) - nothing fails today if the schema weakens to z.unknown().
  const arrayFailure=async (url,options)=>{
    if (options.method==='GET'&&url.endsWith('/deploys/')) return Response.json([]);
    if (options.method==='GET') return Response.json({ref:null,projects:[{slug:'botfleet'}]});
    return new Response(JSON.stringify([`Invalid repository names: ${token}`]),
      {status:400,headers:{'Content-Type':'application/json'}});
  };
  await assert.rejects(
    reportTestFlight(receipt(),{token,runId:'123',fetchImpl:arrayFailure}),
    error=>/HTTP 400/.test(error.message)
      &&!error.message.includes(token)
      &&!/Invalid repository names/.test(error.message),
  );
});

test('ship receipt follows recorded success only after exact ASC readiness; skipped states produce none', () => {
  const source=read('scripts/ios-fleet/ship-testflight.sh');
  const ensure=source.slice(source.indexOf('TF_READY_CONFIRMED=0'),source.indexOf('SENTRY_ARCHIVE_COMMIT="$(repo_head_sha)"'));
  const emit=source.slice(source.indexOf('emit_sentry_deployment_receipt() {'),source.indexOf('\nacquire_archive_lock\nlog "archiving..."'));
  const dir=mkdtempSync(join(tmpdir(),'sentry-testflight-'));
  try {
    for (const [status, receiptStatus] of [[0,0],[0,1],[2,0],[3,0],[4,0]]) {
      const out=join(dir,`out-${status}-${receiptStatus}`); writeFileSync(out,'');
      const script=`set -euo pipefail\nlog(){ :; }\nnode(){ if [[ "$1" == *asc-api.mjs ]]; then printf '{"ok":true}'; return ${status}; elif [[ ${receiptStatus} == 1 ]]; then return 1; else echo emitted >> "$GITHUB_OUTPUT"; fi; }\n${ensure}\n${emit}\nensure_tf_ready\nemit_sentry_deployment_receipt\n`;
      const scriptFile=join(dir,'fixture.sh'); writeFileSync(scriptFile,script);
      const result=spawnSync('bash',[shellPath(scriptFile)],{env:{PATH:process.env.PATH,APP_KEY:'botfleet',GITHUB_OUTPUT:shellPath(out),BUNDLE_ID:'app.botfleet.ios',BUILD_NUM:'202610060212',MARKETING:'1.0.79',REPO_ROOT:shellPath(dir),PREV_SHIP_SHA:sha,DISPLAY_NAME:'BotFleet',IOS_PATH_PREFIX:'ios',FLEET_DIR:shellPath(dir),LOG_DIR:shellPath(dir),ARCHIVE_PATH:shellPath(dir),SENTRY_ARCHIVE_COMMIT:sha},encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      assert.equal(readFileSync(out,'utf8'),status!==0?'':receiptStatus===0?'emitted\n':'sentry_receipt_error=true\n');
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
  assert.equal((source.match(/record_successful_ship\n\s*emit_sentry_deployment_receipt/g)||[]).length,2);
  assert.equal((source.match(/TF_READY_CONFIRMED=1/g)||[]).length,1);
  const workflow=read('.github/workflows/sentry-testflight.yml');
  assert.match(workflow,/workflow_call:/); assert.doesNotMatch(workflow,/workflow_run:|workflow_dispatch:|continue-on-error|exit 0/);
  assert.match(workflow,/required: SENTRY_AUTH_TOKEN/);
  // The root postinstall needs esbuild (a devDependency), so a bare `--prod` install exits 1 and
  // turns every successful upload red.  Pin the flag so a dependency bump cannot bring it back.
  assert.match(workflow,/run: pnpm install --frozen-lockfile --prod --ignore-scripts\n/);
  assert.match(workflow,/receipt.sourceCommit !== process.env.GITHUB_SHA/);
  assert.match(workflow,/SENTRY_RECEIPT_ERROR === "true"\) throw new Error/);
  const ship=read('.github/workflows/ios-ship.yml');
  assert.match(ship,/needs.ship.outputs.sentry_receipt != ''/);
  assert.match(ship,/needs.ship.outputs.sentry_receipt_error == 'true'/);
  assert.match(ship,/uses: .\/.github\/workflows\/sentry-testflight.yml/);
  // The reporter is part of the ship, so an edit to any of its files must run the ship (the only way to exercise it).
  const shipPaths=ship.slice(ship.indexOf('paths:'),ship.indexOf('workflow_dispatch:'));
  for (const file of ['.github/workflows/sentry-testflight.yml','scripts/sentry-report-testflight.mjs','scripts/sentry-testflight-receipt.mjs']) {
    assert.ok(shipPaths.includes(`- '${file}'`),`${file} must be in the ship push paths`);
  }
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

test('a release the ship already created (ref and url null) is updated, then the deploy is recorded', async () => {
  // The ship's sentry-cli upload creates the release before this reporter runs, and Sentry
  // reports its unset fields as null (live shape probed for app.botfleet.ios@1.0.114+202610180148).
  const calls=[];
  const result=await reportTestFlight(receipt(),{token:'fixture-value',runId:'123',fetchImpl:async (url,options)=>{
    const deploys=String(url).includes('/deploys/');
    calls.push(`${options.method}${deploys?' deploys':' release'}`);
    if (options.method==='GET') return deploys?Response.json([{id:'9',environment:'staging',name:null}]):Response.json({ref:null,url:null,dateReleased:null,projects:[{slug:'botfleet'}]});
    if (options.method==='PUT') return Response.json({});
    return Response.json({id:'10',environment:'production',name:'ios-testflight:202610060212'});
  }});
  assert.deepEqual(calls,['GET release','PUT release','GET deploys','POST deploys']);
  assert.deepEqual(result,{release:'app.botfleet.ios@1.0.79+202610060212',deployId:'10',alreadyRecorded:false});
});

test('CLI malformed JSON error does not echo provided input or token', () => {
  const secret=['synthetic','private','fixture'].join('-');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./sentry-report-testflight.mjs',import.meta.url))],{
    env:{PATH:process.env.PATH,SENTRY_DEPLOY_RECEIPT:`{${secret}`,SENTRY_AUTH_TOKEN:secret,GITHUB_RUN_ID:'123'},encoding:'utf8'});
  assert.equal(result.status,1); assert.match(result.stderr,/Invalid TestFlight receipt JSON/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});

test('a confirmed upload survives receipt failure and the same source is not uploaded again', () => {
  const source=read('scripts/ios-fleet/ship-testflight.sh');
  const stateFunctions=source.slice(source.indexOf('ship_state_path() {'),source.indexOf('\nwhile [[ $# -gt 0 ]]'));
  const ensure=source.slice(source.indexOf('TF_READY_CONFIRMED=0'),source.indexOf('SENTRY_ARCHIVE_COMMIT="$(repo_head_sha)"'));
  const emit=source.slice(source.indexOf('emit_sentry_deployment_receipt() {'),source.indexOf('\nacquire_archive_lock\nlog "archiving..."'));
  const dir=mkdtempSync(join(tmpdir(),'sentry-ship-state-'));
  const out=join(dir,'outputs'); writeFileSync(out,'');
  try {
    // Only local fixture builtins replace time/permissions/publication; the
    // production state writer, duplicate-upload gate, and receipt guard run.
    const script=`set -euo pipefail\nlog(){ :; }\njson_get(){ :; }\ndate(){ echo 1791280000; }\nmkdir(){ :; }\nchmod(){ :; }\nbash(){ return 1; }\n${stateFunctions}\nrepo_head_sha(){ echo ${sha}; }\nnode(){ if [[ "$1" == *asc-api.mjs ]]; then printf '{"ok":true}'; else return 1; fi; }\n${ensure}\n${emit}\nprintf uploaded > "$STATE_DIR/uploaded"\nensure_tf_ready\nrecord_successful_ship\nemit_sentry_deployment_receipt\nevaluate_ship_gate\nprintf '%s' "$SHIP_GATE_DECISION"\n`;
    // A file avoids Windows/Git Bash inline-command length and quoting limits.
    const scriptFile=join(dir,'fixture.sh'); writeFileSync(scriptFile,script);
    const result=spawnSync('bash',[shellPath(scriptFile)],{env:{PATH:process.env.PATH,APP_KEY:'botfleet',GITHUB_OUTPUT:shellPath(out),STATE_DIR:shellPath(dir),FORCE_SHIP:'0',EXPORT_ONLY:'0',DEFAULT_MIN_INTERVAL_SEC:'3600',BUNDLE_ID:'app.botfleet.ios',BUILD_NUM:'202610060212',MARKETING:'1.0.79',REPO_ROOT:shellPath(dir),PREV_SHIP_SHA:'',DISPLAY_NAME:'BotFleet',IOS_PATH_PREFIX:'ios',FLEET_DIR:shellPath(dir),LOG_DIR:shellPath(dir),ARCHIVE_PATH:shellPath(dir),SENTRY_ARCHIVE_COMMIT:sha},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,'skip');
    assert.equal(readFileSync(join(dir,'uploaded'),'utf8'),'uploaded');
    assert.match(readFileSync(join(dir,'last-ship-botfleet.txt'),'utf8'),new RegExp(`^1791280000 ${sha}\\n$`));
    assert.equal(readFileSync(out,'utf8'),'sentry_receipt_error=true\n');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('the actual reporting validation fails the explicit error indicator before credential loading', () => {
  const workflow=read('.github/workflows/sentry-testflight.yml');
  const js=workflow.match(/node --input-type=module -e '\n([\s\S]*?)\n          '/)?.[1];
  assert.ok(js);
  const result=spawnSync(process.execPath,['--input-type=module','-e',js],{
    cwd:fileURLToPath(root),env:{PATH:process.env.PATH,SENTRY_RECEIPT_ERROR:'true',GITHUB_SHA:sha},encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/upload succeeded but receipt verification failed/);
  assert.ok(workflow.indexOf('Validate the distribution receipt') < workflow.indexOf('Load the required Sentry auth token'));
});
