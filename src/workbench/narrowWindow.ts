/**
 * In a window too narrow for the side tool windows (a tile on a tiling compositor), the left and
 * right areas collapse so the editor keeps the width. Their stripe buttons stay; the saved layout
 * is untouched, and a wider window puts them back. Keep the breakpoint in step with the
 * `max-width: 560px` queries in Welcome.module.css and TitleBar.module.css.
 */
import { collapseSidesForNarrowWindow, restoreSidesAfterNarrowWindow, useToolWindowLayout } from "./toolwindows/store";

export const NARROW_WINDOW_QUERY = "(max-width: 560px)";

export function installNarrowWindow(): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(NARROW_WINDOW_QUERY);
  const apply = () => (query.matches ? collapseSidesForNarrowWindow() : restoreSidesAfterNarrowWindow());
  query.addEventListener("change", apply);
  // A project's layout loads afresh each time it opens, the same project again included.
  const unsubscribe = useToolWindowLayout.subscribe((s, prev) => {
    if (s.layoutLoads !== prev.layoutLoads && query.matches) collapseSidesForNarrowWindow();
  });
  apply();
  return () => {
    query.removeEventListener("change", apply);
    unsubscribe();
  };
}
