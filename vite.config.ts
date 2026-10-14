import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { sentryReleaseName } from "./server/sentry.ts";
import { runtimeBuildIdentity } from "./server/runtime-identity.ts";

const sentryRelease =
  sentryReleaseName(process.env, runtimeBuildIdentity.sourceCommit) ?? "";
const sentryAuthToken = (process.env.SENTRY_AUTH_TOKEN || "").trim();

export default defineConfig({
  define: {
    "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(sentryRelease),
  },
  build: {
    sourcemap: Boolean(sentryAuthToken),
  },
  plugins: [
    {
      // Vitest sets the client environment to noExternal, and Vite 8.3 then
      // tries to bundle node:sqlite out of the shared test setup.  Happy-dom
      // never opens a transcript database.  The node test environment keeps
      // the real builtin.
      name: "happy-dom-node-sqlite-stub",
      enforce: "pre",
      resolveId(id) {
        if (!process.env.VITEST || id !== "node:sqlite") return null;
        if (this.environment.name !== "client") return null;
        return fileURLToPath(new URL("./server/testing/node-sqlite-stub.ts", import.meta.url));
      },
    },
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: "simple-with-us",
      project: "botfleet",
      authToken: sentryAuthToken || undefined,
      disable: !sentryAuthToken,
      telemetry: false,
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/**/*.map"],
      },
      release: {
        name: sentryRelease || undefined,
      },
    }),
  ],
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "companion/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Prevent vitest-worker RPC teardown race ('Closing rpc while onUserConsoleLog was pending').
    // With console interception disabled, logs stream directly to stdout/stderr without RPC wrapping.
    disableConsoleIntercept: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(process.env.OMB_UI_PORT) || 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.OMB_PORT || process.env.OGB_PORT || 8799}`,
      },
    },
  },
});
