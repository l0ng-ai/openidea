import { useEffect, useRef } from "react";
import { call, commands } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { clampZoom } from "@/platform/zoom";

/**
 * Mounted bars, newest last, each with a resend that ignores what it sent before. The window
 * has one set of buttons: when a bar covering another goes away (the project-opening screen
 * over the frame), the one left re-aligns them to its own height.
 */
const mounted: Array<() => void> = [];

export function useNativeTitlebar(bar: HTMLElement | null) {
  const overlay = usePlatform((s) => s.overlayTitleBar);
  const zoom = useProject((s) => (s.settings ? clampZoom(s.settings.appearance?.zoom) : null));
  const lastHeight = useRef<number | null>(null);
  useEffect(() => {
    if (!overlay || !bar || zoom === null) return;
    bar.style.setProperty("--titlebar-zoom", String(zoom / 100));
    const update = () => {
      // Webview zoom scales CSS pixels; Retina scale is already handled by AppKit.
      const height = (bar.getBoundingClientRect().height * zoom) / 100;
      if (height > 0 && height !== lastHeight.current) {
        lastHeight.current = height;
        void call(commands.windowSetTitlebarHeight(height)).catch((e) => {
          if (lastHeight.current === height) lastHeight.current = null;
          console.warn("cannot align window buttons", e);
        });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    const resend = () => {
      lastHeight.current = null;
      update();
    };
    mounted.push(resend);
    return () => {
      observer.disconnect();
      bar.style.removeProperty("--titlebar-zoom");
      mounted.splice(mounted.indexOf(resend), 1);
      mounted.at(-1)?.();
    };
  }, [bar, overlay, zoom]);
}
