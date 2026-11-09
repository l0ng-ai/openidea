/** Navigate › File Path (⌥⌘F12): the file and its folders, each revealed in the OS file manager. */
import { openPopup } from "@/editor/lsp/popupStore";
import { canRevealInFileManager, fileManagerName, revealInFileManager } from "@/platform/fileManager";
import { notifications } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { nameOf, parentOf } from "./paths";
import { notifyRevealUnavailable } from "./operations";

const DRIVE_ROOT = /^[A-Za-z]:\/?$/;

/** `path` then each folder above it, up to the file system (or drive) root. */
export function filePathChain(path: string): string[] {
  const out = [path];
  for (let p = path; p !== "/" && !DRIVE_ROOT.test(p);) {
    const parent = parentOf(p);
    if (parent === p) break;
    p = /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
    out.push(p);
  }
  return out;
}

async function reveal(path: string) {
  try {
    await revealInFileManager(path);
  } catch (e) {
    const fileManager = tx(fileManagerName());
    notifications().notify({
      level: "error",
      title: tx`Cannot reveal in ${fileManager}`,
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export function showFilePathPopup(path: string, isDir = false) {
  if (!canRevealInFileManager()) return notifyRevealUnavailable();
  const items = filePathChain(path).map((p, i) => ({
    id: p,
    label: nameOf(p) || p,
    detail: i === 0 ? undefined : p,
    icon: i === 0 && !isDir ? "file" : "folder",
    run: () => reveal(p),
  }));
  openPopup({ kind: "list", anchor: { x: window.innerWidth / 2 - 160, y: 96 }, title: "File Path", items });
}
