// GitHub webhook JSON is huge: every delivery repeats `repository`, `sender`,
// and `organization` with URL farms, and `check_run.output` / workflow jobs
// carry logs.  Pretty-printing that and folding distinct deliveries is what
// pushed Compiler's Antigravity fallback to 713 KB (argv-only print mode
// then rejected it; Grok ACP `session/prompt` timed out on the same blob).
// Keep the compile-gate fields (action, conclusion, branch, sha, check name,
// PR merged) and drop the rest.  Non-GitHub payloads stay intact, compact.

import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export const MAX_EVENT_CHARS = 48_000;

export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, JsonValue>;
}

export function pickStr(obj: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function pickNum(obj: Record<string, JsonValue> | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickBool(obj: Record<string, JsonValue> | undefined, key: string): boolean | undefined {
  const value = obj?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function assignDefined(out: Record<string, JsonValue>, key: string, value: JsonValue | undefined): void {
  if (value !== undefined) out[key] = value;
}

function slimActor(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "login", pickStr(rec, "login"));
  assignDefined(out, "type", pickStr(rec, "type"));
  assignDefined(out, "id", pickNum(rec, "id"));
  return Object.keys(out).length ? out : undefined;
}

/** GitHub push `pusher` is `{ name, email }`, not a User actor. */
function slimPusher(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "email", pickStr(rec, "email"));
  assignDefined(out, "login", pickStr(rec, "login"));
  return Object.keys(out).length ? out : undefined;
}

function slimRepo(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "full_name", pickStr(rec, "full_name"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "default_branch", pickStr(rec, "default_branch"));
  assignDefined(out, "private", pickBool(rec, "private"));
  assignDefined(out, "fork", pickBool(rec, "fork"));
  assignDefined(out, "owner", slimActor(rec.owner));
  return Object.keys(out).length ? out : undefined;
}

function slimShaRef(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "ref", pickStr(rec, "ref"));
  assignDefined(out, "sha", pickStr(rec, "sha"));
  assignDefined(out, "label", pickStr(rec, "label"));
  assignDefined(out, "repo", slimRepo(rec.repo));
  return Object.keys(out).length ? out : undefined;
}

function slimPullRequest(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "number", pickNum(rec, "number"));
  assignDefined(out, "title", pickStr(rec, "title"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "state", pickStr(rec, "state"));
  assignDefined(out, "merge_commit_sha", pickStr(rec, "merge_commit_sha"));
  assignDefined(out, "merged", pickBool(rec, "merged"));
  assignDefined(out, "draft", pickBool(rec, "draft"));
  assignDefined(out, "user", slimActor(rec.user));
  assignDefined(out, "base", slimShaRef(rec.base));
  assignDefined(out, "head", slimShaRef(rec.head));
  return Object.keys(out).length ? out : undefined;
}

function slimIssue(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "number", pickNum(rec, "number"));
  assignDefined(out, "title", pickStr(rec, "title"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "state", pickStr(rec, "state"));
  assignDefined(out, "user", slimActor(rec.user));
  return Object.keys(out).length ? out : undefined;
}

function slimCheckSuiteBrief(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "head_branch", pickStr(rec, "head_branch"));
  return Object.keys(out).length ? out : undefined;
}

function slimCheckRun(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "details_url", pickStr(rec, "details_url"));
  assignDefined(out, "started_at", pickStr(rec, "started_at"));
  assignDefined(out, "completed_at", pickStr(rec, "completed_at"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "check_suite", slimCheckSuiteBrief(rec.check_suite));
  return Object.keys(out).length ? out : undefined;
}

function slimCheckSuite(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "head_branch", pickStr(rec, "head_branch"));
  assignDefined(out, "latest_check_runs_count", pickNum(rec, "latest_check_runs_count"));
  return Object.keys(out).length ? out : undefined;
}

