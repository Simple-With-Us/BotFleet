import { Laptop, Monitor, Server } from "lucide-react";
import { cn } from "@/lib/cn";
import { cloudDestinationLabel } from "@/lib/cloud-backend";
import type { CloudBackend } from "../../server/contracts.ts";
import { previewChoices, type ComputerKind, type PreviewChoice } from "@/lib/computer-source";

/**
 * The label for one destination, kept out of the component so the wording is
 * pinned by a test rather than by whoever edits the JSX next.
 *
 * "Auto" is the default and says what it is doing, not where it landed.  The
 * whole point of the override is that the person is checking a *specific*
 * computer, and a label that just read "Cloud" would not tell them which of
 * their two cloud backends they are looking at.
 */
export function previewChoiceLabel(
  choice: PreviewChoice,
  cloudBackend: CloudBackend,
  platformIsMac: boolean,
): string {
  switch (choice) {
    case "auto":
      return "Auto";
    case "vm":
      return "Local VM";
    case "local":
      return platformIsMac ? "This Mac" : "This Computer";
    case "cloud":
      return cloudDestinationLabel(cloudBackend);
  }
}

const ICONS: Record<ComputerKind, typeof Monitor> = {
  vm: Server,
  local: Laptop,
  cloud: Monitor,
};

/**
 * Switch which of the bot's computers the preview shows.
 *
 * Renders nothing for a bot holding a single computer — there is nothing to
 * switch between, and a one-option control is noise.  Auto is the default and
 * the first option, so the common case costs no interaction and behaves
 * exactly as it did before this existed.
 */
export function ComputerSourcePicker({
  computers,
  choice,
  cloudBackend,
  platformIsMac,
  onChange,
}: {
  computers: readonly ComputerKind[];
  choice: PreviewChoice;
  cloudBackend: CloudBackend;
  platformIsMac: boolean;
  onChange: (next: PreviewChoice) => void;
}) {
  const options = previewChoices(computers);
  if (options.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Preview Computer"
      className="flex overflow-hidden rounded-lg border border-hairline/40"
    >
      {options.map((option, i) => {
        const Icon = option === "auto" ? Monitor : ICONS[option];
        const label = previewChoiceLabel(option, cloudBackend, platformIsMac);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={choice === option}
            onClick={() => onChange(option)}
            title={option === "auto" ? "Follow Auto-Selection" : `Preview ${label}`}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]",
              i > 0 && "border-l border-hairline/40",
              choice === option
                ? "bg-control text-ink font-medium"
                : "text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
