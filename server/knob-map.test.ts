import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  KNOB_FIELDS,
  KNOB_INFISICAL_NAMES,
  canonicalKnobString,
  deleteKnobField,
  knobProvenance,
  knobSource,
  parseKnobValue,
  readKnobField,
  resolveKnobFields,
  stripVaultManagedKnobs,
  writeKnobField,
  type KnobFieldSpec,
} from "./knob-map.ts";
import { setInfisicalSnapshot, infisicalSnapshot } from "./secret-map.ts";

const spec = (id: string): KnobFieldSpec => {
  const found = KNOB_FIELDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no knob spec for ${id}`);
  return found;
};

afterEach(() => {
  setInfisicalSnapshot(null, []);
  resolveKnobFields({}, null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the knob table", () => {
  it("has unique ids, paths and Infisical names", () => {
    const ids = KNOB_FIELDS.map((entry) => entry.id);
    const names = KNOB_FIELDS.map((entry) => entry.infisicalName);
    const paths = KNOB_FIELDS.map((entry) => `${String(entry.section)}.${entry.path.join(".")}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps every id equal to its section-plus-path", () => {
    for (const entry of KNOB_FIELDS) {
      expect(entry.id).toBe(`${String(entry.section)}.${entry.path.join(".")}`);
    }
  });

  it("uses names the Infisical shape accepts", () => {
    for (const name of KNOB_INFISICAL_NAMES) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]{0,127}$/);
    }
  });
});

describe("parseKnobValue", () => {
  it("parses ints and truncates fractions", () => {
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "30")).toBe(30);
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "30.9")).toBe(30);
  });

  it("clamps to the spec bounds instead of rejecting", () => {
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "9999")).toBe(360);
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "-5")).toBe(1);
    expect(parseKnobValue(spec("observability.tracesSampleRate"), "2")).toBe(1);
    expect(parseKnobValue(spec("observability.tracesSampleRate"), "-1")).toBe(0);
  });

  it("rejects non-numbers", () => {
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "fast")).toBeNull();
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "")).toBeNull();
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "   ")).toBeNull();
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "NaN")).toBeNull();
    expect(parseKnobValue(spec("jobs.defaultMinutes"), "Infinity")).toBeNull();
  });

  it("parses floats", () => {
    expect(parseKnobValue(spec("observability.tracesSampleRate"), "0.5")).toBe(0.5);
  });

  it("clamps the webhook hot-host deferral limit to its minute bounds", () => {
    expect(parseKnobValue(spec("jobs.webhookHotDeferMinutes"), "20")).toBe(20);
    expect(parseKnobValue(spec("jobs.webhookHotDeferMinutes"), "0")).toBe(1);
    expect(parseKnobValue(spec("jobs.webhookHotDeferMinutes"), "9999")).toBe(720);
  });

  it("clamps the auto-review limit per turn and applies it from the vault", () => {
    expect(parseKnobValue(spec("autoReview.maxReviewsPerTurn"), "50")).toBe(50);
    expect(parseKnobValue(spec("autoReview.maxReviewsPerTurn"), "0")).toBe(1);
    expect(parseKnobValue(spec("autoReview.maxReviewsPerTurn"), "100000")).toBe(500);
    const cfg: AppConfig = { autoReview: { fallbackReviewer: "claude" } };
    resolveKnobFields(cfg, new Map([["BOTFLEET_AUTO_REVIEW_MAX_PER_TURN", "12"]]));
    expect(cfg.autoReview).toEqual({ fallbackReviewer: "claude", maxReviewsPerTurn: 12 });
  });

  it("clamps the TTS audio retention days and applies it from the vault", () => {
    expect(parseKnobValue(spec("tts.audioRetentionDays"), "30")).toBe(30);
    expect(parseKnobValue(spec("tts.audioRetentionDays"), "-5")).toBe(0);
    expect(parseKnobValue(spec("tts.audioRetentionDays"), "999")).toBe(365);
    const cfg: AppConfig = { tts: { voice: "aura-1" } };
    resolveKnobFields(cfg, new Map([["BOTFLEET_TTS_AUDIO_RETENTION_DAYS", "14"]]));
    expect(cfg.tts).toEqual({ voice: "aura-1", audioRetentionDays: 14 });
  });

  it("round-trips through the canonical string", () => {
    for (const entry of KNOB_FIELDS) {
      if (entry.kind === "bool") continue;
      if (entry.kind === "string") {
        const text = "sample-value";
        expect(parseKnobValue(entry, text)).toBe(text);
        continue;
      }
      // An in-bounds value for THIS spec: the midpoint when both bounds
      // exist, otherwise just above the floor.  Out-of-bounds values clamp
      // by design (see the clamping test above), so they cannot round-trip.
      const lo = entry.min ?? 0;
      const value = entry.max !== undefined
        ? entry.kind === "int" ? Math.floor((lo + entry.max) / 2) : (lo + entry.max) / 2
        : entry.kind === "int" ? lo + 1 : lo + 0.5;
      const text = canonicalKnobString(entry, value);
      expect(parseKnobValue(entry, text)).toBe(value);
    }
  });
});