function slimWorkflowPull(value: JsonValue): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "number", pickNum(rec, "number"));
  const head = asRecord(rec.head);
  if (head) {
    const slimHead: Record<string, JsonValue> = {};
    assignDefined(slimHead, "ref", pickStr(head, "ref"));
    assignDefined(slimHead, "sha", pickStr(head, "sha"));
    if (Object.keys(slimHead).length) out.head = slimHead;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimWorkflowRun(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "display_title", pickStr(rec, "display_title"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "event", pickStr(rec, "event"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "head_branch", pickStr(rec, "head_branch"));
  assignDefined(out, "path", pickStr(rec, "path"));
  assignDefined(out, "run_attempt", pickNum(rec, "run_attempt"));
  assignDefined(out, "run_number", pickNum(rec, "run_number"));
  if (Array.isArray(rec.pull_requests)) {
    const pulls = rec.pull_requests.map(slimWorkflowPull).filter((row): row is JsonValue => row !== undefined);
    if (pulls.length) out.pull_requests = pulls;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimWorkflowJob(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "started_at", pickStr(rec, "started_at"));
  assignDefined(out, "completed_at", pickStr(rec, "completed_at"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "workflow_name", pickStr(rec, "workflow_name"));
  assignDefined(out, "run_id", pickNum(rec, "run_id"));
  assignDefined(out, "run_attempt", pickNum(rec, "run_attempt"));
  return Object.keys(out).length ? out : undefined;
}

function slimReview(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "state", pickStr(rec, "state"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "user", slimActor(rec.user));
  return Object.keys(out).length ? out : undefined;
}

function slimComment(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "user", slimActor(rec.user));
  const body = pickStr(rec, "body");
  if (body) out.body = body.length > 500 ? `${body.slice(0, 500)}…` : body;
  return Object.keys(out).length ? out : undefined;
}

function slimCommit(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id"));
  assignDefined(out, "message", pickStr(rec, "message"));
  assignDefined(out, "timestamp", pickStr(rec, "timestamp"));
  const author = asRecord(rec.author);
  if (author) {
    const slimAuthor: Record<string, JsonValue> = {};
    assignDefined(slimAuthor, "name", pickStr(author, "name"));
    assignDefined(slimAuthor, "username", pickStr(author, "username"));
    if (Object.keys(slimAuthor).length) out.author = slimAuthor;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimGithubPayload(root: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "action", pickStr(root, "action"));
  assignDefined(out, "ref", pickStr(root, "ref"));
  assignDefined(out, "after", pickStr(root, "after"));
  assignDefined(out, "before", pickStr(root, "before"));
  assignDefined(out, "master_branch", pickStr(root, "master_branch"));
  assignDefined(out, "state", pickStr(root, "state"));
  assignDefined(out, "sha", pickStr(root, "sha"));
  assignDefined(out, "context", pickStr(root, "context"));
  const description = pickStr(root, "description");
  if (description) out.description = description.length > 500 ? `${description.slice(0, 500)}…` : description;
  assignDefined(out, "target_url", pickStr(root, "target_url"));
  assignDefined(out, "created", pickBool(root, "created"));
  assignDefined(out, "deleted", pickBool(root, "deleted"));
  assignDefined(out, "forced", pickBool(root, "forced"));
  assignDefined(out, "number", pickNum(root, "number"));
  assignDefined(out, "zen", pickStr(root, "zen"));
  assignDefined(out, "hook_id", pickNum(root, "hook_id"));
  assignDefined(out, "repository", slimRepo(root.repository));
  assignDefined(out, "head_repository", slimRepo(root.head_repository));
  assignDefined(out, "sender", slimActor(root.sender));
  assignDefined(out, "organization", slimActor(root.organization));
  assignDefined(out, "pusher", slimPusher(root.pusher));
  assignDefined(out, "pull_request", slimPullRequest(root.pull_request));
  assignDefined(out, "issue", slimIssue(root.issue));
  assignDefined(out, "check_run", slimCheckRun(root.check_run));
  assignDefined(out, "check_suite", slimCheckSuite(root.check_suite));
  assignDefined(out, "workflow_run", slimWorkflowRun(root.workflow_run));
  assignDefined(out, "workflow_job", slimWorkflowJob(root.workflow_job));
  assignDefined(out, "review", slimReview(root.review));
  assignDefined(out, "comment", slimComment(root.comment));
  assignDefined(out, "head_commit", slimCommit(root.head_commit));
  if (Array.isArray(root.commits)) {
    const commits = root.commits.slice(0, 5).map(slimCommit).filter((row): row is JsonValue => row !== undefined);
    if (commits.length) out.commits = commits;
    if (root.commits.length > 5) out.commits_omitted = root.commits.length - 5;
  }
  const installation = asRecord(root.installation);
  const installationId = pickNum(installation, "id");
  if (installationId !== undefined) out.installation = { id: installationId };
  return out;
}

function slimSentryProject(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id") ?? (pickNum(rec, "id") !== undefined ? String(rec.id) : undefined));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "slug", pickStr(rec, "slug"));
  assignDefined(out, "platform", pickStr(rec, "platform"));
  return Object.keys(out).length ? out : undefined;
}

function slimSentryActor(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "type", pickStr(rec, "type"));
  assignDefined(out, "id", pickStr(rec, "id") ?? (pickNum(rec, "id") !== undefined ? String(rec.id) : undefined));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "email", pickStr(rec, "email"));
  return Object.keys(out).length ? out : undefined;
}

function slimSentryIssue(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id") ?? (pickNum(rec, "id") !== undefined ? String(rec.id) : undefined));
  assignDefined(out, "shortId", pickStr(rec, "shortId"));
  assignDefined(out, "title", pickStr(rec, "title"));
  assignDefined(out, "culprit", pickStr(rec, "culprit"));
  assignDefined(out, "level", pickStr(rec, "level"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "substatus", pickStr(rec, "substatus"));
  assignDefined(out, "project", slimSentryProject(rec.project));
  assignDefined(out, "permalink", pickStr(rec, "permalink") ?? pickStr(rec, "web_url") ?? pickStr(rec, "url"));
  assignDefined(out, "count", pickStr(rec, "count") ?? (pickNum(rec, "count") !== undefined ? String(rec.count) : undefined));
  assignDefined(out, "userCount", pickNum(rec, "userCount"));
  assignDefined(out, "firstSeen", pickStr(rec, "firstSeen"));
  assignDefined(out, "lastSeen", pickStr(rec, "lastSeen"));
  assignDefined(out, "priority", pickStr(rec, "priority"));
  assignDefined(out, "seerFixabilityScore", pickNum(rec, "seerFixabilityScore"));
  // Assignment deliveries live or die by the new owner surviving the slim.
  assignDefined(out, "assignedTo", slimSentryActor(rec.assignedTo));
  return Object.keys(out).length ? out : undefined;
}

function slimSentryException(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "type", pickStr(rec, "type"));
  assignDefined(out, "value", pickStr(rec, "value"));
  assignDefined(out, "module", pickStr(rec, "module"));
  const stacktrace = asRecord(rec.stacktrace);
  if (stacktrace && Array.isArray(stacktrace.frames)) {
    const frames = stacktrace.frames.slice(-2).map((f) => {
      const fr = asRecord(f);
      if (!fr) return undefined;
      const sf: Record<string, JsonValue> = {};
      assignDefined(sf, "filename", pickStr(fr, "filename"));
      assignDefined(sf, "function", pickStr(fr, "function"));
      assignDefined(sf, "lineno", pickNum(fr, "lineno"));
      assignDefined(sf, "colno", pickNum(fr, "colno"));
      assignDefined(sf, "context_line", pickStr(fr, "context_line")?.trim());
      return Object.keys(sf).length ? sf : undefined;
    }).filter((f): f is Record<string, JsonValue> => f !== undefined);
    if (frames.length) out.frames = frames;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimSentryEvent(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id") ?? pickStr(rec, "event_id"));
  assignDefined(out, "title", pickStr(rec, "title") ?? pickStr(rec, "message"));
  assignDefined(out, "level", pickStr(rec, "level"));
  assignDefined(out, "culprit", pickStr(rec, "culprit"));
  assignDefined(out, "release", pickStr(rec, "release"));
  assignDefined(out, "environment", pickStr(rec, "environment"));
  assignDefined(out, "timestamp", pickStr(rec, "timestamp") ?? pickStr(rec, "datetime"));
  assignDefined(out, "project", slimSentryProject(rec.project));
  assignDefined(out, "permalink", pickStr(rec, "permalink") ?? pickStr(rec, "web_url") ?? pickStr(rec, "url"));

  const exc = asRecord(rec.exception) ?? (Array.isArray(rec.entries) ? asRecord(asRecord(rec.entries.find((e) => asRecord(e)?.type === "exception"))?.data) : undefined);
  if (exc) {
    const values = Array.isArray(exc.values) ? exc.values : [exc];
    // Keep the tail of chained exceptions so the newest failure (which surfaced the event) survives slimming.
    const slimExc = values.slice(-2).map(slimSentryException).filter((e): e is JsonValue => e !== undefined);
    if (slimExc.length) out.exceptions = slimExc;
  }
  return Object.keys(out).length ? out : undefined;
}

function isSentryUrl(val: unknown): boolean {
  if (typeof val !== "string" || !val) return false;
  try {
    const parsed = new URL(val);
    return parsed.hostname === "sentry.io" || parsed.hostname.endsWith(".sentry.io");
  } catch {
    return false;
  }
}

export function isSentryWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  if (root.actor) {
    const act = asRecord(root.actor);
    if (act?.name === "Sentry" || act?.id === "sentry") return true;
  }
  if (root.installation && pickStr(asRecord(root.installation), "uuid")) {
    if (root.action !== undefined || root.data !== undefined) return true;
  }
  const data = asRecord(root.data) ?? root;
  const issue = asRecord(data.issue);
  const event = asRecord(data.event);
  // culprit and shortId are not Sentry-exclusive — generic issue trackers carry
  // them — so only validated Sentry URLs, actor, or installation mark the payload.
  if (
    issue &&
    (isSentryUrl(issue.permalink) || isSentryUrl(issue.url))
  ) {
    return true;
  }
  if (
    event &&
    (isSentryUrl(event.url) || isSentryUrl(event.web_url) || isSentryUrl(event.permalink))
  ) {
    return true;
  }
  return false;
}

export function slimSentryPayload(payload: JsonValue): JsonValue {
  const root = asRecord(payload);
  if (!root) return payload;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "action", pickStr(root, "action"));
  const data = asRecord(root.data);
  const issue = slimSentryIssue(data?.issue ?? root.issue);
  const event = slimSentryEvent(data?.event ?? root.event);
  if (issue) out.issue = issue;
  if (event) out.event = event;
  assignDefined(out, "actor", slimSentryActor(root.actor));
  const installation = asRecord(root.installation);
  if (installation) {
    const uuid = pickStr(installation, "uuid");
    if (uuid) out.installation = { uuid };
  }

  // Preserve non-issue/non-event Sentry payload data (e.g. metric_alert,
  // comment), hoisted to the root like issue/event.  Keep ONE copy:  a
  // duplicate under out.data doubled large alerts past MAX_EVENT_CHARS and
  // the serializer sliced them into invalid JSON.
  if (data) {
    for (const [key, val] of Object.entries(data)) {
      if (key === "issue" || key === "event") continue;
      out[key] = val;
    }
  }

  // Also preserve any custom or non-standard top-level resources
  for (const [key, val] of Object.entries(root)) {
    if (
      key === "action" ||
      key === "actor" ||
      key === "installation" ||
      key === "data" ||
      key === "issue" ||
      key === "event"
    ) {
      continue;
    }
    if (out[key] === undefined) {
      out[key] = val;
    }
  }

  return Object.keys(out).length ? out : payload;
}

function slimPagerDutyUser(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id"));
  assignDefined(out, "summary", pickStr(rec, "summary") ?? pickStr(rec, "name"));
  assignDefined(out, "name", pickStr(rec, "name") ?? pickStr(rec, "summary"));
  assignDefined(out, "type", pickStr(rec, "type"));
  return Object.keys(out).length ? out : undefined;
}

function slimPagerDutyIncident(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id"));
  assignDefined(out, "incident_number", pickNum(rec, "incident_number") ?? pickNum(rec, "number"));
  assignDefined(out, "title", pickStr(rec, "title") ?? pickStr(rec, "summary"));
  const description = pickStr(rec, "description");
  if (description) {
    out.description = description.length > 500 ? `${description.slice(0, 500)}…` : description;
  }
  const bodyRec = asRecord(rec.body);
  const bodyDetails = pickStr(bodyRec, "details") ?? pickStr(rec, "details");
  if (bodyDetails) {
    const boundedDetails = bodyDetails.length > 500 ? `${bodyDetails.slice(0, 500)}…` : bodyDetails;
    out.body = { details: boundedDetails };
    if (!out.description) {
      out.description = boundedDetails;
    }
  }
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "urgency", pickStr(rec, "urgency"));
  assignDefined(out, "html_url", pickStr(rec, "html_url") ?? pickStr(rec, "self"));
  assignDefined(out, "created_at", pickStr(rec, "created_at") ?? pickStr(rec, "created_on"));
  assignDefined(out, "created_on", pickStr(rec, "created_on") ?? pickStr(rec, "created_at"));
  const priorityRec = asRecord(rec.priority);
  if (priorityRec) {
    const pOut: Record<string, JsonValue> = {};
    assignDefined(pOut, "id", pickStr(priorityRec, "id"));
    assignDefined(pOut, "summary", pickStr(priorityRec, "summary") ?? pickStr(priorityRec, "name"));
    if (Object.keys(pOut).length) out.priority = pOut;
  } else if (typeof rec.priority === "string" && rec.priority.trim()) {
    out.priority = { summary: rec.priority.trim() };
  }
  const service = asRecord(rec.service);
  if (service) {
    const sOut: Record<string, JsonValue> = {};
    assignDefined(sOut, "id", pickStr(service, "id"));
    assignDefined(sOut, "name", pickStr(service, "name") ?? pickStr(service, "summary"));
    if (Object.keys(sOut).length) out.service = sOut;
  }
  if (Array.isArray(rec.assignments)) {
    const slimAssignments = rec.assignments
      .slice(0, 5)
      .map((a) => {
        const aRec = asRecord(a);
        if (!aRec) return undefined;
        const aOut: Record<string, JsonValue> = {};
        assignDefined(aOut, "at", pickStr(aRec, "at"));
        const user = slimPagerDutyUser(aRec.assignee) ?? slimPagerDutyUser(aRec);
        if (user) {
          if (asRecord(aRec.assignee)) {
            aOut.assignee = user;
          } else {
            Object.assign(aOut, user);
          }
        }
        return Object.keys(aOut).length ? aOut : undefined;
      })
      .filter((a): a is Record<string, JsonValue> => Boolean(a));
    if (slimAssignments.length) out.assignments = slimAssignments;
  }
  if (Array.isArray(rec.assignees)) {
    const slimAssignees = rec.assignees
      .slice(0, 5)
      .map((a) => slimPagerDutyUser(a))
      .filter((a): a is Record<string, JsonValue> => Boolean(a));
    if (slimAssignees.length) out.assignees = slimAssignees;
  }
  if (rec.assignee) {
    const user = slimPagerDutyUser(rec.assignee);
    if (user) out.assignee = user;
  }
  if (rec.assigned_to_user) {
    const user = slimPagerDutyUser(rec.assigned_to_user);
    if (user) {
      out.assigned_to_user = user;
      if (!out.assignee) out.assignee = user;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function isPagerDutyUrl(val: unknown): boolean {
  if (typeof val !== "string" || !val) return false;
  try {
    const parsed = new URL(val);
    return parsed.hostname === "pagerduty.com" || parsed.hostname.endsWith(".pagerduty.com");
  } catch {
    return false;
  }
}

export function isPagerDutyWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  const event = asRecord(root.event);
  if (event) {
    const data = asRecord(event.data);
    const htmlUrl = pickStr(data, "html_url") ?? pickStr(event, "html_url") ?? pickStr(data, "self") ?? pickStr(event, "self");
    if (isPagerDutyUrl(htmlUrl)) return true;
    if (data && (isPagerDutyUrl(data.self) || isPagerDutyUrl(pickStr(asRecord(data.service), "html_url")) || isPagerDutyUrl(pickStr(asRecord(data.service), "self")))) return true;
    if (event.agent && (isPagerDutyUrl(pickStr(asRecord(event.agent), "html_url")) || isPagerDutyUrl(pickStr(asRecord(event.agent), "self")))) return true;

    const eventType = pickStr(event, "event_type");
    const isPdEvent =
      eventType === "incident.trigger" ||
      eventType === "incident.triggered" ||
      eventType === "incident.acknowledge" ||
      eventType === "incident.acknowledged" ||
      eventType === "incident.unacknowledge" ||
      eventType === "incident.unacknowledged" ||
      eventType === "incident.resolve" ||
      eventType === "incident.resolved" ||
      eventType === "incident.assign" ||
      eventType === "incident.reassigned" ||
      eventType === "incident.escalate" ||
      eventType === "incident.escalated" ||
      eventType === "incident.delegate" ||
      eventType === "incident.reopened" ||
      eventType === "incident.annotated" ||
      eventType === "incident.priority_updated" ||
      Boolean(eventType?.startsWith("incident.responder."));

    const resourceType = pickStr(event, "resource_type");
    const dataType = pickStr(data, "type");
    const hasResourceType =
      resourceType === "incident" ||
      dataType === "incident" ||
      dataType === "incident_reference";

    const priorityObj = asRecord(data?.priority);
    const hasPdPriority =
      priorityObj !== undefined &&
      (priorityObj.type === "priority" ||
        priorityObj.type === "priority_reference" ||
        isPagerDutyUrl(pickStr(priorityObj, "self")) ||
        isPagerDutyUrl(pickStr(priorityObj, "html_url")));

    const hasPdStatus = data?.status === "triggered" || data?.status === "acknowledged" || data?.status === "resolved";
    const hasExclusiveField =
      data?.incident_key !== undefined ||
      hasPdPriority ||
      data?.urgency === "high" ||
      data?.urgency === "low" ||
      Array.isArray(data?.teams) ||
      Array.isArray(data?.assignments) ||
      asRecord(data?.service)?.type === "service_reference" ||
      asRecord(event.agent)?.type === "user_reference";

    if (hasResourceType && ((isPdEvent && (hasPdStatus || hasExclusiveField)) || data?.incident_key !== undefined)) {
      return true;
    }
  }
  if (Array.isArray(root.messages) && root.messages.length > 0) {
    return root.messages.some((msg) => {
      const rec = asRecord(msg);
      if (!rec) return false;
      const eventName = pickStr(rec, "event") ?? pickStr(rec, "type");
      const inc = asRecord(rec.incident);
      if (!inc) return false;
      if (
        isPagerDutyUrl(inc.html_url) ||
        isPagerDutyUrl(inc.url) ||
        isPagerDutyUrl(pickStr(asRecord(inc.service), "html_url")) ||
        isPagerDutyUrl(pickStr(asRecord(inc.service), "url")) ||
        isPagerDutyUrl(pickStr(asRecord(rec.webhook), "url"))
      ) {
        return true;
      }
      const isPdEvent =
        eventName === "incident.trigger" ||
        eventName === "incident.acknowledge" ||
        eventName === "incident.unacknowledge" ||
        eventName === "incident.resolve" ||
        eventName === "incident.assign" ||
        eventName === "incident.escalate" ||
        eventName === "incident.delegate";
      if (!isPdEvent) return false;

      const hasPdStatus = inc.status === "triggered" || inc.status === "acknowledged" || inc.status === "resolved";
      const hasExclusiveField =
        inc.incident_key !== undefined ||
        Array.isArray(inc.teams) ||
        Array.isArray(rec.log_entries) ||
        rec.webhook !== undefined ||
        inc.assigned_to_user !== undefined ||
        inc.urgency === "high" ||
        inc.urgency === "low";

      return hasExclusiveField || hasPdStatus;
    });
  }
  return false;
}

export function slimPagerDutyPayload(payload: JsonValue): JsonValue {
  const root = asRecord(payload);
  if (!root) return payload;
  const out: Record<string, JsonValue> = {};
  const event = asRecord(root.event);
  if (event) {
    assignDefined(out, "event_type", pickStr(event, "event_type"));
    assignDefined(out, "occurred_at", pickStr(event, "occurred_at"));
    const agent = slimPagerDutyUser(event.agent);
    if (agent) out.agent = agent;
    const data = asRecord(event.data);
    const incident = slimPagerDutyIncident(data ?? event);
    if (incident) out.incident = incident;
  } else if (Array.isArray(root.messages)) {
    const rawMessages = root.messages.slice(0, 10);
    const slimmedMessages: Record<string, JsonValue>[] = [];
    for (const rawMsg of rawMessages) {
      const msgRec = asRecord(rawMsg);
      if (!msgRec) continue;
      const sMsg: Record<string, JsonValue> = {};
      assignDefined(sMsg, "event", pickStr(msgRec, "event") ?? pickStr(msgRec, "type"));
      assignDefined(sMsg, "id", pickStr(msgRec, "id"));
      assignDefined(sMsg, "created_on", pickStr(msgRec, "created_on") ?? pickStr(msgRec, "created_at"));
      const agent = slimPagerDutyUser(msgRec.agent);
      if (agent) sMsg.agent = agent;
      const inc = slimPagerDutyIncident(msgRec.incident);
      if (inc) sMsg.incident = inc;
      if (Object.keys(sMsg).length) slimmedMessages.push(sMsg);
    }
    if (slimmedMessages.length > 0) {
      out.messages = slimmedMessages;
      const first = slimmedMessages[0];
      assignDefined(out, "event_type", pickStr(first, "event"));
      assignDefined(out, "created_on", pickStr(first, "created_on"));
      if (first.agent) out.agent = first.agent;
    }
    if (root.messages.length > rawMessages.length) {
      out.omitted_messages = root.messages.length - rawMessages.length;
    }
  }

  // Preserve any custom top-level fields
  for (const [key, val] of Object.entries(root)) {
    if (key === "event" || key === "messages") continue;
    if (out[key] === undefined) out[key] = val;
  }

  return Object.keys(out).length ? out : payload;
}

export function isGithubWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  return Boolean(slimRepo(root.repository) || slimRepo(root.head_repository));
}

const COOLIFY_DEPLOYMENT_EVENTS = new Set([
  "deployment_success",
  "deployment_failed",
  "deployment_failure",
  "status_changed",
  "restart_limit_reached",
  "test",
]);

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function isCoolifyWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  const hasDeploymentUuid = Boolean(pickStr(root, "deployment_uuid"));
  const hasApplicationUuid = Boolean(pickStr(root, "application_uuid"));
  const deployment = asRecord(root.deployment);
  const application = asRecord(root.application) ?? asRecord(deployment?.application);
  // Coolify-specific markers: UUIDs, named application, or nested deployment
  // with Coolify shape.  A bare top-level `event` in COOLIFY_DEPLOYMENT_EVENTS
  // (especially generic values like "test" / "status_changed") is not enough —
  // those appear in other providers and would otherwise strip the payload to
  // the Coolify allowlist.
  const hasCoolifyMarker =
    hasDeploymentUuid ||
    hasApplicationUuid ||
    Boolean(pickStr(root, "application_name")) ||
    Boolean(pickStr(application, "name") || pickStr(application, "uuid")) ||
    Boolean(deployment && (pickStr(deployment, "uuid") || pickStr(deployment, "status")));
  if (!hasCoolifyMarker) return false;
  const event = pickStr(root, "event");
  if (event && COOLIFY_DEPLOYMENT_EVENTS.has(event)) return true;
  if (hasDeploymentUuid && (hasApplicationUuid || pickStr(root, "application_name") || pickStr(application, "name"))) {
    return true;
  }
  if (deployment && (pickStr(deployment, "uuid") || pickStr(deployment, "status"))) {
    return hasApplicationUuid || Boolean(asRecord(root.application));
  }
  if (
    (pickStr(root, "application_name") || pickStr(application, "name")) &&
    (hasApplicationUuid || pickStr(application, "uuid")) &&
    (pickStr(root, "deployment_url") || pickStr(root, "fqdn") || pickStr(deployment, "url"))
  ) {
    return true;
  }
  return false;
}

function slimCoolifyDeployment(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "uuid", pickStr(rec, "uuid"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "commit", pickStr(rec, "commit") ?? pickStr(rec, "commit_sha") ?? pickStr(rec, "sha"));
  assignDefined(out, "url", pickStr(rec, "url") ?? pickStr(rec, "deployment_url"));
  const message = pickStr(rec, "message") ?? pickStr(rec, "error") ?? pickStr(rec, "failure_reason");
  if (message) out.message = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  return Object.keys(out).length ? out : undefined;
}

export function slimCoolifyPayload(payload: JsonValue): JsonValue {
  const root = asRecord(payload);
  if (!root) return payload;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "event", pickStr(root, "event"));
  assignDefined(out, "success", pickBool(root, "success"));
  const message = pickStr(root, "message") ?? pickStr(root, "error");
  if (message) out.message = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  assignDefined(out, "application_name", pickStr(root, "application_name") ?? pickStr(asRecord(root.application), "name"));
  assignDefined(out, "application_uuid", pickStr(root, "application_uuid") ?? pickStr(asRecord(root.application), "uuid"));
  assignDefined(out, "deployment_uuid", pickStr(root, "deployment_uuid") ?? pickStr(asRecord(root.deployment), "uuid"));
  assignDefined(out, "deployment_url", pickStr(root, "deployment_url") ?? pickStr(asRecord(root.deployment), "url"));
  assignDefined(out, "fqdn", pickStr(root, "fqdn"));
  assignDefined(out, "preview_fqdn", pickStr(root, "preview_fqdn"));
  assignDefined(out, "project", pickStr(root, "project"));
  assignDefined(out, "environment", pickStr(root, "environment"));
  assignDefined(
    out,
    "commit",
    pickStr(root, "commit") ??
      pickStr(root, "commit_sha") ??
      pickStr(root, "sha") ??
      pickStr(asRecord(root.deployment), "commit"),
  );
  const deployment = slimCoolifyDeployment(root.deployment);
  if (deployment) out.deployment = deployment;
  return Object.keys(out).length ? out : payload;
}

