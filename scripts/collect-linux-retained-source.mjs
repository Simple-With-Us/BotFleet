import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLinuxClosure, discoverLinuxRetention, immutableGitSource, MissingLfsObjects, readPrivateRetentionReceipt, verifyLinuxClosure } from "./linux-retained-source.mjs";

/** A filtered export is an artifact, never a clone or a service checkout. */
export async function exportLinuxClosure(repo, receipt, output, expectedSourceSha, expectedPolicySourceSha = expectedSourceSha, expectedPolicyPath) {
  await verifyLinuxClosure(repo, receipt, expectedSourceSha, expectedPolicySourceSha, expectedPolicyPath);
  const source = immutableGitSource(repo, expectedSourceSha);
  const target = resolve(output);
  mkdirSync(target, { mode: 0o700 });
  for (const entry of receipt.files) {
    const path = join(target, entry.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, source.materialize(entry.path), { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
  }
  return { sourceSha: receipt.sourceSha, policySourceSha: receipt.policySourceSha, files: receipt.files.length };
}

let isEntry = false;
try { isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (isEntry) {
  const [command, input, ...args] = process.argv.slice(2);
  const flags = new Map();
  let valid = true;
  for (let index = 0; index < args.length; index += 2) {
    if (!["--out", "--policy-source-sha", "--policy-path", "--source-sha"].includes(args[index]) || !args[index + 1] || flags.has(args[index])) valid = false;
    flags.set(args[index], args[index + 1]);
  }
  if (!valid || !["discover", "collect", "verify", "export"].includes(command) || !input) {
    console.error("usage: collect-linux-retained-source.mjs discover|collect <source-sha> [--policy-source-sha <sha>] [--out <new-file>] | verify|export <private-receipt.json> --source-sha <sha> [--policy-source-sha <sha>] [--out <new-directory>]");
    process.exitCode = 2;
  } else {
    try {
      const repo = process.cwd();
      let result;
      if (command === "discover") result = await discoverLinuxRetention(immutableGitSource(repo, input));
      else if (command === "collect") result = await collectLinuxClosure(immutableGitSource(repo, input), immutableGitSource(repo, flags.get("--policy-source-sha") ?? input), flags.get("--policy-path"));
      else {
        const receipt = readPrivateRetentionReceipt(input);
        const expected = flags.get("--source-sha");
        const policySource = flags.get("--policy-source-sha") ?? expected;
        if (command === "export") {
          if (!flags.get("--out")) throw new Error("Export needs a new directory");
          result = await exportLinuxClosure(repo, receipt, flags.get("--out"), expected, policySource, flags.get("--policy-path"));
        } else {
          const paths = await verifyLinuxClosure(repo, receipt, expected, policySource, flags.get("--policy-path"));
          result = { verified: true, sourceSha: expected, files: paths.size, proof: "immutable-source-consistency-only" };
        }
      }
      if (flags.get("--out") && command !== "export") {
        const text = command === "discover" ? `{\n  "version": 1,\n  "maintainedRef": "main",\n  "files": [\n${result.files.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]\n}\n` : `${JSON.stringify(result, null, 2)}\n`;
        writeFileSync(flags.get("--out"), text, { flag: "wx", mode: 0o600 });
      }
      else console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof MissingLfsObjects ? JSON.stringify({ blocked: "missing-offline-lfs-objects", count: error.missing.length, missing: error.missing }) : "Linux retention refused: missing, malformed, mismatched, unsafe or incomplete source contract");
      process.exitCode = 1;
    }
  }
}
