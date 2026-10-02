// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useState } from "react";
import { Check, Copy, Download, ExternalLink, KeyRound, Loader2, LogIn, TerminalSquare } from "lucide-react";
import type { EngineInstall, InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { isCheckingEngine } from "@/lib/engine-status";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const platform = typeof window !== "undefined" ? window.ogb?.platform : undefined;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (userAgent.includes("Mac")) return "darwin";
  if (userAgent.includes("Win")) return "win32";
  return "linux";
}

/** The install command for this machine, or null when the engine has none
 * here (a GUI download, or a POSIX-only installer viewed on Windows). */
export function installCommandFor(install: EngineInstall | undefined): string | null {
  return install?.command?.[hostPlatform()] ?? null;
}

/** Installed but missing the cloud account session. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

/** The engine CLI itself is absent. Local-model injection needs the CLI but
 * does not need its cloud account to be signed in.  An engine whose probe
 * just did not answer in time is being checked, not missing. */
export function needsCli(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state !== "available" && !isCheckingEngine(instance);
}

/** Title and body for an engine whose last probe gave no answer. */
export function engineCheckingCopy(instance: InstanceInfo) {
  const reason = instance.snapshot.reason?.replace(/\.$/, "") || `${instance.displayName} did not answer in time`;
  return {
    title: `Checking ${instance.displayName}`,
    // U+00A0 + space: the two-space sentence gap survives HTML whitespace
    // collapsing.
    description: `${reason}.\u00a0 BotFleet is checking again and will update this on its own.`,
  };
}

/** No CLI, no interactive login — this driver reads a bare API key from the
 * environment or a config file. `install.command` on one of these is
 * guidance text ("get a key, then set …"), never a runnable shell line, so
 * the card must not call it an "install" or offer to paste it into a
 * terminal — see EngineInstall.apiKeyOnly in server/contracts.ts. */
export function isApiKeyOnly(instance: InstanceInfo | undefined): boolean {
  return instance?.install?.apiKeyOnly === true;
}

/** Title and body for the setup card, factored out of the component so a
 * MiniMax- or openai-compat-shaped instance can be asserted on directly. */
export function engineSetupCopy(instance: InstanceInfo, intent: "cloud" | "inject") {
  const install = instance.install;
  const signInCommand = install?.signInCommand;
  const apiKeyOnly = isApiKeyOnly(instance);
  const signInOnly = !apiKeyOnly && intent === "cloud" && needsSignIn(instance);

  if (apiKeyOnly) {
    return {
      title: `Add a ${instance.displayName} API key`,
      description:
        `${instance.displayName} runs on an API key, not a CLI install.  Set it as shown below, ` +
        "then reopen this menu — Settings → Engines has more on how this engine runs.",
    };
  }
  if (signInOnly) {
    return {
      title: `Sign in to ${instance.displayName}`,
      description: "Finish the account sign-in in Terminal. Reopen this menu afterward and we’ll check again.",
    };
  }
  if (intent === "inject") {
    return {
      title: `Install ${instance.displayName}`,
      description: "Install the engine once, then you can run it with local models—no cloud sign-in required.",
    };
  }
  return {
    title: `Install ${instance.displayName}`,
    description: `Install the command-line app once. Models will appear here as soon as it’s ready${signInCommand ? "; sign-in may follow" : ""}.`,
  };
}

function CommandRow({
  command,
  actionLabel,
  copyOnly,
}: {
  command: string;
  actionLabel: string;
  /** True when `command` is guidance text, not a shell one-liner — offer
   * Copy only, never "open a terminal and run this." */
  copyOnly?: boolean;
}) {
  const [status, setStatus] = useState<"copied" | "opened" | null>(null);
  const canOpen = !copyOnly && Boolean(window.ogb?.openInstallTerminal);

  const settle = (next: "copied" | "opened") => {
    setStatus(next);
    window.setTimeout(() => setStatus(null), 2200);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      settle("copied");
    } catch {
      // The command remains selectable when clipboard access is blocked.
    }
  };

  const openTerminal = async () => {
    const opened = await window.ogb!.openInstallTerminal!(command);
    settle(opened ? "opened" : "copied");
  };

  return (
    <div className="mt-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/50 bg-app px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={command}>
          {command}
        </code>
        {canOpen && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy Command"
            title="Copy Command"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {status === "copied" ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {canOpen ? (
        <>
          <button
            type="button"
            onClick={() => void openTerminal()}
            className="mt-2 flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110"
          >
            {status === "opened" ? <Check size={14} /> : <TerminalSquare size={14} />}
            {status === "opened" ? "Terminal opened" : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
            {status === "opened" ? "Paste the command and press Enter." : "The command is copied when Terminal opens."}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised-hover"
        >
          {status === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {status === "copied" ? "Command copied" : "Copy Command"}
        </button>
      )}
    </div>
  );
}

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
}) {
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const apiKeyOnly = isApiKeyOnly(instance);
  const signInOnly = !apiKeyOnly && intent === "cloud" && needsSignIn(instance);
  const command = signInOnly ? signInCommand : installCommand;
  const { title, description } = engineSetupCopy(instance, intent);

  // A probe that timed out is not a setup problem: no install command, no
  // sign-in — just say it is being checked.
  if (isCheckingEngine(instance)) {
    const checking = engineCheckingCopy(instance);
    return (
      <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
            <Loader2 size={14} className="animate-spin" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">{checking.title}</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{checking.description}</p>
          </div>
        </div>
      </div>
    );
  }

  // Some engines are configured elsewhere (for example, a cloud computer
  // token) and intentionally have no install descriptor.
  if (!install) {
    return (
      <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{instance.displayName} isn’t ready</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.reason ?? "This engine is not available on this machine."}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          {apiKeyOnly ? <KeyRound size={14} /> : signInOnly ? <LogIn size={14} /> : <Download size={14} />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>
        </div>
      </div>

      {command ? (
        <CommandRow
          command={command}
          actionLabel={signInOnly ? "Open sign-in in Terminal" : "Open install in Terminal"}
          copyOnly={apiKeyOnly}
        />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          There isn’t a one-line installer for this platform. Use the setup guide below.
        </p>
      )}

      {!signInOnly && install.needsNode && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
          Requires Node.js and <code className="font-mono">npm</code>.
        </p>
      )}

      {install.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          <ExternalLink size={12} /> View setup guide
        </a>
      )}
    </div>
  );
}
