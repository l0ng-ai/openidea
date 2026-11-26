/**
 * Non-text editors and the Markdown preview: images open in an image viewer,
 * binary and very large files in a read-only hex view (both through file
 * editor providers consulted by `openFile`), and Markdown and SVG files get IDEA's
 * Editor / Editor and Preview / Preview layouts around the text editor.
 */
import { registerActions, type Action } from "@/platform/actions";
import { call, commands, type FileProbe } from "@/platform/ipc";
import { activeEditor } from "@/editor/api";
import { openWithSystemApp } from "@/platform/fileManager";
import { onFileTypesChange } from "@/platform/fileTypes";
import { basename, useProject } from "@/platform/project";
import { fileIconName, lazyComponent } from "@/ui";
import {
  registerEditorKind,
  registerExternalFileOpenHandler,
  registerFileEditorProvider,
  registerMenuGroup,
  registerTextEditorWrapper,
  textEditorWrapperFor,
  useTextEditorWrappers,
  type EditorInput,
} from "@/workbench/contributions";
import {
  BINARY_KIND,
  IMAGE_KIND,
  associatedApplication,
  binaryInput,
  imageInput,
  isImagePath,
  isMarkdownPath,
  isSvgPath,
  wantsHexView,
} from "./fileKinds";
import { ImageViewer, toggleChessboard, useImageViewers } from "./ImageViewer";
import { HexViewer } from "./HexViewer";
import { registerMarkdownLiveSource } from "./markdown/live";
import { setMarkdownMode, useMarkdownModes, useMarkdownSourceHidden } from "./markdown/modes";
import type { LayoutMode } from "./layoutModes";
import { registerSvgLiveSource } from "./svg/live";
import { SvgLayoutActions, svgModes } from "./svg/SvgEditor";
import { MarkdownLayoutActions } from "./markdown/MarkdownLayoutActions";
import { canExtractImages, extractImages, EXTRACT_IMAGES, EXTRACT_IMAGES_TITLE } from "./markdown/extractImages";

const titleOf = (input: EditorInput) => basename(input.path ?? input.key);
const iconOf = (input: EditorInput) => fileIconName(titleOf(input));

function imageActions(): Action[] {
  const image = (id: string, title: string, run: () => void, extra: Partial<Action> = {}): Action => ({
    id,
    title,
    category: "Image",
    when: "imageViewerActive",
    keyWhen: "imageViewerFocus",
    run,
    ...extra,
  });
  const active = () => useImageViewers.getState().active;
  return [
    image("image.zoomIn", "Zoom In", () => active()?.zoom(1), { icon: "zoom-in" }),
    image("image.zoomOut", "Zoom Out", () => active()?.zoom(-1), { icon: "zoom-out" }),
    image("image.actualSize", "Actual Size", () => active()?.actualSize(), { icon: "actual-size" }),
    image("image.fitToWindow", "Fit Zoom to Window", () => active()?.fit(), { icon: "maximize" }),
    image("image.toggleChessboard", "Show Chessboard", toggleChessboard, {
      icon: "chessboard",
      keywords: ["transparency", "background"],
      toggled: () => useImageViewers.getState().chessboard,
    }),
  ];
}

/**
 * The tab whose layout an Editor Only / Editor and Preview / Preview Only action sets: the one its
 * tab button passes, else the focused editor's when it's a Markdown or SVG file.
 */
function layoutTarget(arg: unknown): { tabId: string; set: (tabId: string, mode: LayoutMode) => void } | null {
  if (typeof arg === "string") {
    return { tabId: arg, set: svgModes.useModes.getState().byTab[arg] ? svgModes.set : setMarkdownMode };
  }
  const editor = activeEditor();
  const path = editor?.ctx.path ?? "";
  if (!editor?.tabId) return null;
  if (isSvgPath(path)) return { tabId: editor.tabId, set: svgModes.set };
  if (isMarkdownPath(path) || useMarkdownModes.getState().byTab[editor.tabId])
    return { tabId: editor.tabId, set: setMarkdownMode };
  return null;
}

