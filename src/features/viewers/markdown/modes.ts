/** Markdown editor layout per editor tab: Editor only / Editor and Preview / Preview only. */
import { createLayoutModes, modeOf, type LayoutMode } from "../layoutModes";

export type MarkdownMode = LayoutMode;
export { modeOf };

const markdown = createLayoutModes("openidea.markdown.defaultMode");

export const useMarkdownModes = markdown.useModes;
export const useMarkdownSourceHidden = markdown.useSourceHidden;
export const pinMarkdownMode = markdown.pin;
export const setMarkdownMode = markdown.set;
