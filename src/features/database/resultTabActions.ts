import { registerActions, type ActionContext } from "@/platform/actions";
import { promptInput } from "@/workbench/inputDialogs";
import type { MenuItem } from "@/ui";
import { OUTPUT_TAB, closeResult, useDatabase } from "./store";

function target({ arg, ctx }: ActionContext): number | null {
  const id = typeof arg === "number" ? arg : ctx.dbResultsFocus ? useDatabase.getState().activeResult : null;
  return id === OUTPUT_TAB || useDatabase.getState().results.some((r) => r.id === id) ? id : null;
}

function closable(c: ActionContext): boolean {
  const id = target(c);
  return id !== null && id !== OUTPUT_TAB;
}

function closeOthers(id: number) {
  for (const tab of useDatabase.getState().results) if (tab.id !== id) closeResult(tab.id);
}

function cycle(direction: 1 | -1) {
  const { results, activeResult } = useDatabase.getState();
  const ids = [OUTPUT_TAB, ...results.map((r) => r.id)];
  const index = ids.indexOf(activeResult ?? OUTPUT_TAB);
  if (index >= 0) useDatabase.setState({ activeResult: ids[(index + direction + ids.length) % ids.length]! });
}

export function registerResultTabActions(): () => void {
  return registerActions([
    {
      id: "db.closeResultTab",
      title: "Close",
      category: "Database",
      icon: "close",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: closable,
      run: (c) => closeResult(target(c)!),
    },
    {
      id: "db.closeOtherResultTabs",
      title: "Close Others",
      category: "Database",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: (c) => target(c) !== null && useDatabase.getState().results.some((r) => r.id !== target(c)),
      run: (c) => closeOthers(target(c)!),
    },
    {
      id: "db.closeAllResultTabs",
      title: "Close All",
      category: "Database",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: (c) => target(c) !== null && useDatabase.getState().results.length > 0,
      run: () => closeOthers(OUTPUT_TAB),
    },
    {
      id: "db.renameResultTab",
      title: "Rename Tab",
      category: "Database",
      icon: "edit",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: closable,
      run: async (c) => {
        const id = target(c);
        const tab = useDatabase.getState().results.find((r) => r.id === id);
        if (!tab) return;
        const title = await promptInput({ title: "Rename Tab", label: "Tab name:", initial: tab.title });
        if (title === null) return;
        useDatabase.setState((s) => ({ results: s.results.map((r) => (r.id === id ? { ...r, title } : r)) }));
      },
    },
    ...([1, -1] as const).map((direction) => ({
      id: direction === 1 ? "db.nextResultTab" : "db.previousResultTab",
      title: direction === 1 ? "Select Next Tab" : "Select Previous Tab",
      category: "Database",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: (c: ActionContext) => target(c) !== null && useDatabase.getState().results.length > 0,
      run: () => cycle(direction),
    })),
  ]);
}

export function resultTabMenu(id: number): MenuItem[] {
  return [
    { kind: "action", action: "db.closeResultTab", arg: id },
    { kind: "action", action: "db.closeOtherResultTabs", arg: id },
    { kind: "action", action: "db.closeAllResultTabs", arg: id },
    { kind: "separator" },
    { kind: "action", action: "db.renameResultTab", arg: id },
    { kind: "separator" },
    { kind: "action", action: "db.nextResultTab", arg: id },
    { kind: "action", action: "db.previousResultTab", arg: id },
  ];
}
