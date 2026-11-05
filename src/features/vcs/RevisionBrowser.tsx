import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Commit } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";
import {
  Dialog,
  EmptyState,
  IconButton,
  SearchField,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tree,
  T,
  copyText,
  showContextMenu,
} from "@/ui";
import { openDialog } from "./dialogs";

import { commitRepo, type RepoCommit } from "./multiRoot";
import { currentRepoRoot, useVcs } from "./store";
import { repositoryPath } from "./repositoryPaths";
import { languageFor, viewerBase } from "./cm";
import styles from "./GitLog.module.css";
import { choosePath } from "@/features/settings/languages/api";
import { openLogTab } from "./logStore";

interface RevisionData {
  repo: string;
  revision: string;
  path: string;
  external?: boolean;
}

export async function openExternalLog() {
  const picked = isTauri()
    ? await (
        await import("@tauri-apps/plugin-dialog")
      ).open({ title: tx("Open Git Log"), directory: true, multiple: true })
    : await choosePath({ title: "Open Git Log", directory: true });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (!paths.length) return;
  try {
    const roots = await Promise.all(paths.map((path) => call(commands.vcsOpenExternalLog(path))));
    openLogTab("external", roots.join(", "), "editor", roots);
  } catch (error) {
    notifications().notify({ group: "vcs", level: "error", title: "Could not open Git log", body: String(error) });
  }
}

export function browseRepositoryAt(commit: Commit) {
  const repo = commitRepo(commit) ?? currentRepoRoot();
  if (!repo) return;
  openDialog((close) => (
    <RevisionBrowser repo={repo} revision={commit.id} external={(commit as RepoCommit).readOnly} onClose={close} />
  ));
}

function RevisionBrowser({
  repo,
  revision,
  external,
  onClose,
}: {
  repo: string;
  revision: string;
  external?: boolean;
  onClose: () => void;
}) {
  const [directories, setDirectories] = useState<Record<string, string[]>>({});
  const files = directories[""] ?? null;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchFiles, setSearchFiles] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void call(commands.vcsRevisionChildren(repo, revision, ""))
      .then((files) => {
        if (alive) setDirectories({ "": files });
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [repo, revision]);
  useEffect(() => {
    if (!query || searchFiles) return;
    let alive = true;
    const timer = setTimeout(
      () =>
        void call(commands.vcsRevisionFiles(repo, revision))
          .then((files) => {
            if (alive) setSearchFiles(files);
          })
          .catch((error) => {
            if (alive) setError(String(error));
          }),
      250,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, searchFiles, repo, revision]);
  const tree = useMemo(
    () =>
      (query ? (searchFiles ?? []) : (files ?? [])).filter(
        (path) => !query || path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ),
    [files, query, searchFiles],
  );
  const load = async (path: string) => {
    const children = await call(commands.vcsRevisionChildren(repo, revision, path.replace(/\/$/, "")));
    setDirectories((current) => ({ ...current, [path]: children }));
  };
  const open = (path: string) => {
    if (useVcs.getState().root) {
      const bytes = new TextEncoder().encode(JSON.stringify({ repo, revision, path }));
      const encoded = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      void editorService().openFile(`git-revision:${encoded}/${encodeURIComponent(path.split("/").at(-1)!)}`, {
        focus: true,
      });
    } else
      void editorService().openInput({
        kind: "git-revision",
        key: `git-revision:${repo}\0${revision}\0${path}`,
        data: { repo, revision, path, external } satisfies RevisionData,
      });
  };
  return (
    <Dialog open title={tx`Repository at ${revision.slice(0, 8)}`} onClose={onClose} width={1000}>
      <div style={{ height: "min(70vh, 640px)", display: "flex", flexDirection: "column" }}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search repository files"
          aria-label="Search repository files"
        />
        {error ? (
          <div role="alert">{error}</div>
        ) : !files ? (
          <Spinner />
        ) : (
          <SplitGroup orientation="horizontal" id="git-revision-browser">
            <SplitPanel id="files" defaultSize="30%" minSize="20%">
              <Tree
                roots={tree}
                getKey={(n) => n}
                getLabel={(n) => n.replace(/\/$/, "").split("/").at(-1)!}
                getChildren={(n) => directories[n]}
                isExpandable={(n) => n.endsWith("/")}
                loadChildren={load}
                onSelectionChange={(_, n) => {
                  if (n && !n.endsWith("/")) setSelected(n);
                }}
                onActivate={(n) => {
                  if (!n.endsWith("/")) open(n);
                }}
                onContextMenu={(node, _selection, e) => {
                  if (!node) return;
                  e.preventDefault();
                  showContextMenu(e, [
                    { label: "Open Revision in Editor", disabled: node.endsWith("/"), run: () => open(node) },
                    { label: "Copy Path", run: () => copyText(node) },
                    {
                      label: "Show History",
                      run: () => openLogTab("history", repositoryPath(repo, node.replace(/\/$/, "")), "editor"),
                    },
                  ]);
                }}
                aria-label="Repository files"
              />
            </SplitPanel>
            <SplitHandle />
            <SplitPanel id="source" minSize="30%">
              {selected ? (
                <div className={styles.filesPane}>
                  <div className={styles.detailsBar}>
                    {selected}
                    <IconButton icon="external-link" title="Open Revision in Editor" onClick={() => open(selected)} />
                  </div>
                  <RevisionSource key={selected} repo={repo} revision={revision} path={selected} />
                </div>
              ) : (
                <EmptyState>
                  <T>Select a file to view its repository version</T>
                </EmptyState>
              )}
            </SplitPanel>
          </SplitGroup>
        )}
      </div>
    </Dialog>
  );
}

export function GitRevisionEditor({ input }: { input: EditorInput }) {
  return <RevisionSource {...(input.data as RevisionData)} />;
}

function RevisionSource({ repo, revision, path, external }: RevisionData) {
  const host = useRef<HTMLDivElement>(null);
  const key = `${repo}\0${revision}\0${path}`;
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let view: EditorView | null = null;
    const absolute = repositoryPath(repo, path);
    const content = async () => {
      if (external) await call(commands.vcsOpenExternalLog(repo));
      return call(commands.vcsFileAt(absolute, revision));
    };
    void Promise.all([content(), languageFor(path)])
      .then(([text, language]) => {
        if (!alive || !host.current) return;
        view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text ?? "",
            extensions: [viewerBase({ readOnly: true }), ...(language ? [language] : [])],
          }),
        });
      })
      .catch((error) => {
        if (alive) setError({ key, message: String(error) });
      });
    return () => {
      alive = false;
      view?.destroy();
    };
  }, [repo, revision, path, external, key]);
  return (
    <div className={styles.revisionSource}>
      {error?.key === key && <div role="alert">{error.message}</div>}
      <div className={styles.revisionSource} ref={host} />
    </div>
  );
}
