import { useCallback, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { railAsideClass } from "@/lib/layout-rails";
import {
  DEFAULT_PLUGINS_DRAWER_WIDTH,
  loadPluginsDrawerWidth,
  MAX_PLUGINS_DRAWER_WIDTH,
  MIN_PLUGINS_DRAWER_WIDTH,
  savePluginsDrawerWidth,
} from "@/lib/plugins-drawer-preferences";

/** Resizable right rail that hosts the Plugins manager without eating half the window. */
export function PluginsManagerDrawer({ children }: { children: ReactNode }) {
  const [drawerWidth, setDrawerWidth] = useState(() => loadPluginsDrawerWidth());
  const [isResizing, setIsResizing] = useState(false);

  const startResize = useCallback(
    (downEvent: React.MouseEvent) => {
      downEvent.preventDefault();
      setIsResizing(true);
      const startX = downEvent.clientX;
      const startWidth = drawerWidth;

      const onMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        const maxWidth = Math.min(MAX_PLUGINS_DRAWER_WIDTH, window.innerWidth - 320);
        const next = Math.max(MIN_PLUGINS_DRAWER_WIDTH, Math.min(maxWidth, startWidth + delta));
        setDrawerWidth(next);
      };

      const onUp = (upEvent: MouseEvent) => {
        setIsResizing(false);
        const delta = startX - upEvent.clientX;
        const maxWidth = Math.min(MAX_PLUGINS_DRAWER_WIDTH, window.innerWidth - 320);
        const finalWidth = Math.max(MIN_PLUGINS_DRAWER_WIDTH, Math.min(maxWidth, startWidth + delta));
        setDrawerWidth(finalWidth);
        savePluginsDrawerWidth(finalWidth);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [drawerWidth],
  );

  const resetWidth = useCallback(() => {
    setDrawerWidth(DEFAULT_PLUGINS_DRAWER_WIDTH);
    savePluginsDrawerWidth(DEFAULT_PLUGINS_DRAWER_WIDTH);
  }, []);

  const handleResizeKey = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 40 : 20;
      const maxWidth = Math.min(MAX_PLUGINS_DRAWER_WIDTH, window.innerWidth - 320);
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setDrawerWidth((prev) => {
          const next = Math.min(maxWidth, prev + step);
          savePluginsDrawerWidth(next);
          return next;
        });
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setDrawerWidth((prev) => {
          const next = Math.max(MIN_PLUGINS_DRAWER_WIDTH, prev - step);
          savePluginsDrawerWidth(next);
          return next;
        });
      } else if (event.key === "Home") {
        event.preventDefault();
        resetWidth();
      }
    },
    [resetWidth],
  );

  return (
    <aside
      className={cn(railAsideClass("relative"), isResizing && "select-none")}
      style={{ width: `${drawerWidth}px` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Plugins Panel"
        aria-valuenow={drawerWidth}
        aria-valuemin={MIN_PLUGINS_DRAWER_WIDTH}
        aria-valuemax={MAX_PLUGINS_DRAWER_WIDTH}
        tabIndex={0}
        onMouseDown={startResize}
        onDoubleClick={resetWidth}
        onKeyDown={handleResizeKey}
        className={cn(
          "absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize hover:bg-accent/60 transition-colors max-md:hidden",
          isResizing && "bg-accent w-1.5",
        )}
        title="Drag to resize (double-click to reset)"
      >
        <div className="absolute inset-y-0 -left-2.5 -right-2.5" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </aside>
  );
}
