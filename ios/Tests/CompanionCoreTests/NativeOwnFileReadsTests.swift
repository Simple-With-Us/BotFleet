import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Own-File Reads (upstream #3791)")
struct NativeOwnFileReadsTests {
    @Test("Plain reading commands name their paths")
    func plainReaders() {
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat SOUL.md") == ["SOUL.md"])
        #expect(NativeOwnFileReads.readOnlyPaths(command: "head -n 20 'skills/a b/SKILL.md'") == ["skills/a b/SKILL.md"])
        #expect(NativeOwnFileReads.readOnlyPaths(command: "grep -n needle notes.md") == ["notes.md"])
        #expect(NativeOwnFileReads.readOnlyPaths(command: "rg -n needle memory") == ["memory"])
        #expect(NativeOwnFileReads.readOnlyPaths(command: "sed -n '1,5p' SOUL.md") == ["SOUL.md"])
        #expect(NativeOwnFileReads.readOnlyPaths(command: "ls -la skills") == ["skills"])
        #expect(NativeOwnFileReads.readOnlyPaths(command: "wc -l -- SOUL.md") == ["SOUL.md"])
    }

    @Test("Anything beyond a plain read is not a plain read")
    func nonPlainCommands() {
        for command in [
            "cat SOUL.md | head",
            "cat SOUL.md > out.txt",
            "cat SOUL.md; ls",
            "cat $HOME/SOUL.md",
            "cat *.md",
            "cat ~/SOUL.md",
            "grep -R needle .",
            "rg -L needle memory",
            "rg --pre cat needle memory",
            "tail -f log.txt",
            "sed -i s/a/b/ SOUL.md",
            "rm SOUL.md",
            "cat",
            "grep needle",
            "cat -",
            "cat SOUL.md\nls",
        ] {
            #expect(NativeOwnFileReads.readOnlyPaths(command: command) == nil, "expected nil for: \(command)")
        }
    }

    @Test("ACP read paths require an absolute read call")
    func acpPaths() {
        #expect(NativeOwnFileReads.acpReadPaths(kind: "read", locations: ["/a/SOUL.md"], rawInput: nil) == ["/a/SOUL.md"])
        #expect(NativeOwnFileReads.acpReadPaths(kind: "read", locations: [], rawInput: ["file_path": "/a/x.md"]) == ["/a/x.md"])
        #expect(NativeOwnFileReads.acpReadPaths(kind: "execute", locations: ["/a/SOUL.md"], rawInput: nil) == nil)
        #expect(NativeOwnFileReads.acpReadPaths(kind: "read", locations: ["relative.md"], rawInput: nil) == nil)
        #expect(NativeOwnFileReads.acpReadPaths(kind: "read", locations: [], rawInput: nil) == nil)
    }

    private func makeDataDir() throws -> (policy: NativeOwnFileReadPolicy, root: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("own-file-reads-\(UUID().uuidString)", isDirectory: true)
        let fm = FileManager.default
        for sub in ["workspaces/bot-a/skills", "task-workspaces/bot-a/t1", "bots/bot-a", "bots/bot-b", "workspaces/bot-b"] {
            try fm.createDirectory(at: root.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        for file in ["workspaces/bot-a/memory.md", "workspaces/bot-a/skills/SKILL.md",
                     "task-workspaces/bot-a/t1/note.md", "bots/bot-a/SOUL.md",
                     "bots/bot-a/other.json", "bots/bot-b/SOUL.md", "workspaces/bot-b/memory.md",
                     "config.json"] {
            try "x".write(to: root.appendingPathComponent(file), atomically: true, encoding: .utf8)
        }
        // A symlink inside the bot's folder pointing outside it.
        try fm.createSymbolicLink(
            at: root.appendingPathComponent("workspaces/bot-a/escape.json"),
            withDestinationURL: root.appendingPathComponent("config.json"))
        return (NativeOwnFileReadPolicy(dataDirectory: root.path), root)
    }

    @Test("Own folders and SOUL.md count; everything else still asks")
    func ownContainment() throws {
        let (policy, root) = try makeDataDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let cwd = root.appendingPathComponent("workspaces/bot-a").path

        #expect(NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat memory.md", cwd: cwd))
        #expect(NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat \(root.path)/bots/bot-a/SOUL.md", cwd: cwd))
        #expect(NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", readPaths: ["\(root.path)/task-workspaces/bot-a/t1/note.md"]))

        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat \(root.path)/bots/bot-a/other.json", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat \(root.path)/bots/bot-b/SOUL.md", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat \(root.path)/workspaces/bot-b/memory.md", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat \(root.path)/config.json", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat escape.json", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat memory.md \(root.path)/config.json", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat missing.md", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "../bot-a", command: "cat memory.md", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat memory.md | wc -l", cwd: cwd))
    }
}
