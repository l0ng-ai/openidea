import { Menu, type MenuItem } from "@/ui";
import { useContext, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { LogIdContext } from "../logContext";
import { useGitLog } from "../logStore";
import { useVcs } from "../store";

export function useLogRepositories() {
  const scope = useContext(LogIdContext);
  const tab = useGitLog((s) => s.logTabs.find((t) => t.id === (scope ?? s.shownLog)));
  const roots = useVcs((s) => s.roots);
  const repo = tab?.repo;
  const repositories = tab?.repositories;
  const key = (repositories?.length ? repositories : repo ? [repo] : roots).join("\0");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (repositories?.length ? repositories : repo ? [repo] : roots), [key]);
}

export function useReadOnlyLog() {
  const scope = useContext(LogIdContext);
  return useGitLog((s) => s.logTabs.find((t) => t.id === (scope ?? s.shownLog))?.readOnly === true);
}

/**
 * A toolbar button's dropdown, anchored to the button: a second click on it closes the menu
 * instead of reopening it, as in IDEA. Returns the opener and the element to render.
 */
export function useDropdownMenu() {
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  const open = (anchor: HTMLElement | ReactMouseEvent<HTMLElement>, items: MenuItem[]) => {
    const el = "currentTarget" in anchor ? anchor.currentTarget : anchor;
    setMenu((m) => (m?.anchor === el ? null : { anchor: el, items }));
  };
  const dropdown = menu && <Menu open anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />;
  return [open, dropdown] as const;
}
