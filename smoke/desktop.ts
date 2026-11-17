/**
 * The frontend's view of the desktop app, with a real backend: the window's Tauri runtime
 * in-process (`tauriShim.ts`), and every app command sent to an `openidea-server`, as
 * remote development sends them.
 */
import { homedir, tmpdir } from "node:os";
import { sep } from "node:path";
import { installTauriShim, type ShimWindow } from "./tauriShim";
import type { Server } from "./server";

installTauriShim({ directories: { 12: tmpdir(), 21: homedir() }, sep: sep as "/" | "\\" });

/** Connects this page's frontend to `server`; returns a function that disconnects it. */
export function connectDesktop(server: Server): () => void {
  const w = window as unknown as ShimWindow;
  w.__openideaShim.reset();
  server.onChannel = (id, data) => w.__openideaShim.channel(id, data);
  server.onEvent = (target, event) => w.__openideaShim.event(target, event);
  w.__openideaForward = (cmd, args) => server.invoke(cmd, args);
  return () => {
    delete w.__openideaForward;
    server.onChannel = () => {};
    server.onEvent = () => {};
  };
}
