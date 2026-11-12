import { useEffect, useRef, useState } from "react";
import { Check, Copy, Hash } from "lucide-react";
import { cn } from "@/lib/cn";

export interface CopyButtonProps {
  text?: string;
  messageId?: string;
  requestId?: string;
  className?: string;
  copied?: boolean;
  onCopy?: () => void;
  /** Icon size in px.  The message chrome renders these larger than the
   * default so its stacked rows read at a comparable weight. */
  iconSize?: number;
}

export function CopyButton({
  text = "",
  messageId,
  requestId,
  className,
  copied: externalCopied,
  onCopy,
  iconSize = 14,
}: CopyButtonProps) {
  const [copiedType, setCopiedType] = useState<"text" | "id" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const effectiveId = requestId || messageId;
  const isCopied = externalCopied || copiedType !== null;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const copyText = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!text) return;
    void navigator.clipboard?.writeText(text);
    setCopiedType("text");
    setMenuOpen(false);
    onCopy?.();
    setTimeout(() => setCopiedType(null), 1400);
    window.dispatchEvent(new CustomEvent("focus-composer"));
  };

  const copyId = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!effectiveId) return;
    void navigator.clipboard?.writeText(effectiveId);
    setCopiedType("id");
    setMenuOpen(false);
    onCopy?.();
    setTimeout(() => setCopiedType(null), 1400);
    window.dispatchEvent(new CustomEvent("focus-composer"));
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!effectiveId) return;
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((prev) => !prev);
  };

  /* Right-click is a mouse-only way into the ID menu, so keyboard and screen
   * reader users had no route to Request/Message ID at all — and the old
   * aria-label even instructed them to right-click. Shift+Enter opens the same
   * menu; plain Enter keeps the default copy-text behaviour. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!effectiveId) return;
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      setMenuOpen((prev) => !prev);
    }
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        ref={buttonRef}
        type="button"
        onClick={copyText}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        aria-haspopup={effectiveId ? "menu" : undefined}
        aria-expanded={effectiveId ? menuOpen : undefined}
        aria-label={
          effectiveId ? "Copy Message Text. Right-click or Shift+Enter for ID." : "Copy Message"
        }
        title={
          isCopied
            ? copiedType === "id"
              ? "Copied ID to clipboard!"
              : "Copied to clipboard!"
            : effectiveId
              ? "Copy Message (Right-click or Shift+Enter for Request ID)"
              : "Copy Message"
        }
        className={cn(
          "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
          isCopied && "!opacity-100 text-success hover:text-success",
          menuOpen && "!opacity-100 bg-raised text-ink",
          className,
        )}
      >
        {isCopied ? <Check size={iconSize} className="text-success" /> : <Copy size={iconSize} />}
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute bottom-full right-0 z-50 mb-1.5 min-w-[160px] rounded-xl border border-hairline/50 bg-panel/95 p-1 text-[12.5px] shadow-xl backdrop-blur-md"
        >
          <button
            type="button"
            onClick={copyText}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-control"
          >
            <Copy size={13} className="text-ink-secondary" />
            <span>Copy Text</span>
          </button>
          {effectiveId && (
            <button
              type="button"
              onClick={copyId}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-control"
            >
              <Hash size={13} className="text-ink-secondary" />
              <div className="flex min-w-0 flex-col">
                <span>{requestId ? "Copy Request ID" : "Copy Message ID"}</span>
                <span className="truncate font-mono text-[10px] text-ink-secondary" title={effectiveId}>{effectiveId}</span>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
