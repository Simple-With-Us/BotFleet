// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokDriver } from "./grok.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { KimiAgentDriver } from "./acp/kimi.ts";
import { McodeAgentDriver } from "./acp/mcode.ts";
import { DroidAgentDriver } from "./acp/droid.ts";
import { CursorAgentDriver } from "./acp/cursor.ts";
import { OpenCodeDriver } from "./acp/opencode-go.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";
import { MuseAgentDriver } from "./acp/muse.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";
import { MinimaxDriver } from "./minimax.ts";
import { CliWrapperDriver } from "./cli-wrapper.ts";

import { DeepSeekAgentDriver } from "./acp/deepseek.ts";
import { DshAgentDriver } from "./acp/dsh.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  GrokDriver,
  GrokAgentDriver,
  DeepSeekAgentDriver,
  DshAgentDriver,
  KimiAgentDriver,
  McodeAgentDriver,
  DroidAgentDriver,
  CursorAgentDriver,
  OpenCodeDriver,
  QwenAgentDriver,
  HermesAgentDriver,
  MuseAgentDriver,
  PiDriver,
  OpenAICompatDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  BoxAgentDriver,
  MinimaxDriver,
  CliWrapperDriver,
];
