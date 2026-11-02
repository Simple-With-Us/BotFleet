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

    @Test("Recursive search over a directory containing a symlink is never auto-approved")
    func recursiveSymlinkEscape() throws {
        let (policy, root) = try makeDataDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let fm = FileManager.default
        let workspace = root.appendingPathComponent("workspaces/bot-a")
        try fm.createDirectory(at: workspace.appendingPathComponent("tree"), withIntermediateDirectories: true)
        try "x".write(to: workspace.appendingPathComponent("tree/real.md"), atomically: true, encoding: .utf8)
        // Symlinked file and directory inside the searched tree, both escaping.
        try fm.createSymbolicLink(at: workspace.appendingPathComponent("tree/leak.md"),
                                  withDestinationURL: root.appendingPathComponent("config.json"))
        try fm.createDirectory(at: workspace.appendingPathComponent("tree2"), withIntermediateDirectories: true)
        try "x".write(to: workspace.appendingPathComponent("tree2/real.md"), atomically: true, encoding: .utf8)
        try fm.createSymbolicLink(at: workspace.appendingPathComponent("tree2/leakdir"),
                                  withDestinationURL: root.appendingPathComponent("bots"))
        // A symlink that stays inside the bot's own folder: still not auto-approved
        // inside a searched tree, because its target can be repointed later.
        try fm.createDirectory(at: workspace.appendingPathComponent("tree3"), withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: workspace.appendingPathComponent("tree3/alias.md"),
                                  withDestinationURL: workspace.appendingPathComponent("memory.md"))
        let cwd = workspace.path
        for command in ["grep -r x tree", "rg x tree", "ls -R tree", "grep -r x tree2", "rg x tree3"] {
            #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: command, cwd: cwd),
                    "expected no auto-approval for: \(command)")
        }
        // A clean tree with no symlinks still auto-approves.
        #expect(NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "rg x skills", cwd: cwd))
        #expect(NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "ls -R skills", cwd: cwd))
    }

    @Test("A symlinked final or intermediate component is never auto-approved")
    func symlinkedComponents() throws {
        let (policy, root) = try makeDataDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let fm = FileManager.default
        let workspace = root.appendingPathComponent("workspaces/bot-a")
        // Both links point INSIDE the bot's own folders today.
        try fm.createSymbolicLink(at: workspace.appendingPathComponent("alias.md"),
                                  withDestinationURL: workspace.appendingPathComponent("memory.md"))
        try fm.createSymbolicLink(at: workspace.appendingPathComponent("linkdir"),
                                  withDestinationURL: workspace.appendingPathComponent("skills"))
        let cwd = workspace.path
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat alias.md", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat linkdir/SKILL.md", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", readPaths: ["\(cwd)/alias.md"]))
        // The real files behind them still auto-approve.
        #expect(NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat memory.md", cwd: cwd))
        #expect(NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat skills/SKILL.md", cwd: cwd))
    }

    @Test("Empty quoted arguments are rejected instead of resolving to cwd")
    func emptyArguments() throws {
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat ''") == nil)
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat \"\"") == nil)
        #expect(NativeOwnFileReads.readOnlyPaths(command: "grep '' memory.md") == nil)
        let (policy, root) = try makeDataDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let cwd = root.appendingPathComponent("workspaces/bot-a").path
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "cat ''", cwd: cwd))
        #expect(!NativeOwnFileReads.readsOwnFiles(policy: policy, botId: "bot-a", command: "ls ''", cwd: cwd))
    }

    @Test("Combining marks cannot disguise quotes, backticks or dollars")
    func combiningMarkBypass() {
        let mark = "\u{301}"  // COMBINING ACUTE ACCENT
        // Quote + combining mark must terminate the quoted word for the
        // tokenizer exactly as it does for the (byte-oriented) shell.
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat \"x\"\(mark);id\"") == nil)
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat 'x'\(mark);id'") == nil)
        // Backtick / dollar + combining mark inside double quotes is still
        // a backtick / dollar.
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat \"`\(mark)id`\"") == nil)
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat \"$\(mark)(id)\"") == nil)
        // Ordinary non-ASCII content inside quotes still tokenizes as one word.
        #expect(NativeOwnFileReads.readOnlyPaths(command: "cat 'cafe\u{301}.md'") == ["cafe\u{301}.md"])
    }
}
