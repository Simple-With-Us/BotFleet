#!/usr/bin/env node
// Prepared operational wrapper. No timer is enabled by adding this file.
import {closeSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeSync} from 'node:fs';
import {dirname} from 'node:path';
import {reconcile} from './github-request-log-reconcile.mjs';

function save(path,value) {
 mkdirSync(dirname(path),{recursive:true});const tmp=path+'.tmp';const fd=openSync(tmp,'w',0o600);
 try {const b=Buffer.from(JSON.stringify(value));let n=0;while(n<b.length)n+=writeSync(fd,b,n,b.length-n);fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(tmp,path);const d=openSync(dirname(path),'r');try{fsyncSync(d);}finally{closeSync(d);}
}
export function checkStatus(state,now=Date.now(),maxAgeMs=1800000) {
 return Boolean(state?.lastSuccess && now-Date.parse(state.lastSuccess)<=maxAgeMs && state.consecutiveFailures===0);
}
export function runConfigured(config,{run=reconcile,now=()=>new Date()}={}) {
 if(!config.statusPath||!Array.isArray(config.hooks)||!config.hooks.length)throw Error('statusPath and hook configuration required');
 let old={};try{old=JSON.parse(readFileSync(config.statusPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const at=now().toISOString();const results=[];let ok=true;
 for(const hook of config.hooks) {
  try {const r=run(hook);results.push({hook:String(hook.hook),ok:r.ok,pending:r.pending});if(!r.ok)ok=false;}
  catch {ok=false;results.push({hook:String(hook.hook),ok:false,error:'reconciliation failed'});}
 }
 const state={checkedAt:at,lastSuccess:ok?at:old.lastSuccess??null,consecutiveFailures:ok?0:(old.consecutiveFailures??0)+1,results};
 save(config.statusPath,state);return {ok,state};
}
if(import.meta.url===`file://${process.argv[1]}`) {
 try {
  const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
  if(process.argv[3]==='--check-status') {
   const ok=checkStatus(JSON.parse(readFileSync(config.statusPath,'utf8')));
   if(!ok){console.error('request-log reconciliation failed or stale');process.exitCode=1;}
  } else {const r=runConfigured(config);console.log(JSON.stringify(r.state));if(!r.ok)process.exitCode=1;}
 } catch {console.error('request-log runner failed; inspect durable status/configuration');process.exitCode=1;}
}