const ASC_EVENT_SUFFIXES = [
  "StateUpdated",
  "AppVersionStateUpdated",
  "ExternalBuildStateUpdated",
  "VersionStateUpdated",
];

function isAscEventType(value: string | undefined): boolean {
  if (!value) return false;
  if (value.startsWith("build") || value.startsWith("appStore") || value.startsWith("app")) {
    return ASC_EVENT_SUFFIXES.some((suffix) => value.endsWith(suffix));
  }
  return false;
}

export function isAscWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  const data = asRecord(root.data);
  if (!data) return false;
  const eventType = pickStr(data, "type");
  if (!isAscEventType(eventType)) return false;
  const attrs = asRecord(data.attributes);
  const relationships = asRecord(data.relationships);
  const instance = asRecord(relationships?.instance);
  const instanceData = asRecord(instance?.data);
  return Boolean(
    attrs &&
      (pickStr(attrs, "newState") ||
        pickStr(attrs, "oldState") ||
        pickStr(attrs, "newValue") ||
        pickStr(attrs, "oldValue") ||
        pickStr(attrs, "newExternalBuildState") ||
        pickStr(attrs, "oldExternalBuildState")) &&
      pickStr(instanceData, "type"),
  );
}

function slimAscAttributes(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "oldState", pickStr(rec, "oldState") ?? pickStr(rec, "oldValue"));
  assignDefined(out, "newState", pickStr(rec, "newState") ?? pickStr(rec, "newValue"));
  assignDefined(
    out,
    "oldExternalBuildState",
    pickStr(rec, "oldExternalBuildState"),
  );
  assignDefined(
    out,
    "newExternalBuildState",
    pickStr(rec, "newExternalBuildState"),
  );
  assignDefined(out, "timestamp", pickStr(rec, "timestamp"));
  assignDefined(out, "cfBundleShortVersionString", pickStr(rec, "cfBundleShortVersionString"));
  assignDefined(out, "cfBundleVersion", pickStr(rec, "cfBundleVersion"));
  assignDefined(out, "version", pickNum(rec, "version"));
  return Object.keys(out).length ? out : undefined;
}

