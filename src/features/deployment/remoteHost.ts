/** Remote Host tool window operations: list, open, create, rename, delete and download remote files. */
import { txTemplate } from "@/platform/i18n";
import { call, commands, type RemoteEntry } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { DeploymentServerValid } from "@/platform/remoteSettings";
import { copyText } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { promptInput } from "@/workbench/inputDialogs";
import { confirm } from "@/workbench/messages";
import { downloadPaths } from "./actions";
import { joinRemote, localPathForRemote, remoteName, remoteParent } from "./model";
import { withSsh } from "./ssh";
import { EMPTY_TREE, patchTree, useDeployment } from "./store";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const tree = (server: string) => useDeployment.getState().trees[server] ?? EMPTY_TREE;

function sortEntries(entries: RemoteEntry[]): RemoteEntry[] {
  return [...entries].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

function fail(title: string, e: unknown) {
  notifications().notify({ level: "error", title, body: errorText(e), group: "tools", key: "deployment.remoteHost" });
}

export async function loadFolder(server: DeploymentServerValid, path: string) {
  try {
    const entries = await withSsh(server.sshConfig, () => call(commands.remoteList(server.sshConfig, path)));
    patchTree(server.id, (t) => {
      const folderErrors = { ...t.folderErrors };
      delete folderErrors[path];
      return { listings: { ...t.listings, [path]: sortEntries(entries) }, folderErrors };
    });
  } catch (e) {
    patchTree(server.id, (t) =>
      path === t.root ? { error: errorText(e) } : { folderErrors: { ...t.folderErrors, [path]: errorText(e) } },
    );
  }
}

/** Resolves the server root once per session and lists it. */
export async function ensureRoot(server: DeploymentServerValid, force = false) {
  const current = tree(server.id);
  if (current.root && !force && current.listings[current.root]) return;
  patchTree(server.id, { error: null });
  try {
    const root =
      current.root && !force
        ? current.root
        : await withSsh(server.sshConfig, () => call(commands.deployServerRoot(server.id)));
    patchTree(server.id, { root });
    await loadFolder(server, root);
  } catch (e) {
    patchTree(server.id, { error: errorText(e) });
  }
}

/** Reloads the root and the expanded folders. */
export async function refreshAll(server: DeploymentServerValid) {
  const t = tree(server.id);
  if (!t.root) return ensureRoot(server, true);
  patchTree(server.id, { listings: {}, folderErrors: {}, error: null });
  await loadFolder(server, t.root);
  await Promise.all([...t.expanded].map((p) => loadFolder(server, p)));
}

export async function openRemote(server: DeploymentServerValid, entry: RemoteEntry) {
  try {
    const local = await withSsh(server.sshConfig, () => call(commands.remoteOpen(server.sshConfig, entry.path)));
    await editorService().openFile(local, { focus: true });
  } catch (e) {
    fail(`Cannot open ${entry.name}`, e);
  }
}

export async function newFolder(server: DeploymentServerValid, parent: string) {
  const name = await promptInput({
    title: "New Folder",
    label: "Name:",
    validate: (v) => (!v.trim() ? "Enter a name" : /\//.test(v) ? "A name cannot contain “/”" : null),
  });
  if (!name) return;
  try {
    await withSsh(server.sshConfig, () => call(commands.remoteMkdir(server.sshConfig, joinRemote(parent, name))));
    patchTree(server.id, (t) => ({ expanded: new Set([...t.expanded, parent]) }));
    await loadFolder(server, parent);
  } catch (e) {
    fail("Cannot create folder", e);
  }
}

export async function renameEntry(server: DeploymentServerValid, entry: RemoteEntry) {
  const name = await promptInput({
    title: "Rename",
    label: "New name:",
    initial: entry.name,
    validate: (v) => (!v.trim() ? "Enter a name" : /\//.test(v) ? "A name cannot contain “/”" : null),
  });
  if (!name || name === entry.name) return;
  const parent = remoteParent(entry.path);
  try {
    await withSsh(server.sshConfig, () =>
      call(commands.remoteRename(server.sshConfig, entry.path, joinRemote(parent, name))),
    );
    await loadFolder(server, parent);
  } catch (e) {
    fail(`Cannot rename ${entry.name}`, e);
  }
}

export async function deleteEntries(server: DeploymentServerValid, entries: RemoteEntry[]) {
  if (!entries.length) return;
  const ok = await confirm({
    title: "Delete",
    message: txTemplate(
      entries.length === 1
        ? entries[0]!.isDir
          ? `Delete folder “${entries[0]!.path}” from the server?`
          : `Delete file “${entries[0]!.path}” from the server?`
        : `Delete ${entries.length} items from the server?`,
    ),
    ok: "Delete",
    icon: "warning",
  });
  if (!ok) return;
  const parents = new Set<string>();
  for (const entry of entries) {
    try {
      await withSsh(server.sshConfig, () => call(commands.remoteDelete(server.sshConfig, entry.path)));
      parents.add(remoteParent(entry.path));
    } catch (e) {
      fail(`Cannot delete ${entry.name}`, e);
    }
  }
  await Promise.all([...parents].map((p) => loadFolder(server, p)));
}

/** Downloads mapped entries to their local paths; unmapped ones are reported. */
export async function downloadToProject(server: DeploymentServerValid, entries: RemoteEntry[]) {
  const projectRoot = useProject.getState().project?.root;
  const root = tree(server.id).root;
  if (!projectRoot || !root) return;
  const locals: string[] = [];
  const unmapped: string[] = [];
  for (const e of entries) {
    const local = localPathForRemote(e.path, root, server.mappings, projectRoot);
    if (local) locals.push(local);
    else unmapped.push(remoteName(e.path));
  }
  if (unmapped.length)
    notifications().notify({
      level: "warning",
      title: "Not mapped to a project path",
      body: unmapped.join(", "),
      group: "tools",
      key: "deployment.unmapped",
    });
  if (locals.length) await downloadPaths(server, locals);
}

export const copyRemotePath = (entry: RemoteEntry) => void copyText(entry.path);
