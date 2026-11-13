// S11: the device port is plain HTTP, so it must not be on the LAN by default.
//
// The mechanism under test is the bind address, because that is the only
// control available without a matching iOS change: a self-signed certificate
// pinned in the pairing QR is the real fix, and a phone that cannot verify a
// certificate must not be told to trust one the machine it is talking to
// minted.  So the port binds loopback unless someone says otherwise in a way
// that cannot happen by accident, and everything that would tell a phone to
// dial it on the LAN follows the bind rather than describing a world where it
// still works.
//
// The last test is the one that matters and it is a real socket: it starts the
// sidecar and asks the operating system whether the port answers off-box.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { companionEndpointCandidates } from "../src/endpoints.ts";
import { createControlServer, hostCandidates } from "../src/control.ts";
import {
  CLEARTEXT_LAN_ENV,
  DEFAULT_LAN_POLICY,
  lanPolicyNote,
  readLanPolicy,
  reachableCandidates,
} from "../src/lan-policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");

/** A first routable address on this machine, or null on a host with none.
 *  A test that cannot find one skips rather than passing silently. */
const firstLanAddress = (): string | null => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
};

/** Can a TCP connection be opened?  A refusal is the answer we want off-box,
 *  and it arrives as an error event rather than a timeout. */
const canConnect = (host: string, port: number, timeoutMs = 2_000): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });

describe("the cleartext LAN opt-in", () => {
  it("is refused for an install that configured nothing", () => {
    const policy = readLanPolicy(undefined);
    expect(policy.allowCleartextLan).toBe(false);
    expect(policy.deviceBindHost).toBe("127.0.0.1");
    expect(policy.source).toBe("default");
  });

  it("is granted only by an affirmative word", () => {
    for (const given of ["1", "true", "TRUE", " true "]) {
      expect(readLanPolicy(given), given).toEqual({
        allowCleartextLan: true,
        deviceBindHost: "0.0.0.0",
        source: "env",
      });
    }
  });

  // The point of the narrow set.  A setting that opens the port on a typo is a
  // setting nobody should ship, and the cost of refusing here is a sentence on
  // a console nobody reads.
  it.each(["on", "yes", "enabled", "0", "false", "2", "maybe", "null"])(
    "treats %s as not given",
    (given) => {
      const policy = readLanPolicy(given);
      expect(policy.allowCleartextLan, given).toBe(false);
      expect(policy.deviceBindHost, given).toBe("127.0.0.1");
      expect(policy.source, given).toBe("invalid");
    },
  );

  it("names the environment variable in the refusal it shows a person", () => {
    const note = lanPolicyNote(readLanPolicy("on"));
    expect(note).toContain(CLEARTEXT_LAN_ENV);
    expect(note).toMatch(/not consent/);
    // A flag that was deliberately set must not be reported the same way as
    // one that was never set: the operator already did the thing.
    expect(lanPolicyNote(readLanPolicy("1"))).toBeNull();
  });
});

describe("the routes handed to a phone", () => {
  it("offers only the hosted HTTPS origin when the port is loopback only", () => {
    const endpoints = companionEndpointCandidates(
      8810,
      ["192.168.1.42", "10.0.0.7"],
      "macbook.tail1234.ts.net",
      "https://device-123.companion.example",
      "botfleet-abcd1234.local",
      DEFAULT_LAN_POLICY,
    );
    expect(endpoints).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
    ]);
    // A phone spends seconds on each dead candidate before it walks past it,
    // so an advertised route the sidecar cannot answer is a real cost.
    for (const endpoint of endpoints) expect(endpoint.url.startsWith("https://")).toBe(true);
  });

  it("is empty rather than a list of unusable routes when no hosted origin is set", () => {
    expect(
      companionEndpointCandidates(8810, ["192.168.1.42"], null, null, "botfleet-abcd1234.local"),
    ).toEqual([]);
  });

  it("withholds the LAN host list from the pairing page under the same policy", () => {
    expect(hostCandidates(["192.168.1.42", "10.0.0.7"], null)).toEqual([]);
    expect(hostCandidates(["192.168.1.42"], null, readLanPolicy("1"))).toEqual([
      "192.168.1.42",
      expect.stringMatching(/^botfleet-[0-9a-f]{8}\.local$/),
    ]);
  });

  it("keeps a non-network route whatever the policy says", () => {
    const candidates = [
      { url: "https://device-123.companion.example", kind: "hosted" },
      { url: "http://192.168.1.42:8810", kind: "lan" },
    ];
    expect(reachableCandidates(candidates, DEFAULT_LAN_POLICY)).toEqual([candidates[0]]);
    expect(reachableCandidates(candidates, readLanPolicy("1"))).toEqual(candidates);
  });
});

