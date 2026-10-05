// Your plugin module.  Imported once when the user enables the plugin.
// Exports the host can invoke:
//
//   getCardData({ cardId, host }) -> any
//     Called by the host when rendering a card the manifest declared.
//     Return whatever JSON the host should render against the declared
//     layout.  Keep it small.
//
//   runCommand({ command, args, host }) -> string
//     Called by the host when the user types /<command> in a bot chat.
//     Return the text the host appends as a system message.
//
// The host API you receive is frozen.  You cannot mutate BotFleet
// state from inside a plugin.  See docs/plugins/DESIGN.md for the
// full host API surface.

export function getCardData({ cardId, host }) {
  if (cardId !== "example") return { result: null };
  const bots = host.getBots();
  host.log("info", `rendering example card with ${bots.length} bots`);
  return { result: { a: bots.length, b: bots.length * 2 } };
}

const HELLO_NAME_MAX = 64;

export function runCommand({ command: _command, args, host }) {
  const raw = typeof args === "string" ? args.trim() : "";
  if (raw.length > HELLO_NAME_MAX) {
    host.log("info", "hello command rejected");
    return "That name is too long for this example.";
  }
  const who = raw || "world";
  // The greeting the person asked for may include the name.  The log must not.
  host.log("info", "hello command");
  return `Hello, ${who}, from your plugin.`;
}
