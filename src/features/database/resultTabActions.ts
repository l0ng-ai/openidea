import { registerActions, type ActionContext } from "@/platform/actions";
import { promptInput } from "@/workbench/inputDialogs";
import type { MenuItem } from "@/ui";
import { OUTPUT_TAB, activeResultFor, closeResult, pinResult, resultsFor, selectResult, useDatabase } from "./store";

interface ResultActionArg {
  id: number;
  path: string;
}

function pathFor({ arg, ctx }: ActionContext): string | undefined {
  if (typeof arg === "number") return undefined;
  return arg && typeof arg === "object" && "path" in arg
    ? (arg as ResultActionArg).path
    : typeof ctx.dbResultsPath === "string"
      ? ctx.dbResultsPath
      : undefined;
}

function target(c: ActionContext): number | null {
  const { arg, ctx } = c;
  const s = useDatabase.getState();
  const path = pathFor(c);
  const id =
    typeof arg === "number"
      ? arg
      : arg && typeof arg === "object" && "id" in arg
        ? (arg as ResultActionArg).id
        : ctx.dbResultsFocus
          ? activeResultFor(s, path)
          : null;
  return id === OUTPUT_TAB || resultsFor(s, path).some((r) => r.id === id) ? id : null;
}

function closable(c: ActionContext): boolean {
  const id = target(c);
  return id !== null && id !== OUTPUT_TAB;
}

function closeOthers(id: number, path?: string) {
  for (const tab of resultsFor(useDatabase.getState(), path)) if (tab.id !== id) closeResult(tab.id);
}

function pinned(id: number | null): boolean {
  return !!useDatabase.getState().results.find((r) => r.id === id)?.pinned;
}

function cycle(direction: 1 | -1, focus: boolean, path?: string) {
  const state = useDatabase.getState();
  const ids = [OUTPUT_TAB, ...resultsFor(state, path).map((r) => r.id)];
  const index = ids.indexOf(activeResultFor(state, path));
  if (index < 0) return;
  const next = ids[(index + direction + ids.length) % ids.length]!;
  if (focus) {
    const prefix = path === undefined ? "db-results" : "db-output-results";
    const button = document.getElementById(`${prefix}-tab-${next}`);
    button?.focus();
    // An inline editor can hand focus back to its grid when it blurs.
    if (document.activeElement !== button) button?.focus();
  }
  selectResult(next, path);
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
      enabled: (c) =>
        target(c) !== null && resultsFor(useDatabase.getState(), pathFor(c)).some((r) => r.id !== target(c)),
      run: (c) => closeOthers(target(c)!, pathFor(c)),
    },
    {
      id: "db.closeAllResultTabs",
      title: "Close All",
      category: "Database",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: (c) => target(c) !== null && resultsFor(useDatabase.getState(), pathFor(c)).length > 0,
      run: (c) => closeOthers(OUTPUT_TAB, pathFor(c)),
    },
    {
      id: "db.closeAllButPinnedResultTabs",
      title: "Close All but Pinned",
      category: "Database",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: (c) => {
        const results = resultsFor(useDatabase.getState(), pathFor(c));
        return target(c) !== null && results.some((r) => r.pinned) && results.some((r) => !r.pinned);
      },
      run: (c) => {
        for (const tab of resultsFor(useDatabase.getState(), pathFor(c))) if (!tab.pinned) closeResult(tab.id);
      },
    },
    {
      id: "db.pinResultTab",
      title: "Pin / Unpin Tab",
      category: "Database",
      icon: "pin",
      keyWhen: "dbResultsFocus && !popupOpen",
      enabled: closable,
      run: (c) => {
        const id = target(c)!;
        pinResult(id, !pinned(id));
      },
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
      enabled: (c: ActionContext) => target(c) !== null && resultsFor(useDatabase.getState(), pathFor(c)).length > 0,
      run: (c: ActionContext) => cycle(direction, !!c.ctx.dbResultsFocus, pathFor(c)),
    })),
  ]);
}

export function resultTabMenu(id: number, path?: string): MenuItem[] {
  const arg = path === undefined ? id : { id, path };
  return [
    { kind: "action", action: "db.closeResultTab", arg },
    { kind: "action", action: "db.closeOtherResultTabs", arg },
    { kind: "action", action: "db.closeAllResultTabs", arg },
    { kind: "action", action: "db.closeAllButPinnedResultTabs", arg },
    { kind: "separator" },
    { kind: "action", action: "db.pinResultTab", arg, label: pinned(id) ? "Unpin Tab" : "Pin Tab" },
    { kind: "action", action: "db.renameResultTab", arg },
    { kind: "separator" },
    { kind: "action", action: "db.nextResultTab", arg },
    { kind: "action", action: "db.previousResultTab", arg },
  ];
}
