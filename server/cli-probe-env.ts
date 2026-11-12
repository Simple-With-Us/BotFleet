import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./config.ts";
import { augmentedPath } from "./env-path.ts";

/** Version probes must not inherit workspace secrets or provider billing keys. */
export function cliProbeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  return env;
}
