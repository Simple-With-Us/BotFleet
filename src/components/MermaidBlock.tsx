// Mermaid fence renderer: draws the diagram instead of highlighting its
// source, the same lazy-import + settle-then-cache shape ChatMarkdown's
// CodeBlock uses for Shiki. Mermaid is a heavy import, so it loads only
// when a mermaid fence actually mounts — this file has no static import of
// "mermaid", only the dynamic one inside the effect below, so it ships as
// its own chunk instead of folding into the main bundle (same pattern as
// Shiki; ported from OpenMausBot PR #1619 / f1e066fd, hand-merged onto this
// fork's theming (`useResolvedSkin`) instead of upstream's CSS-var read).
//
// A still-streaming block stays on the raw source so a half-arrived
// diagram never flashes a parse error mid-stream; a settled block that
// still fails to parse shows the source with an error line above it
// instead of silently dropping the diagram.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { isDarkSkin, useResolvedSkin } from "@/lib/skins";
import { hash, STREAM_SETTLE_MS } from "@/lib/stream-settle";

// rendered SVGs, keyed by theme + content hash — same idea as ChatMarkdown's
// highlightCache, smaller cap because SVGs run bigger than token streams
const mermaidCache = new Map<string, string>();
const MERMAID_CACHE_MAX = 50;
// every mermaid.render() call needs an id no earlier call used, including
// calls that failed and may have left an orphan element behind
let mermaidRenderId = 0;

export interface MermaidBlockProps {
  /** Mermaid diagram source from a fenced code block. */
  code: string;
  /** Whether the parent message is still actively receiving tokens. */
  streaming: boolean;
}

/** Renders a ```mermaid fence as an SVG diagram in the current skin's theme. */
export function MermaidBlock({ code, streaming }: MermaidBlockProps) {
  // Same theme source CodeBlock reads (a11y-theme-copy: code-fence-dark-
  // shiki-on-light-default) — the diagram follows the painted skin live.
  const dark = isDarkSkin(useResolvedSkin());
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const key = `${dark ? "dark" : "light"}:${hash(code)}`;
    const cached = mermaidCache.get(key);
    if (cached) {
      setSvg(cached);
      setError(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => {
      import("mermaid")
        .then((module) => {
          const mermaid = module.default;
          mermaidRenderId += 1;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme: dark ? "dark" : "default",
            fontFamily: "var(--font-sans)",
          });
          return mermaid.render(`bf-mermaid-${mermaidRenderId}`, code);
        })
        .then((out) => {
          if (!alive) return;
          if (mermaidCache.size >= MERMAID_CACHE_MAX) {
            const first = mermaidCache.keys().next().value;
            if (first) mermaidCache.delete(first);
          }
          mermaidCache.set(key, out.svg);
          setSvg(out.svg);
          setError(null);
        })
        .catch((cause: unknown) => {
          // a streaming diagram is probably just incomplete: keep the
          // source up and stay quiet until the stream settles and re-runs
          // this effect
          if (!alive || streaming) return;
          console.warn("Mermaid diagram could not be drawn", cause);
          setError("This diagram could not be drawn. The source is below.");
        });
    };
    // Either path is a genuinely new diagram (different code, or the skin
    // flipped so the cached SVG above didn't match) — drop whatever an
    // earlier code/theme rendered so a stale SVG or error line never shows
    // while the new one is in flight.
    setSvg(null);
    setError(null);
    if (streaming) {
      // an earlier render is of a shorter snapshot — drop it so the
      // growing raw source shows the real content, then wait for the block
      // to hold still. The effect re-runs (and this cleanup clears the
      // timer) on every content change, which is the debounce.
      timer = setTimeout(render, STREAM_SETTLE_MS);
    } else {
      render();
    }
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, streaming, dark]);

  useEffect(() => {
    return () => {
      if (copyTimeout.current !== null) clearTimeout(copyTimeout.current);
    };
  }, []);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    if (copyTimeout.current !== null) clearTimeout(copyTimeout.current);
    copyTimeout.current = setTimeout(() => setCopied(false), 1200);
  };

  // Diagrams read left-to-right whatever language surrounds them, so the
  // frame pins its own direction rather than inheriting the message's.
  return (
    <div dir="ltr" className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-secondary">Mermaid diagram</span>
        <button
          onClick={copy}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title={copied ? "Copied" : "Copy Diagram Source"}
          aria-label={copied ? "Copied" : "Copy Diagram Source"}
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 pt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {svg && !error ? (
        <div className="overflow-x-auto p-3 [&_svg]:!max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
    </div>
  );
}
