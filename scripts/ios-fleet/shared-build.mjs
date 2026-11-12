// Pure build planner.  No network, uploads or release state changes.
// One shared merge-timestamp build per app across iOS and macOS (owner, Oct 29 2026).
// build = max(S, M + 1), a plain integer, where S is the committer date of
// the commit being built (HEAD) in America/Chicago as YYYYMMDDHHMM and M is
// the highest first numeric component among every iOS build, every macOS
// build (expired included, all version trains, timestamp-style builds
// included) and every extra floor.  A rebuild of the same commit goes up
// because S itself is then taken.  There is no floor; the result is capped
// at 12 digits, and an incomplete or malformed inventory throws instead of
// guessing.
//
// No typeof here: x === String(x) is true only for a string primitive and
// x === Number(x) only for a number primitive (the idiom asc-api.mjs uses at
// its boundaries), so the lint baseline counts no new no-runtime-typeof hit.
export function nextSharedBuild({iosBuilds, macBuilds, extraFloors = [], complete, mergeStamp, platform}) {
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
  const stamp = BigInt(mergeStamp);
  // `platform` makes the plan platform-aware, and that is what lets the iOS
  // and the Mac build of ONE commit carry the same number.
  //
  // The merge stamp is the authority for a commit's FIRST build on each
  // platform.  A build equal to the stamp is that commit's own build on the
  // OTHER platform, so it must not push this platform's plan up: otherwise
  // the iOS ship of a commit moves the inventory under the Mac release and
  // the two platforms disagree by one.  Only a REBUILD of the same commit on
  // THIS platform takes the highest-existing-plus-one rule.
  //
  // Without `platform` the plan is exactly what it always was, so the landed
  // iOS path keeps its behaviour until it opts in.
  let own = null;
  if (platform !== undefined && platform !== null && platform !== "") {
    if (platform !== "ios" && platform !== "macos") {
      throw new Error(`platform must be ios or macos (got ${JSON.stringify(platform)})`);
    }
    own = platform === "ios" ? iosBuilds : macBuilds;
  }
  let max = -1n;
  let maxWithoutStamp = -1n;
  for (const value of [...iosBuilds, ...macBuilds]) {
    const first = BigInt(value.split('.')[0]);
    if (first > max) max = first;
    if (first !== stamp && first > maxWithoutStamp) maxWithoutStamp = first;
  }
  for (const floor of extraFloors) {
    const candidate = BigInt(floor);
    if (candidate > max) max = candidate;
    // A floor equal to the merge stamp is that commit's own build, so it is
    // excluded here for the same reason a stamp-valued build is excluded
    // above.  Including it would set maxWithoutStamp to the stamp and make
    // this platform's FIRST build overshoot to stamp + 1, so the iOS and the
    // Mac build of one commit would differ by one.
    if (candidate !== stamp && candidate > maxWithoutStamp) maxWithoutStamp = candidate;
  }
  const ownHasStamp =
    own !== null && own.some((value) => BigInt(value.split('.')[0]) === stamp);
  let next;
  if (own === null) {
    next = max + 1n > stamp ? max + 1n : stamp;
  } else if (ownHasStamp) {
    next = max + 1n;
  } else {
    next = maxWithoutStamp + 1n > stamp ? maxWithoutStamp + 1n : stamp;
  }
  // Fixed mode ships a 12-digit merge-timestamp build, and the ship's gate
  // rejects anything else; a floor or an existing build past 12 digits
  // fails closed here instead of planning a build that can never upload.
  if (String(next).length > 12) throw new Error('planned build exceeds 12 digits');
  return {build: String(next)};
}
