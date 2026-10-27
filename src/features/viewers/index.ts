/**
 * Non-text editors and the Markdown preview: images open in an image viewer,
 * binary and very large files in a read-only hex view (both through file
 * editor providers consulted by `openFile`), and Markdown files get IDEA's
 * Editor / Editor and Preview / Preview layouts around the text editor.
 */
import { registerActions, type Action } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { basename } from "@/platform/project";
import { fileIconName, lazyComponent } from "@/ui";
import {
  registerEditorKind,
  registerFileEditorProvider,
  registerTextEditorWrapper,
  type EditorInput,
} from "@/workbench/contributions";
import {
  BINARY_KIND,
  IMAGE_KIND,
  binaryInput,
  imageInput,
  isImagePath,
  isMarkdownPath,
  wantsHexView,
} from "./fileKinds";
import { ImageViewer, toggleChessboard, useImageViewers } from "./ImageViewer";
import { HexViewer } from "./HexViewer";
import { registerMarkdownLiveSource } from "./markdown/live";
import { setMarkdownMode, type MarkdownMode } from "./markdown/modes";

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

function markdownActions(): Action[] {
  const mode = (id: string, title: string, m: MarkdownMode, icon: string): Action => ({
    id,
    title,
    category: "Markdown",
    icon,
    keywords: ["markdown", "preview", "layout"],
    when: "textEditorActive && editorLangId == markdown",
    run: ({ arg }) => {
      const path = typeof arg === "string" ? arg : getContext().editorPath;
      if (typeof path === "string" && isMarkdownPath(path)) setMarkdownMode(path, m);
    },
  });
  return [
    mode("markdown.editorOnly", "Editor Only", "editor", "edit"),
    mode("markdown.editorAndPreview", "Editor and Preview", "split", "split"),
    mode("markdown.previewOnly", "Preview Only", "preview", "eye"),
  ];
}

export function activate(): () => void {
  const disposers = [
    registerEditorKind({ kind: IMAGE_KIND, component: ImageViewer, title: titleOf, icon: iconOf }),
    registerEditorKind({ kind: BINARY_KIND, component: HexViewer, title: titleOf, icon: iconOf }),
    registerFileEditorProvider({
      id: "viewers.image",
      order: 10,
      resolve: (path) => (isImagePath(path) ? imageInput(path) : null),
    }),
    registerFileEditorProvider({
      id: "viewers.hex",
      order: 50,
      resolve: async (path) => {
        const probe = await call(commands.fsProbe(path));
        return wantsHexView(probe) ? binaryInput(path, probe) : null;
      },
    }),
    registerTextEditorWrapper({ id: "viewers.markdown", matches: isMarkdownPath, component: lazyComponent(() => import("./markdown/MarkdownEditor").then((m) => m.MarkdownEditor)) }),
    registerMarkdownLiveSource(),
    registerActions([...imageActions(), ...markdownActions()]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
