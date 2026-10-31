import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";

export function installTerminalPaste(host: HTMLElement, paste: (text: string) => void): () => void {
  let alive = true;
  const onPaste = (event: ClipboardEvent) => {
    pasteClipboardFiles(event, (text) => {
      if (alive) paste(text);
    });
  };
  host.addEventListener("paste", onPaste, true);
  return () => {
    alive = false;
    host.removeEventListener("paste", onPaste, true);
  };
}

export async function pasteTerminalClipboard(paste: (text: string) => void) {
  try {
    const text = await readClipboardText();
    if (text) paste(text);
  } catch {
    /* Clipboard access may be denied. */
  }
}
