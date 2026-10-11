// The TV-Face pack layout is written in three places that have no shared
// import: the iOS player (`ios/App/TVFaceAvatar.swift`), the demo player
// (`public/tv-face/fleet-live.html`, mirrored to `public/tv-face/fleet-demo.html`
// and `docs/fleet-demo.html`), and this suite's neighbours in
// `tvFaceSkins.test.ts`. They drifted once already — the iOS player built the
// non-orange FleetLink path as `botfleet/{color}` while the demo treated
// `botfleet-skins/{color}` as the primary and `botfleet/{color}` as the retry,
// so the phone asked for a shape the rest of the fleet had moved off.
//
// The iOS app target has no unit-test target (`ios/Package.swift` builds and
// tests CompanionCore only, and SwiftUI/UIKit need a simulator), so these
// assertions read the Swift source. That is the same guard style
// `src/lib/settings-models-layout.test.ts` uses for `ios/App/*.swift`: the
// point is that the next edit cannot silently move the layout again.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SHIPPED_SKINS, tvFaceSkinDir } from "./TVFaceAvatar";
import { TVFACE_SHEET_EXPRESSIONS } from "./manifest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const ios = source("ios/App/TVFaceAvatar.swift");
const manifest = source("ios/App/TVFaceManifest.swift");
const mascot = source("ios/App/MascotState.swift");
const demo = source("public/tv-face/fleet-live.html");

describe("the iOS player resolves the same pack layout as the demo", () => {
  it("treats botfleet-skins/{color} as the primary FleetLink root", () => {
    // The demo's `packBase`.  The old iOS code pointed `baseURL` at the legacy
    // `botfleet` tree instead, so the app and the demo disagreed on the only
    // path that decides whether a color pack is reachable.
    expect(demo).toContain('const CDN_SKINS = "https://fleetlink.online/TV-Face/botfleet-skins"');
    expect(ios).toContain('return URL(string: "https://fleetlink.online/TV-Face/botfleet-skins")!');
  });

  it("keeps botfleet/{color} only as a retry, never as the primary", () => {
    // The demo's `packBaseFallback`.  It has to stay reachable — a color pack
    // that has not been mirrored into `botfleet-skins/` still lives here — but
    // it must be the second root tried, not the first.
    expect(demo).toContain('const CDN = "https://fleetlink.online/TV-Face/botfleet"');
    expect(demo).toContain("return `${CDN_SKINS}/${color}`");
    expect(demo).toContain("return `${CDN}/${color}`");
    expect(ios).toContain('URL(string: "https://fleetlink.online/TV-Face/botfleet")!.appendingPathComponent(skin)');
    // Order matters: the skins root is appended first in the array.
    expect(ios.indexOf("baseURL.appendingPathComponent(skin)"))
      .toBeLessThan(ios.indexOf('URL(string: "https://fleetlink.online/TV-Face/botfleet")!'));
  });

  it("leaves the default (orange) pack at the root, with no color segment", () => {
    // Mirrors the demo: `if (color === "orange") return CDN;`  A `/default/`
    // segment on the orange pack is a 404 on every frame.
    expect(demo).toContain('if (color === "orange") return CDN');
    expect(ios).toContain('if skin == "default" { return [baseURL] }');
  });

  it("uses the same still and GIF filenames as the demo", () => {
    expect(demo).toContain("return `${base}/stills/${state}.png`");
    expect(demo).toContain("return `${base}/gifs/${state}_${kind}.gif`");
    expect(ios).toContain('"stills/\\(expression.rawValue).png"');
    expect(ios).toContain('"gifs/\\(expression.rawValue)_\\(kind.rawValue).gif"');
  });
});

describe("nothing interpolated into a pack path can escape the pack", () => {
  it("keeps the iOS skin vocabulary a closed set", () => {
    // `skinDir` is the only untrusted value that reaches `appendingPathComponent`.
    // An unknown or hostile color has to collapse to "default", never pass
    // through as a path segment.
    expect(manifest).toContain('if color == "orange" || !shipped.contains(color) { return "default" }');
  });

  it("agrees with the web player on which color maps to which directory", () => {
    const start = manifest.indexOf("let shipped: Set<String>");
    const shippedBlock = manifest.slice(start, manifest.indexOf("]", start));
    expect(shippedBlock, "the iOS shipped-color set was not found").toContain("let shipped");
    for (const color of SHIPPED_SKINS) {
      // Same mapping in both places, read off the source the iOS player uses.
      expect(shippedBlock, `web maps ${color} to ${tvFaceSkinDir(color)} but iOS does not list it`).toContain(`"${color}"`);
    }
  });

  it("keeps every expression name a legal filename on both sides", () => {
    // `powering-down` is a BotState with a hyphen while `powering_down` is an
    // expression with an underscore, so a rename on either side silently 404s.
    for (const expression of TVFACE_SHEET_EXPRESSIONS) {
      expect(expression, `expression "${expression}" is not a safe filename`).toMatch(/^[a-z][a-z_]*$/);
    }
    // The iOS enum is deliberately a superset (it also carries the transition
    // faces), so the direction that matters is: every face the web can select
    // must be constructible on the phone, or the two build different paths.
    const declared = manifest.slice(manifest.indexOf("public enum TVFaceExpression"), manifest.indexOf("\n}"));
    for (const expression of TVFACE_SHEET_EXPRESSIONS) {
      expect(declared, `the web selects "${expression}" but the iOS player cannot name it`).toContain(` ${expression}`);
    }
  });
});

