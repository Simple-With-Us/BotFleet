// Self-contained stable-loader protocol. Only Node builtins may be imported.
// The installed shell loads this file from a fetched, ancestry-checked main
// commit; this module assembles policy AND its full local import graph from
// immutable git objects, never the working tree or an installed file list.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (checkout, args) => execFileSync('git', ['-C', checkout, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
const safePath = (path) => {
  if (!path || path.startsWith('/') || path.split('/').includes('..') || !/^[\w./-]+$/.test(path)) throw new Error(`Unsafe updater module path: ${path}`);
  return path;
};
// Small lexical scanner, not a regex over comments or string contents.
// Template interpolation is unsupported in the updater module graph: a
// template-literal specifier throws instead of bundling silently.
export function localSpecifiers(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i+2); if (end < 0) throw new Error('Unclosed comment'); i=end+2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c; let value = ''; i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { value += text[i++]; if (i < text.length) value += text[i++]; }
        else value += text[i++];
      }
      i++; tokens.push({ kind: quote === '`' ? 'template' : 'string', value }); continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++;
      while (i < text.length && /[\w$]/.test(text[i])) i++;
      tokens.push({ kind: 'word', value: text.slice(start, i) }); continue;
    }
    tokens.push({ kind: 'symbol', value: c }); i++;
  }
  const found = [];
  for (let t=0; t<tokens.length; t++) {
    const token=tokens[t], next=tokens[t+1];
    if (token.kind !== 'word' || !['import','export'].includes(token.value) || tokens[t-1]?.value === '.') continue;
    if (next?.value === '.') continue; // import.meta
    if (token.value === 'import' && next?.kind === 'string') { found.push(next.value); continue; }
    if (token.value === 'import' && next?.kind === 'template') throw new Error('Template-literal import cannot be bundled');
    if (token.value === 'import' && next?.value === '(') {
      if (tokens[t+2]?.kind !== 'string' || tokens[t+3]?.value !== ')') throw new Error('Computed import cannot be bundled');
      found.push(tokens[t+2].value); continue;
    }
    if (token.value === 'export' && !['{','*'].includes(next?.value)) continue;
    for (let n=t+1; n<tokens.length && tokens[n].value !== ';'; n++) {
      if (tokens[n].kind === 'word' && tokens[n].value === 'from' && tokens[n+1]?.kind === 'string') { found.push(tokens[n+1].value); break; }
      if (tokens[n].kind === 'word' && tokens[n].value === 'from' && tokens[n+1]?.kind === 'template') throw new Error('Template-literal import cannot be bundled');
    }
  }
  return found;
}
export function assertMainCommit(checkout, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Updater commit must be a full SHA');
  git(checkout, ['merge-base', '--is-ancestor', commit, 'origin/main']);
}
export function assembleBundle(checkout, commit, destination, entries) {
  assertMainCommit(checkout, commit);
  const pending = [...entries];
  const files = [];
  const seen = new Set();
  while (pending.length) {
    const path = safePath(pending.pop());
    if (seen.has(path)) continue;
    seen.add(path);
    const tree = git(checkout, ['ls-tree', commit, '--', path]).toString();
    if (!/^100(?:644|755) blob /.test(tree)) throw new Error(`Updater module is missing or not a regular tracked file: ${path}`);
    const bytes = git(checkout, ['show', `${commit}:${path}`]);
    if (/\.[cm]?js$/.test(path)) {
      for (const specifier of localSpecifiers(bytes.toString())) {
        if (specifier.startsWith('.')) pending.push(safePath(posix.normalize(posix.join(posix.dirname(path), specifier))));
        else if (!specifier.startsWith('node:')) throw new Error(`Updater dependency must be a local module or Node builtin: ${specifier}`);
      }
    }
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
    files.push({ path, sha256: digest(bytes) });
  }
  const manifest = { schemaVersion: 1, commit, entries, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  writeFileSync(join(destination, 'updater-manifest.json'), JSON.stringify(manifest, null, 2)+'\n', { mode: 0o600 });
  verifyBundle(destination, commit);
  return manifest;
}
export function verifyBundle(directory, commit) {
  const manifest = JSON.parse(readFileSync(join(directory, 'updater-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.commit !== commit || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid updater bundle manifest');
  for (const file of manifest.files) {
    if (digest(readFileSync(join(directory, safePath(file.path)))) !== file.sha256) throw new Error(`Updater bundle hash mismatch: ${file.path}`);
  }
  for (const entry of manifest.entries) if (!manifest.files.some((file) => file.path === entry)) throw new Error(`Updater entry absent from manifest: ${entry}`);
  return manifest;
}
export function publishHelper(checkout, commit, cache) {
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  cache = realpathSync(cache);
  assertMainCommit(checkout, commit);
  // Reuse a verified immutable generation, so a check/retry at the same main
  // commit cannot fill the cache with one helper tree per attempt.
  const pointer = join(cache, 'current.json');
  try {
    const current = JSON.parse(readFileSync(pointer, 'utf8'));
    if (current.commit === commit && dirname(current.directory) === cache) {
      const verified = verifyBundle(current.directory, commit);
      if (digest(JSON.stringify(verified)) === current.manifestSha256) return current.directory;
    }
  } catch { /* A missing/bad cached generation is rebuilt from git objects. */ }
  const generation = join(cache, `${commit}-${randomUUID()}`);
  const staging = `${generation}.tmp`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    const manifest = assembleBundle(checkout, commit, staging, ['scripts/update-botfleet-policy.sh', 'scripts/update-botfleet-bootstrap.mjs', 'scripts/update-botfleet-mac.mjs', 'scripts/ci-build-resolver.mjs', 'scripts/update-botfleet-runtime-commit.mjs']);
    renameSync(staging, generation);
    const temporary = join(cache, `.current-${randomUUID()}.json`);
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, commit, directory: generation, manifestSha256: digest(JSON.stringify(manifest)), publishedAt: new Date().toISOString() })+'\n', { mode: 0o600 });
    renameSync(temporary, join(cache, 'current.json'));
    return generation;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
function main(args) {
  if (args[0] === '--assemble') {
    const [, checkout, commit, destination, ...entries] = args;
    assembleBundle(checkout, commit, destination, entries);
    return;
  }
  const [checkout, commit, cache, ...policyArgs] = args;
  const directory = publishHelper(checkout, commit, cache);
  const result = spawnSync('/bin/bash', [join(directory, 'scripts/update-botfleet-policy.sh'), ...policyArgs], {
    stdio: 'inherit',
    env: { ...process.env, BOTFLEET_BOOTSTRAP_DRIVER: join(directory, 'scripts/update-botfleet-bootstrap.mjs') },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`BotFleet bootstrap failed: ${error.message}`); process.exitCode = 1; }
}
