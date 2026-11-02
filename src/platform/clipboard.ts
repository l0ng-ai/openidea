import { call, commands, isTauri } from "./ipc";
import { ipcPath } from "./paths";

type FormatFiles = (paths: string[]) => string;
const rawPaths: FormatFiles = (paths) => paths.join("\n");

/** WebKit exposes native file URLs as Files, hiding the pasteboard's text flavor. */
export async function readClipboardText(
  transfer?: DataTransfer | null,
  formatFiles: FormatFiles = rawPaths,
): Promise<string> {
  const text = transfer ? transfer.getData("text/plain") : ((await navigator.clipboard?.readText()) ?? "");
  if ((text && formatFiles === rawPaths) || (transfer && !hasClipboardFiles(transfer)) || !isTauri()) return text;
  try {
    const paths = await call(commands.clipboardFileList());
    // Windows also supplies the file list as text; unrelated text still wins.
    if (text && text.replace(/\r\n/g, "\n").split("\n").map(ipcPath).join("\n") !== paths.join("\n")) return text;
    return formatFiles(paths);
  } catch {
    return text;
  }
}

function hasClipboardFiles(transfer: DataTransfer): boolean {
  return !!transfer.files.length || Array.from(transfer.types).includes("Files");
}

/** Claim synchronously so the native handler cannot emit an empty paste while IPC runs. */
export function pasteClipboardFiles(
  event: ClipboardEvent,
  paste: (text: string) => void,
  formatFiles: FormatFiles = rawPaths,
): boolean {
  const transfer = event.clipboardData;
  if (
    event.defaultPrevented ||
    !transfer ||
    (transfer.getData("text/plain") && formatFiles === rawPaths) ||
    !hasClipboardFiles(transfer)
  )
    return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  void readClipboardText(transfer, formatFiles).then((text) => {
    if (text) paste(text);
  });
  return true;
}
