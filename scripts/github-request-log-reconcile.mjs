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
function clean(s,max=200) { return Array.from(String(s??''),c=>c.charCodeAt(0)<=31||c.charCodeAt(0)===127||c.charCodeAt(0)===133||c.charCodeAt(0)===8232||c.charCodeAt(0)===8233?' ':c).join('').replace(/[()]/g,'').slice(0,max); }
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- external JSON text fields are accepted only as strings in this dependency-free CLI.
function text(value) { return typeof value==='string'?value:undefined; }
function sourceUrl(value) {
  if (!text(value)) return undefined;
  try {
    const url=new URL(value);
    if(url.origin!=='https://github.com'||url.username||url.password||url.search) return undefined;
    if(!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull|discussions)\/[0-9]+(?:\/files)?$/.test(url.pathname))return undefined;
    if(url.hash&&!/^#(?:issuecomment-|discussion_r|pullrequestreview-|discussioncomment-)[0-9]+$/.test(url.hash))return undefined;
    return url.href;
  }catch{return undefined;}
}
export function extractMetadata(p) {
  // External JSON boundary: reject primitive payloads before metadata field reads.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON payloads are untyped in this dependency-free CLI.
  const x=p&&typeof p==='object'?p:{};const m={};
  if(text(x.action)) m.action=clean(x.action,64);
  if(text(x.repository?.full_name)) m.repository=clean(x.repository.full_name);
  if(text(x.sender?.login)) m.actor=clean(x.sender.login,100);
  for(const k of ['pull_request','issue','discussion']) if(Number.isSafeInteger(x[k]?.number)) { m.number=x[k].number;break; }
  const link=sourceUrl(x.comment?.html_url??x.review?.html_url);if(link)m.sourceUrl=link;
  return m;
}
export function formatRecoveredLine({ts,eventName,meta,deliveryId}) {
  const target=(meta.repository??'')+(meta.number!==undefined?'#'+meta.number:'');
  return `- ${ts.toISOString()} ${clean(eventName,64)}${meta.action?'.'+meta.action:''}${target?' '+target:''}${meta.actor?' by '+meta.actor:''} [recovered] via github-request-log-reconcile${sourceUrl(meta.sourceUrl)?' source '+sourceUrl(meta.sourceUrl):''} (delivery ${clean(deliveryId,100)})`;
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
  const lock=options.cursor+'.lock';mkdirSync(lock,{mode:0o700});
  try {return reconcileLocked(options);} finally {rmdirSync(lock);}
}
function reconcileLocked({org,repo,hook,log,cursor,get=ghGet,now=()=>new Date(),maxPages=100}) {
  const base=org?`orgs/${org}`:`repos/${repo}`;const prefix=`${base}/hooks/${hook}/deliveries`;
  let state={version:1,through:null,pending:{},gaps:{}};
  try { state=JSON.parse(readFileSync(cursor,'utf8')); if(state.version!==1||!state.pending||!state.gaps) throw Error('invalid reconcile checkpoint'); }
  catch(e) { if(e.code!=='ENOENT') throw e; }
  const stamp=now();const pages=[];
  const snapshotLock=log+'.lock';mkdirSync(snapshotLock,{mode:0o700});
  let snapshot;
  try {snapshot=loggedDeliveryIds(log);} finally {rmdirSync(snapshotLock);}
  let path=prefix+'?per_page=100';let complete=false;
  for(let page=0;page<maxPages;page++) {
    const response=get(path);if(!Array.isArray(response.data)) throw Error('invalid delivery listing');
    pages.push(...response.data);
    if(!response.next) { complete=true;break; }
    const u=new URL(response.next,'https://api.github.com/');
    if(u.origin!=='https://api.github.com'||u.pathname!=='/'+prefix) throw Error('unexpected pagination URL');
    path=u.pathname.slice(1)+u.search;
  }
  if(!complete) throw Error('delivery pagination limit: checkpoint unchanged');
  const details=new Map();
  // Every retained delivery is inspected. through records successful full-list
  // coverage, not a numeric-id ordering assumption. Pending failures survive runs.
  for(const d of pages) if(!state.gaps[String(d.id)]) state.pending[String(d.id)]={id:d.id,guid:d.guid,delivered_at:d.delivered_at,event:d.event};
  for(const id of Object.keys(state.pending)) if(state.gaps[id]) delete state.pending[id];
  for(const [id,d] of Object.entries(state.pending)) if(snapshot.has(String(d.guid))) delete state.pending[id];
  const errors=[];
  for(const [id,d] of Object.entries(state.pending)) {
    try {
      const detail=get(prefix+'/'+encodeURIComponent(id)).data;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider detail must have an object payload before recovery can be claimed.
      if(!detail.request?.payload||(typeof detail.request.payload!=='object'||Array.isArray(detail.request.payload))) throw Error('payload unavailable');
      const line=formatRecoveredLine({ts:new Date(d.delivered_at),eventName:detail.event??d.event,meta:extractMetadata(detail.request.payload),deliveryId:d.guid});
      details.set(id,line);
    } catch { errors.push(id); }
  }
  // Network is complete. Re-read dedupe under the short shared commit lock;
  // another reconciler/server may have appended while GETs were in flight.
  const lock=log+'.lock';mkdirSync(lock,{mode:0o700});
  try {
  const seen=loggedDeliveryIds(log);let recovered=0;
  for(const [id,d] of Object.entries(state.pending)) {
    if(seen.has(String(d.guid))) {delete state.pending[id];continue;}
    if(details.has(id)) {append(log,details.get(id)+'\n');seen.add(String(d.guid));delete state.pending[id];recovered++;}
  }
  // A failed GET is retryable, never proof of permanent loss. Only elapsed
  // retention creates a potential-gap marker, with unknown count if history
  // no longer covers the prior successful checkpoint.
  if(state.through && stamp-new Date(state.through)>3*86400000) {
    const key=state.through;
    if(!state.gaps[key]) { append(log,`- ${stamp.toISOString()} reconcile [potential-gap] history older than 3 days; missing count unknown; since ${clean(key)}\n`);state.gaps[key]=true; }
  }
  for(const [id,d] of Object.entries(state.pending)) if(stamp-new Date(d.delivered_at)>3*86400000&&!state.gaps[id]) {
    append(log,`- ${stamp.toISOString()} reconcile [potential-gap] delivery ${clean(d.guid)} outside 3-day history; recovery unverified\n`);state.gaps[id]=true;delete state.pending[id];
  }
  state.through=stamp.toISOString();checkpoint(cursor,state);
  return {scanned:pages.length,recovered,pending:Object.keys(state.pending).length,ok:errors.every(id=>!state.pending[id])};
  } finally {rmdirSync(lock);}
}
if(import.meta.url===`file://${process.argv[1]}`) {
  try {const r=reconcile(parseArgs(process.argv));console.log(JSON.stringify(r));if(!r.ok)process.exitCode=1;}
  catch {console.error('github-request-log reconciliation failed; checkpoint retained');process.exitCode=1;}
}