function markdownActions(): Action[] {
  const mode = (id: string, title: string, m: LayoutMode, icon: string): Action => ({
    id,
    title,
    category: "Markdown",
    icon,
    keywords: ["markdown", "svg", "preview", "layout"],
    when: "textEditorActive",
    enabled: ({ arg }) => !!layoutTarget(arg),
    run: ({ arg }) => {
      const target = layoutTarget(arg);
      target?.set(target.tabId, m);
    },
  });
  return [
    mode("markdown.editorOnly", "Editor Only", "editor", "editor-only"),
    mode("markdown.editorAndPreview", "Editor and Preview", "split", "editor-preview"),
    mode("markdown.previewOnly", "Preview Only", "preview", "preview-only"),
    {
      id: EXTRACT_IMAGES,
      title: EXTRACT_IMAGES_TITLE,
      category: "Markdown",
      when: "textEditorActive && !editorReadOnly",
      enabled: () => canExtractImages(),
      run: extractImages,
    },
  ];
}

export function activate(): () => void {
  const probes = new Map<string, Promise<FileProbe>>();
  const disposers = [
    // Open tabs gain or lose the Markdown preview when File Types change.
    onFileTypesChange(() => useTextEditorWrappers.setState((w) => ({ wrappers: new Map(w.wrappers) }))),
    // Files associated with another application (Settings › Editor › File Types)
    // win over the viewers below; a failed launch falls through to them.
    registerExternalFileOpenHandler({
      id: "viewers.associatedApps",
      order: 1,
      matches: (path) =>
        associatedApplication(path, useProject.getState().settings?.files?.associatedApplications ?? []),
      open: openWithSystemApp,
    }),
    registerEditorKind({ kind: IMAGE_KIND, component: ImageViewer, title: titleOf, icon: iconOf }),
    registerEditorKind({ kind: BINARY_KIND, component: HexViewer, title: titleOf, icon: iconOf }),
    registerFileEditorProvider({
      id: "viewers.image",
      order: 10,
      resolve: (path) =>
        isImagePath(path) && !textEditorWrapperFor(useTextEditorWrappers.getState().wrappers, path)
          ? imageInput(path)
          : null,
    }),
    registerFileEditorProvider({
      id: "viewers.hex",
      order: 50,
      resolve: async (path) => {
        let pending = probes.get(path);
        if (!pending) {
          pending = call(commands.fsProbe(path)).finally(() => probes.delete(path));
          probes.set(path, pending);
        }
        const probe = await pending;
        return wantsHexView(probe) ? binaryInput(path, probe) : null;
      },
    }),
    registerTextEditorWrapper({
      id: "viewers.markdown",
      keepAlive: true,
      matches: isMarkdownPath,
      component: lazyComponent(() => import("./markdown/MarkdownEditor").then((m) => m.MarkdownEditor), {
        prefetch: true,
      }),
      tabActions: MarkdownLayoutActions,
      useSourceHidden: useMarkdownSourceHidden,
    }),
    registerMarkdownLiveSource(),
    registerTextEditorWrapper({
      id: "viewers.svg",
      fallback: true,
      matches: isSvgPath,
      component: lazyComponent(() => import("./svg/SvgEditor").then((m) => m.SvgEditor)),
      tabActions: SvgLayoutActions,
      useSourceHidden: svgModes.useSourceHidden,
    }),
    registerSvgLiveSource(),
    registerMenuGroup({
      id: EXTRACT_IMAGES,
      menus: ["editor"],
      items: (_menu, { paths: [path] }) =>
        path === activeEditor()?.ctx.path && canExtractImages() ? [{ kind: "action", action: EXTRACT_IMAGES }] : [],
    }),
    registerActions([...imageActions(), ...markdownActions()]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
