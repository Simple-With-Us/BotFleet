#!/usr/bin/env node

/**
 * benchmark-tts-post-processor.mjs
 *
 * Repeatable benchmark suite evaluating fast/cheap LLMs as chained TTS
 * post-processors (translating technical/markdown bot outputs into natural speech).
 *
 * Usage:
 *   node scripts/benchmark-tts-post-processor.mjs
 *   node scripts/benchmark-tts-post-processor.mjs --tts       # Also test Minimax audio synthesis
 *   node scripts/benchmark-tts-post-processor.mjs --minimax   # Only test MiniMax models
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// 1. Load keys securely from ~/.secrets/global-api-keys if available
const secretsPath = join(homedir(), ".secrets", "global-api-keys");
const secrets = {};
try {
  const content = readFileSync(secretsPath, "utf8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      secrets[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // Rely on process.env
}

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || secrets["MINIMAX_API_KEY"];
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || secrets["DEEPSEEK_API_KEY_AGENT_BAR"] || secrets["SHELLULAR2_DEEPSEEK_API_KEY"];
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || secrets["CT_OPENROUTER_API_KEY"];

// 2. Standard Test Fixture (Realistic technical PR merge output)
const SAMPLE_INPUT = `What I merged this run
ai-fleet-coordinator #304 "docs(bootstrap): cloud agent sandbox toolchain restore" — f44865ae0314e6ae23699d3f9a716cbaeee8135b

Merged via gh pr merge --squash --delete-branch (no --admin)
Branch ops/cloud-agent-bootstrap → base main
PR-head aabb4056
Files changed: README.md +1 -0, docs/CLOUD-AGENT-BOOTSTRAP.md +130 -0 — docs-only, canonical /workspace/.bootstrap.sh explainer (because every fresh cloud session wipes /usr/local/bin while /workspace survives)
All 3 checks green: test (in_progress at verify), gitleaks (in_progress at verify), Seer Code Review SUCCESS
Branch protection requires only test; clean status, no Seer bugs, no review threads
AFC has no live deploy surface (no public URL, internal ops repo)
AFC queue now empty (0 open)`;

const SYSTEM_PROMPT = `You are a helpful voice assistant. Your job is to act as a post-processor. 
Read the following raw, technical output from a bot, and translate it into a natural, conversational, friendly spoken sentence (or two) that is highly optimized for a Text-to-Speech engine. 
CRITICAL RULES:
1. Omit commit hashes, exact file paths, branch names, and deep technical jargon.
2. Provide ONLY the high-level summary of what was accomplished.
3. Make it sound like a human giving a quick verbal update.
4. DO NOT use markdown, bullet points, asterisks, or formatting.
5. Provide ONLY the spoken text, with no preamble.

Raw Output:
${SAMPLE_INPUT}`;

// 3. Models Catalog & Pricing (USD per 1M tokens)
const MODELS = [
  // MiniMax Native
  {
    id: "MiniMax-M3.1-Flash-Preview",
    provider: "minimax-native",
    inputRate: 0.30,
    outputRate: 1.20,
    maxTokens: 300,
  },
  {
    id: "MiniMax-Text-01",
    provider: "minimax-native",
    inputRate: 0.20,
    outputRate: 1.10,
    maxTokens: 300,
  },
  {
    id: "MiniMax-M2.7",
    provider: "minimax-native",
    inputRate: 0.30,
    outputRate: 1.20,
    maxTokens: 500,
  },
  {
    id: "MiniMax-M2.7-highspeed",
    provider: "minimax-native",
    inputRate: 0.60,
    outputRate: 2.40,
    maxTokens: 500,
  },
  // DeepSeek Native
  {
    id: "deepseek-flash",
    provider: "deepseek-native",
    inputRate: 0.14,
    outputRate: 0.28,
    maxTokens: 300,
  },
  {
    id: "deepseek-chat",
    provider: "deepseek-native",
    inputRate: 0.14,
    outputRate: 0.28,
    maxTokens: 150,
  },
  // OpenRouter Models
  {
    id: "meta-llama/llama-3.1-8b-instruct",
    provider: "openrouter",
    inputRate: 0.055,
    outputRate: 0.055,
    maxTokens: 150,
  },
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    provider: "openrouter",
    inputRate: 0.40,
    outputRate: 0.40,
    maxTokens: 150,
  },
  {
    id: "openai/gpt-4o-mini",
    provider: "openrouter",
    inputRate: 0.15,
    outputRate: 0.60,
    maxTokens: 150,
  },
];

async function callModel(modelConfig) {
  const start = performance.now();
  let content = "";
  let inTokens = 0;
  let outTokens = 0;
  let reasoningTokens = 0;

  if (modelConfig.provider === "minimax-native") {
    if (!MINIMAX_API_KEY) throw new Error("MINIMAX_API_KEY missing");
    const res = await fetch("https://api.minimax.io/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelConfig.id,
        messages: [{ role: "user", content: SYSTEM_PROMPT }],
        max_tokens: modelConfig.maxTokens,
      }),
    });
    const data = await res.json();
    if (data?.base_resp?.status_code !== 0 && data?.base_resp?.status_code !== undefined) {
      throw new Error(`MiniMax Error: ${data.base_resp.status_msg}`);
    }
    const choice = data?.choices?.[0];
    content = choice?.message?.content?.trim() || "";
    inTokens = data?.usage?.prompt_tokens || 0;
    outTokens = data?.usage?.completion_tokens || 0;
    if (choice?.message?.reasoning_content) {
      reasoningTokens = Math.round(choice.message.reasoning_content.length / 4);
    }
  } else if (modelConfig.provider === "deepseek-native") {
    if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelConfig.id,
        messages: [{ role: "user", content: SYSTEM_PROMPT }],
        max_tokens: modelConfig.maxTokens,
        temperature: 0.3,
      }),
    });
    const data = await res.json();
    content = data?.choices?.[0]?.message?.content?.trim() || "";
    inTokens = data?.usage?.prompt_tokens || 0;
    outTokens = data?.usage?.completion_tokens || 0;
  } else if (modelConfig.provider === "openrouter") {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelConfig.id,
        messages: [{ role: "user", content: SYSTEM_PROMPT }],
        max_tokens: modelConfig.maxTokens,
        temperature: 0.3,
      }),
    });
    const data = await res.json();
    content = data?.choices?.[0]?.message?.content?.trim() || "";
    inTokens = data?.usage?.prompt_tokens || 0;
    outTokens = data?.usage?.completion_tokens || 0;
  }

  const durationMs = Math.round(performance.now() - start);

  // Fallback token estimations if API did not return usage
  if (!inTokens) inTokens = Math.round(SYSTEM_PROMPT.length / 4);
  if (!outTokens) outTokens = Math.round(content.length / 4);

  const cost = (inTokens * modelConfig.inputRate + outTokens * modelConfig.outputRate) / 1_000_000;

  return {
    content,
    durationMs,
    inTokens,
    outTokens,
    reasoningTokens,
    cost,
  };
}

async function synthesizeTTS(text) {
  if (!MINIMAX_API_KEY || !text) return null;
  const start = performance.now();
  const res = await fetch("https://api.minimax.io/v1/t2a_v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model: "speech-01-turbo",
      text,
      stream: false,
      output_format: "hex",
      voice_setting: {
        voice_id: "English_Graceful_Lady",
        speed: 1.0,
        vol: 1.0,
        pitch: 0,
      },
    }),
  });
  const data = await res.json();
  if (data?.base_resp?.status_code !== 0) return null;
  return Math.round(performance.now() - start);
}

async function main() {
  const args = process.argv.slice(2);
  const includeTTS = args.includes("--tts");
  const onlyMiniMax = args.includes("--minimax");

  console.log("==================================================================================");
  console.log(" BotFleet TTS Post-Processing Benchmark Suite");
  console.log(" Evaluating fast/cheap models converting technical output to spoken text");
  console.log("==================================================================================\n");

  const targetModels = onlyMiniMax
    ? MODELS.filter((m) => m.provider === "minimax-native")
    : MODELS;

  const results = [];

  for (const m of targetModels) {
    process.stdout.write(`Benchmarking ${m.id.padEnd(30)} ... `);
    try {
      const res = await callModel(m);
      let ttsTime = null;
      if (includeTTS && res.content) {
        ttsTime = await synthesizeTTS(res.content);
      }
      results.push({ ...m, ...res, ttsTime });
      console.log(`[OK] ${res.durationMs}ms | $${res.cost.toFixed(6)}`);
    } catch (err) {
      console.log(`[FAIL] ${err.message}`);
      results.push({ ...m, error: err.message });
    }
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log(" SUMMARY TABLE");
  console.log("----------------------------------------------------------------------------------");
  console.log(
    "Model".padEnd(30) +
    "Latency".padEnd(12) +
    "In / Out $/1M".padEnd(18) +
    "Cost/Turn".padEnd(14) +
    (includeTTS ? "TTS Latency".padEnd(14) : "") +
    "Spoken Output Preview"
  );
  console.log("-".repeat(95));

  for (const r of results) {
    if (r.error) {
      console.log(`${r.id.padEnd(30)} ERROR: ${r.error}`);
      continue;
    }
    const rates = `$${r.inputRate}/$${r.outputRate}`;
    const preview = r.content.replace(/\n/g, " ").slice(0, 45) + (r.content.length > 45 ? "..." : "");
    const row =
      r.id.padEnd(30) +
      `${r.durationMs}ms`.padEnd(12) +
      rates.padEnd(18) +
      `$${r.cost.toFixed(6)}`.padEnd(14) +
      (includeTTS ? `${r.ttsTime || "-"}ms`.padEnd(14) : "") +
      `"${preview}"`;
    console.log(row);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log(" FULL TRANSCRIPTS & REASONING NOTES");
  console.log("----------------------------------------------------------------------------------");
  for (const r of results) {
    if (r.error) continue;
    console.log(`\n### ${r.id} (${r.durationMs}ms, Cost: $${r.cost.toFixed(6)})`);
    if (r.reasoningTokens > 0) {
      console.log(`[Note: Model performed ~${r.reasoningTokens} tokens of chain-of-thought reasoning before emitting spoken response]`);
    }
    console.log(`"${r.content}"`);
  }
}

main().catch(console.error);
