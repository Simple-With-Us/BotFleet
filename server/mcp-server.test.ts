import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drainInFlight,
  handleToolCall,
  isLoopbackOrigin,
  probeBaseUrls,
  processMcpMessage,
  request,
  resolveBaseUrl,
  TOOLS,
  validateBaseUrl,
  validateToolArguments,
} from "../scripts/mcp-server.ts";
import { spawnDetached, waitForExit } from "./testing/cleanup.ts";

const MCP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mcp-server.ts");

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.BOTFLEET_TOKEN;
  delete process.env.ALLOW_INSECURE_HTTP;
});

describe("MCP JSON-RPC protocol", () => {
  it("negotiates supported and newer protocol versions", async () => {
    const supported = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })))!);
    expect(supported.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "botfleet-mcp", version: "1.2.0" },
      capabilities: { tools: {} },
    });

    const future = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "future",
      method: "initialize",
      params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })))!);
    expect(future.result.protocolVersion).toBe("2025-11-25");
  });

  it("lists a closed, annotated orchestration surface", async () => {
    const response = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!);
    const names = response.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(TOOLS.map((tool) => tool.name));
    expect(names).toContain("create_bot");
    expect(names).toContain("create_channel");
    expect(names).toContain("wait_for_conversation");
    expect(names).toContain("interrupt_conversation");
    // fleet tools are additive: every earlier name survives beside them
    for (const added of [
      "list_pending_approvals", "answer_approval", "list_routines", "run_routine",
      "list_webhooks", "read_decision_log", "open_app",
    ]) expect(names).toContain(added);
    expect(names).not.toContain("wait_for_bot");
    expect(names).not.toContain("interrupt_bot");
    expect(names).not.toContain("approve_request");
    expect(names).not.toContain("delete_bot");
    expect(response.result.tools.every((tool: any) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(response.result.tools.every((tool: any) => tool.annotations)).toBe(true);
  });

  it("requires the MCP initialize identity and capabilities fields", async () => {
    const response = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2025-11-25" },
    })))!);
    expect(response.error).toMatchObject({ code: -32602 });
  });

  it("returns structured and text tool results", async () => {
    const handler = vi.fn(async () => ({ bots: [{ id: "bot-1" }] })) as any;
    const response = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_bots", arguments: {} },
    }), handler))!);
    expect(response.result.structuredContent).toEqual({ bots: [{ id: "bot-1" }] });
    expect(JSON.parse(response.result.content[0].text)).toEqual(response.result.structuredContent);
  });

  it("rejects unknown tools and malformed arguments as invalid params", async () => {
    for (const params of [
      { name: "does_not_exist", arguments: {} },
      { name: "send_bot_message", arguments: { bot_id: "bot-1", text: { not: "text" } } },
      { name: "list_bots", arguments: { unexpected: true } },
    ]) {
      const response = JSON.parse((await processMcpMessage(JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call", params,
      })))!);
      expect(response.error.code).toBe(-32602);
    }
  });

  it("handles parse errors, method errors, pings, and notifications", async () => {
    expect(JSON.parse((await processMcpMessage("not json"))!).error.code).toBe(-32700);
    expect(JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "nope" })))!).error.code).toBe(-32601);
    expect(JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" })))!).result).toEqual({});
    expect(await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
  });

  it("cancels an in-flight tool call with the MCP cancellation notification", async () => {
    const handler = vi.fn(async (_name, _args, _fetcher, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as any;
    const pending = processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "slow-call",
      method: "tools/call",
      params: {
        name: "wait_for_conversation",
        arguments: { target_type: "bot", target_id: "bot-1" },
      },
    }), handler);
    expect(await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "slow-call", reason: "client closed" },
    }))).toBeNull();
    expect(JSON.parse((await pending)!)).toEqual({
      jsonrpc: "2.0",
      id: "slow-call",
      error: { code: -32800, message: "Request cancelled" },
    });
  });
});

