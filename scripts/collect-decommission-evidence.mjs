// Prepare an offline packet from explicitly named captures.
// Host readers are injection-only; this module supplies no subprocess,
// network, credential, scheduler, installation or retirement adapters.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecretsInText } from "../shared/redact.ts";
import {
  assertReceiptBinding, createEvidenceReader, evidenceHash, EvidenceBundleSchema,
  EvidenceRefSchema, MAX_EVIDENCE_BUNDLE_BYTES, MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_FILES, parseEvidenceReceipt, readEvidenceRef, receiptReferences, REQUIRED_RECEIPTS,
} from "./decommission-evidence-bundle.mjs";

/** Captures must be redacted before their hashes and receipts are issued. */
export async function collectEvidenceBundle(request, { readCapturedFile, readers = {} }) {
  const bundle = EvidenceBundleSchema.parse(request);
  if (Object.keys(readers).some((kind) => !REQUIRED_RECEIPTS.includes(kind) || kind === "owner-acceptance")) throw new Error("No collector may synthesize owner acceptance or an unknown receipt");
  const files = new Map();
  let total = 0;
  const put = (path, bytes) => {
    EvidenceRefSchema.parse({ path, sha256: evidenceHash(bytes) });
    if (path === "bundle.json" || !Buffer.isBuffer(bytes) || bytes.length > MAX_EVIDENCE_FILE_BYTES) throw new Error("Invalid or oversized captured file");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes) || redactSecretsInText(text) !== text) throw new Error("Capture must be redacted UTF-8 before hashing");
    if (files.has(path)) {
      if (!files.get(path).equals(bytes)) throw new Error("Conflicting captured files");
      return;
    }
    total += bytes.length;
    if (files.size >= MAX_EVIDENCE_FILES || total > MAX_EVIDENCE_BUNDLE_BYTES) throw new Error("Captured bundle exceeds its bound");
    files.set(path, Buffer.from(bytes));
  };
  const capturedReader = { read: (path) => {
    const bytes = readCapturedFile(path);
    put(path, bytes);
    return bytes;
  } };
  readEvidenceRef(capturedReader, bundle.state);
  for (const kind of REQUIRED_RECEIPTS) {
    let receipt;
    if (bundle.receipts[kind]) {
      receipt = parseEvidenceReceipt(kind, readEvidenceRef(capturedReader, bundle.receipts[kind]));
      for (const ref of receiptReferences(receipt)) readEvidenceRef(capturedReader, ref);
    } else if (readers[kind]) {
      const capture = await readers[kind]({ candidate: bundle.candidate, mode: bundle.mode, hosts: bundle.hosts });
      receipt = parseEvidenceReceipt(kind, capture.receipt);
      const path = `${kind}.receipt.json`;
      put(path, capture.receipt);
      bundle.receipts[kind] = { path, sha256: evidenceHash(capture.receipt) };
      const reader = { read: (name) => { const bytes = capture.files.get(name); if (!bytes) throw new Error("Missing captured artifact"); put(name, bytes); return bytes; } };
      for (const ref of receiptReferences(receipt)) readEvidenceRef(reader, ref);
    }
    if (receipt) assertReceiptBinding(receipt, bundle);
  }
  return { bundle, files, missing: REQUIRED_RECEIPTS.filter((kind) => !bundle.receipts[kind]) };
}

let isEntry = false;
try { isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (isEntry) {
  const [requestPath, ...args] = process.argv.slice(2);
  if (!requestPath || (args.length !== 0 && (args.length !== 2 || args[0] !== "--out"))) {
    console.error("usage: node scripts/collect-decommission-evidence.mjs <request.json> [--out <new-private-directory>]");
    process.exitCode = 2;
  } else {
    try {
      const absolute = resolve(requestPath);
      const reader = createEvidenceReader(dirname(absolute));
      const request = JSON.parse(reader.read(basename(absolute)).toString("utf8"));
      const packet = await collectEvidenceBundle(request, { readCapturedFile: reader.read });
      if (args[1]) {
        const output = resolve(args[1]);
        mkdirSync(output, { mode: 0o700 });
        for (const [path, bytes] of packet.files) {
          const target = join(output, path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
        }
        writeFileSync(join(output, "bundle.json"), `${JSON.stringify(packet.bundle, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      }
      console.log(JSON.stringify({ prepared: true, written: Boolean(args[1]), missing: packet.missing, validation: "not-performed", ownerAcceptance: packet.bundle.receipts["owner-acceptance"] ? "captured-external-assertion" : "missing" }));
    } catch {
      console.error("Evidence collection refused: invalid, unredacted, mismatched, missing or unsafe capture");
      process.exitCode = 2;
    }
  }
}
