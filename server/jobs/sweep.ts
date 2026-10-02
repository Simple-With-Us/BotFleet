// Finding processes a background job left behind (jobs P1).
//
// Every job runs with `BOTFLEET_JOB_ID=<id>` in its environment, and every
// process it starts inherits it — including one that left the job's process
// group on purpose (`setsid`, a daemon that double-forks).  The registry's
// five-minute sweep lists every process carrying the variable and stops the
// ones whose job is over.
//
// Which strays are OURS is decided by the registry, not here: a process is
// stopped only when its id names a record in this harness's own `jobs.json`
// whose job is not running.  That is what keeps a test harness on a temp
// data folder from killing the owner's live jobs, and the reverse, without a
// second environment variable.
//
// PRIVACY.  Listing environments means reading every one of this user's
// process environments and command lines, which can carry credentials.  This
// file extracts the job id and the two numbers it needs and drops the rest
// on the floor: nothing it reads is logged, returned, or kept.

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

export interface JobProcess {
  pid: number;
  pgid: number;
  jobId: string;
}

/** Lists the processes carrying `BOTFLEET_JOB_ID`.  Injected so the sweep is
 *  tested with fixtures. */
export type JobProcessLister = () => Promise<JobProcess[]>;

const JOB_ENV = /(?:^|\s|\0)BOTFLEET_JOB_ID=(job_[0-9A-Za-z]{10,40})(?=\s|\0|$)/;

/** One `ps -axwwE -o pid=,pgid=,command=` line per process: the pid, the
 *  group, then the command line with the environment appended. */
export function parseEnvListing(text: string): JobProcess[] {
  const found: JobProcess[] = [];
  for (const line of text.split("\n")) {
    const head = /^\s*(\d+)\s+(\d+)\s/.exec(line);
    if (!head) continue;
    const match = JOB_ENV.exec(line.slice(head[0].length - 1));
    if (!match) continue;
    found.push({ pid: Number(head[1]), pgid: Number(head[2]), jobId: match[1]! });
  }
  return found;
}

/** `/proc/<pid>/stat`: the group is the fifth field, after a `(comm)` that
 *  may itself hold spaces and parentheses. */
export function parseProcStatPgid(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  const pgid = Number(fields[2]);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

async function listDarwin(): Promise<JobProcess[]> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-axwwE", "-o", "pid=,pgid=,command="],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
      (error, stdout) => resolve(error ? [] : parseEnvListing(String(stdout))),
    );
  });
}

async function listLinux(): Promise<JobProcess[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const found: JobProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = await readFile(`/proc/${entry}/environ`, "utf8");
      const match = JOB_ENV.exec(environ);
      if (!match) continue;
      const pgid = parseProcStatPgid(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (pgid === null) continue;
      found.push({ pid: Number(entry), pgid, jobId: match[1]! });
    } catch {
      /* gone, or not ours to read */
    }
  }
  return found;
}

/** The real lister for this host.  Never rejects; an unreadable process
 *  table is an empty one, so a failed listing never kills anything. */
export function createJobProcessLister(): JobProcessLister {
  if (process.platform === "darwin") return listDarwin;
  if (process.platform === "linux") return listLinux;
  return async () => [];
}
