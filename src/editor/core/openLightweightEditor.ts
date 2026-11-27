import { getCurrentWindow } from "@tauri-apps/api/window";
import { EDITOR_READY, type EditorReadyResult } from "@/platform/auxWindow";
import { tx } from "@/platform/i18n";
import { call, commands, type EditorLaunch } from "@/platform/ipc";

const READY_MS = 30_000;

/** Opens a lightweight editor window; resolves to its label once it shows the file or tab. */
export async function openLightweightEditor(
  launch: EditorLaunch,
  background: string | null,
  /** What the window reports as shown: the file, or the key of the launch's tab. */
  target = launch.path,
): Promise<string> {
  const parent = getCurrentWindow();
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(tx("Timed out opening the editor window"))), READY_MS);
      void parent
        .listen<EditorReadyResult>(EDITOR_READY, ({ payload }) => {
          if (payload.path && payload.path !== target) return;
          if (payload.ok) resolve(payload.label);
          else reject(new Error(payload.error || tx("Could not open the editor window")));
        })
        .then((unlisten) => {
          off = unlisten;
          return call(commands.windowOpenEditor(launch, background));
        })
        .catch(reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    off?.();
  }
}
