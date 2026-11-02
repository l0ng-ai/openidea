import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";
import { call, commands, type TerminalId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";

export interface TerminalPasteTarget {
  id: TerminalId;
  supported: boolean;
  remote: boolean;
  shell: string;
  current: () => boolean;
}

type Target = () => TerminalPasteTarget | null;

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

function pathsText(paths: readonly string[], target: TerminalPasteTarget): string {
  const shell = target.shell.toLowerCase().replace(/\.exe$/, "");
  return paths
    .map((path) => {
      if (shell === "cmd") {
        if (/[%!"\r\n]/.test(path))
          throw new Error(tx("Cannot paste this path safely in cmd.exe. Use PowerShell or a POSIX shell."));
        return `"${path}"`;
      }
      if (shell === "powershell" || shell === "pwsh") return `'${path.replaceAll("'", "''")}'`;
      return `'${path.replaceAll("'", "'\\''")}'`;
    })
    .join(" ");
}

function isMedia(type: string): boolean {
  return /^(image|audio|video)\//.test(type);
}

function pasteError(error: unknown, target: TerminalPasteTarget | null | undefined) {
  if (target?.current())
    notifications().notify({
      level: "error",
      title: tx("Cannot paste clipboard media"),
      body: error instanceof Error ? error.message : String(error),
    });
}

function filePaths(transfer: DataTransfer): string[] {
  const paths: string[] = [];
  for (const line of transfer.getData("text/uri-list").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    try {
      const url = new URL(line);
      if (url.protocol !== "file:") continue;
      let path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== "localhost") path = `//${url.hostname}${path}`;
      else if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      paths.push(path);
    } catch {
      continue;
    }
  }
  return paths;
}

async function pasteMedia(media: Blob, target: TerminalPasteTarget, paste: (text: string) => void) {
  try {
    if (media.size > MAX_MEDIA_BYTES) throw new Error(tx`Clipboard media is too large to paste (limit ${20} MB).`);
    const data = Array.from(new Uint8Array(await media.arrayBuffer()));
    if (!target.current()) return;
    if (!target.supported) throw new Error(tx("Remote server does not support image paste."));
    const path = await call(commands.termStoreImage(target.id, data, media.type));
    if (target.current()) paste(pathsText([path], target));
  } catch (error) {
    pasteError(error, target);
  }
}

export function installTerminalPaste(host: HTMLElement, paste: (text: string) => void, getTarget?: Target): () => void {
  let alive = true;
  const onPaste = (event: ClipboardEvent) => {
    const transfer = event.clipboardData;
    const target = getTarget?.();
    if (!event.defaultPrevented && target && transfer) {
      const media = Array.from(transfer.files).find((file) => isMedia(file.type));
      const files =
        transfer.files.length ||
        Array.from(transfer.types).some((type) => type === "Files" || type === "text/uri-list");
      if ((!target.remote && files) || (media && !transfer.getData("text/plain"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const captured = { ...target, current: () => alive && target.current() };
        void (async () => {
          if (!captured.remote) {
            const paths = filePaths(transfer);
            const text = paths.length
              ? pathsText(paths, captured)
              : await readClipboardText(transfer, (paths) => pathsText(paths, captured));
            if (!captured.current()) return;
            if (text) {
              paste(text);
              return;
            }
          }
          if (media) await pasteMedia(media, captured, paste);
        })().catch((error) => pasteError(error, captured));
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
    const text = target?.remote
      ? ((await navigator.clipboard?.readText().catch(() => "")) ?? "")
      : await readClipboardText(undefined, target ? (paths) => pathsText(paths, target) : undefined);
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
        const mime = item.types.find(isMedia);
        if (mime) {
          const image = await item.getType(mime);
          if (target.current()) await pasteMedia(image, target, paste);
          return;
        }
      }
    }
    const paths = await readClipboardText(undefined, target.remote ? undefined : (paths) => pathsText(paths, target));
    if (!target.current()) return;
    if (paths) paste(paths);
    else if (!images) throw new Error(tx("Clipboard image reading is unavailable."));
  } catch (error) {
    pasteError(error, target);
  }
}
