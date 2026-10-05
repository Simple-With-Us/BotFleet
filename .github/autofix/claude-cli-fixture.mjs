import assert from 'node:assert/strict';
import {generate, MODEL} from './kody-pilot.mjs';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'kody-cli-fixture-'));
const outputPath = join(dir, 'answer.json');
// This fixture never reads a real provider credential.  All upstream requests are
// intercepted in memory; the placeholder is deliberately not an API key.
let calls=0;
const data={findings:[{path:'server/a.ts',line:1,body:'Change n to 2.'}],files:[{path:'server/a.ts',content:'const n = 1;\n'}]};
try {
await generate(data,outputPath,{PATH:process.env.PATH,DEEPSEEK_API_KEY:'synthetic-local-only'},async(url,options)=>{
  calls++;const request=JSON.parse(options.body);
  assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(request.model, MODEL);
  assert.deepEqual((request.tools ?? []).map(tool => tool.name), ['StructuredOutput']);
  console.log('Mock request',calls,'model',request.model,'tools',(request.tools??[]).map(t=>t.name),'stream',request.stream);
  const output={id:'msg_fixture',type:'message',role:'assistant',model:MODEL,content:[{type:'tool_use',id:'toolu_fixture',name:'StructuredOutput',input:{edits:[{path:'server/a.ts',old_text:'const n = 1;',new_text:'const n = 2;'}]}}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:100,output_tokens:100}};
  if(!request.stream)return new Response(JSON.stringify(output),{headers:{'content-type':'application/json'}});
  const events=[['message_start',{type:'message_start',message:{...output,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_fixture',name:'StructuredOutput',input:{}}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(output.content[0].input)}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:100}}],
    ['message_stop',{type:'message_stop'}]];
  return new Response(events.map(([name,data])=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
});
assert.deepEqual(JSON.parse(await readFile(outputPath,'utf8')), {edits:[{path:'server/a.ts',old_text:'const n = 1;',new_text:'const n = 2;'}]});
console.log('PASS: pinned real CLI accepted the synthetic schema result in',calls,'request(s).');

} finally { await rm(dir, {recursive:true, force:true}); }
