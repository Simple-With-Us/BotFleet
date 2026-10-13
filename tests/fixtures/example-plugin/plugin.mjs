// The example plugin.  Exercises the full lifecycle:
//   - getCardData for the declared card.
//   - runCommand for the declared slash command.
//
// Host API usage:
//   - host.getBots() for the data source.
//   - host.log() for status breadcrumbs.  Log text stays inside the
//     plugin's sandbox process; the host records only level and length.
//     Keep messages constant anyway: never log user input or bot data.
//
// No network, no secrets, no host state mutation.
export function getCardData({ cardId, host }) {
  if (cardId !== "fleet-overview") return { result: null };
  const bots = host.getBots();
  const counts = bots.reduce(
    (acc, bot) => {
      acc.total += 1;
      const status = (bot.status || "").toLowerCase();
      if (status.includes("error") || status.includes("fail")) acc.errored += 1;
      else if (status.includes("stop") || status.includes("idle")) acc.stopped += 1;
      else acc.running += 1;
      return acc;
    },
    { total: 0, running: 0, stopped: 0, errored: 0 },
  );
  host.log("info", "card data rendered");
  return { result: counts };
}

export function runCommand({ command: _command, args: _args, host }) {
  const bots = host.getBots();
  const counts = bots.reduce(
    (acc, bot) => {
      acc.total += 1;
      const status = (bot.status || "").toLowerCase();
      if (status.includes("error") || status.includes("fail")) acc.errored += 1;
      else if (status.includes("stop") || status.includes("idle")) acc.stopped += 1;
      else acc.running += 1;
      return acc;
    },
    { total: 0, running: 0, stopped: 0, errored: 0 },
  );
  host.log("info", "fleet command");
  return `Fleet has ${counts.total} bot${counts.total === 1 ? "" : "s"}: ` +
    `${counts.running} running, ${counts.stopped} stopped, ${counts.errored} errored.`;
}
