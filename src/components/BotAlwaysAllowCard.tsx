/** Always-allowed tool grants for one bot (Agent settings). */
export function BotAlwaysAllowCard({
  alwaysAllow,
  onRemove,
}: {
  alwaysAllow: string[];
  onRemove: (key: string) => void;
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Always allowed</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Tools this bot no longer asks about.</div>
      {alwaysAllow.length === 0 ? (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">Nothing standing yet.</div>
      ) : (
        <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
          {alwaysAllow.map((entry) => (
            <div key={entry} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{entry}</span>
              <button
                type="button"
                aria-label={`Remove ${entry} from always allowed`}
                onClick={() => onRemove(entry)}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
