import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import {
  type VmCliCredentialTransform,
  vmCliCredentialTools,
} from "./vm-cli-manifest.ts";

export const DockerConfigSchema = z
  .object({
    credsStore: z.string().optional(),
    credHelpers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

type DockerConfig = z.infer<typeof DockerConfigSchema>;

export const VM_CLI_GUEST_HOME = "/home/cua";

export interface HostCliCredentialCandidate {
  tool: string;
  relPath: string[];
  guest: string;
  transform?: VmCliCredentialTransform;
}

export interface CredentialSyncToolResult {
  name: string;
  paths: string[];
}

export interface CredentialSyncSkip {
  name: string;
  reason: string;
}

export interface CredentialSyncPlan {
  archiveRelPaths: string[];
  stagedRelPaths: string[];
  stagingDir: string | null;
  syncedTools: CredentialSyncToolResult[];
  skippedTools: CredentialSyncSkip[];
}

export interface CredentialSyncOptions {
  homeDir?: string;
  shareGpgPrivateKeys?: boolean;
  stagingDir?: string;
  /** When false, avoid staging copies (setup-command preview only). */
  materializeCredentials?: boolean;
}

export interface CredentialSyncResult {
  ok: boolean;
  syncedTools: CredentialSyncToolResult[];
  skippedTools: CredentialSyncSkip[];
}

export interface VpsCredentialSyncResult extends CredentialSyncResult {
  containerName: string;
}

const GPG_PUBLIC_FILES = new Set([
  "gpg.conf",
  "pubring.kbx",
  "pubring.gpg",
  "trustdb.gpg",
  "random_seed",
  "openpgp-revocs.d",
]);

/** Destinations dropped from the manifest but still mounted on older Local VMs. */
const LEGACY_ALLOWED_CLI_GUEST_DESTINATIONS = [
  "/home/cua/.oci",
  "/home/cua/.terraform.d",
  "/home/cua/.config/stripe",
  "/home/cua/.config/supabase",
  "/home/cua/.config/huggingface",
  "/home/cua/.sentryclirc",
] as const;

function guestPath(rel: string): string {
  // Linux container paths must stay POSIX even when planning mounts on Windows hosts.
  return posix.join(VM_CLI_GUEST_HOME, rel);
}

function relPathParts(rel: string): string[] {
  return rel.split("/").filter(Boolean);
}

export function guestPathForCredentialRel(rel: string): string {
  return guestPath(rel);
}

export function manifestCredentialCandidates(): HostCliCredentialCandidate[] {
  const candidates: HostCliCredentialCandidate[] = [];
  for (const tool of vmCliCredentialTools()) {
    for (const path of tool.credentialPaths ?? []) {
      candidates.push({
        tool: tool.name,
        relPath: relPathParts(path.rel),
        guest: guestPath(path.rel),
        transform: path.transform,
      });
    }
  }
  return candidates.sort((a, b) => a.guest.localeCompare(b.guest));
}

let cachedCredentialCandidates: readonly HostCliCredentialCandidate[] | null = null;

export function cliCredentialCandidates(): readonly HostCliCredentialCandidate[] {
  if (!cachedCredentialCandidates) cachedCredentialCandidates = manifestCredentialCandidates();
  return cachedCredentialCandidates;
}

let cachedAllowedGuestDestinations: ReadonlySet<string> | null = null;

export function allowedCliGuestDestinations(): ReadonlySet<string> {
  if (!cachedAllowedGuestDestinations) {
    cachedAllowedGuestDestinations = new Set([
      ...cliCredentialCandidates().map((candidate) => candidate.guest),
      ...LEGACY_ALLOWED_CLI_GUEST_DESTINATIONS,
    ]);
  }
  return cachedAllowedGuestDestinations;
}

function pathExists(homeDir: string, rel: string): boolean {
  try {
    return existsSync(join(homeDir, rel));
  } catch {
    return false;
  }
}

export function sanitizeDockerConfigForLinux(raw: string): string {
  const parsed: DockerConfig = DockerConfigSchema.parse(JSON.parse(raw));
  delete parsed.credsStore;
  const helpers = parsed.credHelpers;
  if (helpers) {
    const next = { ...helpers };
    for (const key of Object.keys(next)) {
      const helper = next[key] ?? "";
      if (/osx|desktop|wincred|secretservice/i.test(key) || /osx|desktop|wincred|secretservice/i.test(helper)) {
        delete next[key];
      }
    }
    parsed.credHelpers = next;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function listGpgPublicRelPaths(homeDir: string): string[] {
  const root = join(homeDir, ".gnupg");
  if (!existsSync(root)) return [];
  const rels: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const hostRel = `.gnupg/${rel}`;
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === "private-keys-v1.d") continue;
        walk(full, rel);
        continue;
      }
      if (GPG_PUBLIC_FILES.has(entry) || (entry.endsWith(".gpg") && !hostRel.includes("private-keys"))) {
        rels.push(hostRel);
      }
    }
  };
  walk(root, "");
  return rels;
}