describe("resolving knobs", () => {
  it("leaves the inode floor unset until a file or vault explicitly supplies it", () => {
    const cfg: AppConfig = {};
    resolveKnobFields(cfg, new Map());
    expect(readKnobField(cfg, spec("jobs.admission.minFreeInodes"))).toBeUndefined();
    resolveKnobFields(cfg, new Map([["BOTFLEET_JOBS_MIN_FREE_INODES", "1250"]]));
    expect(cfg.jobs?.admission?.minFreeInodes).toBe(1250);
    expect(knobSource("jobs.admission.minFreeInodes")).toBe("infisical");
  });
  it("applies the migrated computer-call and Claude-session knobs, clamped to their bounds", () => {
    const cfg: AppConfig = { computerCall: { waitMs: 10_000 } };
    resolveKnobFields(cfg, new Map([
      ["BOTFLEET_COMPUTER_CALL_WAIT_MS", "999999"],
      ["BOTFLEET_COMPUTER_CALL_ACT_WITHIN_MS", "250"],
      ["BOTFLEET_COMPUTER_CALL_WAIT_MAX_MS", "90000"],
      ["BOTFLEET_CLAUDE_SESSION_IDLE_MS", "120000"],
      ["BOTFLEET_CLAUDE_SESSION_IDLE_MIN_MS", "2000"],
    ]));
    expect(cfg.computerCall).toEqual({ waitMs: 45_000, actWithinMs: 250, personAwayMs: 90_000 });
    expect(cfg.claudeSession).toEqual({ idleMs: 120_000, idleMinMs: 2_000 });
    expect(knobSource("computerCall.waitMs")).toBe("infisical");
    expect(knobSource("claudeSession.idleMs")).toBe("infisical");
  });
  it("applies a vault value over the file value", () => {
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    setInfisicalSnapshot(new Map([["BOTFLEET_JOBS_DEFAULT_MINUTES", "30"]]), ["BOTFLEET_JOBS_DEFAULT_MINUTES"]);
    const rows = resolveKnobFields(cfg, new Map([["BOTFLEET_JOBS_DEFAULT_MINUTES", "30"]]));
    expect(cfg.jobs?.defaultMinutes).toBe(30);
    expect(rows.find((row) => row.id === "jobs.defaultMinutes")).toMatchObject({
      source: "infisical",
      hasValue: true,
      hasLocalCopy: true,
    });
  });

  it("applies a nested-path knob without disturbing its siblings", () => {
    const cfg: AppConfig = { jobs: { admission: { maxSwapPercent: 98, minFreeDiskMb: 2048 } } };
    resolveKnobFields(cfg, new Map([["BOTFLEET_JOBS_MAX_SWAP_PERCENT", "90"]]));
    expect(cfg.jobs?.admission?.maxSwapPercent).toBe(90);
    expect(cfg.jobs?.admission?.minFreeDiskMb).toBe(2048);
  });

  it("leaves the file value alone when the vault has nothing", () => {
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    resolveKnobFields(cfg, new Map());
    expect(cfg.jobs?.defaultMinutes).toBe(60);
    expect(knobSource("jobs.defaultMinutes")).toBe("file");
  });

  it("keeps the file value and warns loudly on an unparsable vault value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    resolveKnobFields(cfg, new Map([["BOTFLEET_JOBS_DEFAULT_MINUTES", "soon"]]));
    expect(cfg.jobs?.defaultMinutes).toBe(60);
    expect(knobSource("jobs.defaultMinutes")).toBe("file");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BOTFLEET_JOBS_DEFAULT_MINUTES"));
  });

  it("treats an empty vault string as absent", () => {
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    resolveKnobFields(cfg, new Map([["BOTFLEET_JOBS_DEFAULT_MINUTES", ""]]));
    expect(cfg.jobs?.defaultMinutes).toBe(60);
    expect(knobSource("jobs.defaultMinutes")).toBe("file");
  });

  it("reports none when neither file nor vault has the knob", () => {
    const cfg: AppConfig = {};
    resolveKnobFields(cfg, new Map());
    expect(knobSource("usage.spendCeilingUsd")).toBe("none");
    expect(knobProvenance().find((row) => row.id === "usage.spendCeilingUsd")).toMatchObject({
      hasValue: false,
      hasLocalCopy: false,
    });
  });

  it("makes zero network calls: resolution is pure memory off the snapshot", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    resolveKnobFields(cfg, new Map([["BOTFLEET_JOBS_DEFAULT_MINUTES", "30"]]));
    readKnobField(cfg, spec("jobs.defaultMinutes"));
    knobSource("jobs.defaultMinutes");
    knobProvenance();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the snapshot filter", () => {
  it("accepts knob names into the snapshot and still rejects strangers", () => {
    setInfisicalSnapshot(
      new Map([
        ["BOTFLEET_JOBS_DEFAULT_MINUTES", "30"],
        ["PATH", "/usr/bin"],
        ["SOME_RANDOM_ROW", "x"],
      ]),
      ["BOTFLEET_JOBS_DEFAULT_MINUTES", "PATH", "SOME_RANDOM_ROW"],
    );
    // The snapshot is published through the shared filter; knobs resolve off
    // whatever it kept.  Reach it the way loadConfig() does.
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    resolveKnobFields(cfg, infisicalSnapshot());
    expect(cfg.jobs?.defaultMinutes).toBe(30);
  });

  it("applies agent proxy knobs from the vault", () => {
    const cfg: AppConfig = { agentProxy: { enabled: false, address: "localhost:17322" } };
    resolveKnobFields(
      cfg,
      new Map([
        ["BOTFLEET_AGENT_PROXY_ENABLED", "true"],
        ["BOTFLEET_AGENT_PROXY_ADDRESS", "127.0.0.1:17322"],
        ["BOTFLEET_AGENT_PROXY_PROJECT_ID", "test-project-123"],
        ["BOTFLEET_AGENT_PROXY_ENV", "prod"],
        ["BOTFLEET_AGENT_PROXY_PATH", "/nested"],
      ]),
    );
    expect(cfg.agentProxy).toEqual({
      enabled: true,
      address: "127.0.0.1:17322",
      projectId: "test-project-123",
      environment: "prod",
      secretPath: "/nested",
    });
    expect(knobSource("agentProxy.enabled")).toBe("infisical");
    expect(knobSource("agentProxy.address")).toBe("infisical");
    expect(knobSource("agentProxy.projectId")).toBe("infisical");
    expect(knobSource("agentProxy.environment")).toBe("infisical");
    expect(knobSource("agentProxy.secretPath")).toBe("infisical");
  });
});

