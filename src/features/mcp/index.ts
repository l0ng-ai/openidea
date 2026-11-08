/** Window snapshots used by the built-in MCP tools. */
import { activeEditor, onEditorEvent, openEditorPaths, useEditorRegistry } from "@/editor/api";
import { commands, call, onIdeEvent, ideEventsReady } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";

import { registerOverlay } from "@/workbench/contributions";
import { McpConfirmHost } from "./ConfirmDialog";
import { denyAll, dropConfirm, handleMcpRequest } from "./requests";

export function activate(): () => void {
  const offOverlay = registerOverlay({ id: "mcp.confirm", component: McpConfirmHost });
  const offRequests = onIdeEvent("mcpRequest", (e) => void handleMcpRequest(e.id, e.request));
  const offClosed = onIdeEvent("mcpRequestClosed", (e) => dropConfirm(e.id));
  const ready = () => {
    if (!isRemoteWindow() && useProject.getState().project)
      void ideEventsReady()
        .then(() => call(commands.mcpUiReady(true)))
        .catch(() => {});
  };
  const unload = () => {
    denyAll();
    if (!isRemoteWindow()) void call(commands.mcpUiReady(false)).catch(() => {});
  };
  ready();
  window.addEventListener("beforeunload", unload);
  let lastPaths: string | undefined;
  let lastEditor: string | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    timer = null;
    if (isRemoteWindow() || !useProject.getState().project) return;
    const paths = openEditorPaths();
    const editor = activeEditor();
    const focused = document.hasFocus();
    const selection = editor?.view.state.selection.main;
    const doc = editor?.view.state.doc;
    const start = doc && selection ? doc.lineAt(selection.from) : null;
    const end = doc && selection ? doc.lineAt(selection.to) : null;
    const current =
      editor && selection && start && end
        ? {
            path: editor.ctx.path,
            selection: {
              start: { line: start.number - 1, col: selection.from - start.from },
              end: { line: end.number - 1, col: selection.to - end.from },
            },
            selectedText: doc!
              .sliceString(selection.from, Math.min(selection.to, selection.from + 65536))
              .replace(/[\uD800-\uDBFF]$/, ""),
          }
        : null;
    const root = useProject.getState().project?.root;
    const pathKey = JSON.stringify([root, paths]);
    const editorKey = JSON.stringify([root, current, focused]);
    if (pathKey !== lastPaths) {
      lastPaths = pathKey;
      void call(commands.mcpSetOpenEditors(paths)).catch(() => {
        lastPaths = undefined;
        if (!disposed) schedule();
      });
    }
    if (editorKey !== lastEditor) {
      lastEditor = editorKey;
      void call(commands.mcpSetFocusedEditor(current, focused)).catch(() => {
        lastEditor = undefined;
        if (!disposed) schedule();
      });
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 300);
  };
  schedule();
  const offRegistry = useEditorRegistry.subscribe(schedule);
  const offEvents = onEditorEvent(schedule);
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) {
      denyAll();
      ready();
      lastPaths = undefined;
      lastEditor = undefined;
      schedule();
    }
  });
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  return () => {
    disposed = true;
    unload();
    offOverlay();
    offRequests();
    offClosed();
    window.removeEventListener("beforeunload", unload);
    offRegistry();
    offEvents();
    offProject();
    window.removeEventListener("focus", schedule);
    window.removeEventListener("blur", schedule);
    if (timer) clearTimeout(timer);
  };
}
