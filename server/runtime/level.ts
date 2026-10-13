// The one level rule, adapted to BotFleet.
//
// OpenMausBot raises a teammate to a Chief's approval mode when the engine
// can actually run it.  BotFleet does not have that mode ladder.  A peer
// already runs under its own model, its own automatic-approval switch and
// its own grants, and borrowing the requester's switch would let a careful
// teammate inherit a looser one.  The record stores the assignee's own
// posture so a later turn can be checked against it.
import type { Level, LevelSource, OriginKind } from "./types.ts";

export function assignmentLevel(input: {
  own: Level;
  chief?: Level;
  origin: OriginKind;
  chiefLineage: boolean;
  driverKind?: string;
}): { level: Level; source: LevelSource } {
  void input.chief;
  void input.origin;
  void input.chiefLineage;
  void input.driverKind;
  return { level: input.own, source: "own" };
}
