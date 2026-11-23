import { call, commands } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";

let dir: Promise<string> | null = null;

// A window attaches to (or leaves) a remote server in place: the folder is then another host's.
useRemote.subscribe((state, previous) => {
  if (state.session !== previous.session) dir = null;
});

/**
 * The scratch files' folder (`<user data>/scratches`) of the host that runs this window's file
 * commands: the server in a remote window, this machine otherwise. Created on first use.
 */
export function scratchesDir(): Promise<string> {
  if (!dir) {
    const pending = call(commands.fsScratchesDir()).then((path) => path.replace(/\/+$/, ""));
    dir = pending;
    pending.catch(() => {
      if (dir === pending) dir = null;
    });
  }
  return dir;
}