function listGpgPrivateRelPaths(homeDir: string): string[] {
  const privateDir = join(homeDir, ".gnupg", "private-keys-v1.d");
  if (!existsSync(privateDir)) return [];
  let names: string[];
  try {
    names = readdirSync(privateDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith("."))
    .map((name) => `.gnupg/private-keys-v1.d/${name}`);
}

function gnupgRelWithinStagingTree(hostRel: string): string {
  return hostRel.startsWith(".gnupg/") ? hostRel.slice(".gnupg/".length) : hostRel;
}

function pruneStaleGnupgStagingEntries(stagedDir: string, hostRels: string[]): void {
  const desired = new Set(hostRels.map((rel) => gnupgRelWithinStagingTree(rel)));
  const walk = (dir: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const full = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, rel);
        try {
          if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
        } catch {
          // Directory may disappear while gpg-agent mutates ~/.gnupg.
        }
        continue;
      }
      if (!desired.has(rel)) {
        try {
          rmSync(full, { force: true });
        } catch {
          // Best-effort prune for stale staged public material.
        }
      }
    }
  };
  walk(stagedDir, "");
}

function resolveTransformPaths(
  homeDir: string,
  rel: string,
  transform: VmCliCredentialTransform | undefined,
  options: CredentialSyncOptions,
): string[] {
  switch (transform) {
    case "gpg-public-tree": {
      const paths = listGpgPublicRelPaths(homeDir);
      if (options.shareGpgPrivateKeys) paths.push(...listGpgPrivateRelPaths(homeDir));
      return paths;
    }
    case "gpg-private-tree":
      return options.shareGpgPrivateKeys ? listGpgPrivateRelPaths(homeDir) : [];
    case "docker-linux-config":
      return pathExists(homeDir, rel) ? [rel] : [];
    default:
      return pathExists(homeDir, rel) ? [rel] : [];
  }
}

