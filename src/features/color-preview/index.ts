/** Color swatches in the editor gutter for color literals (Settings › Editor › General › Gutter Icons). */
import { registerEditorContribution } from "@/editor/api";
import { pluginColorPreview } from "./pluginColors";
import { colorPreviewGutter } from "./gutter";
import { closeColorPickerFor, disposeColorPicker } from "./ColorPicker";
import { ViewPlugin } from "@codemirror/view";

export function activate(): () => void {
  const unregister = registerEditorContribution({
    id: "colorPreview.gutter",
    order: 59,
    extensions: (ctx) => [
      colorPreviewGutter(ctx),
      pluginColorPreview(ctx),
      ViewPlugin.define((view) => ({ destroy: () => closeColorPickerFor(view) })),
    ],
  });
  return () => {
    unregister();
    disposeColorPicker();
  };
}
