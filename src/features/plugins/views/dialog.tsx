/**
 * Plugin dialogs (`[[contributes.dialogs]]`, API 1.18): a package web page in a modal IDE dialog
 * with the platform's title bar, after IntelliJ's DialogWrapper. The plugin's code opens it with
 * `views.reveal(id)` in the invoking window; the user resizes it (the size is remembered) and
 * closes it with the close button or Escape, or the page closes it with `openidea.dialog.close()`.
 * The plugin hears of the close as a `closed` view event. Messages travel as in any web view.
 */
import { useMemo, useState } from "react";
import { create } from "zustand";
import { Dialog } from "@/ui";
import { registerOverlay } from "@/workbench/contributions";
import { pluginsBackend } from "../backend";
import { WebView, type FrameDialog } from "./WebView";
import styles from "./dialog.module.css";

export interface DialogDecl {
  id: string;
  title: string;
  web: string;
  /** Pixels, 320–1600 and 200–1200 (checked by the backend). */
  width: number;
  height: number;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

const dialogKey = (pluginId: string, id: string) => `${pluginId}/${id}`;

/** The plugin dialogs open in this window, by `<plugin>/<dialog>`. */
const useOpenDialogs = create<{ open: ReadonlySet<string> }>(() => ({ open: new Set() }));
/** The dialogs declared by live plugins, so `revealView` knows a dialog from a tool window. */
const declared = new Set<string>();

function setOpen(key: string, open: boolean) {
  const current = useOpenDialogs.getState().open;
  if (current.has(key) === open) return;
  const next = new Set(current);
  if (open) next.add(key);
  else next.delete(key);
  useOpenDialogs.setState({ open: next });
}

/** Opens the plugin's dialog `id` (from `views.reveal`); false when the plugin declares none by that id. */
export function openPluginDialog(pluginId: string, id: string): boolean {
  const key = dialogKey(pluginId, id);
  if (!declared.has(key)) return false;
  setOpen(key, true);
  return true;
}

const sizeStorageKey = (key: string) => `openidea.plugins.dialogSize.${key}`;

/** The size the user last gave the dialog, if any and still sane. */
export function rememberedDialogSize(key: string): { w: number; h: number } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(sizeStorageKey(key)) ?? "null") as { w?: unknown; h?: unknown };
    return typeof saved?.w === "number" && typeof saved.h === "number" && saved.w > 0 && saved.h > 0
      ? { w: Math.max(MIN_WIDTH, saved.w), h: Math.max(MIN_HEIGHT, saved.h) }
      : null;
  } catch {
    return null;
  }
}

function rememberDialogSize(key: string, size: { w: number; h: number }) {
  try {
    localStorage.setItem(sizeStorageKey(key), JSON.stringify({ w: Math.round(size.w), h: Math.round(size.h) }));
  } catch {
    // Private mode or storage disabled: the dialog opens at its declared size next time.
  }
}

function PluginDialog({ pluginId, decl }: { pluginId: string; decl: DialogDecl }) {
  const key = dialogKey(pluginId, decl.id);
  const open = useOpenDialogs((s) => s.open.has(key));
  if (!open) return null;
  return <OpenPluginDialog pluginId={pluginId} decl={decl} dialogKey={key} />;
}

function OpenPluginDialog({
  pluginId,
  decl,
  dialogKey: key,
}: {
  pluginId: string;
  decl: DialogDecl;
  dialogKey: string;
}) {
  const [initialSize] = useState(() => rememberedDialogSize(key) ?? { w: decl.width, h: decl.height });
  const frame = useMemo<FrameDialog>(() => ({ close: () => close() }), []);
  function close() {
    setOpen(key, false);
    pluginsBackend()
      .viewEvent(pluginId, decl.id, { kind: "closed" }, null)
      .catch((e: unknown) => console.warn(`plugin ${pluginId}: ${e instanceof Error ? e.message : String(e)}`));
  }
  return (
    <Dialog
      open
      title={decl.title}
      onClose={close}
      resizable="both"
      width={initialSize.w}
      initialSize={initialSize}
      minWidth={MIN_WIDTH}
      minHeight={MIN_HEIGHT}
      onResized={(size) => rememberDialogSize(key, size)}
      className={styles.dialog}
      aria-label={decl.title}
    >
      <div className={styles.page}>
        <WebView pluginId={pluginId} view={decl.id} label={decl.title} pluginDialog={frame} />
      </div>
    </Dialog>
  );
}

/** Lets `views.reveal(id)` open the dialog in this window while the plugin is live. */
export function projectDialog(pluginId: string, decl: DialogDecl): () => void {
  const key = dialogKey(pluginId, decl.id);
  function Overlay() {
    return <PluginDialog pluginId={pluginId} decl={decl} />;
  }
  declared.add(key);
  const remove = registerOverlay({ id: `plugin.${pluginId}.dialog.${decl.id}`, component: Overlay });
  return () => {
    remove();
    declared.delete(key);
    setOpen(key, false);
  };
}
