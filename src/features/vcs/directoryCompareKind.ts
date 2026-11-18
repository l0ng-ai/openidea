/** Compare Directories tab input; kept apart from `DirectoryCompare` so opening one does not load it. */
import { editorService, type EditorInput } from "@/workbench/contributions";
import { baseName } from "./model";

export const DIRECTORY_COMPARE_KIND = "directoryCompare";

export interface DirectoryCompareData {
  left: string;
  right: string;
}

export function directoryCompareInput(left: string, right: string): EditorInput {
  return { kind: DIRECTORY_COMPARE_KIND, key: `directoryCompare:${left}\n${right}`, data: { left, right } };
}

/** "a ↔ b", or with the parent folders when both folders have the same name (`x/config ↔ y/config`). */
export function directoryCompareTitle({ left, right }: DirectoryCompareData): string {
  const [l, r] = [left, right].map((p) => p.replace(/[\\/]+$/, "")) as [string, string];
  const same = baseName(l) === baseName(r);
  const name = (path: string) => (same ? path.split(/[\\/]/).slice(-2).join("/") : baseName(path));
  return `${name(l)} ↔ ${name(r)}`;
}

export function showDirectoryComparison(left: string, right: string) {
  if (left === right) return;
  void editorService().openInput(directoryCompareInput(left, right), { focus: true });
}
