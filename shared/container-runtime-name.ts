// Product names for the container runtimes BotFleet drives.
//
// The harness reports the CLI id (`docker`, `podman`, `container`).  A sentence
// a person reads uses the product name, capitalized, and the Local VM card
// header and the harness have to use this one helper.  A second copy is how
// the card ended up starting "docker is slow…" while the harness said "Docker
// is slow…".

export const CONTAINER_RUNTIME_IDS = ["docker", "podman", "container"] as const;
export type ContainerRuntimeId = (typeof CONTAINER_RUNTIME_IDS)[number];

const CONTAINER_RUNTIME_ID_SET: ReadonlySet<string> = new Set(CONTAINER_RUNTIME_IDS);

function isContainerRuntimeId(runtime: string): runtime is ContainerRuntimeId {
  return CONTAINER_RUNTIME_ID_SET.has(runtime);
}

/** Product name shown for a known runtime id.  A new id fails the build until
 *  it is named here. */
export function runtimeProductName(runtime: ContainerRuntimeId): string {
  switch (runtime) {
    case "docker":
      return "Docker";
    case "podman":
      return "Podman";
    case "container":
      return "Apple Container";
    default: {
      const never: never = runtime;
      return never;
    }
  }
}

/** What to say when the runtime is installed but did not answer in time.  One
 *  sentence that is true wherever it lands: the Local VM card, the 409 a
 *  lifecycle action returns, and the error a bot turn gets, which do not
 *  retry by themselves.  A known id uses its product name.  Anything else is
 *  capitalized so the sentence still starts with a capital. */
export function daemonSlowProblem(runtime: string): string {
  const name = isContainerRuntimeId(runtime) ? runtimeProductName(runtime) : capitalizeRuntime(runtime);
  return `${name} is slow to respond right now; try again in a moment`;
}

function capitalizeRuntime(runtime: string): string {
  if (runtime.length === 0) return runtime;
  return `${runtime.charAt(0).toUpperCase()}${runtime.slice(1)}`;
}
