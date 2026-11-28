import { useVcs } from "./store";
import { editorService } from "@/workbench/contributions";

export interface RevisionData {
  repo: string;
  revision: string;
  path: string;
  external?: boolean;
}

/** Read-only editor URI for one file at a Git revision. */
export function gitRevisionUri(repo: string, revision: string, path: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ repo, revision, path }));
  const encoded = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `git-revision:${encoded}/${encodeURIComponent(path.split("/").at(-1)!)}`;
}

/** Opens one file at a Git revision in the read-only revision editor. */
export function openRevisionFile(repo: string, revision: string, path: string, external = false) {
  if (useVcs.getState().root) {
    void editorService().openFile(gitRevisionUri(repo, revision, path), { focus: true });
  } else
    void editorService().openInput({
      kind: "git-revision",
      key: `git-revision:${repo}\0${revision}\0${path}`,
      data: { repo, revision, path, external } satisfies RevisionData,
    });
}
