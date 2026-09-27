/** Profile input limits shared by every web and server write surface. */
export const BOT_PROFILE_LIMITS = {
  name: 100,
  title: 200,
  description: 4000,
  voice: 200,
} as const;

/** Ceiling for per-bot HTTP tool-loop rounds (Designer 2026-09-25). */
export const MAX_TOOL_ROUNDS = 200;
