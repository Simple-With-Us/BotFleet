// The desktop app's data-directory resolver (plain JavaScript).  Typed here so the server can
// assert it resolves the same directory, which is the invariant the app/server pair needs.
export function botfleetDataDir(
  env?: Record<string, string | undefined>,
  home?: string,
): string;
