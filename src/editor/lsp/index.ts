/**
 * LSP-backed editor features: completion, diagnostics, hover / quick docs,
 * parameter info, navigation, document highlights, intentions, rename,
 * formatting, inlay hints, inline completion and semantic highlighting. Everything is contributed
 * through `editor/api` as CodeMirror extensions plus actions; editor/core is
 * never imported.
 */
import type { Extension } from "@codemirror/state";
import { registerEditorContribution, type EditorDocContext } from "@/editor/api";
import {
  registerEditorBanner,
  registerOverlay,
  registerStatusItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { lspDoc } from "./lsp";
import { hintExtension } from "./hint";
import { completionExtension } from "./completion";
import { inplaceRenameExtension } from "./inplaceRename";
import { diagnosticsExtension, installDiagnosticsEvents } from "./diagnostics";
import { hoverExtension } from "./hover";
import { parameterTabKeys, signatureExtension } from "./signature";
import { navigationExtension } from "./navigation";
import { intentionsExtension } from "./intentions";
import { inlayExtension } from "./inlay";
import { inlineCompletionExtension, registerInlineCompletionActions } from "./inlineCompletion";
import { semanticExtension } from "./semantic";
import { usagesLensExtension } from "./codeLens";
import { autoImportExtension } from "./autoImport";
import { importsOnPasteExtension, registerImportsOnPasteActions } from "./importsOnPaste";
import { installConfigurationNavigationEvents } from "./configurationNavigation";
import { installAvailabilityEvents } from "./availability";
import { registerActionsOnSave, registerFormatOnSave, registerLspActions } from "./actions";
import { lspTheme } from "./theme";
import { inspectionWidgetExtension } from "./inspectionWidget";
import { unresolvedReferences } from "./fileReferences";
import { syntaxErrorsExtension } from "./syntaxErrors";
import { spellingExtension } from "./spelling";
import { DocumentationWindow, LspPopups, UsagesStatus } from "./Popups";
import { DOCUMENTATION_WINDOW } from "./docs";
import { prefetchMarkdown } from "./markdown";
import { outsideProjectBanner } from "./outsideProject";
import { implementationGutter, registerNavigationActions } from "@/editor/navigation";
import { HierarchyDialog } from "@/editor/refactor";

export function lspExtensions(ctx: EditorDocContext): Extension[] {
  return [
    lspDoc.of(ctx),
    lspTheme,
    hintExtension(),
    diagnosticsExtension(),
    inspectionWidgetExtension(),
    hoverExtension(),
    signatureExtension(),
    completionExtension(),
    inplaceRenameExtension(),
    navigationExtension(),
    intentionsExtension(),
    inlayExtension(),
    inlineCompletionExtension(),
    semanticExtension(),
    usagesLensExtension(),
    autoImportExtension(),
    importsOnPasteExtension(),
    unresolvedReferences(),
    syntaxErrorsExtension(),
    spellingExtension(),
  ];
}

export function activate(): () => void {
  const disposers = [
    installDiagnosticsEvents(),
    installAvailabilityEvents(),
    installConfigurationNavigationEvents(),
    registerEditorContribution({ id: "lsp", order: 50, extensions: lspExtensions }),
    // After the run icons (order 55), as their own gutter column.
    registerEditorContribution({ id: "lsp.lineMarkers", order: 56, extensions: implementationGutter }),
    // After the templates (order 90): live template / postfix expansion keeps ⇥ first.
    registerEditorContribution({ id: "lsp.parameterTab", order: 95, extensions: () => parameterTabKeys }),
    registerOverlay({ id: "editor-lsp.popups", component: LspPopups }),
    registerOverlay({ id: "editor-lsp.hierarchyDialog", component: HierarchyDialog }),
    registerEditorBanner(outsideProjectBanner),
    registerStatusItem({ id: "editor-lsp.usagesStatus", align: "left", priority: 10, component: UsagesStatus }),
    // IDEA's Documentation tool window: right side, listed once F1 moved documentation there.
    registerToolWindow({
      id: DOCUMENTATION_WINDOW,
      title: "Documentation",
      icon: "info",
      anchor: "right",
      secondary: true,
      stripe: "onUse",
      order: 90,
      component: DocumentationWindow,
    }),
    registerLspActions(),
    registerImportsOnPasteActions(),
    registerInlineCompletionActions(),
    registerNavigationActions(),
    registerFormatOnSave(),
    registerActionsOnSave(),
  ];
  prefetchMarkdown();
  return () => disposers.reverse().forEach((d) => d());
}
