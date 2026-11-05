/** Color swatches in the editor gutter for color literals (Settings › Editor › General › Gutter Icons). */
import { registerEditorContribution } from "@/editor/api";
import { colorPreviewGutter } from "./gutter";

export function activate(): () => void {
  return registerEditorContribution({ id: "colorPreview.gutter", order: 59, extensions: colorPreviewGutter });
}
