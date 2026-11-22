/** The npm tool window: the project's packages and their scripts; activating a script runs it. */
import { useMemo, useState, type ReactNode } from "react";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { Icon, Tree, showContextMenu, type MenuItem, type TreeRowState } from "@/ui";
import { runScriptNode, useNpmScripts, type NpmNode } from "./npmScripts";
import { scriptMenuItems } from "./npmGutter";
import { call, commands } from "@/platform/ipc";
import styles from "./Run.module.css";

function scriptMenuItemsFor(node: NpmNode): Promise<MenuItem[]> {
  if (node.kind !== "script") return Promise.resolve([]);
  return call(commands.fsReadText(node.path))
    .catch(() => "")
    .then((content) => scriptMenuItems({ name: node.name, line: 0 }, node.path, content ?? ""));
}

export function NpmScriptsView() {
  const packages = useNpmScripts((s) => s.packages);
  const loaded = useNpmScripts((s) => s.loaded);
  const hasProject = useProject((s) => !!s.project);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const roots = useMemo(() => packages, [packages]);
  const expanded = useMemo(
    () => new Set(roots.filter((n) => n.kind === "package" && !collapsed.has(n.key)).map((n) => n.key)),
    [roots, collapsed],
  );

  if (!loaded || !hasProject || roots.length === 0) return null;

  const renderNode = (n: NpmNode, state: TreeRowState): ReactNode => {
    if (n.kind === "package") {
      return (
        <span className={styles.scriptsRow} title={n.label}>
          <Icon name="file-npm" size={16} />
          <span className={state.selected ? styles.scriptsStrong : undefined}>{n.label}</span>
          <span className={styles.scriptsMeta}>{n.scripts.length}</span>
        </span>
      );
    }
    return (
      <span className={styles.scriptsRow} title={n.name}>
        <Icon name="runnable-mark" size={14} />
        <span>{n.name}</span>
      </span>
    );
  };

  return (
    <Tree<NpmNode>
      aria-label={tx`npm scripts`}
      roots={roots}
      getKey={(n) => n.key}
      getLabel={(n) => (n.kind === "package" ? n.label : n.name)}
      getChildren={(n) => (n.kind === "package" ? n.scripts : undefined)}
      isExpandable={(n) => n.kind === "package"}
      expanded={expanded}
      onExpandedChange={(_next, node, isOpen) =>
        setCollapsed((prev) => {
          const s = new Set(prev);
          if (isOpen) s.delete(node.key);
          else s.add(node.key);
          return s;
        })
      }
      onActivate={(n) => {
        if (n.kind === "script") void runScriptNode(n, false);
      }}
      onContextMenu={(n, _sel, e) => {
        if (n?.kind !== "script") return;
        void scriptMenuItemsFor(n).then((items) => showContextMenu({ clientX: e.clientX, clientY: e.clientY }, items));
      }}
      renderNode={renderNode}
    />
  );
}