describe("MCP tool execution", () => {
  it("lists bots without fetching transcripts", async () => {
    const fetcher = vi.fn(async (path: string) => {
      expect(path).toBe("/api/bots?messages=0");
      return {
        bots: [{
          id: "bot-1", name: "Deckard", title: "Detective", busy: false, activity: "idle",
          threadId: "task-1", messages: [], tasks: [{ threadId: "task-1", title: "Case", createdAt: 10 }],
        }],
      };
    });
    const result: any = await handleToolCall("list_bots", {}, fetcher);
    expect(result.bots[0]).toMatchObject({ id: "bot-1", activeTaskId: "task-1", activity: "idle" });
    expect(result.bots[0].tasks[0]).toMatchObject({ taskId: "task-1", active: true });
    expect(result.bots[0]).not.toHaveProperty("messages");
  });

  it("reads a bounded bot task and removes pixels and approval grant keys", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Deckard", threadId: "task-1", tasks: [{ threadId: "task-1", title: "Case" }] }],
      };
      if (path === "/api/threads/task-1/messages?limit=200") return {
        messages: [{
          id: "m1", at: 123, role: "bot", kind: "screen", png: "base64-pixels",
          tool: { name: "Browser", ok: false, spoken: "browser failed", setup: true, raw: "drop" },
          card: { title: "Run command?", requestId: "secret-request", allowKey: "Bash:git", answered: false },
        }],
        hasMore: true,
      };
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("get_bot_messages", { bot_id: "bot-1", limit: 200 }, fetcher);
    expect(result.messages[0]).toMatchObject({
      id: "m1", at: 123, hasImage: true,
      tool: { name: "Browser", ok: false, spoken: "browser failed", setup: true },
    });
    expect(result.messages[0]).not.toHaveProperty("png");
    expect(result.messages[0].card).not.toHaveProperty("allowKey");
    expect(result.messages[0].card).not.toHaveProperty("requestId");
    expect(result.hasMore).toBe(true);
  });

  it("pins bot and channel sends to the active task", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{
          id: "bot-1", threadId: "bot-task", tasks: [
            { threadId: "bot-task" },
            { threadId: "bot-old" },
          ],
        }],
        groups: [{
          id: "channel-1", threadId: "channel-task", tasks: [
            { threadId: "channel-task" },
            { threadId: "channel-old" },
          ],
        }],
      };
      if (path === "/api/bots/bot-1/messages") {
        expect(JSON.parse(String(options?.body))).toEqual({ text: "Investigate", threadId: "bot-task" });
        return { ok: true };
      }
      if (path === "/api/groups/channel-1/messages") {
        expect(JSON.parse(String(options?.body))).toEqual({ text: "Ship it", threadId: "channel-task" });
        return { ok: true };
      }
      throw new Error(`unexpected path ${path}`);
    });

    await expect(handleToolCall("send_bot_message", {
      bot_id: "bot-1", task_id: "bot-old", text: "Wrong task",
    }, fetcher)).rejects.toThrow("not active");
    await expect(handleToolCall("send_channel_message", {
      channel_id: "channel-1", task_id: "channel-old", text: "Wrong task",
    }, fetcher)).rejects.toThrow("not active");

    await expect(handleToolCall("send_bot_message", {
      bot_id: "bot-1", text: "Investigate",
    }, fetcher)).resolves.toMatchObject({ success: true, taskId: "bot-task" });
    await expect(handleToolCall("send_channel_message", {
      channel_id: "channel-1", text: "Ship it",
    }, fetcher)).resolves.toMatchObject({ success: true, taskId: "channel-task" });
  });

  it("creates a bot through the safe profile boundary", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots" && options?.method === "POST") {
        expect(JSON.parse(String(options.body))).toEqual({ name: "Mira", title: "Researcher", section: "Work" });
        return { bot: { id: "bot-new", name: "Mira", title: "Researcher", section: "Work", threadId: "task-new", tasks: [] } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("create_bot", { name: "Mira", title: "Researcher", section: "Work" }, fetcher);
    expect(result.bot).toMatchObject({ id: "bot-new", name: "Mira", section: "Work" });
  });

  it("leaves single-request bot-create failures to the server without destructive rollback", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      calls.push(`${options?.method ?? "GET"} ${path}`);
      if (path === "/api/bots" && options?.method === "POST") throw new Error("profile rejected");
      throw new Error(`unexpected path ${path}`);
    });
    await expect(handleToolCall("create_bot", { name: "Mira" }, fetcher)).rejects.toThrow("profile rejected");
    expect(calls).toEqual(["POST /api/bots"]);
  });

  it("creates and completes channel setup in one request", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/groups") {
        expect(JSON.parse(String(options?.body))).toEqual({
          name: "Launch",
          memberIds: ["bot-1", "bot-2"],
          section: "Work",
          setup: { bulletin: "Ship safely", defaultResponder: { kind: "everyone" } },
        });
        return { group: { id: "channel-1", name: "Launch", memberIds: ["bot-1", "bot-2"], threadId: "task-1", tasks: [] } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("create_channel", {
      name: "Launch", member_ids: ["bot-1", "bot-2"], section: "Work", bulletin: "Ship safely",
      default_responder: { kind: "everyone" },
    }, fetcher);
    expect(result.channel.id).toBe("channel-1");
  });

  it("routes bot and channel task mutations", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/groups/channel-1/tasks") {
        return { task: { threadId: "task-2", title: "Fresh" }, group: { threadId: "task-2" } };
      }
      if (path === "/api/bots/bot-1/tasks/task-2?messages=0") {
        return {
          bot: {
            id: "bot-1", name: "Mira", threadId: "task-2",
            tasks: [{ threadId: "task-2", title: "Fresh", cwd: "/private/project" }],
            messages: [{ png: "pixels", card: { allowKey: "Shell:rm" } }],
            resumeCursors: { codex: "session" },
          },
        };
      }
      return { path, method: options?.method, task: { threadId: "task-2", title: "Fresh" } };
    });
    const created: any = await handleToolCall("create_task", { target_type: "channel", target_id: "channel-1", title: "Fresh" }, fetcher);
    expect(fetcher).toHaveBeenLastCalledWith("/api/groups/channel-1/tasks", expect.objectContaining({ method: "POST" }));
    expect(created.task.taskId).toBe("task-2");
    const switched: any = await handleToolCall("switch_task", {
      target_type: "bot", target_id: "bot-1", task_id: "task-2",
    }, fetcher);
    expect(fetcher).toHaveBeenLastCalledWith("/api/bots/bot-1/tasks/task-2?messages=0", expect.objectContaining({ method: "POST" }));
    expect(JSON.stringify(switched)).not.toContain("/private/project");
    expect(JSON.stringify(switched)).not.toContain("pixels");
    expect(JSON.stringify(switched)).not.toContain("Shell:rm");
    expect(JSON.stringify(switched)).not.toContain("session");
  });

  it("rejects incomplete mutation responses before projecting them", async () => {
    const fetcher = vi.fn(async () => ({}));

    await expect(handleToolCall("update_bot_profile", {
      bot_id: "bot-1", name: "Mira",
    }, fetcher)).rejects.toThrow("BotFleet did not return the updated bot");
    await expect(handleToolCall("update_channel", {
      channel_id: "channel-1", name: "Launch",
    }, fetcher)).rejects.toThrow("BotFleet did not return the updated channel");
    await expect(handleToolCall("create_task", {
      target_type: "bot", target_id: "bot-1", title: "Fresh",
    }, fetcher)).rejects.toThrow("BotFleet did not return the created task");
    await expect(handleToolCall("rename_task", {
      target_type: "bot", target_id: "bot-1", task_id: "task-1", title: "Renamed",
    }, fetcher)).rejects.toThrow("BotFleet did not return the renamed task");
  });

  it("searches with encoded, bounded parameters", async () => {
    const fetcher = vi.fn(async () => ({ hits: [{ messageId: "m1" }] }));
    const result: any = await handleToolCall("search_messages", { query: "release notes", task_id: "task-1", limit: 100 }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/search?q=release+notes&limit=100&threadId=task-1");
    expect(result.hits).toHaveLength(1);
  });

  it("requires an exact available model and refuses changes while busy", async () => {
    const busyFetcher = vi.fn(async () => ({ bots: [{ id: "bot-1", busy: true }] }));
    await expect(handleToolCall("set_bot_model", {
      bot_id: "bot-1", instance_id: "codex", model: "gpt-5.6-sol",
    }, busyFetcher)).rejects.toThrow("let it finish");

    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return { bots: [{ id: "bot-1", busy: false }] };
      if (path === "/api/instances") return { instances: [{
        instanceId: "codex", snapshot: { state: "available" },
        models: { default: "gpt-5.6-sol", options: [{ id: "gpt-5.6-sol" }] },
        capabilities: { effortLevels: ["high"] },
      }] };
      if (path === "/api/bots/bot-1") {
        expect(JSON.parse(String(options?.body))).toEqual({
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", effort: "high" },
          requireAvailableModel: true,
        });
        return {
          bot: {
            id: "bot-1",
            name: "Mira",
            threadId: "task-1",
            tasks: [{ threadId: "task-1", cwd: "/secret/work", resumeCursors: { codex: "native-session" } }],
            messages: [{ png: "pixels", card: { allowKey: "Bash:git" } }],
            alwaysAllow: ["Bash:git"],
            resumeCursors: { codex: "native-session" },
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await expect(handleToolCall("set_bot_model", {
      bot_id: "bot-1", instance_id: "codex", model: "made-up",
    }, fetcher)).rejects.toThrow("not offered");
    const result: any = await handleToolCall("set_bot_model", {
      bot_id: "bot-1", instance_id: "codex", model: "gpt-5.6-sol", effort: "high",
    }, fetcher);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/secret/work");
    expect(JSON.stringify(result)).not.toContain("native-session");
    expect(JSON.stringify(result)).not.toContain("Bash:git");
    expect(JSON.stringify(result)).not.toContain("pixels");
  });

  it("waits on a bot conversation and returns a compact attention tail", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Mira", busy: true, activity: "waiting-on-you", threadId: "task-1", tasks: [] }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return { messages: [{ id: "m1", at: 1, role: "bot", kind: "text", text: "Approve?" }] };
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", timeout_seconds: 1,
    }, fetcher);
    expect(result).toMatchObject({ status: "needs-user", messages: [{ text: "Approve?" }] });
  });

  it("reports no-signal as stalled and keeps the frozen task tail", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{
          id: "bot-1", name: "Mira", busy: true, activity: "no-signal",
          threadId: "task-active", tasks: [{ threadId: "task-active" }, { threadId: "task-old" }],
        }],
        groups: [],
      };
      if (path === "/api/threads/task-old/messages?limit=10") {
        return { messages: [{ id: "old", at: 1, role: "bot", kind: "text", text: "Old task" }] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const historical: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", task_id: "task-old", timeout_seconds: 1,
    }, fetcher);
    expect(historical).toMatchObject({ status: "settled", taskId: "task-old", messages: [{ text: "Old task" }] });

    const stalledFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Mira", busy: true, activity: "no-signal", threadId: "task-active", tasks: [] }],
        groups: [],
      };
      if (path === "/api/threads/task-active/messages?limit=10") return { messages: [] };
      throw new Error(`unexpected path ${path}`);
    });
    const stalled: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", timeout_seconds: 1,
    }, stalledFetcher);
    expect(stalled.status).toBe("stalled");
  });

  it("reports asynchronous bot and channel dispatch failures", async () => {
    const errorMessages = {
      messages: [
        { id: "u1", at: 1, role: "user", kind: "text", text: "Start" },
        { id: "e1", at: 2, role: "bot", kind: "activity", tool: { name: "error: provider failed to start", ok: false } },
      ],
    };
    const botFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Mira", busy: false, activity: "idle", threadId: "task-1", tasks: [] }],
        groups: [],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return errorMessages;
      throw new Error(`unexpected path ${path}`);
    });
    const botResult: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", timeout_seconds: 1,
    }, botFetcher);
    expect(botResult.status).toBe("failed");

    const channelFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [],
        groups: [{
          id: "channel-1", name: "Launch", memberIds: [], threadId: "task-1",
          tasks: [], working: false, busyBotId: null,
        }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return errorMessages;
      throw new Error(`unexpected path ${path}`);
    });
    const channelResult: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, channelFetcher);
    expect(channelResult.status).toBe("failed");

    const partialFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [],
        groups: [{
          id: "channel-1", name: "Launch", memberIds: [], threadId: "task-1",
          tasks: [], working: false, busyBotId: null,
        }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return {
        messages: [
          ...errorMessages.messages,
          { id: "m2", at: 3, role: "bot", kind: "text", text: "Another responder completed the task." },
        ],
      };
      throw new Error(`unexpected path ${path}`);
    });
    const partialResult: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, partialFetcher);
    expect(partialResult.status).toBe("settled");
  });

  it("detects durable channel blockers and interrupts the exact target thread", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", activity: "waiting-on-you" }],
        groups: [{ id: "channel-1", name: "Launch", memberIds: ["bot-1"], threadId: "task-1", tasks: [], busyBotId: "bot-1" }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return {
        messages: [{ id: "m1", at: 1, role: "bot", kind: "options", card: { title: "Approve?", requestId: "private", allowKey: "Bash:git" } }],
      };
      if (path === "/api/groups/channel-1/interrupt") {
        expect(JSON.parse(String(options?.body))).toEqual({ threadId: "task-1" });
        return { ok: true };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const waited: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, fetcher);
    expect(waited.status).toBe("needs-user");
    expect(waited.messages[0].card).not.toHaveProperty("requestId");
    expect(waited.messages[0].card).not.toHaveProperty("allowKey");

    const interrupted: any = await handleToolCall("interrupt_conversation", {
      target_type: "channel", target_id: "channel-1",
    }, fetcher);
    expect(interrupted).toEqual({
      success: true, targetType: "channel", targetId: "channel-1", taskId: "task-1",
    });
  });

  it("keeps waiting while a channel operation is between responders", async () => {
    let fleetReads = 0;
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") {
        fleetReads += 1;
        return {
          bots: [],
          groups: [{
            id: "channel-1",
            name: "Launch",
            memberIds: ["bot-1", "bot-2"],
            threadId: "task-1",
            tasks: [],
            working: fleetReads === 1,
            busyBotId: null,
          }],
        };
      }
      if (path === "/api/threads/task-1/messages?limit=10") return {
        messages: fleetReads === 1
          ? [{ id: "m1", at: 1, role: "user", kind: "text", text: "Ask everyone" }]
          : [{ id: "m2", at: 2, role: "bot", kind: "text", text: "Done" }],
      };
      throw new Error(`unexpected path ${path}`);
    });

    const result: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, fetcher);
    expect(fleetReads).toBe(2);
    expect(result).toMatchObject({ status: "settled", target: { working: false } });
  });

  it("does not expose executable paths from the model catalog", async () => {
    const fetcher = vi.fn(async () => ({ instances: [{
      instanceId: "codex", displayName: "Codex", snapshot: { state: "available" }, models: {}, capabilities: {},
      cli: "/secret/bin/codex", cliCandidates: ["/secret/bin/codex"], install: { command: "secret" },
    }] }));
    const result: any = await handleToolCall("list_available_models", {}, fetcher);
    expect(result.instances[0]).not.toHaveProperty("cli");
    expect(result.instances[0]).not.toHaveProperty("cliCandidates");
    expect(result.instances[0]).not.toHaveProperty("install");
    expect(result.instances[0].snapshot).toEqual({ state: "available" });
  });

  it("omits exhausted Antigravity models from the available catalog", async () => {
    const fetcher = vi.fn(async () => ({
      instances: [{
        instanceId: "antigravity",
        displayName: "Antigravity",
        snapshot: {
          state: "available",
          quota: {
            capped: false,
            models: {
              "claude-opus-4-6-thinking": { capped: true, remainingPercent: 0 },
              "gemini-3.1-pro-high": { capped: false, remainingPercent: null },
            },
          },
        },
        models: {
          default: "claude-opus-4-6-thinking",
          options: [
            { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
            { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
          ],
        },
        capabilities: {},
      }],
    }));
    const result: any = await handleToolCall("list_available_models", {}, fetcher);
    expect(result.instances[0].models.default).toBe("gemini-3.1-pro-high");
    expect(result.instances[0].models.options.map((row: { id: string }) => row.id)).toEqual(["gemini-3.1-pro-high"]);
    expect(result.instances[0].snapshot.quota.models["claude-opus-4-6-thinking"].capped).toBe(true);
  });
});

