import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Wiring guard only. Real rendered correctness requires the simulator capture.
test("GIF bridge uses the finite SwiftUI proposal rather than image intrinsic size", () => {
  const source = readFileSync(new URL("../ios/App/AnimatedGIFView.swift", import.meta.url), "utf8");
  assert.match(source, /func sizeThatFits\(_ proposal: ProposedViewSize/);
  assert.match(source, /width\.isFinite, height\.isFinite/);
  assert.match(source, /return CGSize\(width: max\(0, width\), height: max\(0, height\)\)/);
  assert.match(source, /setContentCompressionResistancePriority\(\.defaultLow, for: \.horizontal\)/);
});

test("capture harness contains both white and black bounded avatars", () => {
  const source = readFileSync(new URL("../ios/App/TVFacePreviewHarness.swift", import.meta.url), "utf8");
  for (const skin of ["white", "black"]) {
    assert.ok(source.includes(`TVFaceAvatar(color: "${skin}"`));
  }
  assert.equal((source.match(/size: 72/g) || []).length, 2);
});
