import { editorService, type EditorInput } from "@/workbench/contributions";
import { hideAllToolWindows, useToolWindowLayout } from "@/workbench/toolwindows/store";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton } from "@/ui";
import { DiffEditor } from "./DiffEditor";
import type { DiffData } from "./diffInput";

export function DiffEditorTab({ input }: { input: EditorInput }) {
  const maximized = useToolWindowLayout((state) => !!state.stashed && !Object.values(state.visible).some(Boolean));
  const data = input.data as DiffData;
  // An embedded diff lives inside another view (deployment comparison, color-scheme preview).
  if (data.embedded) return <DiffEditor input={input} fit={!!data.fit} />;
  return (
    <DiffEditor
      input={input}
      onClose={() => void editorService().closeInput?.(input.key)}
      toolbarActions={
        <IconButton
          icon={maximized ? "minimize" : "maximize"}
          title={maximized ? "Restore Size" : "Maximize Editor"}
          shortcut={shortcutLabel("toolwindow.hideAll")}
          pressed={maximized}
          size="small"
          onClick={hideAllToolWindows}
        />
      }
    />
  );
}
