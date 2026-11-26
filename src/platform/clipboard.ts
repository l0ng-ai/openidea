import { call, commands, isTauri } from "./ipc";
import { ipcPath } from "./paths";
import { toBase64 } from "./base64";
import { usePlatform } from "./platformInfo";
import { isWebMode } from "./webBridge";

const isDesktop = () => isTauri() && !isWebMode();

/** Native menu actions and async work can outlive WebKit's user activation. */
export async function writeClipboardText(text: string): Promise<void> {
  if (isDesktop()) await call(commands.clipboardWriteText(text));
  else await navigator.clipboard.writeText(text);
}

/** Start the browser write before awaiting image conversion, preserving Safari user activation. */
export async function writeClipboardPng(png: Promise<Blob>): Promise<void> {
  void png.catch(() => {});
  if (isDesktop()) {
    const bytes = new Uint8Array(await (await png).arrayBuffer());
    await call(commands.clipboardWriteImage(toBase64(bytes)));
  } else {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
      throw new Error("Image clipboard is unavailable");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }
}

/**
 * The clipboard's plain text, read natively in the desktop app, else through the WebView.
 * A Paste from a menu has no paste event to read, WebKitGTK's `navigator.clipboard.readText()`
 * gives no text there, and WebView2 prompts for it. Rejects when the WebView refuses.
 */
export async function readClipboardPlainText(): Promise<string> {
  if (isDesktop()) {
    const text = await call(commands.clipboardText()).catch(() => undefined);
    if (text != null) return text;
    // WebKit on macOS makes the user confirm the read with a "Paste" callout; the backend found no text.
    if (text === null && usePlatform.getState().os === "macos") return "";
  }
  return (await navigator.clipboard?.readText()) ?? "";
}

/** The clipboard's image as base64 PNG, read natively; null when it holds none or outside the desktop app. */
export async function readClipboardPng(): Promise<string | null> {
  if (!isDesktop()) return null;
  const url = await call(commands.clipboardImage());
  return url ? url.slice(url.indexOf(",") + 1) : null;
}

type FormatFiles = (paths: string[]) => string;
const rawPaths: FormatFiles = (paths) => paths.join("\n");

/** WebKit exposes native file URLs as Files, hiding the pasteboard's text flavor. */
export async function readClipboardText(
  transfer?: DataTransfer | null,
  formatFiles: FormatFiles = rawPaths,
): Promise<string> {
  const text = transfer ? transfer.getData("text/plain") : await readClipboardPlainText().catch(() => "");
  if ((text && formatFiles === rawPaths) || (transfer && !hasClipboardFiles(transfer)) || !isDesktop()) return text;
  let paths: string[];
  try {
    paths = await call(commands.clipboardFileList());
  } catch {
    return text;
  }
  // Windows also supplies the file list as text; unrelated text still wins.
  if (text && text.replace(/\r\n/g, "\n").split("\n").map(ipcPath).join("\n") !== paths.join("\n")) return text;
  return formatFiles(paths);
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
