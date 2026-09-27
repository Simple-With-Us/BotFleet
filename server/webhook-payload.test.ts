import { describe, expect, it } from "vitest";

import type { JsonValue } from "./schema.ts";
import {
  isAscWebhookPayload,
  isCoolifyWebhookPayload,
  isGithubWebhookPayload,
  isPagerDutyWebhookPayload,
  isSentryWebhookPayload,
  serializeWebhookPayload,
  slimWebhookPayload,
} from "./webhook-payload.ts";

function fatGithubCheckRun(): Record<string, JsonValue> {
  const urlFarm = {
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    gravatar_id: "",
    url: "https://api.github.com/users/jaywedgeworth22",
    html_url: "https://github.com/jaywedgeworth22",
    followers_url: "https://api.github.com/users/jaywedgeworth22/followers",
    following_url: "https://api.github.com/users/jaywedgeworth22/following{/other_user}",
    gists_url: "https://api.github.com/users/jaywedgeworth22/gists{/gist_id}",
    starred_url: "https://api.github.com/users/jaywedgeworth22/starred{/owner}{/repo}",
    subscriptions_url: "https://api.github.com/users/jaywedgeworth22/subscriptions",
    organizations_url: "https://api.github.com/users/jaywedgeworth22/orgs",
    repos_url: "https://api.github.com/users/jaywedgeworth22/repos",
    events_url: "https://api.github.com/users/jaywedgeworth22/events{/privacy}",
    received_events_url: "https://api.github.com/users/jaywedgeworth22/received_events",
    site_admin: false,
  };
  const owner = { login: "jaywedgeworth22", id: 1, type: "User", ...urlFarm };
  const repository = {
    id: 99,
    node_id: "R_kgDO",
    name: "Socratic.Trade",
    full_name: "jaywedgeworth22/Socratic.Trade",
    private: true,
    fork: false,
    default_branch: "main",
    html_url: "https://github.com/jaywedgeworth22/Socratic.Trade",
    description: "x".repeat(400),
    owner,
    url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade",
    forks_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/forks",
    keys_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/keys{/key_id}",
    collaborators_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/collaborators{/collaborator}",
    teams_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/teams",
    hooks_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/hooks",
    issue_events_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/issues/events{/number}",
    events_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/events",
    assignees_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/assignees{/user}",
    branches_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/branches{/branch}",
    tags_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/tags",
    blobs_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/git/blobs{/sha}",
    git_tags_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/git/tags{/sha}",
    git_refs_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/git/refs{/sha}",
    trees_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/git/trees{/sha}",
    statuses_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/statuses/{sha}",
    languages_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/languages",
    stargazers_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/stargazers",
    contributors_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/contributors",
    subscribers_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/subscribers",
    subscription_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/subscription",
    commits_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/commits{/sha}",
    git_commits_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/git/commits{/sha}",
    comments_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/comments{/number}",
    issue_comment_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/issues/comments{/number}",
    contents_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/contents/{+path}",
    compare_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/compare/{base}...{head}",
    merges_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/merges",
    archive_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/{archive_format}{/ref}",
    downloads_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/downloads",
    issues_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/issues{/number}",
    pulls_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/pulls{/number}",
    milestones_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/milestones{/number}",
    notifications_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/notifications{?since,all,participating}",
    labels_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/labels{/name}",
    releases_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/releases{/id}",
    deployments_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/deployments",
  };
  return {
    action: "completed",
    check_run: {
      id: 104631067992,
      name: "verify",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/jaywedgeworth22/Socratic.Trade/runs/1",
      details_url: "https://github.com/jaywedgeworth22/Socratic.Trade/actions",
      started_at: "2026-09-16T05:00:00Z",
      completed_at: "2026-09-16T05:00:04Z",
      head_sha: "fead2d2952a3e2e4728cf09a13a642374741dd7b",
      output: {
        title: "verify",
        summary: "failed",
        text: "log ".repeat(50_000),
        annotations_count: 0,
        annotations_url: "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/check-runs/1/annotations",
      },
      check_suite: { id: 9, head_sha: "fead2d2952a3e2e4728cf09a13a642374741dd7b", head_branch: "main" },
    },
    repository,
    sender: { login: "github-actions[bot]", id: 2, type: "Bot", ...urlFarm },
    organization: { login: "unused-org", id: 3, ...urlFarm },
  };
}

