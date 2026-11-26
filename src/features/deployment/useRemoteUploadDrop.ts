import { useEffect, useState, type RefObject } from "react";
import { executeAction } from "@/platform/actions";
import { isTauri, type RemoteEntry } from "@/platform/ipc";
import { nativeDropPoint } from "@/platform/nativeDrop";
import { isRemoteWindow } from "@/platform/remote";
import type { DeploymentServerValid } from "@/platform/remoteSettings";
import { FILES_DRAG, registerDropTarget } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { registerFileDropHandler } from "@/workbench/fileDrop";
import { remoteParent } from "./model";

/** Tree keys identify virtualized rows without relying on translated labels or row indexes. */
export function uploadFolderAt(
  view: HTMLElement,
  root: string,
  entries: ReadonlyMap<string, RemoteEntry>,
  x: number,
  y: number,
): string | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit || !view.contains(hit) || hit.closest('[role="toolbar"]')) return null;
  const row = hit.closest<HTMLElement>("[data-tree-key]");
  if (!row) return root;
  const entry = entries.get(row.dataset.treeKey!);
  return entry ? (entry.isDir ? entry.path : remoteParent(entry.path)) : null;
}

export function useRemoteUploadDrop(
  view: RefObject<HTMLDivElement | null>,
  server: DeploymentServerValid | null,
  root: string | null,
  entries: ReadonlyMap<string, RemoteEntry>,
) {
  const [hover, setHover] = useState<{ server: DeploymentServerValid; folder: string | null } | null>(null);
  useEffect(() => {
    const element = view.current;
    if (!element || !server || !root) return;
    const setFolder = (folder: string | null) =>
      setHover((previous) =>
        previous?.server === server && previous.folder === folder ? previous : { server, folder },
      );
    const at = (x: number, y: number) => uploadFolderAt(element, root, entries, x, y);
    const upload = (paths: string[], target: string) =>
      void executeAction("deployment.uploadLocalInto", { server: server.id, paths, target });
    const unregisterFiles = registerFileDropHandler((paths, x, y) => {
      const target = at(x, y);
      if (!target) return false;
      if (isRemoteWindow()) {
        notifications().notify({
          level: "info",
          title: "Desktop uploads are not available in a remote development window",
          group: "tools",
        });
      } else upload([...paths], target);
      return true;
    });
    const unregisterPointer = registerDropTarget(element, {
      accepts: (type) => type === FILES_DRAG,
      over: (_, x, y) => setFolder(at(x, y)),
      leave: () => setFolder(null),
      drop: (data, x, y) => {
        setFolder(null);
        const target = at(x, y);
        if (target)
          upload(
            data.payload
              .split("\n")
              .filter(Boolean)
              .map((path) => path.replace(/\/$/, "")),
            target,
          );
      },
    });
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri())
      void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview()
          .onDragDropEvent(({ payload }) => {
            if (disposed) return;
            if (payload.type === "enter" || payload.type === "over") {
              const { x, y } = nativeDropPoint(payload.position);
              setFolder(at(x, y));
            } else setFolder(null);
          })
          .then((stop) => {
            if (disposed) stop();
            else unlisten = stop;
          }),
      );
    return () => {
      disposed = true;
      unregisterFiles();
      unregisterPointer();
      unlisten?.();
    };
  }, [view, server, root, entries]);
  return root && hover?.server === server ? hover.folder : null;
}
