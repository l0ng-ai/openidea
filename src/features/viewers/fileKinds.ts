/** Which files open in which viewer, and the editor inputs of the viewers. */
import type { EditorInput } from "@/workbench/contributions";
import { hasFileType, wildcardMatch } from "@/platform/fileTypes";
import type { FileProbe } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";

export const IMAGE_KIND = "image";
export const BINARY_KIND = "binary";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"]);
const MARKDOWN_SOURCE_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, "mdx", "ronn", "workbook"]);

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export const isImagePath = (path: string) => IMAGE_EXTENSIONS.has(extension(path));
export const isSvgPath = (path: string) => extension(path) === "svg";

/**
 * Whether `path` gets the Markdown preview under Settings › File Types.
 * The source check also includes Markdown extensions that open in the editor alone.
 */
export function isMarkdownPath(path: string, mode: "preview" | "source" = "preview"): boolean {
  const { settings, project } = useProject.getState();
  const extensions = mode === "source" ? MARKDOWN_SOURCE_EXTENSIONS : MARKDOWN_EXTENSIONS;
  return hasFileType(path, ["markdown"], extensions, settings?.files, project?.root ?? null);
}

/** Whether the file's name matches one of `patterns` (`*.xlsx`); Windows/macOS match case-insensitively. */
export function associatedApplication(
  path: string,
  patterns: readonly string[],
  os = usePlatform.getState().os,
): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const fold = os === "linux" ? (s: string) => s : (s: string) => s.toLowerCase();
  const folded = fold(name);
  return patterns.some((pattern) => wildcardMatch(fold(pattern), folded));
}

export const imageInput = (path: string): EditorInput => ({ kind: IMAGE_KIND, key: `image:${path}`, path });

export interface BinaryInputData {
  size: number;
  /** False for huge text files shown in the hex view (they may still open as text). */
  binary: boolean;
}

export const binaryInput = (path: string, probe: FileProbe): EditorInput => ({
  kind: BINARY_KIND,
  key: `binary:${path}`,
  path,
  data: { size: probe.size, binary: probe.binary } satisfies BinaryInputData,
});

/** Binary content or past the size where the text editor turns read-only → hex view. */
export const wantsHexView = (probe: FileProbe) => probe.binary || probe.tooLarge;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
