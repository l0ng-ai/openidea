import { useEffect, useMemo, useRef, useState } from "react";
import type { PatchFileDiff, PatchPathMapping } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, registerKeyClaim, shortcutLabel } from "@/platform/keymap";
import { IconButton, Spinner, T } from "@/ui";
import { DiffEditor } from "./DiffEditor";
import { displayPath } from "./compareData";
import { DiffDialogFrame, showFront } from "./diffDialog";
import { diffInput, withChain, type DiffData, type DiffSide } from "./diffInput";
import { errorMessage } from "./ops";
import { compareThreeTexts, ThreePaneDiff } from "./ThreePaneDiff";
import styles from "./ApplyPatch.module.css";

export interface PatchDiffRequest {
  repo: string | null;
  base: string | null;
  patch: string;
  mappings: PatchPathMapping[] | null;
  paths: string[];
  path: string;
}

export function showPatchDiff(request: PatchDiffRequest) {
  const index = request.paths.indexOf(request.path);
  if (index >= 0) showFront((onClose) => <PatchDiffDialog request={request} index={index} onClose={onClose} />);
}

function PatchDiffDialog({
  request,
  index: first,
  onClose,
}: {
  request: PatchDiffRequest;
  index: number;
  onClose: () => void;
}) {
  const t = useTx();
  const [index, setIndex] = useState(first);
  const file = request.paths[index]!;
  const root = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ file: string; diff?: PatchFileDiff; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      await Promise.resolve();
      if (!active) return;
      const diff = await call(
        commands.vcsPatchFileDiff(request.repo, request.base, request.patch, file, request.mappings),
      );
      if (active) setResult({ file, diff });
    };
    void load().catch((error) => active && setResult({ file, error: errorMessage(error) }));
    return () => {
      active = false;
    };
  }, [request, file]);

  const current = result?.file === file ? result : null;
  const diff = current?.diff;
  const currentIsText = diff?.content.kind === "text";
  const previous = index > 0;
  const next = index < request.paths.length - 1;
  useEffect(
    () =>
      registerKeyClaim((event, stroke) => {
        if (currentIsText || !(event.target instanceof Node) || !root.current?.contains(event.target)) return false;
        const matches = (action: string) => bindingsFor(action).some((binding) => normalizeBinding(binding) === stroke);
        if (previous && matches("diff.prevFile")) setIndex(index - 1);
        else if (next && matches("diff.nextFile")) setIndex(index + 1);
        else return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }),
    [currentIsText, index, next, previous],
  );

  const remapped =
    diff &&
    request.mappings?.some((mapping) => mapping.path === file && (mapping.file || mapping.directory || mapping.strip));
  const title = t`Patch Diff: ${remapped ? displayPath(diff.path) : file}`;
  return (
    <DiffDialogFrame title={title} onClose={onClose}>
      <div ref={root} className={styles.patchDiff}>
        {request.paths.length > 1 && !currentIsText && (
          <div className={styles.patchDiffNav}>
            <IconButton
              icon="arrow-left"
              title="Compare Previous File"
              shortcut={shortcutLabel("diff.prevFile")}
              size="small"
              disabled={!previous}
              onClick={() => setIndex(index - 1)}
            />
            <IconButton
              icon="arrow-right"
              title="Compare Next File"
              shortcut={shortcutLabel("diff.nextFile")}
              size="small"
              disabled={!next}
              onClick={() => setIndex(index + 1)}
            />
          </div>
        )}
        {diff ? (
          <PatchDiffContent diff={diff} paths={request.paths} index={index} onIndex={setIndex} />
        ) : current?.error ? (
          <div className={styles.error} role="alert">
            {current.error}
          </div>
        ) : (
          <div className={styles.diffEmpty}>
            <Spinner size={18} />
          </div>
        )}
      </div>
    </DiffDialogFrame>
  );
}

const textSide = (text: string | null, label: string, labelDetail?: string): DiffSide => ({
  type: "text",
  text: text ?? "",
  absent: text === null,
  label,
  labelDetail,
});

function PatchDiffContent({
  diff,
  paths,
  index,
  onIndex,
}: {
  diff: PatchFileDiff;
  paths: string[];
  index: number;
  onIndex: (index: number) => void;
}) {
  const t = useTx();
  const content = diff.content;
  const local = t("Local Version");
  const base = t("Base");
  const patched = t("Patched Version");
  const labels = useMemo(() => [local, base, patched] as const, [local, base, patched]);
  const model = useMemo(
    () => (content.kind === "conflict" ? compareThreeTexts([content.local, content.base, content.patched]) : null),
    [content],
  );
  if (content.kind === "binary")
    return (
      <div className={styles.diffEmpty}>
        <T>Binary content</T>
      </div>
    );
  if (content.kind === "conflict") return <ThreePaneDiff path={diff.path} labels={labels} model={model} />;
  if (content.kind === "raw") {
    return (
      <>
        {!content.applies && (
          <div className={styles.error} role="status">
            <T>The patch does not match the local file.</T>
          </div>
        )}
        <div className={styles.rawPatch}>
          {content.local !== null && (
            <section>
              <h2>{local}</h2>
              <pre tabIndex={0}>{content.local}</pre>
            </section>
          )}
          <section>
            <h2>
              <T>Patch</T>
            </h2>
            <pre tabIndex={0}>{content.patch}</pre>
          </section>
        </div>
      </>
    );
  }
  // The diff viewer only needs the neighbours' identities. Their contents load on navigation.
  const entries = paths.map((path, i): DiffData => ({
    path: i === index ? diff.path : path,
    left: textSide(i === index ? content.before : null, local, diff.oldPath ?? undefined),
    right: textSide(i === index ? content.after : null, patched, diff.oldPath ? diff.path : undefined),
    context: { kind: "vcs.patch", path },
  }));
  const input = diffInput({ ...withChain(entries, index), embedded: true });
  return (
    <DiffEditor
      key={input.key}
      input={input}
      skipUnchangedFiles={false}
      onNeighbour={(neighbour) => {
        const next = paths.findIndex((path) => path === neighbour.context?.path);
        if (next >= 0) onIndex(next);
      }}
    />
  );
}
