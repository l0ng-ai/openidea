import { call, commands, isTauri } from "./ipc";

/** WebKit exposes native file URLs as Files, hiding the pasteboard's text flavor. */
export async function readClipboardText(transfer?: DataTransfer | null): Promise<string> {
  const text = transfer ? transfer.getData("text/plain") : ((await navigator.clipboard?.readText()) ?? "");
  if (text || (transfer && !hasClipboardFiles(transfer)) || !isTauri()) return text;
  try {
    return (await call(commands.clipboardFileList())).join("\n");
  } catch {
    return "";
  }
}

function hasClipboardFiles(transfer: DataTransfer): boolean {
  return !!transfer.files.length || Array.from(transfer.types).includes("Files");
}

/** Claim synchronously so the native handler cannot emit an empty paste while IPC runs. */
export function pasteClipboardFiles(event: ClipboardEvent, paste: (text: string) => void): boolean {
  const transfer = event.clipboardData;
  if (event.defaultPrevented || !transfer || transfer.getData("text/plain") || !hasClipboardFiles(transfer))
    return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  void readClipboardText(transfer).then((text) => {
    if (text) paste(text);
  });
  return true;
}
