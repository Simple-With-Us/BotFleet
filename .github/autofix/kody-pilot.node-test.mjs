import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyEdits, sourcePath, validateInput, validatePull, selectFindings, collectThreads,
  snapshot, publish, startProxy, claudeArguments, LIMITS, MODEL, KODY, fixBranch } from './kody-pilot.mjs';

const head = 'a'.repeat(40);
const input = {repository: 'Simple-With-Us/BotFleet', number: 123, head};
const env = {GITHUB_REPOSITORY: input.repository, GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', EXPECTED_HEAD: head, PR_NUMBER: '123'};
const pull = () => ({state:'open', draft:false, user:{type:'User'},
  head:{repo:{full_name:input.repository},ref:'codex/feature',sha:head},
  base:{repo:{full_name:input.repository},ref:'main'}});
const thread = (id = 1, path = 'server/example.ts') => ({id:`t${id}`,isResolved:false,isOutdated:false,diffSide:'RIGHT',path,line:1,
  comments:{nodes:[{databaseId:id,body:'Fix off by one.',url:`https://github.com/Simple-With-Us/BotFleet/pull/123#discussion_r${id}`,
    replyTo:null,commit:{oid:head},originalCommit:{oid:head},author:{__typename:'Bot',login:KODY.login,id:KODY.id}}]}});
const packageData = () => ({version:1,...input,branch:'codex/feature',tree:'b'.repeat(40),
  findings:selectFindings([thread()],head),files:[{path:'server/example.ts',content:'const n = 1;\n'}]});
const answer = () => ({edits:[{path:'server/example.ts',old_text:'const n = 1;',new_text:'const n = 2;'}]});
function fixture() {
  const writes = []; const threads = [thread()]; const pr = pull();
  const options = {exists:false,mode:'100644',truncated:false,blob:Buffer.from('const n = 1;\n'),moveOnRead:0,reads:0};
  const request = async (path, method = 'GET', body) => {
    if (method === 'POST' && path !== '/graphql') {
      writes.push({path,body});
      if (path.endsWith('/git/trees')) return {sha:'c'.repeat(40)};
      if (path.endsWith('/git/commits')) return {sha:'d'.repeat(40)};
      if (path.endsWith('/git/refs')) return {ref:body.ref};
      if (path.endsWith('/pulls')) return {number:999,html_url:'https://github.com/Simple-With-Us/BotFleet/pull/999'};
      assert.fail(`Unexpected write: ${path}`);
    }
    if (path.includes('/git/ref/heads/')) {
      if (options.exists) return {ref:'exists'};
      const e = new Error('missing');e.status=404;throw e;
    }
    if (path.endsWith('/pulls/123')) {
      options.reads++;const result=structuredClone(pr);
      if (options.moveOnRead && options.reads >= options.moveOnRead) result.head.sha='f'.repeat(40);
      return result;
    }
    if (path === '/graphql') return {data:{repository:{pullRequest:{reviewThreads:{nodes:structuredClone(threads),pageInfo:{hasNextPage:false}}}}}};
    if (path.includes('/git/commits/')) return {tree:{sha:'b'.repeat(40)}};
    if (path.includes('/git/trees/')) return {truncated:options.truncated,tree:[{path:'server/example.ts',type:'blob',mode:options.mode,size:options.blob.length,sha:'e'.repeat(40)}]};
    if (path.includes('/git/blobs/')) return {encoding:'base64',content:options.blob.toString('base64')};
    assert.fail(`Unexpected read: ${path}`);
  };
  return {request,writes,threads,pr,options};
}

test('manual trusted-main first-attempt admission is strict', () => {
  assert.deepEqual(validateInput(env),input);
  for (const [key,value] of Object.entries({GITHUB_REPOSITORY:'other/repo',GITHUB_EVENT_NAME:'pull_request_review',
    GITHUB_REF:'refs/heads/feature',GITHUB_RUN_ATTEMPT:'2',EXPECTED_HEAD:'abc',PR_NUMBER:'1; touch /tmp/pwn'})) {
    assert.throws(()=>validateInput({...env,[key]:value}),key);
  }
});
test('fork, bot, closed, draft, moved-head, other-base and fixer PRs are refused', () => {
  assert.equal(validatePull(pull(),input),'codex/feature');
  for (const mutate of [p=>p.state='closed',p=>p.draft=true,p=>p.user.type='Bot',p=>p.head.repo=null,
    p=>p.head.repo.full_name='attacker/BotFleet',p=>p.head.sha='b'.repeat(40),p=>p.base.ref='release',
    p=>p.head.ref='main',p=>p.head.ref='codex/kody-fix-pr-9-a']) {
    const p=pull();mutate(p);assert.throws(()=>validatePull(p,input));
  }
});
test('source allowlist rejects traversal, settings, hidden paths and control files', () => {
  for(const path of ['src/App.tsx','server/example.test.ts','src/lib/example.mjs']) assert(sourcePath(path),path);
  for(const path of ['../server/a.ts','/server/a.ts','server/../a.ts','server//a.ts','server/.hidden/a.ts',
    '.github/workflows/test.yml','server/config.ts','server/secret-map.ts','package.json','server/a.ts\n',
    'server\\a.ts','server/a.json']) assert(!sourcePath(path),path);
});
test('only exact current Kody root findings qualify; noneligible comments do not consume the cap', () => {
  for(const mutate of [t=>t.isResolved=true,t=>t.isOutdated=true,t=>t.comments.nodes[0].author.id='imposter',
    t=>t.comments.nodes[0].author.login='kody',t=>t.comments.nodes[0].author.__typename='User',
    t=>t.diffSide='LEFT',t=>t.comments.nodes[0].originalCommit.oid='b'.repeat(40),t=>t.comments.nodes[0].commit.oid='b'.repeat(40),t=>t.comments.nodes[0].replyTo={id:'reply'},
    t=>t.path='.github/workflows/ci.yml',t=>t.line=null]) {
    const t=thread();mutate(t);assert.deepEqual(selectFindings([t],head),[]);
  }
  assert.equal(selectFindings([thread()],head).length,1);
  assert.equal(selectFindings(Array.from({length:20},(_,i)=>thread(i)),head).length,LIMITS.findings);
  assert.equal(new Set(selectFindings(Array.from({length:20},(_,i)=>thread(i,`src/a${i}.ts`)),head).map(f=>f.path)).size,LIMITS.files);
});
test('review threads paginate beyond the first hundred and reject repeated cursors', async () => {
  const cursors=[];
  const all=await collectThreads(async (_q,variables)=>{
    cursors.push(variables.cursor);return {repository:{pullRequest:{reviewThreads:{
      nodes:[thread(cursors.length)],pageInfo:{hasNextPage:cursors.length===1,endCursor:'next'}}}}};
  },'Simple-With-Us','BotFleet',123);
  assert.equal(all.length,2);assert.deepEqual(cursors,[null,'next']);
  await assert.rejects(collectThreads(async()=>({repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'same'}}}}}),
    'Simple-With-Us','BotFleet',123),/pagination/);
});
test('snapshot rejects symlinks, gitlinks, executable files, truncation, binary and invalid UTF-8', async () => {
  for(const mode of ['120000','160000','100755']) {
    const f=fixture();f.options.mode=mode;await assert.rejects(snapshot(f.request,input),/ordinary/);
  }
  const truncated=fixture();truncated.options.truncated=true;await assert.rejects(snapshot(truncated.request,input),/Incomplete/);
  for(const blob of [Buffer.from([0,65]),Buffer.from([0xff]),Buffer.alloc(LIMITS.fileBytes+1,65)]) {
    const f=fixture();f.options.blob=blob;await assert.rejects(snapshot(f.request,input));
  }
});
test('literal replacement, scoped file, unique match and size bounds', () => {
  assert.deepEqual(applyEdits(packageData(),answer()),[{path:'server/example.ts',content:'const n = 2;\n'}]);
  const literal=answer();literal.edits[0].new_text='$&';
  assert.equal(applyEdits(packageData(),literal)[0].content,'$&\n');
  for(const mutate of [a=>a.extra='bad',a=>a.edits=[],a=>a.edits[0].path='server/other.ts',
    a=>a.edits[0].old_text='',a=>a.edits[0].old_text='not found',a=>a.edits[0].new_text='\0',
    a=>a.edits[0].new_text='x'.repeat(LIMITS.replacementBytes),a=>a.edits[0].command='bad']) {
    const a=answer();mutate(a);assert.throws(()=>applyEdits(packageData(),a));
  }
  const duplicate=packageData();duplicate.files[0].content+='const n = 1;\n';
  assert.throws(()=>applyEdits(duplicate,answer()),/exactly once/);
});
test('edits cannot overlap or reach unrelated distant code', () => {
  const a=answer();a.edits.push({...a.edits[0]});assert.throws(()=>applyEdits(packageData(),a),/Overlapping/);
  const data=packageData();data.files[0].content='\n'.repeat(99)+data.files[0].content;
  assert.throws(()=>applyEdits(data,answer()),/neighborhood/);
});
test('publication only creates a new branch and draft against unchanged source', async () => {
  const f=fixture();const data=await snapshot(f.request,input);const result=await publish(f.request,data,answer(),input);
  assert.equal(result.number,999);assert.equal(f.writes.length,4);
  assert.equal(f.writes[1].body.parents[0],head);
  assert.equal(f.writes[2].body.ref,`refs/heads/${fixBranch(input)}`);
  assert.equal(f.writes[3].body.draft,true);assert.equal(f.writes[3].body.base,'codex/feature');
  assert(!f.writes.some(w=>/merge|resolve|dispatch/.test(w.path)));
});
test('existing proposal, modified/resolved findings and moved head prevent publication', async () => {
  for(const mutate of [f=>f.options.exists=true,f=>f.threads[0].isResolved=true,
    f=>f.threads[0].comments.nodes[0].body='New finding text',f=>f.pr.head.sha='b'.repeat(40)]) {
    const f=fixture();const data=await snapshot(f.request,input);mutate(f);
    await assert.rejects(publish(f.request,data,answer(),input));assert.equal(f.writes.length,0);
  }
});
test('late concurrent push is caught before ref creation', async () => {
  const f=fixture();const data=await snapshot(f.request,input);f.options.moveOnRead=3;
  await assert.rejects(publish(f.request,data,answer(),input),/head moved/);
  assert.deepEqual(f.writes.map(w=>w.path.split('/').pop()),['trees','commits']);
});
test('proxy enforces fixed provider, request count, route, model, output cap and redirect policy without paid calls', async () => {
  const calls=[];const proxy=await startProxy('fixture-only',async(url,options)=>{
    calls.push({url,options});return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});
  });
  try {
    const call=(path='/v1/messages',body={model:MODEL,max_tokens:100_000})=>fetch(proxy.url+path,{method:'POST',body:JSON.stringify(body)});
    assert.equal((await call('/evil')).status,400);
    assert.equal((await call('/v1/messages',{model:'other'})).status,429);
    for(let i=0;i<LIMITS.requests;i++)assert.equal((await call()).status,200);
    assert.equal((await call()).status,429);assert.equal(calls.length,LIMITS.requests);
    for(const c of calls){assert.equal(c.url,'https://api.deepseek.com/anthropic/v1/messages');
      assert.equal(c.options.redirect,'error');assert.equal(c.options.headers['x-api-key'],'fixture-only');
      assert.equal(JSON.parse(c.options.body).max_tokens,LIMITS.outputTokens);}
  } finally {await proxy.close();}
});
test('CLI has no code tools, hooks, settings, MCP or session persistence', () => {
  const args=claudeArguments();assert(args.includes('--bare'));
  assert.equal(args[args.indexOf('--tools')+1],'');assert.equal(args[args.indexOf('--setting-sources')+1],'');
  assert(args.includes('--strict-mcp-config'));assert(args.includes('--no-session-persistence'));
  assert(!args.includes('--dangerously-skip-permissions'));assert(args.includes('--max-budget-usd'));
});
test('workflow is manual, disabled by default, pinned, split privilege and protected environment', async () => {
  const yaml=await readFile(new URL('../workflows/kody-autofix-pilot.yml',import.meta.url),'utf8');
  assert(yaml.includes('workflow_dispatch:'));assert(!/^  (pull_request|pull_request_target|pull_request_review|issue_comment|push):/m.test(yaml));
  assert(yaml.includes("vars.BOTFLEET_KODY_FIX_PILOT_ENABLED == 'true'"));
  assert(yaml.includes('environment: kody-autofix-pilot'));assert(yaml.includes('secrets.KODY_DEEPSEEK_API_KEY'));
  assert(!yaml.includes('secrets.GH_PAT'));assert(!yaml.includes('id-token:'));assert(!yaml.includes('actions: write'));
  assert.equal((yaml.match(/persist-credentials: false/g)??[]).length,3);
  for(const action of yaml.matchAll(/uses: (\S+)/g))assert.match(action[1],/@[a-f0-9]{40}$/);
  const gen=yaml.split('  generate:')[1].split('  publish:')[0];assert(!gen.includes('GH_TOKEN:'));assert(!gen.includes('contents: write'));
});

