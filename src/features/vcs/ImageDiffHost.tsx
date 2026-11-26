import { useCallback, useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { setContext } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton, isPopupOpen } from "@/ui";
import { editorService } from "@/workbench/contributions";
import type { DiffEditorProps } from "./DiffEditor";
import { chainNeighbour, openDiff, sideFile, type DiffData } from "./diffInput";
import { changedChainNeighbour } from "./diffNavigation";
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import { loadDiffOptions } from "./diffOptions";
import { ImageDiff } from "./ImageDiff";
import styles from "./DiffEditor.module.css";

export function ImageDiffHost({
  data,
  onSource,
  onNeighbour,
  skipUnchangedFiles = true,
  onJumpToSource,
  onClose,
  toolbarActions,
  fit,
}: Pick<
  DiffEditorProps,
  "onNeighbour" | "skipUnchangedFiles" | "onJumpToSource" | "onClose" | "toolbarActions" | "fit"
> & {
  data: DiffData;
  onSource?: () => void;
}) {
  const request = useRef<object | null>(null);
  const navigator = useMemo<DiffNavigator>(() => {
    const file = async (dir: 1 | -1) => {
      const id = {};
      request.current = id;
      const next = skipUnchangedFiles
        ? await changedChainNeighbour(data, dir, loadDiffOptions().ignore)
        : chainNeighbour(data, dir);
      if (!next || id !== request.current) return;
      if (onNeighbour) onNeighbour(next);
      else await openDiff(next, { preview: true });
    };
    return {
      file,
      next: () => void file(1),
      prev: () => void file(-1),
      close: () => {
        onClose?.();
        return !!onClose;
      },
      jumpToSource: () => {
        const path = sideFile(data.right, data.path) ?? sideFile(data.left, data.path);
        if (path) {
          onJumpToSource?.();
          void editorService().openFile(path, { focus: true });
        }
      },
      applyChange: () => false,
      showSettings: () => {},
      focusOpposite: () => false,
      swapSides: () => false,
      showInExternalTool: () => false,
    };
  }, [data, onClose, onJumpToSource, onNeighbour, skipUnchangedFiles]);
  const blur = useCallback(() => {
    if (focusedDiffNavigator() !== navigator) return;
    setFocusedDiffNavigator(null);
    setContext("diffEditorFocus", false);
  }, [navigator]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (root.current?.contains(document.activeElement)) {
      setFocusedDiffNavigator(navigator);
      setContext("diffEditorFocus", true);
    }
    return () => {
      request.current = null;
      blur();
    };
  }, [navigator, blur]);
  return (
    <div
      ref={root}
      className={clsx(styles.root, fit && styles.fit)}
      onFocusCapture={() => {
        setFocusedDiffNavigator(navigator);
        setContext("diffEditorFocus", true);
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) blur();
      }}
      onKeyDown={(e) => {
        if (
          e.key === "Escape" &&
          !e.defaultPrevented &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.nativeEvent.isComposing &&
          !isPopupOpen() &&
          navigator.close()
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <ImageDiff
        data={data}
        forwardFocus={!fit && !data.embedded}
        onSource={onSource}
        toolbarActions={
          <>
            {data.chain &&
              ([-1, 1] as const).map((dir) => (
                <IconButton
                  key={dir}
                  icon={dir === 1 ? "arrow-right" : "arrow-left"}
                  size="small"
                  title={dir === 1 ? "Compare Next File" : "Compare Previous File"}
                  shortcut={shortcutLabel(dir === 1 ? "diff.nextFile" : "diff.prevFile")}
                  disabled={!chainNeighbour(data, dir)}
                  onClick={() => navigator.file(dir)}
                />
              ))}
            {toolbarActions}
          </>
        }
      />
    </div>
  );
}