describe("slimWebhookPayload", () => {
  it("keeps compile-gate fields and drops GitHub URL farms and check logs", () => {
    const fat = fatGithubCheckRun();
    const raw = JSON.stringify(fat);
    expect(raw.length).toBeGreaterThan(200_000);
    expect(isGithubWebhookPayload(fat)).toBe(true);

    const slim = slimWebhookPayload(fat) as Record<string, JsonValue>;
    const text = serializeWebhookPayload(fat);
    expect(text.length).toBeLessThan(2_000);
    expect(text).not.toContain("\n  ");
    expect(slim.action).toBe("completed");
    expect((slim.check_run as Record<string, JsonValue>).name).toBe("verify");
    expect((slim.check_run as Record<string, JsonValue>).conclusion).toBe("failure");
    expect((slim.check_run as Record<string, JsonValue>).head_sha).toBe(
      "fead2d2952a3e2e4728cf09a13a642374741dd7b",
    );
    expect(slim.check_run).not.toHaveProperty("output");
    expect((slim.repository as Record<string, JsonValue>).full_name).toBe("jaywedgeworth22/Socratic.Trade");
    expect((slim.repository as Record<string, JsonValue>).default_branch).toBe("main");
    expect(slim.sender).toEqual({ login: "github-actions[bot]", type: "Bot", id: 2 });
    expect(JSON.stringify(slim)).not.toContain("followers_url");
    expect(JSON.stringify(slim)).not.toContain("log log");
  });

  it("keeps PR merged and merge_commit_sha", () => {
    const payload = {
      action: "closed",
      pull_request: {
        number: 3351,
        title: "Fix signin destination",
        html_url: "https://github.com/jaywedgeworth22/Socratic.Trade/pull/3351",
        state: "closed",
        merged: true,
        merge_commit_sha: "fead2d2952a3e2e4728cf09a13a642374741dd7b",
        draft: false,
        user: { login: "jaywedgeworth22", type: "User", id: 1, avatar_url: "https://example/a" },
        base: { ref: "main", sha: "abc", repo: { full_name: "jaywedgeworth22/Socratic.Trade", default_branch: "main" } },
        head: { ref: "ag/fix", sha: "def", repo: { full_name: "jaywedgeworth22/Socratic.Trade" } },
      },
      repository: { full_name: "jaywedgeworth22/Socratic.Trade", default_branch: "main", name: "Socratic.Trade" },
      sender: { login: "jaywedgeworth22", type: "User", id: 1 },
    };
    const slim = slimWebhookPayload(payload) as Record<string, JsonValue>;
    const pr = slim.pull_request as Record<string, JsonValue>;
    expect(slim.action).toBe("closed");
    expect(pr.merged).toBe(true);
    expect(pr.merge_commit_sha).toBe("fead2d2952a3e2e4728cf09a13a642374741dd7b");
    expect((pr.base as Record<string, JsonValue>).ref).toBe("main");
    expect(JSON.stringify(slim)).not.toContain("avatar_url");
  });

  it("keeps GitHub push pusher name and email", () => {
    const payload = {
      ref: "refs/heads/main",
      after: "abc123",
      before: "def456",
      forced: false,
      pusher: { name: "jaywedgeworth22", email: "jaywedgeworth22@users.noreply.github.com" },
      sender: { login: "jaywedgeworth22", type: "User", id: 1, avatar_url: "https://example/a" },
      repository: { full_name: "jaywedgeworth22/BotFleet", name: "BotFleet", default_branch: "main" },
    };
    const slim = slimWebhookPayload(payload) as Record<string, JsonValue>;
    expect(slim.pusher).toEqual({
      name: "jaywedgeworth22",
      email: "jaywedgeworth22@users.noreply.github.com",
    });
    expect(slim.sender).toEqual({ login: "jaywedgeworth22", type: "User", id: 1 });
    expect(slim.ref).toBe("refs/heads/main");
    expect(JSON.stringify(slim)).not.toContain("avatar_url");
  });

  it("preserves commit status fields in slimmed GitHub payload", () => {
    const payload = {
      state: "failure",
      sha: "70dbcd702ce3e4bc60b354b977517b979c3aa547",
      context: "continuous-integration/travis-ci",
      description: "Build failed on x86_64",
      target_url: "https://ci.example.com/build/123",
      repository: { full_name: "jaywedgeworth22/BotFleet", name: "BotFleet", default_branch: "main" },
    };
    const slim = slimWebhookPayload(payload) as Record<string, JsonValue>;
    expect(slim.state).toBe("failure");
    expect(slim.sha).toBe("70dbcd702ce3e4bc60b354b977517b979c3aa547");
    expect(slim.context).toBe("continuous-integration/travis-ci");
    expect(slim.description).toBe("Build failed on x86_64");
    expect(slim.target_url).toBe("https://ci.example.com/build/123");
  });

  it("budgets unknown JSON by dropping heavy keys and capping depth", () => {
    const payload = {
      lead: "Ada",
      note: "important body text",
      body_html: "<p>".repeat(5_000),
      attachments: [{ name: "big.bin", data: "x".repeat(20_000) }],
      headers: { cookie: "secret" },
      nested: { deep: { deeper: { deepest: { value: "ok" } } } },
    };
    expect(isGithubWebhookPayload(payload)).toBe(false);
    const slim = slimWebhookPayload(payload) as Record<string, JsonValue>;
    expect(slim.lead).toBe("Ada");
    expect(slim.note).toBe("important body text");
    expect(slim).not.toHaveProperty("body_html");
    expect(slim).not.toHaveProperty("attachments");
    expect(slim).not.toHaveProperty("headers");
    expect(serializeWebhookPayload(payload)).toContain("important body text");
    expect(serializeWebhookPayload(payload)).not.toContain("<p><p>");
  });


  it("routes root JSON arrays through the generic budget", () => {
    const payload: JsonValue = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      body_html: "<p>".repeat(100),
      note: `item-${i}`,
    }));
    const slim = slimWebhookPayload(payload) as JsonValue[];
    expect(Array.isArray(slim)).toBe(true);
    expect(slim.length).toBeLessThanOrEqual(21); // 20 + omission marker
    expect(JSON.stringify(slim)).not.toContain("<p><p>");
    expect(JSON.stringify(slim)).toContain("item-0");
  });
  it("applies the depth limit before descending into nested arrays", () => {
    // Six levels of arrays would previously recurse past GENERIC_MAX_DEPTH
    // because the depth guard ran only on objects.
    let nested: JsonValue = "leaf";
    for (let i = 0; i < 10; i++) nested = [nested];
    const payload = { wrap: nested };
    const slim = slimWebhookPayload(payload) as Record<string, JsonValue>;
    const serialized = JSON.stringify(slim);
    expect(serialized).toContain("nested array omitted");
    expect(serialized).not.toContain('"leaf"');
  });

  it("does not classify bare generic events as Coolify without provider markers", () => {
    for (const event of ["test", "status_changed", "deployment_success"]) {
      const generic = { event, note: "important status details", status: "ok" };
      expect(isCoolifyWebhookPayload(generic)).toBe(false);
      const slim = slimWebhookPayload(generic) as Record<string, JsonValue>;
      // Falls through to generic budget — retains status details, not Coolify allowlist-only.
      expect(slim.note).toBe("important status details");
      expect(slim.status).toBe("ok");
      expect(serializeWebhookPayload(generic)).toContain("important status details");
    }
  });

  it("still classifies Coolify when event is paired with Coolify markers", () => {
    const payload = {
      event: "status_changed",
      application_uuid: "app-uuid-1",
      application_name: "socratic-trade",
      deployment_uuid: "deploy-uuid-1",
      status: "running",
      note: "should slim via Coolify path",
      logs: "huge ".repeat(5_000),
    };
    expect(isCoolifyWebhookPayload(payload)).toBe(true);
    const slim = slimWebhookPayload(payload) as Record<string, JsonValue>;
    expect(slim.event).toBe("status_changed");
    expect(slim.application_name).toBe("socratic-trade");
    expect(JSON.stringify(slim)).not.toContain("huge ");
  });

  it("slims a Coolify deployment webhook to actionable fields", () => {
    const fatCoolify = {
      success: true,
      event: "deployment_success",
      message: "New version successfully deployed",
      application_name: "socratic-trade",
      application_uuid: "app-uuid-1",
      deployment_uuid: "deploy-uuid-1",
      deployment_url: "https://coolify.example/project/p/env/e/app/a/deployment/d",
      project: "Production",
      environment: "main",
      fqdn: "https://socratictrade.com",
      logs: "build log ".repeat(10_000),
      docker: { config: { env: { SECRET: "hidden" }, labels: { a: "b".repeat(5_000) } } },
    };
    expect(isCoolifyWebhookPayload(fatCoolify)).toBe(true);
    const slim = slimWebhookPayload(fatCoolify) as Record<string, JsonValue>;
    expect(slim.event).toBe("deployment_success");
    expect(slim.application_name).toBe("socratic-trade");
    expect(slim.deployment_uuid).toBe("deploy-uuid-1");
    expect(slim.fqdn).toBe("https://socratictrade.com");
    expect(JSON.stringify(slim)).not.toContain("build log");
    expect(JSON.stringify(slim)).not.toContain("SECRET");
    expect(serializeWebhookPayload(fatCoolify).length).toBeLessThan(1_000);
  });

  it("slims an App Store Connect webhook and drops certificate blobs", () => {
    const fatAsc: JsonValue = {
      data: {
        type: "buildUploadStateUpdated",
        id: "evt-1",
        version: 1,
        attributes: {
          oldState: "PROCESSING",
          newState: "COMPLETE",
          timestamp: "2026-09-21T12:00:00Z",
          cfBundleShortVersionString: "1.0.31",
          cfBundleVersion: "202609211200",
        },
        relationships: {
          instance: { data: { type: "buildUploads", id: "upload-1" } },
        },
      },
      included: [
        {
          type: "apps",
          id: "app-1",
          attributes: { name: "BotFleet", bundleId: "app.botfleet.ios" },
        },
        {
          type: "certificates",
          id: "cert-1",
          attributes: { certificateContent: "MIIF".repeat(5_000) },
        },
      ],
      signedPayload: "eyJ".repeat(5_000),
    };
    expect(isAscWebhookPayload(fatAsc)).toBe(true);
    const slim = slimWebhookPayload(fatAsc) as Record<string, JsonValue>;
    const data = slim.data as Record<string, JsonValue>;
    expect(data.type).toBe("buildUploadStateUpdated");
    expect((data.attributes as Record<string, JsonValue>).newState).toBe("COMPLETE");
    expect((data.attributes as Record<string, JsonValue>).cfBundleVersion).toBe("202609211200");
    expect((slim.data as Record<string, JsonValue>).app).toEqual({ name: "BotFleet", bundleId: "app.botfleet.ios" });
    expect(JSON.stringify(slim)).not.toContain("MIIF");
    expect(JSON.stringify(slim)).not.toContain("eyJeyJ");
    expect(serializeWebhookPayload(fatAsc).length).toBeLessThan(1_500);
  });

  it("does not classify unrelated payloads with an incident property as PagerDuty without an event marker", () => {
    const generic = {
      messages: [{ incident: { id: "custom-id" }, body: "important body text" }],
    };
    expect(isPagerDutyWebhookPayload(generic)).toBe(false);
    expect((slimWebhookPayload(generic) as Record<string, JsonValue>).messages).toBeDefined();
    expect(serializeWebhookPayload(generic)).toContain("important body text");
  });

  it("does not treat a Sentry issue payload as GitHub", () => {
    const payload = {
      action: "unresolved",
      data: {
        issue: {
          title: "Cron failure",
          shortId: "FLEET-1",
          permalink: "https://jays-services.sentry.io/issues/101/",
          project: { slug: "fleet-infra" },
        },
      },
    };
    expect(isGithubWebhookPayload(payload)).toBe(false);
    expect(isSentryWebhookPayload(payload)).toBe(true);
    expect(serializeWebhookPayload(payload)).toContain("fleet-infra");
  });

  it("does not classify generic issue payloads as Sentry without provider-exclusive markers", () => {
    const generic = {
      data: { issue: { project: { id: "p" }, title: "Alert", details: { foo: "bar" } } },
    };
    expect(isSentryWebhookPayload(generic)).toBe(false);
    expect(slimWebhookPayload(generic)).toEqual(generic);
    // culprit reads Sentry-ish but is not provider-exclusive — generic
    // issue trackers carry one — so it must not mark the payload.
    const culpritOnly = {
      data: { issue: { title: "Alert", culprit: "src/jobs/nightly.ts in run" } },
    };
    expect(isSentryWebhookPayload(culpritOnly)).toBe(false);
    expect(slimWebhookPayload(culpritOnly)).toEqual(culpritOnly);

    // shortId is also used by generic issue trackers — without a validated
    // sentry.io URL, actor, or installation, it must not mark the payload as Sentry.
    const shortIdOnly = {
      data: { issue: { shortId: "INC-7", summary: "Failure", details: { foo: "bar" } } },
    };
    expect(isSentryWebhookPayload(shortIdOnly)).toBe(false);
    expect(slimWebhookPayload(shortIdOnly)).toEqual(shortIdOnly);

    // event_id is generic across event systems — without a sentry.io URL or
    // Sentry actor/installation, it must not mark the payload as Sentry.
    const eventIdOnly = {
      event: { event_id: "12345", message: "Alert", details: { extra: "data" } },
    };
    expect(isSentryWebhookPayload(eventIdOnly)).toBe(false);
    expect(slimWebhookPayload(eventIdOnly)).toEqual(eventIdOnly);

    // URLs with non-Sentry hostnames must not classify the payload as Sentry.
    const fakeUrl = {
      event: { url: "https://not-sentry.io/events/1", details: { secret: 123 } },
    };
    expect(isSentryWebhookPayload(fakeUrl)).toBe(false);
    expect(slimWebhookPayload(fakeUrl)).toEqual(fakeUrl);

    const docsUrl = {
      data: { issue: { permalink: "https://example.com/docs/sentry.io", details: { secret: 123 } } },
    };
    expect(isSentryWebhookPayload(docsUrl)).toBe(false);
    expect(slimWebhookPayload(docsUrl)).toEqual(docsUrl);
    expect(serializeWebhookPayload(generic)).toContain("foo");
  });

  it("slims a fat Sentry issue webhook and drops breadcrumbs and raw headers", () => {
    const fatSentry = {
      action: "unresolved",
      installation: { uuid: "fb6490f9-7a4b-4a4a-a167-b48b1232d85f" },
      actor: { type: "application", id: "sentry", name: "Sentry" },
      data: {
        issue: {
          id: "7669443788",
          shortId: "SOCRATIC-TRADE-1Y",
          title: "robinhood-broker connection failed",
          culprit: "src/broker/robinhood.ts in connect",
          level: "warning",
          status: "unresolved",
          substatus: "regressed",
          permalink: "https://jays-services.sentry.io/issues/7669443788/",
          project: { id: "4511650513158144", name: "agentic-trading", slug: "socratic-trade", platform: "javascript-nextjs" },
          count: "3",
          userCount: 0,
          firstSeen: "2026-08-13T07:38:38Z",
          lastSeen: "2026-09-21T22:52:10Z",
          priority: "medium",
          seerFixabilityScore: 0.85,
          breadcrumbs: Array.from({ length: 50 }, (_, i) => ({ timestamp: i, category: "xhr", message: "verbose log ".repeat(20) })),
          request: { headers: { cookie: "secret=123", authorization: "Bearer xyz" }, env: { PATH: "/bin" } },
        },
      },
    };
    expect(isSentryWebhookPayload(fatSentry)).toBe(true);
    expect(isGithubWebhookPayload(fatSentry)).toBe(false);

    const slim = slimWebhookPayload(fatSentry) as Record<string, JsonValue>;
    const issue = slim.issue as Record<string, JsonValue>;
    expect(slim.action).toBe("unresolved");
    expect(slim.actor).toEqual({ type: "application", id: "sentry", name: "Sentry" });
    expect(issue.shortId).toBe("SOCRATIC-TRADE-1Y");
    expect(issue.title).toBe("robinhood-broker connection failed");
    expect(issue.level).toBe("warning");
    expect(issue.culprit).toBe("src/broker/robinhood.ts in connect");
    expect((issue.project as Record<string, JsonValue>).slug).toBe("socratic-trade");
    expect(issue.seerFixabilityScore).toBe(0.85);
    expect(JSON.stringify(slim)).not.toContain("verbose log");
    expect(JSON.stringify(slim)).not.toContain("authorization");
    expect(JSON.stringify(slim)).not.toContain("cookie");
    expect(serializeWebhookPayload(fatSentry).length).toBeLessThan(1_500);
  });

  it("slims a PagerDuty incident webhook and keeps essential incident fields", () => {
    const fatPd = {
      event: {
        id: "01D8K47Y5Z",
        event_type: "incident.triggered",
        resource_type: "incident",
        occurred_at: "2026-09-21T20:20:29Z",
        data: {
          id: "Q10L8B6ZWJNGYM",
          number: 175,
          title: "Recurring session/prompt timeout on BotFleet Compiler",
          status: "triggered",
          urgency: "high",
          html_url: "https://jays-services.pagerduty.com/incidents/Q10L8B6ZWJNGYM",
          service: { id: "PXYZ123", name: "BotFleet", summary: "BotFleet Service" },
          assignees: [{ id: "P123", summary: "Jay Wedgeworth" }],
          teams: [{ id: "T1", summary: "Fleet Ops", html_url: "https://example/team" }],
          log_entries: [{ id: "L1", summary: "log details ".repeat(100) }],
        },
      },
    };
    expect(isPagerDutyWebhookPayload(fatPd)).toBe(true);
    expect(isGithubWebhookPayload(fatPd)).toBe(false);

    const slim = slimWebhookPayload(fatPd) as Record<string, JsonValue>;
    const incident = slim.incident as Record<string, JsonValue>;
    expect(slim.event_type).toBe("incident.triggered");
    expect(incident.id).toBe("Q10L8B6ZWJNGYM");
    expect(incident.incident_number).toBe(175);
    expect(incident.urgency).toBe("high");
    expect((incident.service as Record<string, JsonValue>).name).toBe("BotFleet");
    expect(incident.assignees).toEqual([
      { id: "P123", summary: "Jay Wedgeworth", name: "Jay Wedgeworth" },
    ]);
    expect(JSON.stringify(slim)).not.toContain("log details");
    expect(JSON.stringify(slim)).not.toContain("Fleet Ops");
    expect(serializeWebhookPayload(fatPd).length).toBeLessThan(1_000);
  });

  it("preserves non-issue Sentry resources such as metric_alert and custom alert data", () => {
    const sentryMetricAlert = {
      action: "created",
      installation: { uuid: "inst-uuid-42" },
      actor: { type: "application", id: "sentry", name: "Sentry" },
      data: {
        metric_alert: {
          id: "98765",
          title: "High API Error Rate Alert",
          threshold: 50,
          project: { id: "1001", slug: "agentic-trading" },
        },
      },
    };
    expect(isSentryWebhookPayload(sentryMetricAlert)).toBe(true);
    const slim = slimWebhookPayload(sentryMetricAlert) as Record<string, JsonValue>;
    expect(slim.action).toBe("created");
    expect(slim.metric_alert).toEqual({
      id: "98765",
      title: "High API Error Rate Alert",
      threshold: 50,
      project: { id: "1001", slug: "agentic-trading" },
    });
    // One copy only — duplicating under out.data doubled large alerts past
    // MAX_EVENT_CHARS and the serializer sliced them into invalid JSON.
    expect(slim.data).toBeUndefined();
    expect(JSON.stringify(slim).match(/High API Error Rate Alert/g)).toHaveLength(1);
    expect(serializeWebhookPayload(sentryMetricAlert)).toContain("High API Error Rate Alert");
  });

  it("keeps a slim assignedTo so assignment deliveries retain the new owner", () => {
    const assigned = {
      action: "assigned",
      actor: { type: "user", id: "sentry", name: "Jay" },
      data: {
        issue: {
          id: "102",
          shortId: "ST-3",
          title: "Assigned incident for triage",
          level: "error",
          project: { slug: "socratic-trade" },
          assignedTo: {
            type: "user",
            id: "42",
            name: "Ada",
            email: "ada@example.com",
            avatarUrl: "https://gravatar.example.com/avatar/deadbeef",
            flags: { newsletter: false },
          },
        },
      },
    };
    const slim = slimWebhookPayload(assigned) as Record<string, JsonValue>;
    const issue = slim.issue as Record<string, JsonValue>;
    expect(issue.assignedTo).toEqual({
      type: "user",
      id: "42",
      name: "Ada",
      email: "ada@example.com",
    });
    expect(JSON.stringify(issue)).not.toContain("avatarUrl");
  });

  it("retains and slims every message in a multi-incident PagerDuty delivery batch", () => {
    const multiPd = {
      messages: [
        {
          id: "msg-1",
          event: "incident.trigger",
          incident: {
            id: "INC-1",
            number: 101,
            title: "First incident in batch",
            urgency: "high",
            status: "triggered",
            teams: [{ id: "T1", summary: "verbose team ".repeat(20) }],
          },
        },
        {
          id: "msg-2",
          event: "incident.trigger",
          incident: {
            id: "INC-2",
            number: 102,
            title: "Second incident in batch",
            urgency: "low",
            status: "triggered",
            teams: [{ id: "T2", summary: "verbose team ".repeat(20) }],
          },
        },
      ],
    };
    expect(isPagerDutyWebhookPayload(multiPd)).toBe(true);
    const slim = slimWebhookPayload(multiPd) as Record<string, JsonValue>;
    const messages = slim.messages as Record<string, JsonValue>[];
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("msg-1");
    expect((messages[0].incident as Record<string, JsonValue>).title).toBe("First incident in batch");
    expect(messages[1].id).toBe("msg-2");
    expect(JSON.stringify(slim)).not.toContain("verbose team");
    expect(slim.incident).toBeUndefined();
  });

  it("preserves bounded assignees and assignments in PagerDuty incidents", () => {
    const reassignedPd = {
      event: {
        event_type: "incident.reassigned",
        resource_type: "incident",
        agent: {
          id: "PUSER_AG",
          summary: "Auto Escalator",
          type: "user_reference",
          extra: "agent_bloat".repeat(20),
        },
        data: {
          id: "INC-REASSIGN",
          title: "Database failover required",
          status: "acknowledged",
          assignments: [
            {
              at: "2026-09-24T05:00:00Z",
              assignee: {
                id: "PUSER99",
                summary: "Lead SRE",
                type: "user_reference",
                extra_bloat: "x".repeat(500),
              },
            },
          ],
        },
      },
    };
    expect(isPagerDutyWebhookPayload(reassignedPd)).toBe(true);
    const slim = slimWebhookPayload(reassignedPd) as Record<string, JsonValue>;
    expect(slim.agent).toEqual({
      id: "PUSER_AG",
      summary: "Auto Escalator",
      name: "Auto Escalator",
      type: "user_reference",
    });
    const inc = slim.incident as Record<string, JsonValue>;
    expect(inc.title).toBe("Database failover required");
    const assignments = inc.assignments as Record<string, JsonValue>[];
    expect(assignments).toHaveLength(1);
    expect(assignments[0].at).toBe("2026-09-24T05:00:00Z");
    expect(assignments[0].assignee).toEqual({
      id: "PUSER99",
      summary: "Lead SRE",
      name: "Lead SRE",
      type: "user_reference",
    });
    expect(JSON.stringify(slim)).not.toContain("extra_bloat");
    expect(JSON.stringify(slim)).not.toContain("agent_bloat");
  });
  it("does not classify generic event objects with resource_type incident as PagerDuty without event_type marker", () => {
    const generic = {
      event: { resource_type: "incident", data: { id: "x", title: "Alert", details: { foo: "bar" } } },
      note: "important provider note",
    };
    expect(isPagerDutyWebhookPayload(generic)).toBe(false);
    expect((slimWebhookPayload(generic) as Record<string, JsonValue>)).toBeTruthy();
    expect(serializeWebhookPayload(generic)).toContain("important provider note");
  });

  it("does not classify generic modern event envelopes as PagerDuty without provider-exclusive fields", () => {
    const genericModern = {
      event: {
        event_type: "incident.created",
        resource_type: "incident",
        data: { type: "incident", status: "open", details: { custom: "payload" } },
      },
    };
    expect(isPagerDutyWebhookPayload(genericModern)).toBe(false);
    expect((slimWebhookPayload(genericModern) as Record<string, JsonValue>)).toBeTruthy();
    expect(serializeWebhookPayload(genericModern)).toContain("custom");
  });

  it("does not classify payloads with non-PagerDuty URL hostnames as PagerDuty", () => {
    const fakePdUrl = {
      event: { data: { html_url: "https://not-pagerduty.com/incidents/1", details: { foo: "bar" } } },
      note: "important provider note",
    };
    expect(isPagerDutyWebhookPayload(fakePdUrl)).toBe(false);
    expect(slimWebhookPayload(fakePdUrl)).toEqual(fakePdUrl);

    const fakePdDocUrl = {
      messages: [{ incident: { html_url: "https://example.com/docs/pagerduty.com", details: { foo: "bar" } } }],
    };
    expect(isPagerDutyWebhookPayload(fakePdDocUrl)).toBe(false);
    expect(slimWebhookPayload(fakePdDocUrl)).toEqual(fakePdDocUrl);
  });

  it("keeps the newest exceptions in chained Sentry events", () => {
    const chained = {
      action: "created",
      actor: { id: "sentry", name: "Sentry" },
      data: {
        issue: { id: "1", title: "Chained error", url: "https://sentry.io/issues/1" },
        event: {
          exception: {
            values: [
              { type: "RootError", value: "initial failure (oldest)" },
              { type: "MiddleError", value: "intermediate wrap" },
              { type: "SurfacedError", value: "final failure that triggered sentry (newest)" },
            ],
          },
        },
      },
    };
    const slim = slimWebhookPayload(chained) as Record<string, JsonValue>;
    const exceptions = (slim.event as Record<string, JsonValue>).exceptions as Record<string, JsonValue>[];
    expect(exceptions).toHaveLength(2);
    expect(exceptions[0].type).toBe("MiddleError");
    expect(exceptions[1].type).toBe("SurfacedError");
  });

  it("reports omitted_messages count when PagerDuty delivery batches more than ten messages", () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      id: `msg-${i + 1}`,
      event: "incident.trigger",
      incident: { id: `INC-${i + 1}`, title: `Incident ${i + 1}`, status: "triggered" },
    }));
    const payload = { messages };
    const slim = slimWebhookPayload(payload) as Record<string, JsonValue>;
    expect(slim.messages).toHaveLength(10);
    expect(slim.omitted_messages).toBe(5);
  });

  it("preserves bounded PagerDuty incident priority representation", () => {
    const pdPriority = {
      event: {
        event_type: "incident.trigger",
        resource_type: "incident",
        data: {
          id: "INC-PRIORITY",
          title: "Major outage",
          status: "triggered",
          urgency: "high",
          priority: {
            id: "P1",
            name: "P1",
            summary: "P1 - Critical Outage",
            description: "Highest level incident",
          },
        },
      },
    };
    const slim = slimWebhookPayload(pdPriority) as Record<string, JsonValue>;
    const incident = slim.incident as Record<string, JsonValue>;
    expect(incident.priority).toEqual({
      id: "P1",
      summary: "P1 - Critical Outage",
    });
    expect(JSON.stringify(incident)).not.toContain("Highest level incident");
  });

  it("does not classify custom incident payloads without PagerDuty markers as PagerDuty", () => {
    const customIncident = {
      event: {
        event_type: "incident.created",
        data: { id: "1", title: "Alert", details: { foo: "bar", reason: "custom webhook" } },
      },
    };
    expect(isPagerDutyWebhookPayload(customIncident)).toBe(false);
    expect(slimWebhookPayload(customIncident)).toEqual(customIncident);
    expect(serializeWebhookPayload(customIncident)).toContain("custom webhook");
  });

  it("does not classify custom messages payloads without PagerDuty markers as PagerDuty", () => {
    const customBatch = {
      messages: [
        {
          event: "incident.created",
          incident: { id: "1", title: "Alert", details: { foo: "bar", custom: "legacy data" } },
        },
      ],
    };
    expect(isPagerDutyWebhookPayload(customBatch)).toBe(false);
    expect(slimWebhookPayload(customBatch)).toEqual(customBatch);
    expect(serializeWebhookPayload(customBatch)).toContain("legacy data");
  });

  it("preserves legacy PagerDuty created_on occurrence timestamps on messages and incidents", () => {
    const legacyPd = {
      messages: [
        {
          id: "msg-legacy-1",
          event: "incident.trigger",
          created_on: "2026-09-24T08:15:00Z",
          incident: {
            id: "INC-LEGACY",
            number: 109,
            title: "Disk space full",
            status: "triggered",
            urgency: "high",
            created_on: "2026-09-24T08:14:50Z",
            html_url: "https://my-team.pagerduty.com/incidents/INC-LEGACY",
          },
        },
      ],
    };
    expect(isPagerDutyWebhookPayload(legacyPd)).toBe(true);
    const slim = slimWebhookPayload(legacyPd) as Record<string, JsonValue>;
    expect(slim.created_on).toBe("2026-09-24T08:15:00Z");
    const msgs = slim.messages as Record<string, JsonValue>[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].created_on).toBe("2026-09-24T08:15:00Z");
    const inc = msgs[0].incident as Record<string, JsonValue>;
    expect(inc.created_on).toBe("2026-09-24T08:14:50Z");
    expect(inc.created_at).toBe("2026-09-24T08:14:50Z");
  });

  it("does not classify custom messages payloads with generic status as PagerDuty", () => {
    const customPayload = {
      messages: [
        {
          event: "incident.created",
          incident: {
            id: "1",
            status: "open",
            details: { customField: "important-payload-data" },
          },
        },
      ],
    };
    expect(isPagerDutyWebhookPayload(customPayload)).toBe(false);
    expect(slimWebhookPayload(customPayload)).toEqual(customPayload);
    expect(serializeWebhookPayload(customPayload)).toContain("important-payload-data");
  });

  it("does not classify modern custom incident envelopes with generic priority as PagerDuty", () => {
    const customModernPayload = {
      event: {
        event_type: "incident.trigger",
        resource_type: "incident",
        data: {
          id: "custom-inc-1",
          type: "incident",
          priority: "high",
          details: { important_context: "keep-this-unaltered" },
        },
      },
    };
    expect(isPagerDutyWebhookPayload(customModernPayload)).toBe(false);
    expect(slimWebhookPayload(customModernPayload)).toEqual(customModernPayload);
    expect(serializeWebhookPayload(customModernPayload)).toContain("keep-this-unaltered");

    const pdModernPayload = {
      event: {
        event_type: "incident.trigger",
        resource_type: "incident",
        data: {
          id: "pd-inc-1",
          type: "incident",
          priority: {
            id: "P1",
            type: "priority",
            summary: "P1",
          },
          details: { bloat: "x".repeat(500) },
        },
      },
    };
    expect(isPagerDutyWebhookPayload(pdModernPayload)).toBe(true);
  });

  it("preserves canonical investigation URLs in slimmed Sentry event payloads", () => {
    const sentryEvent = {
      event: {
        id: "evt-12345",
        title: "Unhandled exception in worker",
        level: "error",
        web_url: "https://sentry.io/organizations/acme/issues/101/events/evt-12345/",
        project: { slug: "core-api" },
      },
    };
    expect(isSentryWebhookPayload(sentryEvent)).toBe(true);
    const slim = slimWebhookPayload(sentryEvent) as Record<string, JsonValue>;
    const event = slim.event as Record<string, JsonValue>;
    expect(event.permalink).toBe("https://sentry.io/organizations/acme/issues/101/events/evt-12345/");
  });

  it("retains and maps legacy PagerDuty assigned_to_user in incident payloads", () => {
    const legacyAssign = {
      messages: [
        {
          id: "msg-assign-1",
          event: "incident.assign",
          incident: {
            id: "INC-ASSIGN",
            number: 202,
            status: "triggered",
            html_url: "https://my-team.pagerduty.com/incidents/INC-ASSIGN",
            assigned_to_user: {
              id: "PUSER123",
              name: "OnCall Hero",
              email: "hero@example.com",
              summary: "OnCall Hero",
            },
          },
        },
      ],
    };
    expect(isPagerDutyWebhookPayload(legacyAssign)).toBe(true);
    const slim = slimWebhookPayload(legacyAssign) as Record<string, JsonValue>;
    const msgs = slim.messages as Record<string, JsonValue>[];
    expect(msgs).toHaveLength(1);
    const inc = msgs[0].incident as Record<string, JsonValue>;
    expect(inc.assigned_to_user).toEqual({
      id: "PUSER123",
      summary: "OnCall Hero",
      name: "OnCall Hero",
    });
    expect(inc.assignee).toEqual({
      id: "PUSER123",
      summary: "OnCall Hero",
      name: "OnCall Hero",
    });
  });

  it("preserves bounded incident description in slimmed PagerDuty payloads", () => {
    const pdIncidentWithDesc = {
      event: {
        event_type: "incident.trigger",
        resource_type: "incident",
        data: {
          id: "PD-DESC-1",
          type: "incident",
          title: "Alert",
          description: "Database connection pool exhausted on prod-db-01 causing HTTP 500 errors across api-gateway.",
          status: "triggered",
          urgency: "high",
          html_url: "https://my-team.pagerduty.com/incidents/PD-DESC-1",
        },
      },
    };
    expect(isPagerDutyWebhookPayload(pdIncidentWithDesc)).toBe(true);
    const slim = slimWebhookPayload(pdIncidentWithDesc) as Record<string, JsonValue>;
    const incident = slim.incident as Record<string, JsonValue>;
    expect(incident.title).toBe("Alert");
    expect(incident.description).toBe(
      "Database connection pool exhausted on prod-db-01 causing HTTP 500 errors across api-gateway.",
    );

    const pdLongDesc = {
      event: {
        event_type: "incident.trigger",
        resource_type: "incident",
        data: {
          id: "PD-DESC-2",
          type: "incident",
          title: "Alert",
          description: "d".repeat(600),
          status: "triggered",
          html_url: "https://my-team.pagerduty.com/incidents/PD-DESC-2",
        },
      },
    };
    const slimLong = slimWebhookPayload(pdLongDesc) as Record<string, JsonValue>;
    const incLong = slimLong.incident as Record<string, JsonValue>;
    expect(typeof incLong.description).toBe("string");
    expect((incLong.description as string).length).toBe(501); // 500 + '…'
    expect((incLong.description as string).endsWith("…")).toBe(true);
  });

  it("preserves bounded body.details value alongside description in PagerDuty incidents", () => {
    const pdIncidentWithBody = {
      event: {
        event_type: "incident.trigger",
        resource_type: "incident",
        data: {
          id: "PD-BODY-1",
          type: "incident",
          title: "Alert",
          body: {
            type: "incident_body",
            details: "Worker process killed: out of memory while rendering large report.",
          },
          status: "triggered",
          urgency: "high",
          html_url: "https://my-team.pagerduty.com/incidents/PD-BODY-1",
        },
      },
    };
    expect(isPagerDutyWebhookPayload(pdIncidentWithBody)).toBe(true);
    const slim = slimWebhookPayload(pdIncidentWithBody) as Record<string, JsonValue>;
    const incident = slim.incident as Record<string, JsonValue>;
    expect(incident.title).toBe("Alert");
    expect(incident.body).toEqual({
      details: "Worker process killed: out of memory while rendering large report.",
    });
    expect(incident.description).toBe("Worker process killed: out of memory while rendering large report.");
  });

  it("preserves canonical URL from self when html_url is missing in PagerDuty incidents", () => {
    const pdSelfUrlOnly = {
      event: {
        event_type: "incident.trigger",
        resource_type: "incident",
        data: {
          id: "PD-SELF-1",
          type: "incident",
          title: "Alert",
          status: "triggered",
          urgency: "high",
          self: "https://api.pagerduty.com/incidents/PD-SELF-1",
        },
      },
    };
    expect(isPagerDutyWebhookPayload(pdSelfUrlOnly)).toBe(true);
    const slim = slimWebhookPayload(pdSelfUrlOnly) as Record<string, JsonValue>;
    const incident = slim.incident as Record<string, JsonValue>;
    expect(incident.html_url).toBe("https://api.pagerduty.com/incidents/PD-SELF-1");
  });
});


