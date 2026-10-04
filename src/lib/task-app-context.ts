type AppCandidate = {
  id: string;
  name: string;
  memberIds: readonly string[];
  cwd?: string;
  dm?: boolean;
};

/** Only explicit member rooms with a folder can supply a new task binding. */
export function eligibleTaskApps(botId: string, groups: readonly AppCandidate[]): Array<{ id: string; name: string; cwd: string }> {
  const apps: Array<{ id: string; name: string; cwd: string }> = [];
  for (const group of groups) {
    if (!group.dm && group.memberIds.includes(botId) && group.cwd?.trim()) {
      apps.push({ id: group.id, name: group.name, cwd: group.cwd });
    }
  }
  return apps;
}
