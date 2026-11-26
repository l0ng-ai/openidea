import { useId, useState } from "react";
import { Button, Checkbox, Dialog, Icon, Popup, T, Tree, fileIconName } from "@/ui";
import { projectFs } from "@/features/project-tree/fs";
import { openDialog } from "./dialogs";
import { dirName, relTo, stripSlash } from "./model";
import { repoName, repoOf } from "./store";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { formatBinding, hasPrimaryModifier, isMacHost } from "@/platform/keymap";
import { ipcPath, isSameOrInside } from "@/platform/paths";
import styles from "./PathFilterDialog.module.css";

interface PathNode {
  path: string;
  name: string;
  directory: boolean;
}

export function chooseLogPaths(roots: string[], initial: string[], readOnly = false): Promise<string[] | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <PathFilterDialog
        roots={roots}
        initial={initial}
        readOnly={readOnly}
        onDone={(value) => {
          close();
          resolve(value);
        }}
      />
    ));
  });
}

function commonRoot(roots: string[]): string | undefined {
  let base = roots[0];
  while (base && !roots.every((root) => isSameOrInside(root, base!))) {
    const parent = dirName(base);
    base = parent || (base.startsWith("/") && base !== "/" ? "/" : undefined);
  }
  return base;
}

export function LogPathsEditor({
  anchor,
  roots,
  initial,
  onDone,
}: {
  anchor: HTMLElement;
  roots: string[];
  initial: string[];
  onDone: (value: string[] | null) => void;
}) {
  const [base] = useState(() => commonRoot(roots));
  const [text, setText] = useState(() =>
    initial.map((path) => (base ? (path === base ? "." : relTo(stripSlash(base), path)) : path)).join("\n"),
  );
  const [error, setError] = useState(false);
  const hint = useId();
  const shortcut = formatBinding(isMacHost() ? "Meta+Enter" : "Ctrl+Enter");
  const apply = () => {
    const paths = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const path = ipcPath(line);
        return !base || path.startsWith("/") || /^[A-Za-z]:\//.test(path)
          ? path
          : path === "."
            ? base
            : `${stripSlash(base)}/${path.replace(/^\.\//, "")}`;
      })
      .map(stripSlash);
    if (paths.some((path) => path.split(/[\\/]/).includes("..") || !roots.some((root) => isSameOrInside(path, root)))) {
      setError(true);
      return;
    }
    onDone([...new Set(paths)]);
  };
  return (
    <Popup
      open
      anchor={anchor}
      aria-label={tx("Filter by Paths")}
      className={styles.editor}
      initialSize={{ w: 432, h: 200 }}
      resizable="both"
      minWidth={200}
      minHeight={110}
      trapFocus
      onClose={() => onDone(null)}
    >
      <textarea
        data-autofocus
        className={styles.pathInput}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(false);
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            !hasPrimaryModifier(event) ||
            event.shiftKey ||
            event.altKey ||
            isImeKey(event.nativeEvent)
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          apply();
        }}
        aria-label={tx("Paths")}
        aria-describedby={hint}
        aria-invalid={error || undefined}
      />
      {error && (
        <div className={styles.editorError} role="alert">
          <T>Choose a path inside a repository.</T>
        </div>
      )}
      <div className={styles.editorFooter}>
        <span id={hint}>
          <T>One path per line</T>
        </span>
        <span className={styles.apply}>
          <kbd>{shortcut}</kbd>
          <Button onClick={apply} size="small" variant="primary">
            OK
          </Button>
        </span>
      </div>
    </Popup>
  );
}

function PathFilterDialog({
  roots,
  initial,
  readOnly,
  onDone,
}: {
  roots: string[];
  initial: string[];
  readOnly: boolean;
  onDone: (value: string[] | null) => void;
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initial));
  const [listings, setListings] = useState<Map<string, PathNode[]>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const toggle = (path: string, on: boolean) =>
    setChecked((before) => {
      const next = new Set(before);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const nodes = roots.map((path) => ({ path, name: repoName(path), directory: true }));
  const load = async (node: PathNode) => {
    try {
      const root = roots.includes(node.path) ? node.path : repoOf(node.path, roots);
      if (!root) return;
      let entries: PathNode[];
      if (readOnly) {
        const files = await call(commands.vcsRevisionFiles(root, "HEAD"));
        const prefix = node.path === root ? "" : `${node.path.slice(root.length + 1)}/`;
        const children = new Map<string, PathNode>();
        for (const file of files)
          if (file.startsWith(prefix)) {
            const [name, ...rest] = file.slice(prefix.length).split("/");
            if (name) children.set(name, { name, path: `${node.path}/${name}`, directory: rest.length > 0 });
          }
        entries = [...children.values()].sort(
          (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
        );
      } else
        entries = (await projectFs(root).readDir(node.path))
          .filter((entry) => entry.name !== ".git")
          .map((entry) => ({ name: entry.name, path: entry.path, directory: entry.kind === "dir" }));
      setListings((before) => new Map(before).set(node.path, entries));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Dialog
      open
      title="Filter by Paths"
      className={styles.chooser}
      width={432}
      initialSize={{ w: 432, h: 392 }}
      resizable="both"
      minWidth={300}
      minHeight={220}
      onClose={() => onDone(null)}
      buttons={[
        { label: "OK", role: "default", onClick: () => onDone([...checked]) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.content}>
        <Tree<PathNode>
          className={styles.tree}
          roots={nodes}
          getKey={(n) => n.path}
          getLabel={(n) => n.name}
          getChildren={(n) => (n.directory ? listings.get(n.path) : undefined)}
          isExpandable={(n) => n.directory}
          loadChildren={load}
          renderNode={(n) => (
            <Checkbox
              className={styles.choice}
              label={
                <span className={styles.entry}>
                  <Icon name={n.directory ? "folder" : fileIconName(n.name, n.path)} size={16} />
                  <span className={styles.path} title={n.name}>
                    {n.name}
                  </span>
                </span>
              }
              checked={checked.has(n.path)}
              onChange={(on) => toggle(n.path, on)}
            />
          )}
          aria-label="Files and folders"
        />
        {checked.size > 0 && (
          <div className={styles.selected} role="group" aria-label={tx("Selected paths")}>
            {[...checked].map((path) => {
              const root = roots.includes(path) ? path : repoOf(path, roots);
              const label = root ? (path === root ? repoName(root) : `${repoName(root)}/${relTo(root, path)}`) : path;
              return (
                <Checkbox
                  key={path}
                  className={styles.choice}
                  label={
                    <span className={styles.path} title={label}>
                      {label}
                    </span>
                  }
                  checked
                  onChange={(on) => toggle(path, on)}
                />
              );
            })}
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
