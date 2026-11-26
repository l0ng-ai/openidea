import { IconButton } from "@/ui";
import type { LayoutMode } from "./layoutModes";
import styles from "./markdown/Markdown.module.css";

/** Editor Only / Editor and Preview / Preview Only buttons of a text editor with a preview. */
export function LayoutActions({ tabId, mode, label }: { tabId: string; mode: LayoutMode; label: string }) {
  return (
    <div className={styles.layoutActions} role="toolbar" aria-label={label}>
      <IconButton
        icon="editor-only"
        iconSize={16}
        size="small"
        title="Editor Only"
        action="markdown.editorOnly"
        actionArg={tabId}
        pressed={mode === "editor"}
      />
      <IconButton
        icon="editor-preview"
        iconSize={16}
        size="small"
        title="Editor and Preview"
        action="markdown.editorAndPreview"
        actionArg={tabId}
        pressed={mode === "split"}
      />
      <IconButton
        icon="preview-only"
        iconSize={16}
        size="small"
        title="Preview Only"
        action="markdown.previewOnly"
        actionArg={tabId}
        pressed={mode === "preview"}
      />
    </div>
  );
}
