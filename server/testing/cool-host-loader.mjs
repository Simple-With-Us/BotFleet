// Permission-wiring integration tests need a cool host, independent of the
// runner's real load and swap. Applied only to the spawned test server with
// --import; production admission remains covered by host-dispatch-hot.test.ts
// and routines.test.ts, including hot-host deferral and bounded retry.
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url === new URL("../host-dispatch-hot.ts", import.meta.url).href) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const readHostDispatchHoldReason = () => null; export const readHostDispatchHot = () => false;",
      };
    }
    return nextLoad(url, context);
  },
});
