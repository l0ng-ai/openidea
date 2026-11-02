import { useRef } from "react";
import type { EditorInput, ToolWindowAnchor } from "@/workbench/contributions";
import { hideAllToolWindows, useToolWindowLayout } from "@/workbench/toolwindows/store";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton } from "@/ui";
import { DiffEditor } from "./DiffEditor";

export function DiffEditorTab({ input }: { input: EditorInput }) {
  const previousMaximized = useRef<ToolWindowAnchor | null>(null);
  const maximized = useToolWindowLayout((state) => !!state.stashed && !Object.values(state.visible).some(Boolean));
  return (
    <DiffEditor
      input={input}
      toolbarActions={
        <IconButton
          icon={maximized ? "minimize" : "maximize"}
          title={maximized ? "Restore Size" : "Maximize Editor"}
          shortcut={shortcutLabel("toolwindow.hideAll")}
          pressed={maximized}
          size="small"
          onClick={() => {
            const state = useToolWindowLayout.getState();
            if (Object.values(state.visible).some(Boolean)) previousMaximized.current = state.maximized;
            hideAllToolWindows();
            if (maximized) {
              useToolWindowLayout.setState({ maximized: previousMaximized.current });
              previousMaximized.current = null;
            }
          }}
        />
      }
    />
  );
}
