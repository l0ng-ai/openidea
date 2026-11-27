/**
 * Scratch files live in the user data dir (`<data>/scratches`) of the host that runs the
 * window's file commands (the server in a remote window), not in the project, like IDEA's
 * config-dir scratches. Creating one picks the next free `scratch[_n].<ext>` name and opens
 * it as a normal document.
 */
import { toBase64 } from "@/platform/base64";
import { call, commands, emitLocalIdeEvent, isTauri } from "@/platform/ipc";
import { scratchesDir as hostScratchesDir } from "@/platform/scratchesDir";
import { editorService, notifications } from "@/workbench/contributions";
import { scratchContent, scratchFileName, scratchLanguages, type ScratchLanguage } from "./model";

export interface ScratchBackend {
  /** Absolute scratches folder, created. */
  scratchesDir(): Promise<string>;
  listNames(dir: string): Promise<string[]>;
  createFile(path: string, text: string): Promise<void>;
  languages(): Promise<ScratchLanguage[]>;
  open(path: string, caret: { line: number; col: number } | null): Promise<void>;
}

export const tauriScratchBackend: ScratchBackend = {
  scratchesDir: hostScratchesDir,
  listNames: async (dir) => (await call(commands.fsReadDir(dir))).map((e) => e.name),
  createFile: async (path, text) =>
    void (await call(
      text ? commands.fsCreateFileBytes(path, toBase64(new TextEncoder().encode(text))) : commands.fsCreateFile(path),
    )),
  languages: async () => scratchLanguages(await commands.languages()),
  open: (path, caret) => editorService().openFile(path, { focus: true, ...(caret && { selection: caret }) }),
};

let backend: ScratchBackend = tauriScratchBackend;

/** Tests swap the backend. */
export function setScratchBackend(b: ScratchBackend) {
  backend = b;
}

export const scratchBackend = () => backend;

/** The scratches folder, created if needed. */
export async function scratchesDir(): Promise<string> {
  return (await backend.scratchesDir()).replace(/\/+$/, "");
}

export const scratchesAvailable = () => isTauri() || backend !== tauriScratchBackend;

/** Creates `scratch[_n].<ext>` for `lang` from its template and opens it; returns its path. */
export async function createScratch(lang: ScratchLanguage): Promise<string | null> {
  try {
    const dir = await scratchesDir();
    const name = scratchFileName(await backend.listNames(dir), lang.ext);
    const path = `${dir}/${name}`;
    const { text, caret } = scratchContent(lang.template);
    await backend.createFile(path, text);
    // The file watcher covers the project only: tell the project view.
    emitLocalIdeEvent({ type: "fsChanged", created: [path], modified: [], removed: [] });
    await backend.open(path, caret);
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
