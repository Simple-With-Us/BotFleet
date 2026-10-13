import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { SERVER_ROOT } from "./proxy-paths.ts";

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

// A pinned release artifact, one per CPU architecture.  Everything here is
// rendered into shell, so the shapes are deliberately narrow: an https URL with
// no quotes or whitespace, a lowercase sha256, and file names that cannot carry
// shell syntax.  The renderer verifies the sha256 before it unpacks anything.
const VmCliDownloadFormatSchema = z.enum(["raw", "tar.gz", "tar.xz"]);

const VmCliDownloadFileSchema = z
  .object({
    /** Path inside the archive.  Omitted for a `raw` download, which is the binary itself. */
    path: z.string().regex(/^[A-Za-z0-9._+/-]+$/).optional(),
    /** File name installed into /usr/local/bin. */
    as: z.string().regex(/^[A-Za-z0-9._+-]+$/),
  })
  .strict();

const VmCliDownloadAssetSchema = z
  .object({
    url: z.string().regex(/^https:\/\/[A-Za-z0-9._~:/?#@%&=+,-]+$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.array(VmCliDownloadFileSchema).min(1),
  })
  .strict();

const VmCliDownloadSchema = z
  .object({
    format: VmCliDownloadFormatSchema,
    assets: z.object({ x86_64: VmCliDownloadAssetSchema, aarch64: VmCliDownloadAssetSchema }).strict(),
  })
  .strict()
  .superRefine((download, ctx) => {
    for (const [arch, asset] of Object.entries(download.assets)) {
      if (download.format === "raw") {
        if (asset.files.length !== 1 || asset.files[0]!.path !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `raw download for ${arch} must install exactly one file, with no archive path`,
          });
        }
      } else if (asset.files.some((file) => file.path === undefined)) {
        ctx.addIssue({ code: "custom", message: `${download.format} download for ${arch} needs a path for every file` });
      }
    }
  });

const VmCliToolSchema = z
  .object({
    name: z.string().min(1),
    targets: z.array(VmCliTargetSchema).min(1),
    version: z.string().min(1),
    verify: VmCliVerifySchema.optional(),
    apt: z.array(z.string().min(1)).optional(),
    recipe: z.string().min(1).optional(),
    npmPackage: z.string().min(1).optional(),
    /** Pinned per-architecture artifacts, consumed by the `pinned_binary` recipe. */
    download: VmCliDownloadSchema.optional(),
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

export type VmCliDownload = z.infer<typeof VmCliDownloadSchema>;

export type VmCliTool = z.infer<typeof VmCliToolSchema>;

export type VmCliManifest = z.infer<typeof VmCliManifestSchema>;

const VmCliShellEnvironmentSchema = z.enum(["cloud", "local-vm"]);

let cachedManifest: VmCliManifest | null = null;

/** CLI argv for install/verify scripts (`cloud` | `local-vm`).  Omitted argv defaults to `cloud`. */
export function parseVmCliShellEnvironment(raw: string | undefined): VmCliEnvironment {
  if (raw === undefined || raw === "") return "cloud";
  return VmCliShellEnvironmentSchema.parse(raw);
}

export function vmCliManifestPath(): string {
  const candidates = [
    join(SERVER_ROOT, "computer-vm-cli/manifest.json"),
    join(SERVER_ROOT, "../computer-vm-cli/manifest.json"),
    join(SERVER_ROOT, "../scripts/computer-vm-cli/manifest.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

export function loadVmCliManifest(): VmCliManifest {
  if (!cachedManifest) {
    const manifestPath = vmCliManifestPath();
    cachedManifest = VmCliManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
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
