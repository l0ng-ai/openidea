/** Merge-scheme preview input; kept apart from `MergeSchemePreview` so registering it does not load CodeMirror. */

export const MERGE_SCHEME_PREVIEW_KIND = "mergeSchemePreview";

export interface MergeSchemePreviewData {
  /** Virtual URI; keeps language detection and avoids any file/git access. */
  path: string;
  /** Text of the left parent, merge result and right parent. */
  left: string;
  result: string;
  right: string;
  labels: [string, string, string];
  /** Attribute id for each change type, used as `data-diattr` on the coloured lines. */
  attrs: { inserted: string; deleted: string; modified: string; wave: string };
  /** 1-based, inclusive line range folded into a wavy separator in each pane. */
  fold: { from: number; to: number; label: string };
}