function stageTransformedFile(
  homeDir: string,
  rel: string,
  transform: VmCliCredentialTransform | undefined,
  stagingDir: string,
): boolean {
  const source = join(homeDir, rel);
  if (!existsSync(source)) return false;
  const target = join(stagingDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  if (transform === "docker-linux-config") {
    try {
      const body = sanitizeDockerConfigForLinux(readFileSync(source, "utf8"));
      writeFileSync(target, body, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
  copyFileSync(source, target);
  const mode = statSync(source).mode & 0o777;
  try {
    chmodSync(target, mode > 0 ? mode : 0o600);
  } catch {
    // Best-effort permission mirror for staged mounts.
  }
  return true;
}

export function planCredentialSync(options: CredentialSyncOptions = {}): CredentialSyncPlan {
  const homeDir = options.homeDir ?? homedir();
  const stagingDir = options.stagingDir ?? null;
  const archiveRelPaths = new Set<string>();
  const stagedRelPaths = new Set<string>();
  const syncedTools: CredentialSyncToolResult[] = [];
  const skippedTools: CredentialSyncSkip[] = [];

  for (const tool of vmCliCredentialTools()) {
    const toolPaths: string[] = [];
    for (const spec of tool.credentialPaths ?? []) {
      const resolved = resolveTransformPaths(homeDir, spec.rel, spec.transform, options);
      if (resolved.length === 0) {
        if (spec.transform === "gpg-private-tree") {
          if (!options.shareGpgPrivateKeys) {
            skippedTools.push({ name: tool.name, reason: "GPG private keys require opt-in" });
          }
          continue;
        }
        continue;
      }
      for (const rel of resolved) {
        if (spec.transform === "docker-linux-config") {
          if (!stagingDir) continue;
          if (stageTransformedFile(homeDir, rel, spec.transform, stagingDir)) {
            stagedRelPaths.add(rel);
            toolPaths.push(rel);
          }
          continue;
        }
        archiveRelPaths.add(rel);
        toolPaths.push(rel);
      }
    }
    if (toolPaths.length > 0) {
      syncedTools.push({ name: tool.name, paths: [...new Set(toolPaths)].sort() });
    } else if ((tool.credentialPaths?.length ?? 0) > 0) {
      const alreadySkipped = skippedTools.some((entry) => entry.name === tool.name);
      if (!alreadySkipped) skippedTools.push({ name: tool.name, reason: "No host login files found" });
    }
  }

  return {
    archiveRelPaths: [...archiveRelPaths].sort(),
    stagedRelPaths: [...stagedRelPaths].sort(),
    stagingDir,
    syncedTools,
    skippedTools,
  };
}

export function credentialMountStagingRoot(homeDir = homedir()): string {
  const digest = createHash("sha256").update(homeDir).digest("hex").slice(0, 16);
  return join(DATA_DIR, "vm-cli-credential-mounts", digest);
}

export function resolveCredentialMountSource(
  homeDir: string,
  candidate: HostCliCredentialCandidate,
  stagingRoot: string,
  options: CredentialSyncOptions,
): string | null {
  const materialize = options.materializeCredentials !== false;
  const rel = candidate.relPath.join("/");
  if (candidate.transform === "docker-linux-config") {
    const staged = join(stagingRoot, rel);
    if (!materialize) {
      return existsSync(staged) ? staged : null;
    }
    if (stageTransformedFile(homeDir, rel, candidate.transform, stagingRoot)) return staged;
    return null;
  }
  if (candidate.transform === "gpg-public-tree") {
    const stagedDir = join(stagingRoot, ".gnupg");
    if (!options.shareGpgPrivateKeys) {
      const stagedPrivateKeys = join(stagedDir, "private-keys-v1.d");
      if (existsSync(stagedPrivateKeys)) {
        rmSync(stagedPrivateKeys, { recursive: true, force: true });
      }
    }
    const publicPaths = listGpgPublicRelPaths(homeDir);
    const privatePaths = options.shareGpgPrivateKeys ? listGpgPrivateRelPaths(homeDir) : [];
    if (publicPaths.length === 0 && privatePaths.length === 0) return null;
    if (!materialize) {
      return existsSync(stagedDir) ? stagedDir : null;
    }
    mkdirSync(stagedDir, { recursive: true, mode: 0o700 });
    pruneStaleGnupgStagingEntries(stagedDir, [...publicPaths, ...privatePaths]);
    for (const publicRel of [...publicPaths, ...privatePaths]) {
      stageTransformedFile(homeDir, publicRel, undefined, stagingRoot);
    }
    return stagedDir;
  }
  if (candidate.transform === "gpg-private-tree") {
    return null;
  }
  const host = join(homeDir, ...candidate.relPath);
  return existsSync(host) ? host : null;
}

export function hostCliCredentialMounts(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  options: CredentialSyncOptions = {},
): string[] {
  if (platform === "win32") return [];
  const materialize = options.materializeCredentials !== false;
  const stagingRoot = credentialMountStagingRoot(home);
  if (materialize) {
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  }
  const mounts: string[] = [];
  const mountedGuests = new Set<string>();
  for (const candidate of cliCredentialCandidates()) {
    if (mountedGuests.has(candidate.guest)) continue;
    const source = resolveCredentialMountSource(home, candidate, stagingRoot, options);
    if (!source) continue;
    mountedGuests.add(candidate.guest);
    mounts.push("--mount", `type=bind,source=${source},target=${candidate.guest},readonly`);
  }
  return mounts;
}

export function credentialPermissionHardeningShell(user = "cua"): string {
  return [
    `for d in .ssh .infisical .aws .azure .oci .kube .cargo .config .gnupg .vercel .turso .docker .wrangler .deno; do`,
    `  [ -d "/home/${user}/$d" ] && chmod 700 "/home/${user}/$d" 2>/dev/null || true`,
    `done`,
    `[ -d "/home/${user}/.ssh" ] && chmod 600 /home/${user}/.ssh/id_* /home/${user}/.ssh/known_hosts* /home/${user}/.ssh/config 2>/dev/null || true`,
    `[ -f "/home/${user}/.netrc" ] && chmod 600 "/home/${user}/.netrc" 2>/dev/null || true`,
    `[ -f "/home/${user}/.pgpass" ] && chmod 600 "/home/${user}/.pgpass" 2>/dev/null || true`,
    `[ -f "/home/${user}/.docker/config.json" ] && chmod 600 "/home/${user}/.docker/config.json" 2>/dev/null || true`,
  ].join("; ");
}

export async function packageCredentialArchive(
  homeDir: string,
  plan: CredentialSyncPlan,
): Promise<Buffer | null> {
  const paths = [...new Set([...plan.archiveRelPaths, ...plan.stagedRelPaths])];
  if (paths.length === 0) return null;
  const tarRoot = plan.stagingDir ?? homeDir;
  return await new Promise<Buffer>((resolve, reject) => {
    const tar = spawn(
      "tar",
      [
        "--format=ustar",
        "-C",
        tarRoot,
        "--no-xattrs",
        "--exclude=*/virtenv*",
        "--exclude=*/agent/*",
        "--exclude=*.sock",
        "--exclude=*cm-*",
        "--exclude=*.DS_Store",
        "-cf",
        "-",
        ...paths,
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const chunks: Buffer[] = [];
    tar.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar packaging failed with code ${code}`));
    });
  });
}

export async function prepareCredentialSyncWorkspace(
  homeDir: string,
  options: CredentialSyncOptions = {},
): Promise<{ plan: CredentialSyncPlan; cleanup: () => Promise<void> }> {
  const needsStaging = vmCliCredentialTools().some((tool) =>
    tool.credentialPaths?.some((path) => path.transform === "docker-linux-config" && pathExists(homeDir, path.rel)),
  );
  if (!needsStaging) {
    return {
      plan: planCredentialSync({ ...options, homeDir }),
      cleanup: async () => {},
    };
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "bf-cli-cred-stage-"));
  try {
    const plan = planCredentialSync({ ...options, homeDir, stagingDir });
    for (const rel of plan.archiveRelPaths) {
      const source = join(homeDir, rel);
      const target = join(stagingDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      if (statSync(source).isDirectory()) {
        cpSync(source, target, { recursive: true, force: true });
      } else {
        copyFileSync(source, target);
      }
    }
    return {
      plan: { ...plan, stagingDir },
      cleanup: async () => {
        await rm(stagingDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export function listCredentialRelPathsForShell(): string[] {
  const plan = planCredentialSync({ homeDir: homedir() });
  return [...new Set([...plan.archiveRelPaths, ...plan.stagedRelPaths])].sort();
}
