/**
 * editor/core: the text editor (CodeMirror 6), document sync with the Rust
 * backend, tabs and splits, find/replace, navigation history and the editor
 * status bar widgets. See editor/api.ts for the extension contract.
 */
import {
  provideEditorArea,
  provideEditorService,
  registerEditorBanner,
  registerOverlay,
  registerStatusItem,
} from "@/workbench/contributions";
import { _provideCodePreview, _provideDocumentAttacher, editorsFor } from "@/editor/api";
import { formatDocument } from "@/editor/lsp/format";
import { editorController } from "./controller";
import { attachDocument } from "./model/attachment";
import { previewExtensions } from "./cm/preview";
import { registerEditorActions } from "./actions";
import { installColorScheme } from "./colorSchemeRuntime";
import { documentBanner } from "./view/Banner";
import { EditorAreaView } from "./view/EditorArea";
import { GotoLineDialog } from "./view/GotoLineDialog";
import { NavBarPopup } from "./view/NavBarPopup";
import { installClipboardTracking } from "./clipboardHistory";
import {
  Breadcrumbs,
  CaretStatus,
  EncodingStatus,
  IndentStatus,
  LineEndingStatus,
  ReadOnlyStatus,
} from "./view/StatusItems";

export function activate(): void | (() => void) {
  const ctrl = editorController();
  ctrl.start();
  provideEditorService({
    openFile: (path, options) => ctrl.openFile(path, options),
    openInput: (input, options) => ctrl.openInput(input, options),
    activePath: () => ctrl.activePath(),
    activeCursor: () => ctrl.activeCursor(),
    saveAll: () => ctrl.saveAll(),
    focus: () => ctrl.focus(),
    openPaths: () => ctrl.openPaths(),
    openTabs: () => ctrl.openTabs(),
    activeInput: () => ctrl.activeInput(),
    onActiveInputChange: (fn) => ctrl.onActiveInputChange(fn),
    closePath: (path) => ctrl.closePath(path),
    closeInput: (key) => ctrl.closeInput(key),
    prepareClose: () => ctrl.prepareClose(),
    cancelClose: () => ctrl.cancelClose(),
    documentHistory: (command) => ctrl.documentHistory(command),
    reformat: async (path) => {
      const handle = editorsFor(path)[0];
      return !!handle && (await formatDocument(handle.view, { explicit: false, selectionOnly: false })).applied;
    },
  });
  _provideDocumentAttacher((path) => attachDocument(ctrl.manager, path));
  _provideCodePreview((path) => previewExtensions(path, ctrl.manager.settings()?.editor));
  const disposers = [
    installColorScheme(),
    provideEditorArea(EditorAreaView),
    registerEditorActions(),
    registerEditorBanner(documentBanner),
    registerOverlay({ id: "editor.gotoLine", component: GotoLineDialog }),
    registerOverlay({ id: "editor.navigationBar", component: NavBarPopup }),
    installClipboardTracking(),
    registerStatusItem({
      id: "editor.breadcrumbs",
      align: "left",
      priority: 0,
      component: Breadcrumbs,
      title: "Navigation Bar",
    }),
    registerStatusItem({
      id: "editor.caret",
      align: "right",
      priority: 20,
      component: CaretStatus,
      title: "Line:Column Number",
      lightEdit: true,
    }),
    registerStatusItem({
      id: "editor.lineEnding",
      align: "right",
      priority: 30,
      component: LineEndingStatus,
      title: "Line Separator",
      lightEdit: true,
    }),
    registerStatusItem({
      id: "editor.encoding",
      align: "right",
      priority: 40,
      component: EncodingStatus,
      title: "File Encoding",
      lightEdit: true,
    }),
    registerStatusItem({
      id: "editor.indent",
      align: "right",
      priority: 50,
      component: IndentStatus,
      title: "Indentation",
      lightEdit: true,
    }),
    registerStatusItem({
      id: "editor.readOnly",
      align: "right",
      priority: 55,
      component: ReadOnlyStatus,
      title: "Read-only Attribute",
      lightEdit: true,
    }),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    _provideDocumentAttacher(null);
    _provideCodePreview(null);
    ctrl.stop();
  };
}
