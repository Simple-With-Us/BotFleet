/** Minimal environment for bot-reachable host subprocesses. Never copy the
 * harness environment: it includes provider keys and the vault machine identity. */
export function modelShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key] !== undefined) env[key] = source[key];
  return env;
}
