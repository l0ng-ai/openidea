/**
 * Scratch files live in the app data dir (`<appData>/scratches`), not in the
 * project, like IDEA's config-dir scratches. Creating one picks the next free
 * `scratch[_n].<ext>` name and opens it as a normal document.
 */
import { IpcError, call, commands, emitLocalIdeEvent, isTauri } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { editorService, notifications } from "@/workbench/contributions";
import { scratchFileName, scratchLanguages, type ScratchLanguage } from "./model";

export interface ScratchBackend {
  /** Absolute app data dir. */
  dataDir(): Promise<string>;
  listNames(dir: string): Promise<string[]>;
  createDir(dir: string): Promise<void>;
  createFile(path: string): Promise<void>;
  languages(): Promise<ScratchLanguage[]>;
  open(path: string): Promise<void>;
}

export const tauriScratchBackend: ScratchBackend = {
  // `appDataDir()` is native (`C:\…`); the scratch paths are used as UI paths.
  dataDir: async () => {
    const { appDataDir } = await import("@tauri-apps/api/path");
    return ipcPath(await appDataDir());
  },
  listNames: async (dir) => (await call(commands.fsReadDir(dir))).map((e) => e.name),
  createDir: async (dir) => void (await call(commands.fsCreateDir(dir))),
  createFile: async (path) => void (await call(commands.fsCreateFile(path))),
  languages: async () => scratchLanguages(await commands.languages()),
  open: (path) => editorService().openFile(path, { focus: true }),
};

let backend: ScratchBackend = tauriScratchBackend;

/** Tests swap the backend. */
export function setScratchBackend(b: ScratchBackend) {
  backend = b;
  dirPromise = null;
}

export const scratchBackend = () => backend;

let dirPromise: Promise<string> | null = null;

/** `<appData>/scratches`, created on first use. */
export function scratchesDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const dir = `${(await backend.dataDir()).replace(/\/+$/, "")}/scratches`;
      try {
        await backend.createDir(dir);
      } catch (e) {
        if (!(e instanceof IpcError && e.kind === "alreadyExists")) throw e;
      }
      return dir;
    })();
    dirPromise.catch(() => {
      dirPromise = null;
    });
  }
  return dirPromise;
}

export const scratchesAvailable = () => isTauri() || backend !== tauriScratchBackend;

/** Creates `scratch[_n].<ext>` for `lang` and opens it; returns its path. */
export async function createScratch(lang: ScratchLanguage): Promise<string | null> {
  try {
    const dir = await scratchesDir();
    const name = scratchFileName(await backend.listNames(dir), lang.ext);
    const path = `${dir}/${name}`;
    await backend.createFile(path);
    // The file watcher covers the project only: tell the project view.
    emitLocalIdeEvent({ type: "fsChanged", created: [path], modified: [], removed: [] });
    await backend.open(path);
    return path;
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot create scratch file",
      body: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
