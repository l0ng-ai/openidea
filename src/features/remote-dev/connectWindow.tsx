/**
 * The Remote Development window (`connect-<parent>`): the connect dialog in its own native
 * window. The connection is its project window's (the remote project may open in it), so the
 * window hands the target over, shows the progress the project window sends back, and closes
 * once the project is open; a failure stays in the window, as in the dialog.
 */
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Window } from "@tauri-apps/api/window";
import { logError } from "@/platform/errorLog";
import { call, commands, isCancelled, isTauri, type RemoteProgress, type RemoteTarget } from "@/platform/ipc";
import { isRemoteWindow, useRemoteProgress } from "@/platform/remote";
import { closeDialogWindow, useDialogWindow } from "@/workbench/dialogWindow";
import { showError } from "@/workbench/messages";
import { OverlayHost } from "@/workbench/OverlayHost";
import { openRemoteProject } from "@/workbench/projectWindow";
import { useApplyTheme, windowBackgroundHex } from "@/workbench/theme";
import { WindowResizeHandles } from "@/workbench/WindowResizeHandles";
import { ConnectDialog } from "./ConnectDialog";
import { openConnectDialog, useConnectDialog } from "./model";

const REQUEST = "openidea://connect/request";
const PROGRESS = "openidea://connect/progress";
const RESULT = "openidea://connect/result";

interface ConnectRequest {
  id: number;
  from: string;
  target: RemoteTarget;
  path: string;
}
interface ConnectResult {
  id: number;
  opened: boolean;
  error?: string;
}

/** File › Remote Development…: its own window in the desktop app, else a dialog in this page. */
export function showConnect() {
  if (!isTauri() || isRemoteWindow()) return openConnectDialog();
  void call(commands.windowOpenConnect(windowBackgroundHex())).catch((e: unknown) => {
    logError("cannot open the Remote Development window", e);
    openConnectDialog();
  });
}

/** Connects for the Remote Development window, here in its project window. */
export function installConnectHandoff(): () => void {
  if (!isTauri()) return () => {};
  let self: ReturnType<typeof getCurrentWebviewWindow>;
  try {
    self = getCurrentWebviewWindow();
  } catch {
    return () => {}; // Not a desktop window (tests).
  }
  let disposed = false;
  let off: (() => void) | undefined;
  void self
    .listen<ConnectRequest>(REQUEST, ({ payload: { id, from, target, path } }) => {
      void self.setFocus().catch(() => {});
      const relay = useRemoteProgress.subscribe((s) => void emitTo(from, PROGRESS, s.progress).catch(() => {}));
      useConnectDialog.setState({ inWindow: true });
      const reply = async (result: ConnectResult) => {
        if (await Window.getByLabel(from)) return emitTo(from, RESULT, result);
        // The window is gone (closed, or with this window's old project): tell it here.
        if (result.error) await showError("Cannot connect to the remote host", result.error);
      };
      void openRemoteProject(target, path)
        .then(
          (opened) => reply({ id, opened }),
          (e: unknown) => reply(isCancelled(e) ? { id, opened: false } : { id, opened: false, error: errorText(e) }),
        )
        .finally(() => {
          relay();
          useConnectDialog.setState({ inWindow: false });
        });
    })
    .then((u) => (disposed ? u() : (off = u)));
  return () => {
    disposed = true;
    off?.();
  };
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

let nextId = 0;

/** Asks project window `parent` to connect; true once the project is open, false if it was not. */
async function requestConnect(parent: string, target: RemoteTarget, path: string): Promise<boolean> {
  const self = getCurrentWebviewWindow();
  const id = ++nextId;
  const offs: Array<() => void> = [];
  try {
    const result = new Promise<ConnectResult>((resolve) => {
      void self
        .listen<ConnectResult>(RESULT, ({ payload }) => payload.id === id && resolve(payload))
        .then((u) => {
          offs.push(u);
        });
    });
    offs.push(
      await self.listen<RemoteProgress | null>(PROGRESS, ({ payload }) =>
        useRemoteProgress.setState({ progress: payload }),
      ),
    );
    await emitTo(parent, REQUEST, { id, from: self.label, target, path } satisfies ConnectRequest);
    const { opened, error } = await result;
    if (error) throw new Error(error);
    return opened;
  } finally {
    offs.forEach((off) => off());
    useRemoteProgress.setState({ progress: null });
  }
}

export function ConnectWindow() {
  useApplyTheme();
  const parent = useDialogWindow((s) => s.parent);
  const connect = async (target: RemoteTarget, path: string) => {
    if (!parent) return false;
    const opened = await requestConnect(parent, target, path);
    if (opened) closeDialogWindow();
    return opened;
  };
  return (
    <>
      {parent && <ConnectDialog standalone onClose={closeDialogWindow} onConnect={connect} />}
      <OverlayHost />
      <WindowResizeHandles />
    </>
  );
}