export function slimAscPayload(payload: JsonValue): JsonValue {
  const root = asRecord(payload);
  if (!root) return payload;
  const data = asRecord(root.data);
  if (!data) return payload;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "type", pickStr(data, "type"));
  assignDefined(out, "id", pickStr(data, "id"));
  assignDefined(out, "attributes", slimAscAttributes(data.attributes));
  const relationships = asRecord(data.relationships);
  const instance = asRecord(relationships?.instance);
  const instanceData = asRecord(instance?.data);
  if (instanceData) {
    const slimInstance: Record<string, JsonValue> = {};
    assignDefined(slimInstance, "type", pickStr(instanceData, "type"));
    assignDefined(slimInstance, "id", pickStr(instanceData, "id"));
    out.instance = slimInstance;
  }
  const included = Array.isArray(root.included) ? root.included : [];
  const app = included.find((row) => pickStr(asRecord(row), "type") === "apps");
  const appAttrs = asRecord(asRecord(app)?.attributes);
  if (appAttrs) {
    const slimApp: Record<string, JsonValue> = {};
    assignDefined(slimApp, "name", pickStr(appAttrs, "name"));
    assignDefined(slimApp, "bundleId", pickStr(appAttrs, "bundleId"));
    if (Object.keys(slimApp).length) out.app = slimApp;
  }
  return Object.keys(out).length ? { data: out } : payload;
}

