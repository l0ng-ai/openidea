import { IconButton } from "@/ui";
import { tx } from "@/platform/i18n";
import { modeOf, useMarkdownModes } from "./modes";
import styles from "./Markdown.module.css";

export function MarkdownLayoutActions({ tabId }: { path: string; tabId: string }) {
  const mode = useMarkdownModes((s) => modeOf(s, tabId));
  return (
    <div className={styles.layoutActions} role="toolbar" aria-label={tx("Markdown editor layout")}>
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
