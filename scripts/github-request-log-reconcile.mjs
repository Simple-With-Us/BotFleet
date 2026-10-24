#!/usr/bin/env node
// Recover metadata by GET only. Never redeliver a dispatching webhook.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export function parseArgs(argv) {
  const a = {};
  for (let i=2;i<argv.length;i+=2) {
    const k=argv[i].replace(/^--/,'');
    if (!['org','repo','hook','log','cursor'].includes(k) || !argv[i+1]) throw Error('invalid arguments');
    a[k]=argv[i+1];
  }
  if (!a.hook||!a.log||!a.cursor||Boolean(a.org)===Boolean(a.repo)) throw Error('hook, log, cursor and exactly one org/repo required');
  return a;
}
function writeAll(fd,text) {
  const b=Buffer.from(text); let offset=0;
  while(offset<b.length) { const n=writeSync(fd,b,offset,b.length-offset); if(n<=0) throw Error('short write'); offset+=n; }
  fsyncSync(fd);
}
function append(path,text) {
  mkdirSync(dirname(path),{recursive:true});const fd=openSync(path,'a',0o600);
  try { writeAll(fd,text); } finally { closeSync(fd); }
}
function checkpoint(path,state) {
  mkdirSync(dirname(path),{recursive:true});const tmp=path+'.tmp';const fd=openSync(tmp,'w',0o600);
  try { writeAll(fd,JSON.stringify(state)); } finally { closeSync(fd); }
  renameSync(tmp,path);const d=openSync(dirname(path),'r');try { fsyncSync(d); } finally { closeSync(d); }
}
export function loggedDeliveryIds(path) {
  try { return new Set([...readFileSync(path,'utf8').matchAll(/\(delivery ([^)\r\n]+)\)/g)].map(m=>m[1])); }
  catch(e) { if(e.code==='ENOENT') return new Set();throw e; }
}
function clean(s,max=200) { return String(s??'').replace(/[\r\n\x00-\x1f\x7f]/g,' ').replace(/[()]/g,'').slice(0,max); }
export function extractMetadata(p) {
  const x=p&&typeof p==='object'?p:{};const m={};
  if(x.action) m.action=clean(x.action,64);
  if(x.repository?.full_name) m.repository=clean(x.repository.full_name);
  if(x.sender?.login) m.actor=clean(x.sender.login,100);
  for(const k of ['pull_request','issue','discussion']) if(Number.isSafeInteger(x[k]?.number)) { m.number=x[k].number;break; }
  return m;
}
export function formatRecoveredLine({ts,eventName,meta,deliveryId}) {
  const target=(meta.repository??'')+(meta.number!==undefined?'#'+meta.number:'');
  return `- ${ts.toISOString()} ${clean(eventName,64)}${meta.action?'.'+meta.action:''}${target?' '+target:''}${meta.actor?' by '+meta.actor:''} [recovered] via github-request-log-reconcile (delivery ${clean(deliveryId,100)})`;
}
function ghGet(path) {
  // --include exposes Link cursors; no tokens or request headers are logged.
  const raw=execFileSync('gh',['api','--include',path],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
  const split=raw.search(/\r?\n\r?\n/);if(split<0) throw Error('missing API headers');
  const headers=raw.slice(0,split);const data=JSON.parse(raw.slice(split).trim());
  const link=headers.match(/^link:\s*(.*)$/im)?.[1];const next=link?.split(',').find(x=>/rel="next"/.test(x))?.match(/<([^>]+)>/)?.[1];
  return {data,next};
}
export function reconcile(options) {
  mkdirSync(dirname(options.log), {recursive:true});
  const lock=options.log+'.lock';mkdirSync(lock,{mode:0o700});
  try {return reconcileLocked(options);} finally {rmdirSync(lock);}
}
function reconcileLocked({org,repo,hook,log,cursor,get=ghGet,now=()=>new Date(),maxPages=100}) {
  const base=org?`orgs/${org}`:`repos/${repo}`;const prefix=`${base}/hooks/${hook}/deliveries`;
  let state={version:1,through:null,pending:{},gaps:{}};
  try { state=JSON.parse(readFileSync(cursor,'utf8')); if(state.version!==1||!state.pending||!state.gaps) throw Error('invalid reconcile checkpoint'); }
  catch(e) { if(e.code!=='ENOENT') throw e; }
  const stamp=now();const seen=loggedDeliveryIds(log);const pages=[];let path=prefix+'?per_page=100';let complete=false;
  for(let page=0;page<maxPages;page++) {
    const response=get(path);if(!Array.isArray(response.data)) throw Error('invalid delivery listing');
    pages.push(...response.data);
    if(!response.next) { complete=true;break; }
    const u=new URL(response.next,'https://api.github.com/');
    if(u.origin!=='https://api.github.com'||u.pathname!=='/'+prefix) throw Error('unexpected pagination URL');
    path=u.pathname.slice(1)+u.search;
  }
  if(!complete) throw Error('delivery pagination limit: checkpoint unchanged');
  // Every retained delivery is inspected. through records successful full-list
  // coverage, not a numeric-id ordering assumption. Pending failures survive runs.
  for(const d of pages) if(!seen.has(String(d.guid))) state.pending[String(d.id)]={id:d.id,guid:d.guid,delivered_at:d.delivered_at,event:d.event};
  for(const [id,d] of Object.entries(state.pending)) if(seen.has(String(d.guid))) delete state.pending[id];
  let recovered=0;const errors=[];
  for(const [id,d] of Object.entries(state.pending)) {
    try {
      const detail=get(prefix+'/'+encodeURIComponent(id)).data;
      if(!detail.request?.payload||typeof detail.request.payload!=='object') throw Error('payload unavailable');
      const line=formatRecoveredLine({ts:new Date(d.delivered_at),eventName:detail.event??d.event,meta:extractMetadata(detail.request.payload),deliveryId:d.guid});
      append(log,line+'\n');seen.add(String(d.guid));delete state.pending[id];recovered++;
    } catch { errors.push(id); }
  }
  // A failed GET is retryable, never proof of permanent loss. Only elapsed
  // retention creates a potential-gap marker, with unknown count if history
  // no longer covers the prior successful checkpoint.
  if(state.through && stamp-new Date(state.through)>3*86400000) {
    const key=state.through;
    if(!state.gaps[key]) { append(log,`- ${stamp.toISOString()} reconcile [potential-gap] history older than 3 days; missing count unknown; since ${clean(key)}\n`);state.gaps[key]=true; }
  }
  for(const [id,d] of Object.entries(state.pending)) if(stamp-new Date(d.delivered_at)>3*86400000&&!state.gaps[id]) {
    append(log,`- ${stamp.toISOString()} reconcile [potential-gap] delivery ${clean(d.guid)} outside 3-day history; recovery unverified\n`);state.gaps[id]=true;
  }
  state.through=stamp.toISOString();checkpoint(cursor,state);
  return {scanned:pages.length,recovered,pending:Object.keys(state.pending).length,ok:errors.length===0};
}
if(import.meta.url===`file://${process.argv[1]}`) {
  try {const r=reconcile(parseArgs(process.argv));console.log(JSON.stringify(r));if(!r.ok)process.exitCode=1;}
  catch {console.error('github-request-log reconciliation failed; checkpoint retained');process.exitCode=1;}
}
