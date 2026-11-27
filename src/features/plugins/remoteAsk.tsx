/**
 * Plugin code of a remote window runs on its server. Opening a link, writing
 * the clipboard or reading it on this machine waits for the user, who sees exactly what.
 */
import { tx } from "@/platform/i18n";
import { ask } from "@/workbench/messages";
import { usePlugins } from "./store";
import styles from "./remoteAsk.module.css";

const PREVIEW_CHARS = 500;
const PREVIEW_LINES = 12;

const pluginName = (pluginId: string) => usePlugins.getState().plugins.find((p) => p.id === pluginId)?.name ?? pluginId;

/** Whether the user lets a remote plugin open `url` with this machine's browser. */
export async function confirmRemoteOpen(pluginId: string, url: string): Promise<boolean> {
  const name = pluginName(pluginId);
  const r = await ask({
    title: tx`Open a link from ${name}?`,
    body: (
      <>
        <div>{tx("A plugin running on the remote host wants to open this address on this computer:")}</div>
        <div className={styles.value}>{url}</div>
      </>
    ),
    buttons: [{ id: "open", label: tx("Open"), primary: true }],
  });
  return r.button === "open";
}

/** Whether the user lets a remote plugin put `text` on this machine's clipboard. */
export async function confirmRemoteCopy(pluginId: string, text: string): Promise<boolean> {
  const name = pluginName(pluginId);
  const preview = previewOf(text);
  const count = text.length.toLocaleString();
  const r = await ask({
    title: tx`Copy text from ${name}?`,
    body: (
      <>
        <div>
          {tx("A plugin running on the remote host wants to copy this text to the clipboard of this computer:")}
        </div>
        <div className={styles.value}>{preview}</div>
        {preview !== text && <div className={styles.note}>{tx`${count} characters in total`}</div>}
      </>
    ),
    buttons: [{ id: "copy", label: tx("Copy"), primary: true }],
  });
  return r.button === "copy";
}

/** Whether the user lets a remote plugin read this machine's clipboard (`ui.read-clipboard`). */
export async function confirmRemoteClipboardRead(pluginId: string, signal: AbortSignal): Promise<boolean> {
  const name = pluginName(pluginId);
  const r = await ask({
    title: tx`Let ${name} read the clipboard?`,
    body: tx(
      "A plugin running on the remote host wants to read the text and image on the clipboard of this computer and send them to the remote host.",
    ),
    buttons: [{ id: "allow", label: tx("Allow"), primary: true }],
    signal,
  });
  return r.button === "allow";
}

/** The start of `text`, at most `PREVIEW_CHARS` characters on `PREVIEW_LINES` lines, marked when cut. */
function previewOf(text: string): string {
  let preview = text.slice(0, PREVIEW_CHARS);
  const lines = preview.split("\n");
  if (lines.length > PREVIEW_LINES) preview = lines.slice(0, PREVIEW_LINES).join("\n");
  return preview.length < text.length ? `${preview}…` : text;
}
