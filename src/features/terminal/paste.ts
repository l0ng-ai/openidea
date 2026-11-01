import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";
import { call, commands, type TerminalId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";

export interface RemotePasteTarget {
  id: TerminalId;
  supported: boolean;
  current: () => boolean;
}

type Target = () => RemotePasteTarget | null;

async function pasteImage(image: Blob, target: RemotePasteTarget, paste: (text: string) => void) {
  try {
    const data = Array.from(new Uint8Array(await image.arrayBuffer()));
    if (!target.current()) return;
    if (!target.supported) throw new Error(tx("Remote server does not support image paste."));
    const path = await call(commands.termStoreImage(target.id, data, image.type));
    if (target.current()) paste(`'${path.replaceAll("'", "'\\''")}'`);
  } catch (error) {
    if (target.current())
      notifications().notify({ level: "error", title: tx("Cannot paste image"), body: String(error) });
  }
}

export function installTerminalPaste(host: HTMLElement, paste: (text: string) => void, getTarget?: Target): () => void {
  let alive = true;
  const onPaste = (event: ClipboardEvent) => {
    const transfer = event.clipboardData;
    const target = getTarget?.();
    if (!event.defaultPrevented && target && transfer && !transfer.getData("text/plain")) {
      const image = Array.from(transfer.files).find((file) => file.type.startsWith("image/"));
      if (image) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void pasteImage(image, { ...target, current: () => alive && target.current() }, paste);
        return;
      }
    }
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

export async function pasteTerminalClipboard(paste: (text: string) => void, getTarget?: Target) {
  const target = getTarget?.();
  try {
    // Native paste preserves clipboard blobs where Clipboard.read() is unavailable.
    if (target && document.queryCommandSupported?.("paste") && document.execCommand("paste")) return;
    const images =
      target && navigator.clipboard?.read
        ? navigator.clipboard.read().then(
            (items) => ({ items }),
            (error: unknown) => ({ error }),
          )
        : null;
    const text = target ? ((await navigator.clipboard?.readText().catch(() => "")) ?? "") : await readClipboardText();
    if (target && !target.current()) return;
    if (text) {
      paste(text);
      return;
    }
    if (!target) return;
    if (images) {
      const result = await images;
      if ("error" in result) throw result.error;
      if (!target.current()) return;
      for (const item of result.items) {
        const mime = item.types.find((type) => type.startsWith("image/"));
        if (mime) {
          const image = await item.getType(mime);
          if (target.current()) await pasteImage(image, target, paste);
          return;
        }
      }
    }
    const paths = await readClipboardText();
    if (!target.current()) return;
    if (paths) paste(paths);
    else if (!images) throw new Error(tx("Clipboard image reading is unavailable."));
  } catch (error) {
    if (target?.current())
      notifications().notify({ level: "error", title: tx("Cannot paste image"), body: String(error) });
  }
}
