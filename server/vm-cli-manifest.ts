import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type VmCliTarget = "cloud" | "local" | "both";

export type VmCliEnvironment = "cloud" | "local-vm";

export interface VmCliVerify {
  command: string;
  args?: string[];
}

export type VmCliCredentialTransform = "docker-linux-config" | "gpg-public-tree" | "gpg-private-tree";

export interface VmCliCredentialPath {
  rel: string;
  transform?: VmCliCredentialTransform;
}

export interface VmCliTool {
  name: string;
  targets: VmCliTarget[];
  version: string;
  verify?: VmCliVerify;
  apt?: string[];
  recipe?: string;
  npmPackage?: string;
  postInstall?: string;
  credentialPaths?: VmCliCredentialPath[];
}

export interface VmCliManifest {
  schemaVersion: number;
  tools: VmCliTool[];
}

const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "../scripts/computer-vm-cli/manifest.json");

let cachedManifest: VmCliManifest | null = null;

export function vmCliManifestPath(): string {
  return MANIFEST_PATH;
}

export function loadVmCliManifest(): VmCliManifest {
  if (!cachedManifest) {
    cachedManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as VmCliManifest;
  }
  return cachedManifest;
}

/** Which manifest `targets` apply to a provisioner surface. */
export function vmCliTargetsForEnvironment(environment: VmCliEnvironment): VmCliTarget[] {
  return environment === "local-vm" ? ["both", "local"] : ["both", "cloud"];
}

export function vmCliToolsForEnvironment(environment: VmCliEnvironment): VmCliTool[] {
  const allowed = new Set(vmCliTargetsForEnvironment(environment));
  const manifest = loadVmCliManifest();
  return manifest.tools.filter((tool) => tool.targets.some((target) => allowed.has(target)));
}

export function vmCliInstallableTools(environment: VmCliEnvironment): VmCliTool[] {
  return vmCliToolsForEnvironment(environment).filter((tool) => Boolean(tool.apt?.length || tool.recipe));
}

export function vmCliCredentialTools(): VmCliTool[] {
  return loadVmCliManifest().tools.filter((tool) => (tool.credentialPaths?.length ?? 0) > 0);
}

export function collectAptPackages(tools: VmCliTool[]): string[] {
  const packages = new Set<string>([
    "ca-certificates",
    "gnupg",
    "lsb-release",
    "unzip",
    "xz-utils",
  ]);
  for (const tool of tools) {
    for (const pkg of tool.apt ?? []) packages.add(pkg);
    if (tool.recipe === "pbcopy_shim") packages.add("xclip");
  }
  return [...packages].sort();
}
