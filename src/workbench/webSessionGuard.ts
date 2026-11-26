/**
 * Prompts before closing or navigating away from the browser tab in web mode
 * when any open editor document has unsaved changes.
 */
import { isWebMode } from "@/platform/webBridge";
import { maybeEditorService } from "./contributions";

export function installWebSessionGuard(): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!isWebMode()) return;
    const editor = maybeEditorService();
    if ((editor?.dirtyDocumentIds?.().length ?? 0) > 0 || (editor?.untitledDirtyDocumentIds?.().length ?? 0) > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => window.removeEventListener("beforeunload", onBeforeUnload);
}
