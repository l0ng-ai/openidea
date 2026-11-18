import { startEditorWindow } from "./editorWindow";
import { logError } from "@/platform/errorLog";
import { holdSplash } from "@/platform/splash";

export { EditorWindow as Window } from "@/workbench/EditorWindow";

/** Loaded only by detached editors; avoid the all-features entry point. */
export function activate(parent: string): void {
  holdSplash(
    startEditorWindow(parent).catch((error) => {
      logError("Editor window startup failed", error);
      window.dispatchEvent(new CustomEvent("openidea:boot-error", { detail: error }));
    }),
  );
}
