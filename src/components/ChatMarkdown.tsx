// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, a code block renders
// as plain <pre> until its content has held still for STREAM_SETTLE_MS (the
// fence is very likely complete), then highlights and caches — so the settled
// bubble, a fresh component instance, mounts straight from cache instead of
// popping from plain to highlighted.
import { memo, useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { isDarkSkin, useResolvedSkin } from "@/lib/skins";
import { remarkMentions } from "@/lib/mentions";
import { MermaidBlock } from "./MermaidBlock";
import { hash, STREAM_SETTLE_MS } from "@/lib/stream-settle";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed and capped. Streamed partials may land here
// under their own hash — harmless (never collides with the final content's
// key, and the cap evicts it), and the final content's entry is exactly what
// makes the settled bubble render highlighted on mount.
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;

// A markdown link whose target is a file on this machine: bots hand over
// bot-created documents as absolute paths or file:// URLs. Web links stay
// ordinary anchors handled by the shell's window-open policy.
// A leading slash covers macOS and Linux; "C:\…" and "C:/…" cover Windows,
// where a file:// URL's pathname also arrives as "/C:/…".
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") && WINDOWS_PATH.test(value.slice(1))) return value.slice(1);
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  // URL schemes are case-insensitive, so FILE:// is as valid as file://
  if (/^file:\/\//i.test(href)) {
    try {
      return absolutePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return null;
    }
  }
  return absolutePath(href);
};

