/** Remote Host tool window: the files of a deployment server, lazily listed over SFTP. */
import { useEffect, useMemo, useState } from "react";
import { executeAction } from "@/platform/actions";
import type { RemoteEntry } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import {
  Button,
  EmptyState,
  IconButton,
  Select,
  Spinner,
  T,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import { resolveServer, serverLabel } from "./model";
import {
  copyRemotePath,
  deleteEntries,
  downloadToProject,
  ensureRoot,
  loadFolder,
  newFolder,
  openRemote,
  refreshAll,
  renameEntry,
} from "./remoteHost";
import { EMPTY_TREE, patchTree, useDeployment } from "./store";
import styles from "./Deployment.module.css";

function useCurrentServer() {
  const settings = useWorkflowSettings((s) => s.deployment);
  const chosen = useDeployment((s) => s.remoteServer);
  const server =
    settings.servers.find((s) => s.id === chosen) ?? resolveServer(settings, null) ?? settings.servers[0] ?? null;
  return { servers: settings.servers, server };
}

export function RemoteHostView() {
  const tx = useTx();
  const { servers, server } = useCurrentServer();
  const tree = useDeployment((s) => (server ? s.trees[server.id] : undefined)) ?? EMPTY_TREE;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (server) void ensureRoot(server);
  }, [server]);

  const byPath = useMemo(() => {
    const map = new Map<string, RemoteEntry>();
    for (const list of Object.values(tree.listings)) for (const e of list) map.set(e.path, e);
    return map;
  }, [tree.listings]);

  if (!servers.length || !server)
    return (
      <div className={styles.view}>
        <EmptyState title="No deployment servers">
          <Button variant="ghost" onClick={() => void executeAction("deployment.configure")}>
            <T>Configure…</T>
          </Button>
        </EmptyState>
      </div>
    );

  const roots = tree.root ? tree.listings[tree.root] : undefined;

  const menuFor = (node: RemoteEntry | null, selection: Set<string>): MenuItem[] => {
    const picked = [...selection].map((p) => byPath.get(p)).filter((e): e is RemoteEntry => !!e);
    const entries = node && !selection.has(node.path) ? [node] : picked;
    const single = entries.length === 1 ? entries[0]! : null;
    const folder = single?.isDir ? single.path : single ? null : tree.root;
    return [
      {
        id: "open",
        label: "Open",
        icon: "edit",
        disabled: !single || single.isDir,
        run: () => single && void openRemote(server, single),
      },
      {
        id: "download",
        label: "Download to Project",
        disabled: !entries.length,
        run: () => void downloadToProject(server, entries),
      },
      { kind: "separator" },
      {
        id: "newFolder",
        label: "New Folder…",
        icon: "folder",
        disabled: !folder,
        run: () => folder && void newFolder(server, folder),
      },
      { id: "rename", label: "Rename…", disabled: !single, run: () => single && void renameEntry(server, single) },
      {
        id: "delete",
        label: "Delete…",
        icon: "trash",
        danger: true,
        disabled: !entries.length,
        run: () => void deleteEntries(server, entries),
      },
      { kind: "separator" },
      {
        id: "refresh",
        label: "Refresh",
        icon: "refresh",
        run: () => void (single?.isDir ? loadFolder(server, single.path) : refreshAll(server)),
      },
      {
        id: "copyPath",
        label: "Copy Path",
        icon: "copy",
        disabled: !single,
        run: () => single && copyRemotePath(single),
      },
    ];
  };

  return (
    <div className={styles.view}>
      <div className={styles.toolbar} role="toolbar" aria-label="Remote host actions">
        <Select
          className={styles.serverSelect}
          aria-label="Deployment server"
          value={server.id}
          options={servers.map((s) => ({ value: s.id, label: serverLabel(s) }))}
          onChange={(id) => useDeployment.setState({ remoteServer: id })}
        />
        <IconButton icon="refresh" size="small" title="Refresh" onClick={() => void refreshAll(server)} />
        <IconButton
          icon="collapse-all"
          size="small"
          title="Collapse All"
          onClick={() => patchTree(server.id, { expanded: new Set() })}
        />
        <IconButton
          icon="settings"
          size="small"
          title="Deployment Configuration…"
          onClick={() => void executeAction("deployment.configure")}
        />
      </div>
      {tree.root && (
        <div className={styles.rootPath} title={tree.root}>
          {tree.root}
        </div>
      )}
      {tree.error ? (
        <div className={styles.viewError}>
          <span className={styles.error}>{tree.error}</span>
          <Button size="small" onClick={() => void ensureRoot(server, true)}>
            <T>Retry</T>
          </Button>
        </div>
      ) : !roots ? (
        <div className={styles.center}>
          <Spinner /> <T>Connecting…</T>
        </div>
      ) : (
        <div className={styles.treeHost}>
          <Tree<RemoteEntry>
            aria-label={tx("Remote files")}
            roots={roots}
            getKey={(e) => e.path}
            getLabel={(e) => e.name}
            getChildren={(e) => tree.listings[e.path]}
            isExpandable={(e) => e.isDir}
            loadChildren={(e) => loadFolder(server, e.path)}
            getIcon={(e) => (e.isDir ? "folder" : fileIconName(e.name))}
            getDetail={(e) => tree.folderErrors[e.path]}
            expanded={tree.expanded}
            onExpandedChange={(expanded) => patchTree(server.id, { expanded })}
            selected={selected}
            onSelectionChange={(s) => setSelected(s)}
            multiSelect
            speedSearch
            onActivate={(e) => !e.isDir && void openRemote(server, e)}
            onContextMenu={(node, selection, e) => showContextMenu(e, menuFor(node, selection))}
            empty={<T>Empty folder</T>}
          />
        </div>
      )}
    </div>
  );
}