describe("writeKnobField and deleteKnobField", () => {
  it("copies each level on the way down", () => {
    const admission = { maxSwapPercent: 98 };
    const jobs = { admission };
    const cfg: AppConfig = { jobs };
    writeKnobField(cfg, spec("jobs.admission.maxSwapPercent"), 90);
    expect(cfg.jobs?.admission?.maxSwapPercent).toBe(90);
    expect(jobs.admission).toBe(admission);
    expect(admission.maxSwapPercent).toBe(98);
  });

  it("deletes the leaf and leaves the section in place", () => {
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 30, enabled: true } };
    deleteKnobField(patch, spec("jobs.defaultMinutes"));
    expect(patch.jobs).toEqual({ enabled: true });
  });
});

describe("stripVaultManagedKnobs", () => {
  it("drops vault-managed knobs from a patch bound for disk", () => {
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    resolveKnobFields(cfg, new Map([["BOTFLEET_JOBS_DEFAULT_MINUTES", "30"]]));
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 30 } };
    const stripped = stripVaultManagedKnobs(patch);
    expect(stripped).toEqual(["jobs.defaultMinutes"]);
    expect(patch.jobs).toEqual({});
  });

  it("leaves file-managed knobs alone", () => {
    const cfg: AppConfig = { jobs: { defaultMinutes: 60 } };
    resolveKnobFields(cfg, new Map());
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 45 } };
    expect(stripVaultManagedKnobs(patch)).toEqual([]);
    expect(patch.jobs?.defaultMinutes).toBe(45);
  });
});
