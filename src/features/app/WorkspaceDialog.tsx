import { useState } from "react";
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { basename, dirname, useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { tx } from "@/platform/i18n";
import { Button, Dialog, Icon, IconButton, Input, T } from "@/ui";
import { openProjectInWindow } from "./windows";
import styles from "./WorkspaceDialog.module.css";

const useWorkspaceDialog = create<{ mode: "create" | "manage" | null }>(() => ({ mode: null }));
export const showWorkspaceDialog = (mode: "create" | "manage") => useWorkspaceDialog.setState({ mode });

export function WorkspaceDialogHost() {
  const mode = useWorkspaceDialog((s) => s.mode);
  return mode ? <WorkspaceDialog mode={mode} onClose={() => useWorkspaceDialog.setState({ mode: null })} /> : null;
}

function WorkspaceDialog({ mode, onClose }: { mode: "create" | "manage"; onClose: () => void }) {
  const project = useProject.getState().project;
  const workspace = mode === "manage" ? project?.workspace : null;
  const [name, setName] = useState(workspace?.name ?? "Workspace");
  const [path, setPath] = useState(
    workspace ? project!.root : project && !isRemoteWindow() ? `${dirname(project.root)}/workspace` : "",
  );
  const [projects, setProjects] = useState<string[]>(
    workspace?.projects ?? (project && !isRemoteWindow() && !project.workspace ? [project.root] : []),
  );
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = (value: string) => {
    const path = value.trim();
    if (path && !projects.includes(path)) setProjects([...projects, path]);
    setAdding("");
  };
  const browse = async (target: "workspace" | "project") => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      directory: true,
      multiple: target === "project",
      title: tx(target === "project" ? "Add Projects" : "Workspace Location"),
    });
    const paths = result === null ? [] : Array.isArray(result) ? result : [result];
    if (target === "workspace" && paths[0]) setPath(paths[0]);
    else setProjects((current) => [...new Set([...current, ...paths])]);
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const included = adding.trim() ? [...new Set([...projects, adding.trim()])] : projects;
      if (mode === "create") {
        const root = await call(commands.workspaceCreate(path.trim(), name.trim(), included));
        await openProjectInWindow(root, !!project);
      } else {
        const updated = await call(commands.workspaceUpdate(name.trim(), included));
        useProject.setState({ project: updated, settings: updated.settings });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={mode === "create" ? "New Workspace" : "Manage Workspace"}
      width={640}
      buttons={[
        { label: "Cancel", role: "cancel", disabled: busy },
        {
          label: mode === "create" ? "Create" : "Apply",
          role: "default",
          disabled: busy || !name.trim() || !path.trim(),
          onClick: () => void save(),
        },
      ]}
    >
      <div className={styles.body}>
        <label className={styles.field}>
          <T>Name</T>
          <Input aria-label="Workspace name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={styles.field}>
          <T>Location</T>
          <div className={styles.row}>
            <Input
              aria-label="Workspace location"
              value={path}
              disabled={busy || mode === "manage"}
              onChange={(e) => setPath(e.target.value)}
            />
            {mode === "create" && (
              <IconButton
                icon="folder-open"
                title="Choose workspace location"
                onClick={() => void browse("workspace").catch((e) => setError(String(e)))}
              />
            )}
          </div>
        </label>
        <div className={styles.heading}>
          <T>Linked projects</T>
          <Button
            size="small"
            icon="plus"
            disabled={busy}
            onClick={() => void browse("project").catch((e) => setError(String(e)))}
          >
            Add Projects…
          </Button>
        </div>
        <div className={styles.projects} role="list" aria-label="Linked projects">
          {projects.map((root) => (
            <div className={styles.project} role="listitem" key={root}>
              <Icon name="folder" size={16} />
              <div className={styles.path}>
                <strong>{basename(root)}</strong>
                <span title={root}>{root}</span>
              </div>
              <IconButton
                icon="close"
                title={tx`Remove ${basename(root)}`}
                disabled={busy}
                onClick={() => setProjects(projects.filter((p) => p !== root))}
              />
            </div>
          ))}
          {!projects.length && (
            <p className={styles.hint}>
              <T>Add the projects you want to work on together.</T>
            </p>
          )}
        </div>
        <div className={styles.row}>
          <Input
            aria-label="Project folder path"
            placeholder="Project folder path"
            value={adding}
            disabled={busy}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                add(adding);
              }
            }}
          />
          <Button disabled={busy || !adding.trim()} onClick={() => add(adding)}>
            Add
          </Button>
        </div>
        <p className={styles.hint}>
          <T>Project folders stay in place. Removing a project here keeps its files.</T>
        </p>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
