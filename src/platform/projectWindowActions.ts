import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { allActions, executeAction, getAction, registerAction, useActions, type Action } from "./actions";
import { auxiliaryWindow, AUX_CLOSED, type AuxCloseResult } from "./auxWindow";
import { isTauri } from "./ipc";

const REQUEST = "openidea://project-actions/request";
const ACTIONS = "openidea://project-actions/actions";
const EXECUTE = "openidea://project-actions/execute";
const PROJECT_ACTIONS = new Set([
  "file.openProject",
  "file.closeProject",
  "app.quit",
  "file.settings",
  "file.newProjectsSettings",
  "settings.keymap",
  "settings.appearance",
]);
type ActionInfo = Pick<Action, "id" | "title" | "category" | "description" | "icon" | "when" | "keywords" | "hidden">;

/** Project operations and settings retain the owner's guards and dialog host. */
export function installProjectWindowActionHost(): () => void {
  if (!isTauri() || auxiliaryWindow()) return () => {};
  const native = getCurrentWindow();
  const clients = new Set<string>();
  const stops: Array<() => void> = [];
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keep = (off: () => void) => (disposed ? off() : stops.push(off));
  const owns = (source: string) => {
    const aux = auxiliaryWindow(source);
    return (aux?.kind === "editor" || aux?.kind === "diff") && aux.parent === native.label;
  };
  const send = () => {
    const actions: ActionInfo[] = allActions()
      .filter((action) => PROJECT_ACTIONS.has(action.id))
      .map(({ id, title, category, description, icon, when, keywords, hidden }) => ({
        id,
        title,
        category,
        description,
        icon,
        when,
        keywords,
        hidden,
      }));
    for (const source of clients) void emitTo(source, ACTIONS, actions).catch(() => clients.delete(source));
  };
  void native
    .listen<{ source: string }>(REQUEST, ({ payload }) => {
      if (!owns(payload.source)) return;
      clients.add(payload.source);
      send();
    })
    .then(keep);
  void native
    .listen<{ source: string; id: string; arg?: unknown }>(EXECUTE, ({ payload }) => {
      if (!owns(payload.source) || !PROJECT_ACTIONS.has(payload.id)) return;
      void native
        .show()
        .then(() => native.unminimize())
        .then(() => native.setFocus())
        .then(() => executeAction(payload.id, payload.arg))
        .catch((error) => console.warn("could not run project window action", error));
    })
    .then(keep);
  void native
    .listen<AuxCloseResult>(AUX_CLOSED, ({ payload }) => {
      if (payload.closed) clients.delete(payload.label);
    })
    .then(keep);
  stops.push(
    useActions.subscribe((state, previous) => {
      if (state.actions === previous.actions) return;
      clearTimeout(timer);
      timer = setTimeout(send, 50);
    }),
  );
  return () => {
    disposed = true;
    clearTimeout(timer);
    stops.forEach((stop) => stop());
    clients.clear();
  };
}

export function installProjectWindowActions(parent: string): () => void {
  if (!isTauri()) return () => {};
  const native = getCurrentWindow();
  const proxies = new Map<string, () => void>();
  let disposed = false;
  let stop = () => {};
  void native
    .listen<ActionInfo[]>(ACTIONS, ({ payload }) => {
      if (disposed) return;
      proxies.forEach((off) => off());
      proxies.clear();
      for (const info of payload) {
        if (!PROJECT_ACTIONS.has(info.id) || getAction(info.id)) continue;
        proxies.set(
          info.id,
          registerAction({
            ...info,
            run: ({ arg }) => emitTo(parent, EXECUTE, { source: native.label, id: info.id, arg }),
          }),
        );
      }
    })
    .then(async (off) => {
      if (disposed) return off();
      stop = off;
      await emitTo(parent, REQUEST, { source: native.label });
    })
    .catch((error) => console.warn("could not load project window actions", error));
  return () => {
    disposed = true;
    stop();
    proxies.forEach((off) => off());
    proxies.clear();
  };
}
