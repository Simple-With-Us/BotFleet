// The privilege a fixture needs, stated once.
//
// A test that depends on the filesystem refusing something is only meaningful
// for an unprivileged uid.  Root bypasses the file-mode checks and owns every
// link it creates, so as root the refusal never happens: the test either
// fails, or worse, passes without testing anything.  The suites that need
// this say so and skip themselves, instead of depending on the machine they
// happen to run on.

/** Whether this process runs as root. */
export function runningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

/** Why a suite whose fixture needs a refusal cannot run as root. */
export const ROOT_BYPASSES_THE_FIXTURE =
  "needs an unprivileged uid: root bypasses the file-mode and link-ownership checks this fixture is built on";
