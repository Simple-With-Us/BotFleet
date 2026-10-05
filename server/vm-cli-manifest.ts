import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const VmCliTargetSchema = z.enum(["cloud", "local", "both"]);

const VmCliVerifySchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  })
  .strict();

const VmCliCredentialTransformSchema = z.enum(["docker-linux-config", "gpg-public-tree", "gpg-private-tree"]);

const VmCliCredentialPathSchema = z
  .object({
    rel: z.string().min(1),
    transform: VmCliCredentialTransformSchema.optional(),
  })
  .strict();

const VmCliToolSchema = z
  .object({
    name: z.string().min(1),
    targets: z.array(VmCliTargetSchema).min(1),
    version: z.string().min(1),
    verify: VmCliVerifySchema.optional(),
    apt: z.array(z.string().min(1)).optional(),
    recipe: z.string().min(1).optional(),
    npmPackage: z.string().min(1).optional(),
    postInstall: z.string().min(1).optional(),
    credentialPaths: z.array(VmCliCredentialPathSchema).optional(),
  })
  .strict();

export const VmCliManifestSchema = z
  .object({
    schemaVersion: z.number().int().nonnegative(),
    tools: z.array(VmCliToolSchema),
  })
  .strict();

export type VmCliTarget = z.infer<typeof VmCliTargetSchema>;

export type VmCliEnvironment = "cloud" | "local-vm";

export type VmCliVerify = z.infer<typeof VmCliVerifySchema>;

export type VmCliCredentialTransform = z.infer<typeof VmCliCredentialTransformSchema>;

export type VmCliCredentialPath = z.infer<typeof VmCliCredentialPathSchema>;

export type VmCliTool = z.infer<typeof VmCliToolSchema>;

export type VmCliManifest = z.infer<typeof VmCliManifestSchema>;

const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "../scripts/computer-vm-cli/manifest.json");

let cachedManifest: VmCliManifest | null = null;

export function vmCliManifestPath(): string {
  return MANIFEST_PATH;
}

export function loadVmCliManifest(): VmCliManifest {
  if (!cachedManifest) {
    cachedManifest = VmCliManifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
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
