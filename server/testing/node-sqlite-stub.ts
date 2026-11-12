// Stand-in for node:sqlite when Vitest bundles the shared setup into the
// happy-dom environment.  That environment never opens a transcript
// database.  A real open throws, so a client test that starts writing
// messages fails here instead of talking to a fake file.

export class DatabaseSync {
  constructor(_path: string) {
    throw new Error("node:sqlite is not available in the client test environment");
  }

  close(): void {}
}
