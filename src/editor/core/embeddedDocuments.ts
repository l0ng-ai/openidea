/** Live document services for a native comparison window, without editor tabs or session restoration. */
import { _provideCodePreview, _provideDocumentAttacher } from "@/editor/api";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { ipcBackend } from "./backend";
import { previewExtensions } from "./cm/preview";
import { installColorScheme } from "./colorSchemeRuntime";
import { attachDocument } from "./model/attachment";
import { DocumentManager, type DocModel } from "./model/document";

class EmbeddedDocumentManager extends DocumentManager {
  // Keep files visited in this comparison until it closes, including unsaved
  // edits in a row that is no longer selected. No project tab/session is made.
  override release(_model: DocModel) {}
}

export function activateEmbeddedDocuments() {
  const manager = new EmbeddedDocumentManager(ipcBackend, {
    settings: () => useProject.getState().settings,
    notify: (message) => notifications().notify(message),
  });
  manager.start();
  _provideDocumentAttacher((path) => attachDocument(manager, path));
  _provideCodePreview((path) => previewExtensions(path, useProject.getState().settings?.editor, ipcBackend));
  const offColor = installColorScheme();
  const offSettings = useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings) manager.applySettings();
  });
  return {
    dirty: () => [...manager.byPath.values()].some((model) => model.getMeta().dirty),
    save: () => manager.saveAll("explicit"),
    savePaths: (paths: readonly string[]) =>
      Promise.all(paths.map((path) => manager.get(path)?.save("explicit"))).then(() => {}),
    async dispose() {
      _provideDocumentAttacher(null);
      _provideCodePreview(null);
      offSettings();
      offColor();
      manager.stop();
      for (const model of manager.byPath.values()) {
        await model.sync.whenIdle();
        model.dispose();
        await ipcBackend.close(model.doc);
      }
      manager.byPath.clear();
      manager.byId.clear();
    },
  };
}
