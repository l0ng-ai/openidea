import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { call, commands, isCancelled, nextRequestId, type ProjectDiscovery, type RequestId } from "@/platform/ipc";
import { invokeLocal } from "@/platform/tauriCore";
import { confirmProjectTrust } from "@/platform/projectTrust";
import { basename, dirname, useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { tx } from "@/platform/i18n";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, T } from "@/ui";
import { openProjectWithPolicy } from "./windows";
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
  const [scanning, setScanning] = useState(false);
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<RequestId | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (request.current !== null) {
        // Discovery and its native folder picker stay local in remote windows too.
        void invokeLocal("cancel_request", { id: request.current }).catch(() => {});
        request.current = null;
      }
    };
  }, []);
  const disabled = busy || scanning;
  const add = (value: string) => {
    const path = value.trim();
    if (path && !projects.includes(path)) setProjects([...projects, path]);
    setAdding("");
  };
  const browse = async (target: "workspace" | "project") => {
    const { open } = await import("@/platform/dialog");
    const result = await open({
      directory: true,
      multiple: target === "project",
      title: tx(target === "project" ? "Add Projects" : "Workspace Location"),
    });
    const paths = result === null ? [] : Array.isArray(result) ? result : [result];
    if (!mounted.current || !paths.length) return;
    if (target === "workspace") {
      setPath(paths[0]);
      return;
    }
    const id = nextRequestId();
    request.current = id;
    setScanning(true);
    setError("");
    setTruncated(false);
    try {
      const found = await call(commands.workspaceDiscoverProjects(id, paths));
      if (request.current !== id) return;
      setProjects((current) => [...new Set([...current, ...found.direct])]);
      setTruncated(found.truncated);
      if (found.projects.length) {
        setDiscovery(found);
        setSelected(
          new Set(found.projects.map((p) => p.path).filter((p) => !projects.includes(p) && !found.direct.includes(p))),
        );
      }
    } catch (e) {
      if (request.current === id && !isCancelled(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request.current === id) {
        request.current = null;
        setScanning(false);
      }
    }
  };
  const save = async () => {
    if (disabled || discovery) return;
    setBusy(true);
    setError("");
    try {
      const included = adding.trim() ? [...new Set([...projects, adding.trim()])] : projects;
      if (mode === "create") {
        const root = await call(commands.workspaceCreate(path.trim(), name.trim(), included));
        await openProjectWithPolicy(root);
      } else {
        for (const path of included.filter((p) => !workspace?.projects.includes(p))) {
          await confirmProjectTrust(path);
          if (!(await call(commands.projectTrustStatus(path))).trusted) {
            setError(
              tx`Cannot attach ${path} because it is restricted. Open it separately and choose Trust Project, then attach it again.`,
            );
            return;
          }
        }
        const updated = await call(commands.workspaceUpdate(name.trim(), included));
        useProject.setState({ project: updated, settings: updated.settings });
      }
      onClose();
    } catch (e) {
      if (!isCancelled(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (discovery)
    return (
      <Dialog
        open
        onClose={onClose}
        title="Choose Projects"
        width={640}
        buttons={[
          { label: "Back", role: "cancel", onClick: () => setDiscovery(null) },
          {
            label: "Add Selected",
            role: "default",
            disabled: !selected.size,
            onClick: () => {
              setProjects((current) => [...new Set([...current, ...selected])]);
              setDiscovery(null);
            },
          },
        ]}
      >
        <div className={styles.body}>
          <div className={styles.heading}>
            <T>Projects found</T>
            <div className={styles.row}>
              <Button
                size="small"
                onClick={() =>
                  setSelected(new Set(discovery.projects.map((p) => p.path).filter((p) => !projects.includes(p))))
                }
              >
                Select All
              </Button>
              <Button size="small" onClick={() => setSelected(new Set())}>
                Select None
              </Button>
            </div>
          </div>
          <p className={styles.hint}>
            <T>Choose the projects to link to this workspace.</T>
          </p>
          <div className={styles.projects} role="group" aria-label={tx("Projects found")}>
            {discovery.projects.map((candidate) => {
              const linked = projects.includes(candidate.path);
              return (
                <div className={styles.project} key={candidate.path}>
                  <Checkbox
                    checked={selected.has(candidate.path)}
                    disabled={linked}
                    aria-label={candidate.relative_path}
                    label={
                      <span className={styles.candidate} title={candidate.path}>
                        <span>{candidate.relative_path}</span>
                        <span className={styles.hint}>{linked ? <T>Already linked</T> : basename(candidate.root)}</span>
                      </span>
                    }
                    onChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(candidate.path);
                        else next.delete(candidate.path);
                        return next;
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
          {truncated && (
            <p className={styles.hint} role="status">
              <T>
                Search stopped at the entry limit. More projects may exist; choose a smaller folder to search again.
              </T>
            </p>
          )}
        </div>
      </Dialog>
    );
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
          disabled: disabled || !name.trim() || !path.trim(),
          onClick: () => void save(),
        },
      ]}
    >
      <div className={styles.body}>
        <label className={styles.field}>
          <T>Name</T>
          <Input
            aria-label="Workspace name"
            value={name}
            disabled={disabled}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <T>Location</T>
          <div className={styles.row}>
            <Input
              aria-label="Workspace location"
              value={path}
              disabled={disabled || mode === "manage"}
              onChange={(e) => setPath(e.target.value)}
            />
            {mode === "create" && (
              <IconButton
                icon="folder-open"
                title="Choose workspace location"
                disabled={disabled}
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
            disabled={disabled}
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
                disabled={disabled}
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
            disabled={disabled}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                add(adding);
              }
            }}
          />
          <Button disabled={disabled || !adding.trim()} onClick={() => add(adding)}>
            Add
          </Button>
        </div>
        <p className={styles.hint}>
          <T>Project folders stay in place. Removing a project here keeps its files.</T>
        </p>
        {scanning && (
          <p className={styles.hint} role="status">
            <T>Searching for projects…</T>
          </p>
        )}
        {truncated && (
          <p className={styles.hint} role="status">
            <T>Search stopped at the entry limit. More projects may exist; choose a smaller folder to search again.</T>
          </p>
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