test('overlapping occurrences of old_text are ambiguous', () => {
  const data=packageData();data.files[0].content='===';const a=answer();a.edits[0].old_text='==';
  assert.throws(()=>applyEdits(data,a),/exactly once/);
});

test('malformed branch refs fail validation before string-method use', () => {
  for(const value of [null,undefined,123,{}]) {const p=pull();p.head.ref=value;
    assert.throws(()=>validatePull(p,input),/Malformed source branch ref/);}
});
test('credential, payment, permission and quota refusals stop upstream retries without key disclosure', async () => {
  for(const status of [401,402,403,429]) {
    let calls=0;const events=[];
    const proxy=await startProxy('not-a-real-secret',async()=>{calls++;return new Response('sensitive upstream body',{status});},event=>events.push(event));
    try {
      const call=()=>fetch(proxy.url+'/v1/messages',{method:'POST',body:JSON.stringify({model:MODEL,max_tokens:100})});
      assert.equal((await call()).status,status);assert.equal((await call()).status,status);
      assert.equal(calls,1);assert.deepEqual(events,[JSON.stringify({event:'kody_pilot.provider_rejected',keyRef:'KODY_DEEPSEEK_API_KEY',status})]);
    } finally {await proxy.close();}
  }
});
test('model scratch home is removed after CLI startup failure and no provider call occurs', async () => {
  const {generate}=await import('./kody-pilot.mjs');
  const {readdir}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const before=new Set((await readdir(tmpdir())).filter(name=>name.startsWith('kody-pilot-')));
  let calls=0;
  await assert.rejects(generate(packageData(),'/unused-output.json',{PATH:'/nonexistent-kody-fixture',DEEPSEEK_API_KEY:'fixture-only'},
    async()=>{calls++;assert.fail('No upstream request is permitted.');}),/failed to start/);
  assert.equal(calls,0);
  const after=(await readdir(tmpdir())).filter(name=>name.startsWith('kody-pilot-')&&!before.has(name));
  assert.deepEqual(after,[]);
});
test('top-level failures log a stable message without raw input', async () => {
  const {spawnSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const script=new URL('./kody-pilot.mjs',import.meta.url);
  const result=spawnSync(process.execPath,[fileURLToPath(script),'prepare'],{encoding:'utf8',env:{...env,GITHUB_REPOSITORY:'private-input-marker'}});
  assert.equal(result.status,1);
  assert.equal(result.stderr.trim(),'Kody pilot failed closed.  Inspect the failed step and runbook; raw errors are not logged.');
  assert(!result.stderr.includes('private-input-marker'));
});
