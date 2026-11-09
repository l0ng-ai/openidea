/** Color swatches in the editor gutter for color literals (Settings › Editor › General › Gutter Icons). */
import { registerEditorContribution } from "@/editor/api";
import { pluginColorPreview } from "./pluginColors";
import { colorPreviewGutter } from "./gutter";

export function activate(): () => void {
  return registerEditorContribution({
    id: "colorPreview.gutter",
    order: 59,
    extensions: (ctx) => [colorPreviewGutter(ctx), pluginColorPreview(ctx)],
  });
}
