// Pure build planner.  No network, uploads or release state changes.
// One shared merge-timestamp build per app across iOS and macOS (owner, Oct 29 2026).
// build = max(S, M + 1), a plain integer, where S is the committer date of
// the commit being built (HEAD) in America/Chicago as YYYYMMDDHHMM and M is
// the highest first numeric component among every iOS build, every macOS
// build (expired included, all version trains, timestamp-style builds
// included) and every extra floor.  A rebuild of the same commit goes up
// because S itself is then taken.  There is no floor and no cap; an
// incomplete or malformed inventory throws instead of guessing.
//
// No typeof here: x === String(x) is true only for a string primitive and
// x === Number(x) only for a number primitive (the idiom asc-api.mjs uses at
// its boundaries), so the lint baseline counts no new no-runtime-typeof hit.
export function nextSharedBuild({iosBuilds, macBuilds, extraFloors = [], complete, mergeStamp}) {
  if (complete !== true || !Array.isArray(iosBuilds) || !Array.isArray(macBuilds)) {
    throw new Error('complete build inventory required');
  }
  if (mergeStamp !== String(mergeStamp) || !/^[1-9][0-9]{11}$/.test(mergeStamp)) {
    throw new Error('merge stamp must be a 12-digit YYYYMMDDHHMM string');
  }
  if (!Array.isArray(extraFloors)) throw new Error('malformed build inventory');
  for (const floor of extraFloors) {
    if (floor === Number(floor) && Number.isSafeInteger(floor)) {
      if (floor < 0) throw new Error('malformed build inventory');
    } else if (floor !== String(floor) || !/^[0-9]+$/.test(floor)) {
      throw new Error('malformed build inventory');
    }
  }
  // Validate everything before computing; malformed evidence is never ignored.
  const re = /^[0-9]+(\.[0-9]+){0,2}$/;
  for (const value of [...iosBuilds, ...macBuilds]) {
    if (value !== String(value) || !re.test(value)) throw new Error('malformed build inventory');
  }
  let max = -1n;
  for (const value of [...iosBuilds, ...macBuilds]) {
    const first = BigInt(value.split('.')[0]);
    if (first > max) max = first;
  }
  for (const floor of extraFloors) {
    const candidate = BigInt(floor);
    if (candidate > max) max = candidate;
  }
  const stamp = BigInt(mergeStamp);
  const next = max + 1n > stamp ? max + 1n : stamp;
  return {build: String(next)};
}
