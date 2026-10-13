import { describe, expect, it } from "vitest";

import { OUTBOUND_DEFAULT_CAP, connectorCallsIn, isOutboundTool, isReadOnlyTool, normalizeOutboundPolicy, outboundCallsIn } from "./outbound.ts";

describe("isOutboundTool", () => {
  it("flags tools that send, reply, post, publish, invite, share, or move money", () => {
    for (const name of [
      "GMAIL_SEND_EMAIL",
      "GMAIL_SEND_DRAFT",
      "GMAIL_REPLY_TO_THREAD",
      "SLACK_SEND_MESSAGE",
      "SLACK_CHAT_POST_MESSAGE",
      "TWITTER_CREATION_OF_A_POST",
      "LINKEDIN_CREATE_LINKED_IN_POST",
      "STRIPE_CREATE_REFUND",
      "GITHUB_CREATE_AN_ISSUE_COMMENT",
      "HUBSPOT_SEND_EMAIL",
      "GOOGLECALENDAR_INVITE_ATTENDEES",
      "mcp__composio__WHATSAPP_SEND_MESSAGE",
      "mcp__claude_ai_Gmail__send_message",
      "mcp__claude_ai_Gmail__reply",
      "mcp__claude_ai_Gmail__forward",
      "mcp__claude_ai_Slack__slack_send_message",
    ]) {
      expect(isOutboundTool(name), name).toBe(true);
    }
  });

  it("leaves reading, searching, drafting, and internal record-keeping alone", () => {
    for (const name of [
      "GMAIL_FETCH_EMAILS",
      "GMAIL_LIST_THREADS",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "SLACK_SEARCH_MESSAGES",
      "REDDIT_GET_POST",
      "STRIPE_LIST_CHARGES",
      "GITHUB_GET_A_PULL_REQUEST",
      "GITHUB_CREATE_AN_ISSUE",
      "LINEAR_CREATE_ISSUE",
      "NOTION_CREATE_PAGE",
      "GOOGLESHEETS_BATCH_UPDATE",
      "GOOGLECALENDAR_CREATE_EVENT",
      "mcp__claude_ai_Gmail__search_threads",
      "mcp__claude_ai_Linear__save_issue",
      "mcp__computer__click",
      "Bash",
      "Read",
      "Edit",
    ]) {
      expect(isOutboundTool(name), name).toBe(false);
    }
  });
});

describe("isReadOnlyTool", () => {
  it("recognizes exact MCP reads without treating other non-outbound actions as reads", () => {
    for (const name of [
      "mcp__linear__list_issues",
      "mcp__linear__list_comments",
      "mcp__linear__get_issue",
      "GMAIL_SEARCH_MESSAGES",
    ]) expect(isReadOnlyTool(name), name).toBe(true);

    for (const name of [
      "mcp__linear__save_issue",
      "mcp__linear__delete_issue",
      "mcp__linear__create_comment",
      "mcp__computer__click",
      "Bash",
    ]) expect(isReadOnlyTool(name), name).toBe(false);
  });
});

describe("normalizeOutboundPolicy", () => {
  it("accepts ask and allow with a whole-number daily cap", () => {
    expect(normalizeOutboundPolicy({ policy: "ask" })).toEqual({ policy: "ask", dailyCap: OUTBOUND_DEFAULT_CAP });
    expect(normalizeOutboundPolicy({ policy: "allow", dailyCap: 10 })).toEqual({ policy: "allow", dailyCap: 10 });
  });

  it("refuses anything else", () => {
    expect(normalizeOutboundPolicy(null as never)).toBeNull();
    expect(normalizeOutboundPolicy({ policy: "maybe" })).toBeNull();
    expect(normalizeOutboundPolicy({ policy: "ask", dailyCap: 0 })).toBeNull();
  });
});

describe("connectorCallsIn", () => {
  it("expands multi-execute into per-slug calls", () => {
    expect(connectorCallsIn("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] })).toEqual([
      { slug: "GMAIL_SEND_EMAIL" },
    ]);
  });

  it("treats opaque composio workbench calls as unrestricted proxy executes", () => {
    expect(connectorCallsIn("COMPOSIO_REMOTE_BASH_TOOL", { command: "echo hi" })).toEqual([
      { slug: "COMPOSIO_PROXY_EXECUTE", arguments: { command: "echo hi" } },
    ]);
  });
});

describe("outboundCallsIn", () => {
  it("keeps only sends", () => {
    expect(outboundCallsIn("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }, { tool_slug: "GMAIL_FETCH_EMAILS" }],
    })).toEqual([{ slug: "GMAIL_SEND_EMAIL" }]);
  });
});
