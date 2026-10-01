import { useEffect, useRef } from "react";
import { CheckCircle2, Zap, X } from "lucide-react";

export type TtsBenchmarkModalProps = {
  open: boolean;
  onClose: () => void;
};

export function TtsBenchmarkModal({ open, onClose }: TtsBenchmarkModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-150"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tts-benchmark-title"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-hairline bg-surface p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline/60 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="tts-benchmark-title" className="text-[17px] font-semibold text-ink">
                TTS Voice Summary Benchmark
              </h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-medium text-accent">
                <Zap size={11} /> DeepSeek V4.1 Flash Selected
              </span>
            </div>
            <p className="mt-1 text-[12.5px] text-ink-secondary">
              Evaluating lightweight LLMs to condense complex code and markdown into natural spoken speech before synthesis by MiniMax TTS.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Highlight Callout */}
        <div className="mt-4 rounded-lg border border-accent/25 bg-accent/5 p-3.5">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <CheckCircle2 size={16} className="text-accent" />
            <span>Why DeepSeek V4.1 Flash was chosen for BotFleet Voice</span>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
            DeepSeek V4.1 Flash achieved sub-second latency (<strong>861ms</strong>) and the lowest per-turn cost (<strong>$0.00006</strong>, or ~6¢ per 1,000 voice turns). Unlike reasoning models (such as MiniMax M2.7-Highspeed, which took ~5.2s due to internal CoT tokens), DeepSeek Flash generates natural conversational speech immediately without conversational lag.
          </p>
        </div>

        {/* Results Table */}
        <div className="mt-5 overflow-hidden rounded-lg border border-hairline">
          <table className="w-full text-left text-[12px]">
            <thead className="border-b border-hairline bg-raised/50 font-medium text-ink-secondary">
              <tr>
                <th className="py-2.5 pl-3 pr-2">Model</th>
                <th className="px-2 py-2.5">Latency</th>
                <th className="px-2 py-2.5">Rates (In / Out)</th>
                <th className="px-2 py-2.5">Cost / Turn</th>
                <th className="py-2.5 pl-2 pr-3">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline/40 text-ink">
              <tr className="bg-accent/5 font-medium">
                <td className="py-2.5 pl-3 pr-2 text-accent">DeepSeek V4.1 Flash</td>
                <td className="px-2 py-2.5 font-mono">861ms</td>
                <td className="px-2 py-2.5 font-mono text-ink-secondary">$0.14 / $0.28</td>
                <td className="px-2 py-2.5 font-mono">$0.000060</td>
                <td className="py-2.5 pl-2 pr-3 text-accent">Default Choice (Fastest)</td>
              </tr>
              <tr>
                <td className="py-2.5 pl-3 pr-2">LLaMA 3.1 70B</td>
                <td className="px-2 py-2.5 font-mono">1,232ms</td>
                <td className="px-2 py-2.5 font-mono text-ink-secondary">$0.40 / $0.40</td>
                <td className="px-2 py-2.5 font-mono">$0.000159</td>
                <td className="py-2.5 pl-2 pr-3 text-ink-secondary">High quality, fast</td>
              </tr>
              <tr>
                <td className="py-2.5 pl-3 pr-2">LLaMA 3.1 8B</td>
                <td className="px-2 py-2.5 font-mono">1,077ms</td>
                <td className="px-2 py-2.5 font-mono text-ink-secondary">$0.055 / $0.055</td>
                <td className="px-2 py-2.5 font-mono">$0.000022</td>
                <td className="py-2.5 pl-2 pr-3 text-ink-secondary">Fast, minor hallucination</td>
              </tr>
              <tr>
                <td className="py-2.5 pl-3 pr-2">MiniMax Text-01</td>
                <td className="px-2 py-2.5 font-mono">2,721ms</td>
                <td className="px-2 py-2.5 font-mono text-ink-secondary">$0.20 / $1.10</td>
                <td className="px-2 py-2.5 font-mono">$0.000270</td>
                <td className="py-2.5 pl-2 pr-3 text-ink-secondary">Native MiniMax fallback</td>
              </tr>
              <tr>
                <td className="py-2.5 pl-3 pr-2">MiniMax M3.1 Flash</td>
                <td className="px-2 py-2.5 font-mono">3,059ms</td>
                <td className="px-2 py-2.5 font-mono text-ink-secondary">$0.30 / $1.20</td>
                <td className="px-2 py-2.5 font-mono">$0.000355</td>
                <td className="py-2.5 pl-2 pr-3 text-ink-secondary">Accurate, concise</td>
              </tr>
              <tr>
                <td className="py-2.5 pl-3 pr-2">GPT-4o-mini</td>
                <td className="px-2 py-2.5 font-mono">3,359ms</td>
                <td className="px-2 py-2.5 font-mono text-ink-secondary">$0.15 / $0.60</td>
                <td className="px-2 py-2.5 font-mono">$0.000075</td>
                <td className="py-2.5 pl-2 pr-3 text-ink-secondary">Good tone, slower</td>
              </tr>
              <tr>
                <td className="py-2.5 pl-3 pr-2">MiniMax M2.7 Highspeed</td>
                <td className="px-2 py-2.5 font-mono">4,754ms</td>
                <td className="px-2 py-2.5 font-mono text-ink-secondary">$0.60 / $2.40</td>
                <td className="px-2 py-2.5 font-mono">$0.000595</td>
                <td className="py-2.5 pl-2 pr-3 text-ink-secondary">CoT reasoning delay</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Footer actions */}
        <div className="mt-5 flex items-center justify-between border-t border-hairline/60 pt-4">
          <span className="text-[11.5px] text-ink-secondary">
            Benchmark script: <code className="font-mono">scripts/benchmark-tts-post-processor.mjs</code>
          </span>
          <button
            onClick={onClose}
            className="rounded-lg bg-control px-4 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-raised"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