const GENERIC_MAX_DEPTH = 6;
const GENERIC_MAX_KEYS = 48;
const GENERIC_MAX_ARRAY = 20;
const GENERIC_DROP_KEYS = new Set([
  "html",
  "body_html",
  "attachments",
  "screenshots",
  "raw",
  "headers",
  "cookies",
  "stacktrace",
]);

function shouldDropGenericKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (GENERIC_DROP_KEYS.has(normalized)) return true;
  if (normalized.endsWith("_html") || normalized.endsWith("_raw")) return true;
  return false;
}

function truncateGenericString(value: string): string {
  if (value.length <= 2_000) return value;
  if (looksLikeUrl(value)) return value.slice(0, 500);
  return `${value.slice(0, 2_000)}…`;
}

function applyGenericPayloadBudget(value: JsonValue, depth = 0): JsonValue {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return truncateGenericString(value);
    return value;
  }
  // Depth guard runs before descending into arrays or objects so deeply
  // nested authenticated webhooks cannot exhaust the call stack.
  if (depth >= GENERIC_MAX_DEPTH) {
    return Array.isArray(value) ? "[nested array omitted]" : "[nested object omitted]";
  }
  if (Array.isArray(value)) {
    const capped = value.slice(0, GENERIC_MAX_ARRAY).map((entry) => applyGenericPayloadBudget(entry, depth + 1));
    if (value.length > GENERIC_MAX_ARRAY) capped.push(`…${value.length - GENERIC_MAX_ARRAY} more items omitted`);
    return capped;
  }
  const rec = value as Record<string, JsonValue>;
  const out: Record<string, JsonValue> = {};
  let kept = 0;
  for (const [key, entry] of Object.entries(rec)) {
    if (shouldDropGenericKey(key)) continue;
    if (kept >= GENERIC_MAX_KEYS) {
      out._keys_omitted = Object.keys(rec).length - kept;
      break;
    }
    out[key] = applyGenericPayloadBudget(entry, depth + 1);
    kept += 1;
  }
  return out;
}

