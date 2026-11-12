import { useState } from "react";
import { Checkbox, Dialog, Input, Tree } from "@/ui";
import { projectFs } from "@/features/project-tree/fs";
import { openDialog } from "./dialogs";
import { repoName } from "./store";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

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
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggle = (path: string, on: boolean) =>
    setChecked((before) => {
      const next = new Set(before);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const apply = () => {
    const added = custom
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      added.some(
        (path) =>
          !roots.some((root) => path === root || path.startsWith(`${root}/`)) || path.split(/[\\/]/).includes(".."),
      )
    ) {
      setError(tx("Choose an absolute path inside a selected repository."));
      return;
    }
    onDone([...new Set([...checked, ...added])]);
  };
  const nodes = roots.map((path) => ({ path, name: repoName(path), directory: true }));
  const load = async (node: PathNode) => {
    try {
      const root = roots.find((r) => node.path === r || node.path.startsWith(`${r}/`));
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
      width={560}
      onClose={() => onDone(null)}
      buttons={[
        { label: "OK", role: "default", onClick: apply },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div style={{ height: 320, display: "flex" }}>
        <Tree<PathNode>
          roots={nodes}
          getKey={(n) => n.path}
          getLabel={(n) => n.name}
          getChildren={(n) => (n.directory ? listings.get(n.path) : undefined)}
          isExpandable={(n) => n.directory}
          loadChildren={load}
          renderNode={(n) => (
            <Checkbox label={n.name} checked={checked.has(n.path)} onChange={(on) => toggle(n.path, on)} />
          )}
          aria-label="Files and folders"
        />
      </div>
      {checked.size > 0 && (
        <div style={{ maxHeight: 100, overflow: "auto" }} aria-label="Selected paths">
          {[...checked].map((path) => (
            <Checkbox key={path} label={path} checked onChange={(on) => toggle(path, on)} />
          ))}
        </div>
      )}
      <Input
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        placeholder="Additional absolute path"
        aria-label="Additional absolute path"
      />
      {error && <div role="alert">{error}</div>}
    </Dialog>
  );
}
