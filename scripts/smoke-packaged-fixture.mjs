import { join } from "node:path";

// A reserved claude/grok/codex id expands into the product fleet.  This one
// exercises a real driver with an absent executable and never discovers a
// CLI or credential belonging to the host running the package gate.
export function packagedSmokeConfig(home) {
  return {
    instances: {
      "package-smoke": {
        driver: "claudeAgent",
        config: { cli: join(home, "not-installed", "package-smoke-cli") },
      },
    },
  };
}
