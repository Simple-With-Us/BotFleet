export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const ROOM_TURN_TIMEOUT_INPUT_ERROR = "Enter a whole number from 1 to 1,440.";
/** The band most bot turns should sit in: short enough that a runaway
 * turn cannot lock a channel for an hour, long enough that a real multi-step
 * task has time to finish.  Surfaces in the Settings copy so the user has a
 * default to read off, not just the raw numeric bounds. */
export const RECOMMENDED_TURN_TIMEOUT_MIN_MINUTES = 5;
export const RECOMMENDED_TURN_TIMEOUT_MAX_MINUTES = 60;

export type RoomTurnTimeoutInput =
  | { ok: true; minutes: number }
  | { ok: false; error: string };

export type RoomTurnTimeoutSaveResult = RoomTurnTimeoutInput;

export interface ExclusiveSaveGate {
  tryStart: () => boolean;
  finish: () => void;
}

export function createExclusiveSaveGate(): ExclusiveSaveGate {
  let active = false;

  return {
    tryStart: () => {
      if (active) return false;
      active = true;
      return true;
    },
    finish: () => {
      active = false;
    },
  };
}

export function parseRoomTurnTimeoutMinutes(value: string): RoomTurnTimeoutInput {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: ROOM_TURN_TIMEOUT_INPUT_ERROR };
  const minutes = Number(trimmed);
  if (minutes < MIN_ROOM_TURN_TIMEOUT_MINUTES || minutes > MAX_ROOM_TURN_TIMEOUT_MINUTES) {
    return { ok: false, error: ROOM_TURN_TIMEOUT_INPUT_ERROR };
  }
  return { ok: true, minutes };
}

export async function saveRoomTurnTimeoutMinutes(
  value: string,
  persist: (minutes: number) => Promise<number>,
): Promise<RoomTurnTimeoutSaveResult> {
  const parsed = parseRoomTurnTimeoutMinutes(value);
  if (!parsed.ok) return parsed;

  try {
    return { ok: true, minutes: await persist(parsed.minutes) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "Could not save the channel turn limit." };
  }
}
