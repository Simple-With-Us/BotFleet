#!/usr/bin/env node
// Coalesce eligible main changes without treating a skipped merge as deployed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COOLDOWN_MS = 3 * 60 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const ACTIVE = new Set(['QUEUED', 'INITIALIZING', 'BUILDING']);
const STATES = new Set([...ACTIVE, 'READY', 'ERROR', 'CANCELED']);
function must(ok, message) { if (!ok) throw new Error(message); }
function object(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
export function deploymentSha(d) {
  const values = [d.gitSource?.sha, d.meta?.githubCommitSha, d.meta?.fleetCommitSha].filter(Boolean);
  must(values.length > 0 && values.every(x => SHA.test(x) && x === values[0]), 'Deployment commit missing or conflicting');
  return values[0];
}
export function assertProject(p, config) {
  must(object(p) && p.id === config.projectId, 'Wrong Vercel project');
  must((p.rootDirectory ?? '') === config.rootDirectory, 'Vercel root directory drift');
  must(p.accountId === config.teamId, 'Wrong Vercel team');
  must(p.gitProviderOptions?.createDeployments === 'disabled', 'Disable competing Git publisher before activation');
  must(p.link?.type === 'github' && String(p.link.repoId) === String(config.repoId), 'Vercel repository binding drift');
  must(p.link.productionBranch === 'main', 'Wrong production branch');
}
export function classify({ deployments, baseline, target, now, changed, projectId }) {
  must(SHA.test(target), 'Invalid target SHA');
  must(Array.isArray(deployments), 'Invalid deployment list');
  must(deployments.length > 0 && Number.isSafeInteger(now), 'Missing history or invalid clock');
  let newest = 0, active = false;
  for (const d of [...deployments, baseline]) {
    must(object(d) && d.target === 'production', 'Unexpected deployment target');
    must(d.projectId === projectId, 'Wrong deployment history project');
    const state = d.readyState ?? d.state;
    must(STATES.has(state), 'Unknown deployment state');
    const created = d.createdAt ?? d.created;
    must(Number.isSafeInteger(created) && created > 0 && created <= now, 'Invalid deployment timestamp');
    newest = Math.max(newest, created);
    active ||= ACTIVE.has(state);
  }
  must(object(baseline) && baseline.target === 'production' && (baseline.readyState ?? baseline.state) === 'READY', 'No verified current production baseline');
  if (active) return { deploy: false, reason: 'production build in flight' };
  const deployed = deploymentSha(baseline);
  if (deployed === target) return { deploy: false, reason: 'current main is already deployed' };
  if (now - newest < COOLDOWN_MS) return { deploy: false, reason: '3h production cooldown', eligibleAt: new Date(newest + COOLDOWN_MS).toISOString() };
  if (!changed(deployed, target)) return { deploy: false, reason: 'no site changes since deployed SHA' };
  return { deploy: true, reason: 'eligible main differs from production', target };
}
export function assertCi(runs, names, sha) {
  must(Array.isArray(runs) && Array.isArray(names) && names.length > 0 && names.every(n => typeof n === 'string' && n), 'Invalid CI runs or workflow configuration');
  for (const name of names) {
    const candidates = runs.filter(r => r.name === name && r.head_sha === sha && r.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(r.event)).sort((a, b) => b.id - a.id);
    must(candidates.length > 0 && candidates[0].status === 'completed' && candidates[0].conclusion === 'success', `Exact-main CI not successful: ${name}`);
  }
}
export function assertReceipt(d, config, sha) {
  must(object(d) && d.projectId === config.projectId && d.target === 'production' && d.readyState === 'READY', 'Deployment is not READY production for this project');
  must(deploymentSha(d) === sha, 'Deployment SHA mismatch');
  must(typeof d.url === 'string' && /^[a-zA-Z0-9.-]+\.vercel\.app$/.test(d.url), 'Invalid deployment URL');
  return `https://${d.url}`;
}
function git(args) { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
export async function request(url, token, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  must(res.ok, `Provider read failed: HTTP ${res.status}`);
  return res.json();
}
async function main() {
  const config = JSON.parse(readFileSync('scripts/deploy/vercel-config.json', 'utf8'));
  const target = git(['rev-parse', 'HEAD']);
  must(process.env.GITHUB_REPOSITORY === config.repository, 'Wrong repository');
  must(process.env.VERCEL_TOKEN && process.env.GH_TOKEN, 'Missing deploy/read credentials');
  const api = path => `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(config.teamId)}`;
  const read = path => request(api(path), process.env.VERCEL_TOKEN);
  const gh = path => request(`https://api.github.com/repos/${config.repository}${path}`, process.env.GH_TOKEN);
  if (process.argv[2] === 'receipt') {
    const result = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const id = result.id ?? result.uid ?? result.deployment?.id ?? result.data?.id ?? result.data?.deployment?.id;
    must(typeof id === 'string' && /^dpl_[A-Za-z0-9]+$/.test(id), 'CLI returned no deployment ID');
    const url = assertReceipt(await read(`/v13/deployments/${id}?withGitRepoInfo=true`), config, target);
    const project = await read(`/v9/projects/${config.projectId}`);
    assertProject(project, config);
    must((project.targets?.production?.id ?? project.targets?.production?.uid) === id, 'Deployment is not the current production target');
    console.log(`Verified production ${target}: ${url}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Verified production: ${url}\n\nCommit: ${target}\n`);
    return;
  }
  const head = await gh('/git/ref/heads/main');
  if (head.object?.sha !== target) {
    console.log('Skipped: main superseded this checkout');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'deploy=false\n');
    return;
  }
  const project = await read(`/v9/projects/${config.projectId}`);
  assertProject(project, config);
  const baselineId = project.targets?.production?.id ?? project.targets?.production?.uid;
  must(typeof baselineId === 'string' && /^dpl_[A-Za-z0-9]+$/.test(baselineId), 'No current production target');
  const baseline = await read(`/v13/deployments/${baselineId}?withGitRepoInfo=true`);
  must(baseline.projectId === config.projectId, 'Wrong production baseline project');
  const history = await read(`/v7/deployments?projectId=${config.projectId}&target=production&limit=100`);
  must(Array.isArray(history.deployments) && history.deployments.length > 0, 'Missing deployment history');
  // The newest page is enough only if its oldest row is outside the window.
  const oldest = Math.min(...history.deployments.map(d => d.createdAt ?? d.created));
  must(!history.pagination?.next || oldest < Date.now() - COOLDOWN_MS, 'Deployment history truncated inside cooldown window');
  const decision = classify({ deployments: history.deployments, baseline, target, projectId: config.projectId, now: Date.now(), changed: (from, to) => {
    must(git(['merge-base', from, to]) === from, 'Deployed SHA is not an ancestor of main; investigate before deploying');
    return git(['diff', '--name-only', from, to, '--', ...config.watch]).length > 0;
  } });
  if (decision.deploy) {
    const ci = await gh(`/actions/runs?head_sha=${target}&per_page=100`);
    must(!ci.total_count || ci.total_count <= 100, 'CI run history truncated');
    assertCi(ci.workflow_runs, config.ciWorkflows, target);
  }
  console.log(JSON.stringify(decision));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${decision.deploy}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Vercel catch-up refused: ${error.message}`); process.exitCode = 1; });
}
