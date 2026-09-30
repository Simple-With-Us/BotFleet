// A small dependency-free popover for quiet, read-only detail (a chip's
// breakdown, a figure's derivation).  Opens on hover AND on keyboard focus;
// a click pins it open (the way to keep one on a touch screen) and a second
// click unpins.  Escape and a press outside close it.  The panel is portalled
// to <body>, so no ancestor's `overflow` clips it, and it is positioned above
// the trigger, flipping below when there is no room, then clamped so it never
// leaves the viewport.
//
// The panel is a non-modal `role="dialog"` named by its own heading; the
// trigger carries aria-haspopup / aria-expanded / aria-controls.  Motion is
// `motion-safe:` only, so prefers-reduced-motion gets the panel with no
// animation at all.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export type PopoverPlacement = "top" | "bottom";

export interface PopoverBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PlacedPopover {
  top: number;
  left: number;
  placement: PopoverPlacement;
}

/** Air kept between the panel and every viewport edge. */
export const POPOVER_VIEWPORT_MARGIN = 8;
/** Air between the trigger and the panel. */
export const POPOVER_ANCHOR_GAP = 8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Where a panel of `panel` size goes for a trigger at `anchor`, in viewport
 * (fixed-position) coordinates.  Prefers `prefer`, flips to the other side
 * when it does not fit there but the other side has more room, centers on the
 * trigger, and clamps into the viewport.  Pure, so it is unit-tested.
 */
export function placePopover(
  anchor: PopoverBox,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  prefer: PopoverPlacement = "top",
): PlacedPopover {
  const spaceAbove = anchor.top - POPOVER_ANCHOR_GAP - POPOVER_VIEWPORT_MARGIN;
  const spaceBelow = viewport.height - (anchor.top + anchor.height) - POPOVER_ANCHOR_GAP - POPOVER_VIEWPORT_MARGIN;
  const fits = (space: number) => panel.height <= space;
  let placement = prefer;
  if (prefer === "top" && !fits(spaceAbove) && (fits(spaceBelow) || spaceBelow > spaceAbove)) placement = "bottom";
  else if (prefer === "bottom" && !fits(spaceBelow) && (fits(spaceAbove) || spaceAbove > spaceBelow)) placement = "top";

  const rawTop = placement === "top"
    ? anchor.top - POPOVER_ANCHOR_GAP - panel.height
    : anchor.top + anchor.height + POPOVER_ANCHOR_GAP;
  const rawLeft = anchor.left + anchor.width / 2 - panel.width / 2;
  return {
    top: Math.round(clamp(rawTop, POPOVER_VIEWPORT_MARGIN, viewport.height - panel.height - POPOVER_VIEWPORT_MARGIN)),
    left: Math.round(clamp(rawLeft, POPOVER_VIEWPORT_MARGIN, viewport.width - panel.width - POPOVER_VIEWPORT_MARGIN)),
    placement,
  };
}

/** Layout effect in the browser, plain effect where there is no DOM. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Hover intent: a pointer sweeping across the page must not flash panels. */
const OPEN_DELAY_MS = 80;
/** Bridges the gap between the trigger and its panel. */
const CLOSE_DELAY_MS = 140;

export interface PopoverProps {
  /** The panel's heading, which is also the dialog's accessible name. */
  title: string;
  /** Quiet figure beside the heading — a total, for instance. */
  titleAside?: ReactNode;
  /** What the trigger button shows. */
  trigger: ReactNode;
  /** The panel body. */
  children: ReactNode;
  /** Classes for the trigger button. */
  className?: string;
  /** Extra classes for the panel. */
  panelClassName?: string;
  placement?: PopoverPlacement;
  /** Start pinned open.  Without a DOM (server render) an open panel renders
   *  in place rather than portalled, which is how the markup is tested. */
  defaultOpen?: boolean;
}

