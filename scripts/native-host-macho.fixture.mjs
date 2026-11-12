// Synthetic Mach-O structures exercise the real on-disk parser without native tools or signing material.
export const source = "1234567890abcdef1234567890abcdef12345678";
export const build = "202611031000";
export function identity(changes = {}) {
  return { schemaVersion: 1, codeIdentifier: "BotFleetNativeHost", sourceCommit: source, build,
    marketingVersion: "0.1.0", capabilities: ["identity-v1", "foreground-service-data-v1", "signal-drain-v1"],
    distribution: "developer-id", sourceDirty: false, ...changes };
}
function stringCommand(command, value, prefix) {
  const text = Buffer.from(value + "\0"), bytes = Buffer.alloc(Math.ceil((prefix + text.length) / 8) * 8);
  bytes.writeUInt32LE(command, 0); bytes.writeUInt32LE(bytes.length, 4); bytes.writeUInt32LE(prefix, 8);
  text.copy(bytes, prefix); return bytes;
}
export function thin({ arch = "arm64", stamp = identity(), loads = [], rpaths = [], fileType = 2 } = {}) {
  const commands = loads.map((load) => stringCommand(0xc, load, 24));
  commands.push(...rpaths.map((path) => stringCommand(0x8000001c, path, 12)));
  const text = stamp === null ? null : Buffer.from(JSON.stringify(stamp));
  if (text) commands.unshift(Buffer.alloc(152));
  const commandSize = commands.reduce((sum, command) => sum + command.length, 0), offset = 32 + commandSize;
  const bytes = Buffer.alloc(offset + (text?.length ?? 0));
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(arch === "arm64" ? 0 : 3, 8); bytes.writeUInt32LE(fileType, 12);
  bytes.writeUInt32LE(commands.length, 16); bytes.writeUInt32LE(commandSize, 20);
  if (text) {
    const segment = commands[0]; segment.writeUInt32LE(0x19); segment.writeUInt32LE(152, 4);
    segment.write("__TEXT", 8); segment.writeBigUInt64LE(0x100000000n, 24);
    segment.writeBigUInt64LE(BigInt(bytes.length), 32); segment.writeBigUInt64LE(BigInt(bytes.length), 48);
    segment.writeUInt32LE(1, 64); segment.write("__bf_identity", 72); segment.write("__TEXT", 88);
    segment.writeBigUInt64LE(0x100000000n + BigInt(offset), 104);
    segment.writeBigUInt64LE(BigInt(text.length), 112); segment.writeUInt32LE(offset, 120);
    text.copy(bytes, offset);
  }
  let cursor = 32;
  for (const command of commands) { command.copy(bytes, cursor); cursor += command.length; }
  return bytes;
}
export function universal(first = thin(), second = thin({ arch: "x86_64" })) {
  const firstOffset = 4096, secondOffset = Math.ceil((firstOffset + first.length) / 4096) * 4096;
  const bytes = Buffer.alloc(secondOffset + second.length);
  bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [index, slice, offset] of [[0, first, firstOffset], [1, second, secondOffset]]) {
    const record = 8 + index * 20;
    bytes.writeUInt32BE(slice.readUInt32LE(4), record); bytes.writeUInt32BE(slice.readUInt32LE(8), record + 4);
    bytes.writeUInt32BE(offset, record + 8); bytes.writeUInt32BE(slice.length, record + 12); bytes.writeUInt32BE(12, record + 16);
    slice.copy(bytes, offset);
  }
  return bytes;
}
