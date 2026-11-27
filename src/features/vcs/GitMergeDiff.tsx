import { useEffect, useMemo, useState } from "react";
import type { EditorInput } from "@/workbench/contributions";
import { readDiffSide } from "./diffInput";
import { repositoryPath } from "./repositoryPaths";
import { compareThreeTexts, ThreePaneDiff, type ThreePanes } from "./ThreePaneDiff";

/** Read-only parent / merge result / parent comparison, independent of the worktree. */
export function GitMergeDiff({ input }: { input: EditorInput }) {
  const data = input.data as {
    repo: string;
    revision: string;
    path: string;
    parents: Array<{ rev: string; path: string }>;
  };
  const path = repositoryPath(data.repo, data.path);
  const sides = useMemo(
    () => [data.parents[0]!, { rev: data.revision, path: data.path }, data.parents[1]!] as const,
    [data],
  );
  const labels = useMemo(() => {
    const title = (side: (typeof sides)[number]) => `${side.rev.slice(0, 8)} · ${side.path}`;
    return [title(sides[0]), title(sides[1]), title(sides[2])] satisfies ThreePanes<string>;
  }, [sides]);
  const [model, setModel] = useState<ReturnType<typeof compareThreeTexts> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (side: (typeof sides)[number]) =>
      readDiffSide(path, { type: "rev", rev: side.rev, path: repositoryPath(data.repo, side.path) });
    void Promise.all([load(sides[0]), load(sides[1]), load(sides[2])])
      .then((texts) => {
        if (!alive) return;
        setError(null);
        setModel(compareThreeTexts(texts));
      })
      .catch((failure) => alive && setError(String(failure)));
    return () => {
      alive = false;
    };
  }, [data.repo, path, sides]);
  return (
    <>
      {error && <div role="alert">{error}</div>}
      <ThreePaneDiff path={path} labels={labels} model={model} />
    </>
  );
}
