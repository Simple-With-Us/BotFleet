# BotFleet Test Suite Repairs

**Date:** Sept 2, 2026
**Agent:** Antigravity

- **Fixed `server/drivers/acp/dsh.test.ts`:** Removed duplicate models from `STATIC_DSH_MODELS` in `server/drivers/acp/dsh.ts` which were causing the test asserting the exact catalog content to fail.
- **Fixed `server/vps-routing.test.ts`:** The `VPS turn routing e2e` test was failing because the `security: "unsafe"` flag was being raised by `vpsDriverError`. Fixed the test's `fake docker` template to include `RestartPolicy: { Name: "unless-stopped" }` and matched the new `MEMORY_BYTES` (8GB) and `NANO_CPUS` (4) limits introduced by a recent upgrade to the computer container resources.
- **Verified `server/index.test.ts` Timeouts:** Investigated the timeouts reported in the previous run and verified they were purely caused by test runner concurrency issues (flaky due to parallel suite execution slowing down `child_process` hooks). The suite passes reliably when run individually.
