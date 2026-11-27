/** Text / Data tab of each open CSV editor, and a counter of each CSV file's text changes. */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { registerEditorContribution } from "@/editor/api";
import { isCsvPath } from "./csv";

export type CsvMode = "text" | "data";

export const useCsvModes = create<Record<string, CsvMode | undefined>>(() => ({}));
export const useCsvSourceHidden = (tabId: string) => useCsvModes((s) => s[tabId] === "data");

/** Bumped when a CSV file's text changes. */
export const useCsvVersions = create<Record<string, number | undefined>>(() => ({}));
const bump = (path: string) => useCsvVersions.setState((s) => ({ [path]: (s[path] ?? 0) + 1 }));
const TEXT_DELAY = 300;

export function registerCsvLiveSource(): () => void {
  return registerEditorContribution({
    id: "database.csvLive",
    extensions: (ctx) =>
      !ctx.virtual && isCsvPath(ctx.path)
        ? [
            ViewPlugin.fromClass(
              class {
                private timer: ReturnType<typeof setTimeout> | undefined;
                constructor(_view: EditorView) {
                  bump(ctx.path);
                }
                update(u: ViewUpdate) {
                  if (!u.docChanged) return;
                  clearTimeout(this.timer);
                  this.timer = setTimeout(() => bump(ctx.path), TEXT_DELAY);
                }
                destroy() {
                  clearTimeout(this.timer);
                }
              },
            ),
          ]
        : [],
  });
}