describe("MCP fleet tools", () => {
  const cardMessages = {
    messages: [
      {
        id: "old", at: 1, role: "bot", kind: "options",
        card: { title: "Done before", subtitle: "ls", options: ["Allow", "Deny"], requestId: "answered-request", tool: "Bash", allowKey: "Bash:ls", answered: "Allow" },
      },
      {
        id: "ask", at: 2, role: "bot", kind: "options",
        card: { title: "Run command?", subtitle: "git push", options: ["Allow", "Deny"], requestId: "live-request", tool: "Bash", allowKey: "Bash:git", held: "pushes to a remote" },
      },
      {
        id: "question", at: 3, role: "bot", kind: "options",
        card: { title: "Which branch?", subtitle: "main or release", options: ["main", "release"], requestId: "question-request" },
      },
    ],
  };

  it("lists pending cards across active tasks with the ids needed to answer them", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [
          { id: "bot-1", name: "Mira", busy: true, activity: "waiting-on-you", threadId: "task-1", tasks: [] },
          { id: "bot-2", name: "Deckard", busy: false, activity: "idle", threadId: "task-2", tasks: [] },
        ],
        groups: [{ id: "channel-1", name: "Launch", memberIds: ["bot-2"], threadId: "task-room", tasks: [], busyBotId: null }],
      };
      if (path === "/api/threads/task-1/messages?limit=50") return cardMessages;
      if (path === "/api/threads/task-2/messages?limit=50") return { messages: [{ id: "t", at: 5, role: "bot", kind: "text", text: "Idle" }] };
      if (path === "/api/threads/task-room/messages?limit=50") return {
        messages: [{
          id: "room-card", at: 4, role: "bot", kind: "options",
          from: { botId: "bot-2", name: "Deckard" },
          card: { title: "Approval needed", subtitle: "rm -rf /tmp/scratch", options: ["Allow", "Deny"], requestId: "room-request", tool: "Bash", allowKey: "Bash:rm" },
        }],
      };
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("list_pending_approvals", {}, fetcher);
    expect(result.tasksInspected).toBe(3);
    expect(result.approvals.map((approval: any) => approval.requestId)).toEqual(["live-request", "question-request", "room-request"]);
    expect(result.approvals[0]).toMatchObject({
      taskId: "task-1", botId: "bot-1", botName: "Mira", kind: "permission", tool: "Bash",
      summary: "git push", held: "pushes to a remote", waitingOnYou: true, messageId: "ask",
    });
    expect(result.approvals[1]).toMatchObject({ kind: "question", tool: null, options: ["main", "release"] });
    expect(result.approvals[2]).toMatchObject({
      channelId: "channel-1", channelName: "Launch", botId: "bot-2", botName: "Deckard", taskId: "task-room", waitingOnYou: false,
    });
    // the remembered-grant key never leaves the harness, even here
    expect(JSON.stringify(result)).not.toContain("Bash:git");
    expect(JSON.stringify(result)).not.toContain("Bash:rm");

    const scoped: any = await handleToolCall("list_pending_approvals", { bot_id: "bot-1", limit: 50 }, fetcher);
    expect(scoped.tasksInspected).toBe(1);
    expect(scoped.approvals).toHaveLength(2);
    await expect(handleToolCall("list_pending_approvals", { channel_id: "missing" }, fetcher)).rejects.toThrow("Channel not found");
  });

  it("answers a card exactly as the desktop does and reports what the harness did", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      expect(path).toBe("/api/threads/task-1/respond");
      expect(options?.method).toBe("POST");
      const body = JSON.parse(String(options?.body));
      bodies.push(body);
      if (body.requestId === "gone") return { ok: true, outcome: "unavailable" };
      if (body.requestId === "routine") return { ok: true, outcome: "allowed-once", routineAction: "create", resultId: "routine-9" };
      return { ok: true, outcome: body.behavior === "allow" ? "allowed-once" : body.behavior === "deny" ? "rejected" : "answered" };
    });

    const allowed: any = await handleToolCall("answer_approval", {
      task_id: "task-1", request_id: "live-request", behavior: "allow",
    }, fetcher);
    expect(allowed).toMatchObject({ outcome: "allowed-once", delivered: true, behavior: "allow" });
    const denied: any = await handleToolCall("answer_approval", {
      task_id: "task-1", request_id: "live-request", behavior: "deny", message: "Not from a script.",
    }, fetcher);
    expect(denied).toMatchObject({ outcome: "rejected", delivered: true });
    const answered: any = await handleToolCall("answer_approval", {
      task_id: "task-1", request_id: "question-request", behavior: "answer", message: "release",
    }, fetcher);
    expect(answered).toMatchObject({ outcome: "answered", delivered: true });
    const stale: any = await handleToolCall("answer_approval", {
      task_id: "task-1", request_id: "gone", behavior: "allow",
    }, fetcher);
    expect(stale).toMatchObject({ outcome: "unavailable", delivered: false });
    const routine: any = await handleToolCall("answer_approval", {
      task_id: "task-1", request_id: "routine", behavior: "allow",
    }, fetcher);
    expect(routine).toMatchObject({ routineAction: "create", routineResultId: "routine-9" });

    expect(bodies).toEqual([
      { requestId: "live-request", behavior: "allow" },
      { requestId: "live-request", behavior: "deny", message: "Not from a script." },
      { requestId: "question-request", behavior: "answer", message: "release" },
      { requestId: "gone", behavior: "allow" },
      { requestId: "routine", behavior: "allow" },
    ]);
    // no body ever carries a remembered grant
    expect(JSON.stringify(bodies)).not.toContain("alwaysAllow");

    await expect(handleToolCall("answer_approval", {
      task_id: "task-1", request_id: "question-request", behavior: "answer",
    }, fetcher)).rejects.toThrow("message is required");
    expect(() => validateToolArguments("answer_approval", {
      task_id: "task-1", request_id: "x", behavior: "always-allow",
    })).toThrow("must be one of");
  });

  it("reports the send outcome and forwards a validated idempotency key", async () => {
    const seen: unknown[] = [];
    let reply: Record<string, unknown> = { ok: true };
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", threadId: "task-1", tasks: [{ threadId: "task-1" }] }],
        groups: [{ id: "channel-1", threadId: "room-1", tasks: [{ threadId: "room-1" }] }],
      };
      if (path === "/api/bots/bot-1/messages" || path === "/api/groups/channel-1/messages") {
        seen.push(JSON.parse(String(options?.body)));
        return reply;
      }
      throw new Error(`unexpected path ${path}`);
    });

    const started: any = await handleToolCall("send_bot_message", { bot_id: "bot-1", text: "Go", idempotency_key: "run:1" }, fetcher);
    expect(started).toMatchObject({ success: true, outcome: "started", replayed: false, idempotencyKey: "run:1" });
    reply = { ok: true, queued: true, queueId: "q-7", threadId: "task-1", replayed: true };
    const queued: any = await handleToolCall("send_bot_message", { bot_id: "bot-1", text: "Go", idempotency_key: "run:1" }, fetcher);
    expect(queued).toMatchObject({ outcome: "queued", queueId: "q-7", replayed: true });
    reply = { ok: true, steered: true };
    const steered: any = await handleToolCall("send_bot_message", { bot_id: "bot-1", text: "Also" }, fetcher);
    expect(steered).toMatchObject({ outcome: "steered", replayed: false });
    expect(steered).not.toHaveProperty("idempotencyKey");
    reply = { ok: true };
    const posted: any = await handleToolCall("send_channel_message", { channel_id: "channel-1", text: "Ship", idempotency_key: "ship.1" }, fetcher);
    expect(posted).toMatchObject({ outcome: "started", replayed: false, idempotencyKey: "ship.1" });

    expect(seen).toEqual([
      { text: "Go", threadId: "task-1", idempotencyKey: "run:1" },
      { text: "Go", threadId: "task-1", idempotencyKey: "run:1" },
      { text: "Also", threadId: "task-1" },
      { text: "Ship", threadId: "room-1", idempotencyKey: "ship.1" },
    ]);
    await expect(handleToolCall("send_bot_message", {
      bot_id: "bot-1", text: "Go", idempotency_key: "has spaces",
    }, fetcher)).rejects.toThrow("idempotency_key may contain only");
  });

  it("lists routines with bounded prompts and newest runs, and queues one to run now", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/routines") return {
        routines: [
          { id: "r1", name: "Tidy", botId: "bot-1", runOn: "bot", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 30, nextRunAt: 99, createdAt: 1, updatedAt: 2, prompt: "p".repeat(1_500) },
          { id: "r2", name: "Other", botId: "bot-2", runOn: "cloud", enabled: false, schedule: { type: "once", at: 5 }, durationMinutes: 10, nextRunAt: null, createdAt: 1, updatedAt: 1, prompt: "short" },
        ],
        runs: [
          { id: "run-old", routineId: "r1", routineName: "Tidy", botId: "bot-1", runOn: "bot", scheduledFor: 1, status: "completed", manual: false, createdAt: 10, output: "o".repeat(900), seenAt: 11 },
          { id: "run-new", routineId: "r1", routineName: "Tidy", botId: "bot-1", runOn: "bot", scheduledFor: 2, status: "failed", manual: true, createdAt: 20, error: "provider unavailable", threadId: "task-9" },
          { id: "run-other", routineId: "r2", routineName: "Other", botId: "bot-2", runOn: "cloud", scheduledFor: 3, status: "queued", manual: false, createdAt: 30 },
        ],
      };
      if (path === "/api/routines/r1/run" && options?.method === "POST") {
        return { run: { id: "run-now", routineId: "r1", routineName: "Tidy", botId: "bot-1", runOn: "bot", scheduledFor: 4, status: "queued", manual: true, createdAt: 40 } };
      }
      if (path === "/api/routines/missing/run") return { error: "no such routine" };
      throw new Error(`unexpected path ${path}`);
    });
    const listed: any = await handleToolCall("list_routines", { bot_id: "bot-1", run_limit: 1 }, fetcher);
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]).toMatchObject({ id: "r1", promptTruncated: true, enabled: true });
    expect(listed.routines[0].prompt).toHaveLength(1_000);
    expect(listed.runs.map((run: any) => run.id)).toEqual(["run-new"]);
    expect(listed.runs[0]).toMatchObject({ status: "failed", taskId: "task-9", error: "provider unavailable", triggerSource: "manual", seen: false });

    const everything: any = await handleToolCall("list_routines", {}, fetcher);
    expect(everything.routines.map((routine: any) => routine.id)).toEqual(["r1", "r2"]);
    expect(everything.runs.map((run: any) => run.id)).toEqual(["run-other", "run-new", "run-old"]);
    expect(everything.runs[2]).toMatchObject({ outputTruncated: true, seen: true });
    expect(everything.runs[2].outputPreview).toHaveLength(500);

    const ran: any = await handleToolCall("run_routine", { routine_id: "r1" }, fetcher);
    expect(ran).toMatchObject({ success: true, routineId: "r1", run: { id: "run-now", status: "queued", manual: true } });
    await expect(handleToolCall("run_routine", { routine_id: "missing" }, fetcher)).rejects.toThrow("did not return the queued run");
  });

  it("lists webhooks without secrets, endpoint ids, or captured payloads", async () => {
    const fetcher = vi.fn(async () => ({
      webhooks: [{
        id: "wh-1", endpointId: "wh_abc", name: "Deploy done", prompt: "Check the deploy", botId: "bot-1", runOn: "bot", enabled: true,
        createdAt: 1, updatedAt: 2, deliveryCount: 3, verificationPending: false, verifiedAt: 5, eventTypes: ["deploy"],
        secretHash: "deadbeef", verificationSample: { receivedAt: 4, preview: "token=whsec_secret" },
      }],
      attempts: [{ endpointId: "wh_abc", statusCode: 401, reason: "bad secret whsec_leak" }],
      ingress: { available: true, baseUrl: "http://127.0.0.1:8800", error: undefined },
    }));
    const result: any = await handleToolCall("list_webhooks", {}, fetcher);
    expect(result.webhooks[0]).toMatchObject({ id: "wh-1", name: "Deploy done", deliveryCount: 3, eventTypes: ["deploy"], verifiedAt: 5 });
    expect(result.ingress).toEqual({ available: true, baseUrl: "http://127.0.0.1:8800" });
    const serialized = JSON.stringify(result);
    for (const leak of ["wh_abc", "deadbeef", "whsec_", "secretHash", "verificationSample", "attempts"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("reads the decision log through the server-side filters", async () => {
    const fetcher = vi.fn(async (path: string) => {
      expect(path).toBe("/api/decisions?limit=25&botId=bot-1&threadId=task-1");
      return { decisions: [{
        at: "2026-09-02T10:00:00.000Z", threadId: "task-1", requestId: "req-1", botId: "bot-1", botName: "Mira",
        tool: "Bash", summary: "git status", decision: "auto-approved", source: "grant", rule: "Bash:git",
      }] };
    });
    const result: any = await handleToolCall("read_decision_log", { bot_id: "bot-1", task_id: "task-1", limit: 25 }, fetcher);
    expect(result.decisions).toEqual([{
      at: "2026-09-02T10:00:00.000Z", taskId: "task-1", requestId: "req-1", botId: "bot-1", botName: "Mira",
      tool: "Bash", summary: "git status", decision: "auto-approved", source: "grant", rule: "Bash:git", unattended: false,
    }]);
  });

  it("opens the desktop only through the loopback harness route", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      expect(path).toBe("/api/desktop/open");
      expect(options?.method).toBe("POST");
      return { ok: true };
    });
    // the default endpoint is loopback, so the tool asks the harness and nothing else
    const result: any = await handleToolCall("open_app", {}, fetcher);
    expect(result).toMatchObject({ success: true, opened: true, endpoint: "http://127.0.0.1:8799" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(isLoopbackOrigin("http://127.0.0.1:8799")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:8799")).toBe(true);
    expect(isLoopbackOrigin("https://botfleet.example.com")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.1.example.com")).toBe(false);
    // a Linux or Windows harness answers 503 with an honest reason, which surfaces verbatim
    const refusing = vi.fn(async () => { throw new Error("BotFleet API error (503): opening the desktop app is a Mac action"); });
    await expect(handleToolCall("open_app", {}, refusing)).rejects.toThrow("Mac action");
  });

  it("lets in-flight calls settle after stdin closes and aborts only what outlives the grace", async () => {
    const quick = new AbortController();
    const settled = new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(await drainInFlight([settled], [quick], 1_000)).toEqual({ aborted: 0 });
    expect(quick.signal.aborted).toBe(false);

    const stuck = new AbortController();
    const done = new AbortController();
    done.abort();
    const neverOnItsOwn = new Promise<void>((_resolve, reject) => {
      stuck.signal.addEventListener("abort", () => reject(stuck.signal.reason), { once: true });
    });
    expect(await drainInFlight([neverOnItsOwn.catch(() => undefined)], [stuck, done], 20)).toEqual({ aborted: 1 });
    expect(stuck.signal.aborted).toBe(true);
    expect(await drainInFlight([], [new AbortController()], 0)).toEqual({ aborted: 0 });
  });

  it("answers every call a one-shot pipe driver queued before closing stdin", async () => {
    const stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/health") return res.end(JSON.stringify({ app: "botfleet" }));
      if (url.pathname === "/api/bots") {
        // slow enough that aborting on close would have cut it off
        setTimeout(() => res.end(JSON.stringify({
          bots: [{ id: "bot-1", name: "Mira", threadId: "task-1", tasks: [] }],
          groups: [],
        })), 300);
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;
    const child = spawnDetached(process.execPath, [MCP_SCRIPT], {
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        BOTFLEET_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.stdin!.write([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pipe", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_system_health", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } }),
      "",
    ].join("\n"));
    child.stdin!.end();
    try {
      await waitForExit(child, { graceMs: 15_000 });
      const frames = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const context = `stdout:\n${stdout}\nstderr:\n${stderr}`;
      expect(frames.map((frame) => frame.id), context).toEqual([1, 2, 3]);
      expect(frames.some((frame) => frame.error?.code === -32800), context).toBe(false);
      expect(frames[1].result.structuredContent.status, context).toBe("connected");
      expect(frames[2].result.structuredContent.bots[0].id, context).toBe("bot-1");
      expect(child.exitCode, context).toBe(0);
    } finally {
      stub.close();
    }
  }, 30_000);
});

describe("connection security and discovery", () => {
  it("accepts loopback HTTP and HTTPS origins, but rejects unsafe URL shapes", () => {
    expect(validateBaseUrl("http://127.0.0.1:8799/")).toBe("http://127.0.0.1:8799");
    expect(validateBaseUrl("http://[::1]:8799")).toBe("http://[::1]:8799");
    expect(validateBaseUrl("https://maus.example.com")).toBe("https://maus.example.com");
    expect(() => validateBaseUrl("ftp://maus.example.com")).toThrow("http:// or https://");
    expect(() => validateBaseUrl("https://maus.example.com/api")).toThrow("origin without a path");
    expect(() => validateBaseUrl("https://user:pass@maus.example.com")).toThrow("must not contain credentials");
    expect(() => validateBaseUrl("http://0.0.0.0:8799")).toThrow("Insecure cleartext HTTP");
  });

  it("skips a foreign process and discovers the real fallback port", async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes(":8799")) return jsonResponse({ app: "not-botfleet" });
      if (String(url).includes(":18799")) return jsonResponse({ app: "botfleet" });
      throw new Error("unexpected port");
    }) as any;
    await expect(probeBaseUrls(["http://127.0.0.1:8799", "http://127.0.0.1:18799"])).resolves.toBe("http://127.0.0.1:18799");
  });

  it("rejects successful non-JSON responses and sends an optional bearer token", async () => {
    process.env.BOTFLEET_TOKEN = "proxy-token";
    globalThis.fetch = vi.fn(async (_url: any, options: any) => {
      expect(new Headers(options.headers).get("Authorization")).toBe("Bearer proxy-token");
      return { ...jsonResponse({}), json: vi.fn(async () => { throw new Error("not json"); }) };
    }) as any;
    await expect(request("/api/health", {}, "https://maus.example.com")).rejects.toThrow("non-JSON response");
  });

  it("requires an explicit destination before sending a bearer token", async () => {
    process.env.BOTFLEET_TOKEN = "proxy-token";
    await expect(resolveBaseUrl()).rejects.toThrow("BOTFLEET_URL or OMB_PORT");
  });

  it("validates direct tool arguments", () => {
    expect(() => validateToolArguments("send_bot_message", { bot_id: "bot-1", text: "hello" })).not.toThrow();
    expect(() => validateToolArguments("send_bot_message", { bot_id: "bot-1", text: "hello", extra: true })).toThrow("not supported");
  });
});