export function slimGenericPayload(payload: JsonValue): JsonValue {
  return applyGenericPayloadBudget(payload);
}

/** Drop GitHub, Sentry, PagerDuty, Coolify, and ASC bloat; budget unknown JSON. */
export function slimWebhookPayload(payload: JsonValue): JsonValue {
  // Root JSON arrays never pass asRecord — budget them before provider detection
  // so depth/item/string limits still apply to batch-shaped unknown webhooks.
  if (Array.isArray(payload)) return slimGenericPayload(payload);
  const root = asRecord(payload);
  if (!root) return payload;
  if (isGithubWebhookPayload(root)) return slimGithubPayload(root);
  if (isPagerDutyWebhookPayload(root)) return slimPagerDutyPayload(root);
  if (isSentryWebhookPayload(root)) return slimSentryPayload(root);
  if (isCoolifyWebhookPayload(root)) return slimCoolifyPayload(root);
  if (isAscWebhookPayload(root)) return slimAscPayload(root);
  return slimGenericPayload(payload);
}

export function serializeWebhookPayload(payload: JsonValue): string {
  let text: string;
  const plainText = z.string().safeParse(payload);
  if (plainText.success) text = plainText.data;
  else {
    const slimmed = slimWebhookPayload(payload);
    try {
      text = JSON.stringify(slimmed) ?? String(slimmed);
    } catch {
      text = String(slimmed);
    }
  }
  if (text.length <= MAX_EVENT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by BotFleet]`;
}
