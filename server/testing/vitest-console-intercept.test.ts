import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vitest Console Intercept Configuration (board abf43c71)", () => {
  it("enforces disableConsoleIntercept: true to prevent worker teardown RPC races", () => {
    const configPath = resolve(__dirname, "../../vite.config.ts");
    const content = readFileSync(configPath, "utf-8");
    expect(content).toMatch(/^\s*disableConsoleIntercept:\s*true/m);
  });
});