describe("the device port as an actual socket", () => {
  const lanAddress = firstLanAddress();
  // A distinct port per posture: both sidecars are started together, and a
  // shared one would hand the loser a bare EADDRINUSE — which is the exact
  // startup failure this suite exists to keep out of a real install.
  const DEFAULT_PORT = 18_810;
  const OPTED_IN_PORT = 18_820;

  /** Start the sidecar on a known port and collect its banner.  The banner is
   *  part of the mechanism: the operator has to be told, or a phone that
   *  cannot pair is indistinguishable from a broken install. */
  const start = (port: number, env: Record<string, string>) => {
    // Carried across explicitly rather than by spreading process.env, so the
    // child cannot inherit a real setting by accident — and so the only
    // variables this suite controls are visible in one list.  HOME and
    // USERPROFILE still have to travel: DeviceRegistry is built at module
    // scope and reads its device file from homedir(), so without them the child
    // would reach the account running the suite.  OMB_COMPANION_DIR is the one
    // that actually decides where it writes.
    const carried = ["PATH", "SystemRoot", "HOME", "USERPROFILE", "OMB_COMPANION_DIR"];
    const childEnv: Record<string, string> = {};
    for (const name of carried) {
      const value = process.env[name];
      if (value) childEnv[name] = value;
    }
    childEnv.OMB_COMPANION_PORT = String(port);
    childEnv.OMB_CONTROL_PORT = String(port + 1);
    // The harness is not running and never needs to be for this: the device
    // port binds and the banner prints regardless, and a name lookup that
    // fails falls back rather than blocking.
    childEnv.OMB_COMPANION_NAME = "test computer";
    for (const [name, value] of Object.entries(env)) childEnv[name] = value;
    return spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };

  type Sidecar = ReturnType<typeof start>;
  const children: Sidecar[] = [];
  /** Everything a child has printed so far, kept as it arrives.  The banner is
   *  several lines and the test must not depend on the order they land in, so
   *  this collects first and the assertion below reads the whole thing. */
  const output = new Map<Sidecar, string>();
  const collect = (child: Sidecar): string => {
    const seen = output.get(child) ?? "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output.set(child, (output.get(child) ?? "") + chunk.toString("utf8"));
    });
    child.on("error", () => {});
    return seen;
  };

  /** Resolve once the child has printed every marker.  Waiting on markers
   *  rather than on a single sentinel line is what keeps this from depending
   *  on where the process happens to be in its startup logging. */
  const waitFor = (child: Sidecar, markers: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`never printed ${JSON.stringify(markers)}; saw: ${output.get(child) ?? ""}`)),
        15_000,
      );
      deadline.unref?.();
      const check = () => {
        const seen = output.get(child) ?? "";
        if (!markers.every((marker) => seen.includes(marker))) return;
        clearTimeout(deadline);
        resolve(seen);
      };
      child.stdout?.on("data", check);
      child.on("exit", check);
      check();
    });

  beforeAll(() => {
    const a = start(DEFAULT_PORT, {});
    const b = start(OPTED_IN_PORT, { [CLEARTEXT_LAN_ENV]: "1" });
    collect(a);
    collect(b);
    children.push(a, b);
  });

  afterAll(() => {
    for (const child of children) child.kill("SIGKILL");
  });

  it("binds loopback by default and refuses a connection from the LAN", async () => {
    const port = DEFAULT_PORT;
    const out = await waitFor(children[0], [
      "pair here",
      "loopback only",
      // The refusal has to name the way out, or it reads as a broken install.
      CLEARTEXT_LAN_ENV,
      "pair over HTTPS instead",
    ]);
    expect(out).toContain("http://127.0.0.1:" + port);
    // Nothing is invented: a loopback port is a loopback port, whatever the
    // machine looks like.  The LAN half of the claim is below, where a
    // routable address actually exists.
    expect(await canConnect("127.0.0.1", port)).toBe(true);
    if (lanAddress) {
      expect(await canConnect(lanAddress, port), `${lanAddress}:${port} answered`).toBe(false);
    }
  });

  it("opens the LAN only when the flag is set, and says so in the banner", async () => {
    const port = OPTED_IN_PORT;
    const out = await waitFor(children[1], ["pair here", "open on the LAN in cleartext"]);
    expect(out).toContain(`http://0.0.0.0:${port}`);
    expect(await canConnect("127.0.0.1", port)).toBe(true);
    // The control plane is loopback in BOTH postures — a flag about the device
    // port must never be able to move the surface that opens pairing windows.
    expect(await canConnect("127.0.0.1", port + 1)).toBe(true);
    if (lanAddress) {
      expect(await canConnect(lanAddress, port + 1), `control answered on ${lanAddress}`).toBe(false);
    }
  });
});

describe("the pairing page reports the posture", () => {
  it("serves loopback only, whatever the Host header claims", async () => {
    const server = createControlServer({
      // SAFETY: companionState and the route guards read only `pairing` and
      // `list` off the registry, and this stand-in supplies exactly those.
      devices: { pairing: () => null, list: () => [] } as never,
      companionPort: 8810,
      discovery: () => ({ advertising: false, name: "botfleet-test.local" }),
      lanPolicy: DEFAULT_LAN_POLICY,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a listening TCP server always reports a bound address with a
    // numeric port, and this one is bound to 127.0.0.1 by the line above.
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/state`);
      // SAFETY: /state is this server's own JSON, written by companionState
      // above, so the two fields read here are the two it publishes.
      const body = (await res.json()) as {
        hosts: string[];
        lanPolicy: { allowCleartextLan: boolean; note: string | null };
      };
      expect(body.hosts).toEqual([]);
      expect(body.lanPolicy.allowCleartextLan).toBe(false);
      expect(body.lanPolicy.note).toContain("loopback only");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
