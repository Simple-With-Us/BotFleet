// Turning a set of ticked bots back into a room's ordered roster. Existing
// members keep their order, so the room's lead does not move when someone new
// joins; additions land at the end, in the order the picker listed them.
export function nextMemberIds(current: string[], picked: Set<string>, order: string[]): string[] {
  return [...current.filter((id) => picked.has(id)), ...order.filter((id) => picked.has(id) && !current.includes(id))];
}

/**
 * Ids that belong to a room.
 *
 * Section labels and room names are editable dividers.  Matching them would
 * move matrix cells and badge counts when a person renames a section.
 * A matching cwd is not membership either.
 */
export function explicitMemberIdSet(
  memberIds: readonly string[] | null | undefined,
): ReadonlySet<string> {
  return new Set(memberIds ?? []);
}
