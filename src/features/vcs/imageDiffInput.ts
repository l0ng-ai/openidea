import { attachDocument } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { isSvgPath } from "@/features/viewers/fileKinds";
import { maybeEditorService } from "@/workbench/contributions";
import { stagedDocumentAtPath } from "./stagedDocument";
import { isIndex, type DiffData, type DiffSide } from "./diffInput";

/** Only route file-backed images; a patch, review thread or line range needs the text viewer. */
export function imageDiffKind(data: DiffData): "svg" | "raster" | null {
  if (data.stagingRange || data.line !== undefined || data.context || data.annotations?.length || data.annotateLeft)
    return null;
  const paths: string[] = [];
  for (const side of [data.left, data.middle, data.right]) {
    if (!side || (side.type === "text" && side.absent && !side.gitlinkSource)) continue;
    if (side.type !== "rev" && side.type !== "worktree" && side.type !== "file") return null;
    const path = (side.type !== "worktree" && side.path) || data.path;
    if (!/\.(png|jpe?g|webp|svg)$/i.test(path)) return null;
    paths.push(path);
  }
  if (!paths.length) return null;
  return paths.every(isSvgPath) ? "svg" : "raster";
}

const svgDataUrl = (text: string) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);

export async function readImageSide(path: string, side: DiffSide): Promise<string | null> {
  if (side.type === "rev") {
    const file = side.path ?? path;
    const draft = isIndex(side) && isSvgPath(file) && stagedDocumentAtPath(file);
    if (draft && draft.dirty) return svgDataUrl(draft.status.getState().text);
    return call(commands.vcsImageAt(file, side.rev));
  }
  if (side.type !== "worktree" && side.type !== "file") return null;
  const file = side.type === "file" ? side.path : path;
  if (isSvgPath(file) && maybeEditorService()?.dirtyDocumentIds?.().length !== 0) {
    // The shared document keeps unsaved text even when its editor tab is unmounted.
    const doc = await attachDocument(file).catch(() => null);
    try {
      if (doc?.dirty()) return svgDataUrl(doc.text());
    } finally {
      doc?.release();
    }
  }
  return call(commands.fsReadImage(file));
}
