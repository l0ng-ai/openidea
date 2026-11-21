import { editorService, type EditorInput } from "@/workbench/contributions";
import { hideAllToolWindows, useToolWindowLayout } from "@/workbench/toolwindows/store";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton } from "@/ui";
import { DiffEditor } from "./DiffEditor";
import type { DiffData } from "./diffInput";

export function DiffEditorTab({ input }: { input: EditorInput }) {
  const maximized = useToolWindowLayout((state) => !!state.stashed && !Object.values(state.visible).some(Boolean));
  // An embedded diff lives inside another view (deployment comparison, color-scheme preview):
  // no toolbar of its own, sized by its content, like the all-in-one diff block.
  if ((input.data as DiffData).embedded) return <DiffEditor input={input} fit />;
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
