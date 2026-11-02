/** Editor / Editor and Preview / Preview switcher for Excalidraw files. */
import { IconButton } from "@/ui";
import { tx } from "@/platform/i18n";
import { modeOf, useExcalidrawModes } from "./modes";
import styles from "./Excalidraw.module.css";

export function ExcalidrawLayoutActions({ path }: { path: string; tabId: string }) {
  const mode = useExcalidrawModes((s) => modeOf(s, path));
  return (
    <div className={styles.layoutActions} role="toolbar" aria-label={tx("Excalidraw layout")}>
      <IconButton
        icon="editor-only"
        iconSize={16}
        size="small"
        title="Editor Only"
        action="excalidraw.editorOnly"
        actionArg={path}
        pressed={mode === "editor"}
      />
      <IconButton
        icon="editor-preview"
        iconSize={16}
        size="small"
        title="Editor and Preview"
        action="excalidraw.editorAndPreview"
        actionArg={path}
        pressed={mode === "split"}
      />
      <IconButton
        icon="preview-only"
        iconSize={16}
        size="small"
        title="Preview Only"
        action="excalidraw.previewOnly"
        actionArg={path}
        pressed={mode === "preview"}
      />
    </div>
  );
}
