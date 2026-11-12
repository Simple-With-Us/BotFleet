import { describe, expect, it, vi } from "vitest";

import {
  TEAM_LIBRARY_NOT_CONFIGURED,
  fetchGithubTeam,
  fetchLibraryTeam,
  fetchTeamCatalog,
  githubManifestUrls,
  parseTeamCatalog,
  parseTeamLibraryRepository,
  teamLibrarySource,
} from "./team-library.ts";

const source = parseTeamLibraryRepository("https://github.com/acme/botfleet-teams")!;

const manifest = {
  format: "botfleet.team",
  version: 2,
  team: {
    name: "Engineering",
    members: [
      {
        key: "lead",
        name: "Ada",
        title: "Tech Lead",
        description: "Coordinates the work",
        appearance: { color: "purple" },
      },
    ],
  },
};

const catalog = {
  format: "botfleet.catalog",
  version: 1,
  teams: [
    {
      slug: "engineering",
      name: "Engineering Team",
      summary: "Plan and ship software.",
      category: "Engineering",
      manifest: "teams/engineering/team.mausteam.json",
      readme: "teams/engineering/README.md",
      members: 1,
      skills: ["teams/engineering/skills/release/SKILL.md"],
      requires: { apps: ["GitHub"] },
    },
  ],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("team library", () => {
  it("has no built-in catalog host and only accepts a public GitHub repository", () => {
    // The repository this build used to name does not exist; nothing may be
    // fetched from a guessed host.
    expect(teamLibrarySource({})).toBeNull();
    expect(teamLibrarySource({ OMB_TEAM_LIBRARY_REPOSITORY: "" })).toBeNull();
    expect(parseTeamLibraryRepository("https://github.com/acme/botfleet-teams")).toEqual({
      repositoryUrl: "https://github.com/acme/botfleet-teams",
      rawRoot: "https://raw.githubusercontent.com/acme/botfleet-teams/main",
      catalogUrl: "https://raw.githubusercontent.com/acme/botfleet-teams/main/catalog.json",
    });
    expect(parseTeamLibraryRepository("https://github.com/acme/botfleet-teams.git/#release/v2")?.rawRoot).toBe(
      "https://raw.githubusercontent.com/acme/botfleet-teams/release/v2",
    );
    for (const bad of [
      "http://github.com/acme/botfleet-teams",
      "https://gitlab.com/acme/botfleet-teams",
      "https://github.com/acme",
      "https://github.com/acme/teams/tree/main",
      "https://user:pw@github.com/acme/teams",
      "https://github.com/acme/teams#../../evil",
    ]) {
      expect(parseTeamLibraryRepository(bad)).toBeNull();
    }
  });

  it("fails soft when the library is not configured", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(fetchTeamCatalog(fetcher, null)).resolves.toEqual({
      format: "botfleet.catalog",
      version: 1,
      repositoryUrl: "",
      configured: false,
      teams: [],
    });
    await expect(fetchLibraryTeam("engineering", fetcher, null)).rejects.toMatchObject({
      message: TEAM_LIBRARY_NOT_CONFIGURED,
      status: 404,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates catalog paths and adds the configured repository URL", () => {
    const parsed = parseTeamCatalog(catalog, source.repositoryUrl);
    expect(parsed.repositoryUrl).toBe("https://github.com/acme/botfleet-teams");
    expect(parsed.configured).toBe(true);
    expect(parsed.teams[0]).toMatchObject({ slug: "engineering", members: 1 });

    const unsafe = structuredClone(catalog);
    unsafe.teams[0]!.manifest = "../private.json";
    expect(() => parseTeamCatalog(unsafe, source.repositoryUrl)).toThrow("safe catalog path");
  });

  it("loads only the manifest selected by the configured catalog", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === source.catalogUrl) return response(catalog);
      if (target === `${source.rawRoot}/teams/engineering/team.mausteam.json`) return response(manifest);
      return response({}, 404);
    }) as unknown as typeof fetch;

    const loaded = await fetchLibraryTeam("engineering", fetcher, source);
    if (loaded.format !== "botfleet.team") throw new Error("expected a legacy team");
    expect(loaded.team.name).toBe("Engineering");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes public GitHub repository, blob, and raw links", () => {
    expect(githubManifestUrls("https://github.com/acme/team")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/main/team.md",
      "https://raw.githubusercontent.com/acme/team/main/team.mausteam.json",
      "https://raw.githubusercontent.com/acme/team/master/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/master/team.md",
      "https://raw.githubusercontent.com/acme/team/master/team.mausteam.json",
    ]);
    expect(githubManifestUrls("https://github.com/acme/team/blob/main/presets/seo.mausteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/presets/seo.mausteam.json",
    ]);
    expect(githubManifestUrls("https://raw.githubusercontent.com/acme/team/main/team.mausteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/team.mausteam.json",
    ]);
    expect(() => githubManifestUrls("http://example.com/team.json")).toThrow("public HTTPS GitHub");
    expect(() => githubManifestUrls("https://github.com/acme/team/blob/main/run.sh")).toThrow("Markdown playbook");
  });

  it("falls back from main to master for a repository link", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("team.mausteam.json") && String(url).includes("/master/")
        ? response(manifest)
        : response({}, 404),
    ) as unknown as typeof fetch;

    const loaded = await fetchGithubTeam("https://github.com/acme/team", fetcher);
    if (loaded.format !== "botfleet.team") throw new Error("expected a legacy team");
    expect(loaded.team.members[0]?.name).toBe("Ada");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
