import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Reject an existing tag unless its peeled commit is the pinned build source. */
export async function verifyReleaseTag({ repo, tag, sha, request }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error("Invalid pinned release identity");
  }
  const base = `repos/${repo}/git`;
  const ref = await request(`${base}/ref/tags/${tag}`);
  if (ref.status === 404) return { exists: false };
  if (ref.status !== 200) throw new Error(`Cannot verify release tag (HTTP ${ref.status})`);
  let object = ref.body?.object;
  const visited = new Set();
  for (let depth = 0; depth < 16; depth++) {
    if (!/^[a-f0-9]{40}$/i.test(object?.sha ?? "")) throw new Error("Invalid release tag object");
    if (object.type === "commit") {
      if (object.sha.toLowerCase() !== sha.toLowerCase()) throw new Error("Release tag targets a different commit than the pinned build");
      return { exists: true };
    }
    if (object.type !== "tag" || visited.has(object.sha)) throw new Error("Invalid release tag chain");
    visited.add(object.sha);
    const annotated = await request(`${base}/tags/${object.sha}`);
    if (annotated.status !== 200) throw new Error(`Cannot peel release tag (HTTP ${annotated.status})`);
    object = annotated.body?.object;
  }
  throw new Error("Release tag chain is too deep");
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  try {
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error("GH_TOKEN is required to verify the release tag");
    await verifyReleaseTag({
      repo: process.env.RELEASES_REPO,
      tag: `v${process.env.VERSION}`,
      sha: process.env.SHA,
      request: async (path) => {
        const response = await fetch(`https://api.github.com/${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
      },
    });
    console.log("Release tag matches the pinned source or is absent");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release tag verification failed");
    process.exitCode = 1;
  }
}