function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The fence sits on `bg-inset`, which is light on 9 of 11 skins — a single
  // dark Shiki theme reads as near-invisible on those (a11y-theme-copy:
  // code-fence-dark-shiki-on-light-default). Pick per resolved skin, and
  // re-render live if the user switches skins with this block on screen.
  const dark = isDarkSkin(useResolvedSkin());

  useEffect(() => {
    const key = `${lang}:${dark ? "dark" : "light"}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const highlight = () => {
      import("shiki")
        .then((shiki) =>
          shiki.codeToHtml(code, {
            lang: lang || "text",
            theme: dark ? "github-dark-default" : "github-light-default",
          }),
        )
        .then((out) => {
          if (!alive) return;
          if (highlightCache.size >= CACHE_MAX) {
            const first = highlightCache.keys().next().value;
            if (first) highlightCache.delete(first);
          }
          highlightCache.set(key, out);
          setHtml(out);
        })
        .catch(() => {
          /* unknown language or shiki failed — the plain <pre> stays */
        });
    };
    if (streaming) {
      // any earlier highlight is of a shorter snapshot — drop it so the
      // growing plain <pre> shows the real content, then wait for the block
      // to hold still. The effect re-runs (and this cleanup clears the timer)
      // on every content change, which is the debounce.
      setHtml(null);
      timer = setTimeout(highlight, STREAM_SETTLE_MS);
    } else {
      highlight();
    }
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, lang, streaming, dark]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-secondary">{lang || "code"}</span>
        <button
          onClick={copy}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Copy Code"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
    </div>
  );
}

// A bot handing over a file it created renders as a button, not an anchor.
// Two reasons the href is dropped rather than merely preventDefault()ed:
// an absolute path in an href resolves against the page origin, so the link
// pointed at http://127.0.0.1:8799<path> and opened the chat UI in a browser;
// and an <a href="file://…"> would still reach setWindowOpenHandler on a
// middle or modifier click, which calls shell.openExternal without the main
// process' containment check.
function LocalFileLink({ filePath, children }: { filePath: string; children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "opened" | "revealed" | "saved" | "failed">("idle");
  const [reason, setReason] = useState("");
  const [showMenu, setShowMenu] = useState(false);

  const openDirect = async (e?: React.MouseEvent) => {
    if (e?.altKey || e?.metaKey) {
      return revealInFinder();
    }
    if (window.ogb?.openFile) {
      try {
        await window.ogb.openFile(filePath);
        setState("opened");
        setTimeout(() => setState("idle"), 2500);
        return;
      } catch (err) {
        // fall back to reveal in finder
        return revealInFinder();
      }
    }
    if (window.ogb?.showInFolder) {
      return revealInFinder();
    }
    return saveCopy();
  };

  const revealInFinder = async () => {
    setShowMenu(false);
    if (window.ogb?.showInFolder) {
      try {
        await window.ogb.showInFolder(filePath);
        setState("revealed");
        setTimeout(() => setState("idle"), 2500);
        return;
      } catch (err) {
        setReason(err instanceof Error ? err.message : "Could not open folder");
        setState("failed");
      }
    }
  };

  const saveCopy = async () => {
    setShowMenu(false);
    const saveFile = window.ogb?.saveFile;
    if (!saveFile) {
      setReason("Saving files needs the desktop app");
      setState("failed");
      return;
    }
    try {
      const saved = await saveFile(filePath);
      if (!saved) return;
      setState("saved");
      setTimeout(() => setState("idle"), 3000);
    } catch (error) {
      setReason(error instanceof Error ? error.message : "That file could not be saved");
      setState("failed");
    }
  };

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={openDirect}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowMenu(true);
        }}
        title={`Click to open · Alt/Cmd-click to reveal in Finder (${filePath})`}
        className="break-words text-left font-mono text-[12.5px] text-accent underline decoration-accent/40 hover:decoration-accent hover:text-accent-hover cursor-pointer"
      >
        {children}
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[170px] rounded-lg border border-hairline/40 bg-raised/95 p-1 shadow-lg backdrop-blur-md">
            <button
              type="button"
              onClick={() => void openDirect()}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-hover"
            >
              <span>Open File</span>
            </button>
            <button
              type="button"
              onClick={() => void revealInFinder()}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-hover"
            >
              <span>Reveal in Finder</span>
            </button>
            <button
              type="button"
              onClick={() => void saveCopy()}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-hover hover:text-ink"
            >
              <span>Save Copy As...</span>
            </button>
          </div>
        </>
      )}

      {state !== "idle" && (
        <span className={`ml-1.5 text-[11.5px] ${state === "failed" ? "text-danger" : "text-success font-medium"}`}>
          {state === "opened" ? "✓ Opened" : state === "revealed" ? "✓ Shown in Finder" : state === "saved" ? "✓ Saved" : reason}
        </span>
      )}
    </span>
  );
}

// Spoiler spans: GFM parses ~~text~~ to <del>; in bot messages that content
// is usually a spoiler (answers, plot points, surprises), not a deletion —
// hide it behind a tap-to-reveal chip instead of striking it through.
// Display only: the stored markdown, exports, and the model's own context
// all keep the raw ~~text~~.
function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <span className="relative mx-px inline-block rounded px-1 py-px">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none bg-raised text-transparent [&_*]:!text-transparent [&_a]:!no-underline"
        >
          {children}
        </span>
        <button
          type="button"
          aria-label="Reveal Spoiler"
          title="Reveal Spoiler"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 rounded bg-raised/90"
        />
      </span>
    );
  }
  return (
    <span className="mx-px inline rounded px-1 py-px text-[13px] leading-relaxed text-ink underline decoration-dotted decoration-hairline underline-offset-2">
      {children}
      <button
        type="button"
        aria-label="Hide Spoiler"
        title="Hide Spoiler"
        onClick={() => setRevealed(false)}
        className="ml-1 rounded px-0.5 text-[11px] text-ink-secondary hover:text-ink"
      >
        Hide
      </button>
    </span>
  );
}

function ChatMarkdownComponent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const content = text.replace(/&nbsp;/g, "\u00A0");
  return (
    <div className="chat-md min-w-0 [&>*+*]:mt-2">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMentions]}
        components={{
          pre({ children }: { children?: ReactNode }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string = child?.props?.className ?? "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            // children can be a string OR an array of strings/nodes — flatten
            // strings only, so String() never comma-joins an array
            const flat = (n: any): string =>
              typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
            const code = flat(child?.props?.children).replace(/\n$/, "");
            // a mermaid fence is a picture, not a program: hand it to the
            // diagram renderer instead of the highlighter
            if (lang.toLowerCase() === "mermaid") {
              return <MermaidBlock code={code} streaming={streaming} />;
            }
            return <CodeBlock code={code} lang={lang} streaming={streaming} />;
          },
          img({ src, alt }: { src?: string; alt?: string }) {
            return (
              <img
                src={src}
                alt={alt ?? ""}
                loading="lazy"
                className="max-h-96 max-w-full rounded-lg border border-hairline/30"
              />
            );
          },
          code({ children }: { children?: ReactNode }) {
            return (
              <code className="rounded bg-inset px-1 py-px text-[13px]">{children}</code>
            );
          },
          a({ href, children }: { href?: string; children?: ReactNode }) {
            const localPath = localFilePath(href);
            if (localPath) return <LocalFileLink filePath={localPath}>{children}</LocalFileLink>;
            const handleClick = (e: React.MouseEvent) => {
              if (href && window.ogb?.openExternal) {
                e.preventDefault();
                void window.ogb.openExternal(href);
              }
            };
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={handleClick}
                className="break-words text-accent underline decoration-accent/40 hover:decoration-accent"
              >
                {children}
              </a>
            );
          },
          table({ children }: { children?: ReactNode }) {
            return (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13.5px]">{children}</table>
              </div>
            );
          },
          th({ children }: { children?: ReactNode }) {
            return (
              <th className="border-b border-hairline/40 px-2 py-1.5 text-left font-semibold">{children}</th>
            );
          },
          td({ children }: { children?: ReactNode }) {
            return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
          },
          ul({ children }: { children?: ReactNode }) {
            return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }: { children?: ReactNode }) {
            return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
          },
          h1({ children }: { children?: ReactNode }) {
            return <div className="mt-2 text-[16px] font-semibold">{children}</div>;
          },
          h2({ children }: { children?: ReactNode }) {
            return <div className="mt-2 text-[15.5px] font-semibold">{children}</div>;
          },
          h3({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          h4({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          h5({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 text-[14px] font-semibold">{children}</div>;
          },
          h6({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</div>;
          },
          blockquote({ children }: { children?: ReactNode }) {
            return (
              <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
            );
          },
          del({ children }: { children?: ReactNode }) {
            return <Spoiler>{children}</Spoiler>;
          },
          hr() {
            return <hr className="border-hairline/40" />;
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