describe("the iOS fallback chain does not re-issue a miss", () => {
  it("records the resolution under every URL that missed", () => {
    // The packs ship a hold GIF for only a dozen faces, so the other ~30 sheet
    // faces miss their hold GIF by design.  Caching only successes meant that
    // guaranteed 404 was re-fetched on every single state change.
    expect(ios).toContain("for missed in urls[..<index] { Self.cache(missed, data) }");
  });

  it("walks the same order as the demo: requested frame, still, then resting", () => {
    expect(ios).toContain("var frames: [(TVFaceExpression, TVFaceFrameKind)] = [(expression, kind)]");
    expect(ios).toContain("if kind != .still { frames.append((expression, .still)) }");
    expect(ios).toContain("frames.append((.resting, .still))");
  });

  it("shares one bounded cache instead of pinning a pack per avatar row", () => {
    // `TVFacePlayer` is created per view through `@StateObject`, so a
    // per-player dictionary held N copies of every pack for N visible rows and
    // fetched each pack once per row, with nothing ever released.
    expect(ios).toContain("private static var sharedCache: [URL: Data] = [:]");
    expect(ios).toContain("private static let sharedCacheByteCeiling");
    expect(ios).toContain("while sharedCacheBytes > sharedCacheByteCeiling");
    expect(ios).not.toContain("private var cache: [URL: Data] = [:]");
  });
});

describe("every iOS face keyword is reachable", () => {
  it("never lists a phrase an earlier branch already claims", () => {
    // `forBot` walks a fixed list of `if matches([...]) { return .face }`
    // branches and returns on the first hit, and `matches` tests the profile
    // with \b<keyword>\b.  So a later keyword is dead whenever an earlier
    // keyword is a contiguous sub-phrase of it: every profile that satisfies
    // the later one also satisfies the earlier one.  The `.sneaking` branch
    // listed "background agent" while the `.drowsy` branch above it already
    // claimed "background", so the face this PR added was unreachable for
    // exactly the role it was added for.
    const branches = [...mascot.matchAll(/if matches\(\[(.*?)\]\) \{ return \.(\w+)/g)];
    expect(branches.length, "no face keyword branches were parsed").toBeGreaterThan(0);
    const claimed: { keyword: string; face: string }[] = [];
    for (const [, words, face] of branches) {
      for (const keyword of [...words.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
        const parts = keyword.split(" ");
        const owner = claimed.find((c) => {
          const earlier = c.keyword.split(" ");
          return (
            c.face !== face &&
            parts.some((_, at) => parts.slice(at, at + earlier.length).join(" ") === c.keyword)
          );
        });
        expect(
          owner,
          `".${face}" lists "${keyword}", but it can never be reached: .${owner?.face} already claims "${owner?.keyword}"`,
        ).toBeUndefined();
        claimed.push({ keyword, face });
      }
    }
  });
});

describe("the demo player does not download a GIF twice", () => {
  it("probes with HEAD, so the existence check transfers no body", () => {
    // The probe used to `fetch(url, { method: "GET" })`, discard the body, and
    // then let `show()` fetch the identical URL again to decode it.
    expect(demo).toContain('await fetch(candidate.url, { method: "HEAD", mode: "cors" })');
    expect(demo).not.toContain('await fetch(candidate.url, { method: "GET", mode: "cors" })');
  });

  it("skips a candidate only on a definitive absence", () => {
    // Anything other than 404/410 falls through to `show()`, which fetches for
    // real and reports a miss by throwing — so a server that refuses HEAD
    // cannot silently drop every GIF on the page.
    expect(demo).toContain("if (head && (head.status === 404 || head.status === 410)) continue;");
  });
});

describe("the demo player never lets a stale step tear down a newer one", () => {
  it("cancels the running loop only after the new asset is in hand", () => {
    // `show()` used to `cancelAnimationFrame` before awaiting.  A slow, stale
    // step that entered `show()` last bumped the token itself, so its own
    // `my !== this.token` guard passed: it killed the newer step's hold loop
    // and painted its own finished enter GIF, which then stayed on screen
    // because `apply()` short-circuits on the newer key.
    const show = demo.slice(demo.indexOf("async show(url, kind"), demo.indexOf("console.warn(\"face load failed\""));
    // Token bump first, then the awaits, and only then the cancel — in both
    // the still branch and the GIF branch.
    expect(show.indexOf("const my = ++this.token;"))
      .toBeLessThan(show.indexOf("const img = await loadStill(url);"));
    expect(show.indexOf("const img = await loadStill(url);"))
      .toBeLessThan(show.indexOf("if (this.raf) cancelAnimationFrame(this.raf);"));
    const gifBranch = show.slice(show.indexOf("const gif = await loadGif(url);"));
    expect(gifBranch.indexOf("if (my !== this.token || !isCurrent()) return;"))
      .toBeLessThan(gifBranch.indexOf("if (this.raf) cancelAnimationFrame(this.raf);"));
  });

  it("re-checks the caller's current step after every await", () => {
    expect(demo).toContain("const isCurrent = () => card.cur === key && card.gen === gen;");
    expect(demo).toContain("if (my !== this.token || !isCurrent()) return;");
    expect(demo).toContain("await card.player.show(candidate.url, candidate.kind, isCurrent);");
  });

  it("keeps the three copies of the demo byte-identical", () => {
    // `public/tv-face/fleet-demo.html` and `docs/fleet-demo.html` are copies of
    // `public/tv-face/fleet-live.html`.  Fixing one and not the others is how
    // the fleet-live restoration drifted in the first place.
    for (const copy of ["public/tv-face/fleet-demo.html", "docs/fleet-demo.html"]) {
      expect(source(copy), `${copy} has drifted from public/tv-face/fleet-live.html`).toBe(demo);
    }
  });
});