export function Popover({
  title,
  titleAside,
  trigger,
  children,
  className,
  panelClassName,
  placement = "top",
  defaultOpen = false,
}: PopoverProps) {
  const id = useId();
  const titleId = `${id}-title`;
  // three independent reasons to be open: a click pinned it, the pointer is
  // on it, keyboard focus is on the trigger
  const [pinned, setPinned] = useState(defaultOpen);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [placed, setPlaced] = useState<PlacedPopover | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // set by Escape / an unpin click so the pointer that is still resting on
  // the trigger does not immediately reopen it; cleared on pointer leave
  const suppressHover = useRef(false);
  const open = pinned || hovered || focused;

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const hoverAfter = (next: boolean, delay: number) => {
    clearTimer();
    timer.current = window.setTimeout(() => setHovered(next), delay);
  };
  const closeAll = useCallback(() => {
    clearTimer();
    setPinned(false);
    setHovered(false);
    setFocused(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  // dismissal: Escape anywhere, or a press outside both the trigger and panel
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // a pinned panel is a dialog the person opened, so Escape belongs to
      // it; a hover peek is not, and leaves Escape to whatever else wants it
      if (pinned) event.stopPropagation();
      if (hovered) suppressHover.current = true;
      closeAll();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      closeAll();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, pinned, hovered, closeAll]);

  // placement: measured once the panel is in the DOM, before paint, then kept
  // current while the window or the panel's own size changes
  useIsoLayoutEffect(() => {
    if (!open) {
      setPlaced(null);
      return;
    }
    const place = () => {
      const anchor = triggerRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const root = document.documentElement;
      const next = placePopover(
        { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { width: root.clientWidth, height: root.clientHeight },
        placement,
      );
      setPlaced((prev) => (prev && prev.top === next.top && prev.left === next.left && prev.placement === next.placement ? prev : next));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (observer && panelRef.current) observer.observe(panelRef.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [open, placement]);

  const enter = (event: ReactPointerEvent) => {
    // a touch "hover" is the emulated one that precedes a tap; the tap pins
    if (event.pointerType === "touch" || suppressHover.current) return;
    if (hovered) clearTimer();
    else hoverAfter(true, OPEN_DELAY_MS);
  };
  const leave = () => {
    suppressHover.current = false;
    if (hovered) hoverAfter(false, CLOSE_DELAY_MS);
    else clearTimer();
  };
  const onFocus = (event: FocusEvent<HTMLButtonElement>) => {
    // keyboard focus only: a mouse press focuses the button too, and that
    // press is the pin click's business, not a second reason to open
    let visible = true;
    try {
      visible = event.currentTarget.matches(":focus-visible");
    } catch {
      /* a browser without :focus-visible treats every focus as keyboard */
    }
    if (visible) setFocused(true);
  };
  const onBlur = (event: FocusEvent<HTMLButtonElement>) => {
    if (panelRef.current?.contains(event.relatedTarget as Node | null)) return;
    setFocused(false);
  };
  const onClick = () => {
    clearTimer();
    if (pinned) {
      // unpin means close now, even with the pointer or focus still here
      suppressHover.current = true;
      closeAll();
    } else {
      setPinned(true);
    }
  };

  const style = {
    top: placed?.top ?? 0,
    left: placed?.left ?? 0,
    visibility: placed ? "visible" : "hidden",
  } as const;
  const panel = open ? (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-labelledby={titleId}
      data-placement={placed?.placement ?? placement}
      style={style}
      onPointerEnter={enter}
      onPointerLeave={leave}
      className={cn(
        "fixed z-50 w-max min-w-[13rem] max-w-[min(22rem,calc(100vw-1rem))] rounded-xl border border-hairline/50 bg-card p-3 text-left text-ink shadow-2xl shadow-black/20 motion-safe:animate-pop-in",
        panelClassName,
      )}
    >
      <div className="mb-2 flex items-baseline justify-between gap-6">
        <h3 id={titleId} className="text-[12.5px] font-semibold text-ink">{title}</h3>
        {titleAside ? <span className="text-[12px] tabular-nums text-ink-secondary">{titleAside}</span> : null}
      </div>
      {children}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={onClick}
      >
        {trigger}
      </button>
      {panel && typeof document !== "undefined" ? createPortal(panel, document.body) : panel}
    </>
  );
}
