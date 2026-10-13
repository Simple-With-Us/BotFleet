import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The cloud capture banner must not outlive the capture that raised it.
 *
 * The bug: `captureProblem` was cleared only by the next GOOD capture or by the
 * mount effect.  The poll effect is torn down the instant the gate stops asking
 * for screenshots — a busy bot's stream resumes and delivers, so
 * `decideCloudPreview` returns `poll: false` — and a torn-down effect never
 * comes back with a success.  The red "Couldn't capture this computer's
 * screen" banner therefore stayed up over a preview that was streaming frames
 * normally, with `captureFailures.current` pinned at the limit so the next
 * transient blip re-raised it instantly.
 *
 * These are source-level assertions rather than a render test because this
 * repo installs no jsdom and no @testing-library/react, and its renderer tests
 * are SSR-only (`react-dom/server`'s `renderToStaticMarkup`) — SSR never runs
 * effects, so a DOM assertion cannot observe a `useEffect` clearing state at
 * all.  This pins the wiring and its position, the same technique
 * `ChatView.test.tsx` and `CallView.test.ts` already use for exactly this
 * reason.  The decision rule itself is pinned behaviourally in
 * `src/lib/computer-preview.test.ts` via `cloudCaptureErrorIsStale`.
 */
const SRC = readFileSync(join(__dirname, "ComputerPanel.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("cloud capture error lifetime", () => {
  it("resets the failure counter and the banner once the cloud capture stops", () => {
    // Without BOTH halves the banner is still wrong: clearing only the message
    // leaves the counter at the limit, so one transient failure re-raises it.
    expect(SRC).toMatch(/captureFailures\.current = 0;/);
    expect(SRC).toMatch(/setCaptureProblem\(null\);/);
  });

  it("gates that reset on the shared decision rule, not on a bare `!preview.poll`", () => {
    // A blanket `!preview.poll` reset would also fire for `phase === "vm"`,
    // which is never `poll: true` and writes the SAME `captureProblem` string
    // from its own `vmFailures` counter.  That would erase a live, accurate VM
    // error and zero the counter so one hiccup re-raised the banner.
    expect(SRC).toMatch(/cloudCaptureErrorIsStale\(phase, preview\.poll\)/);
    expect(SRC).not.toMatch(/useEffect\(\(\) => \{\s*if \(!preview\.poll\) return;\s*captureFailures/);
  });

  it("declares the reset after the refs and state it touches, so hook order is stable", () => {
    const ref = SRC.indexOf("const captureFailures = useRef(0);");
    const reset = SRC.indexOf("if (!cloudCaptureErrorIsStale(phase, preview.poll)) return;");
    expect(ref).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(ref);
  });

  it("keeps the VM's own failure counter independent of the cloud one", () => {
    // The two counters are separate on purpose: zeroing `captureFailures` must
    // never make a VM banner re-raise after a single failure.
    expect(SRC).toMatch(/const vmFailures = useRef\(0\);/);
    expect(SRC).not.toMatch(/captureFailures\.current = vmFailures/);
  });
});
