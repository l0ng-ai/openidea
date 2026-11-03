/**
 * File › New Project…: a language (or an empty folder), optionally a Git
 * repository, opened in a new window (this one when it has no project).
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { Checkbox, Dialog, Icon, IconButton, Input, T } from "@/ui";
import { groupedProjectKinds, projectKind, projectKindIcon, projectKindLabel } from "./newProjectLanguages";
import { defaultFieldValues, projectFieldWarning, projectFields, starterChoices } from "./newProjectOptions";
import { ProjectOptions } from "./newProjectForm";
import { starterFiles } from "./newProjectTemplates";
import { defaultProjectDirectory, openProjectInWindow } from "./windows";
import styles from "./app.module.css";

const useNewProject = create<{ open: boolean; kindId: string | null }>(() => ({ open: false, kindId: null }));
export const showNewProject = (kindId?: string) => useNewProject.setState({ open: true, kindId: kindId ?? null });

export function NewProjectOverlay() {
  const open = useNewProject((s) => s.open);
  const kindId = useNewProject((s) => s.kindId);
  return open ? (
    <NewProjectDialog kindId={kindId} onClose={() => useNewProject.setState({ open: false, kindId: null })} />
  ) : null;
}

/** Why `name` cannot be a project folder name, or null. */
export function projectNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a project name";
  if (/[/\\:*?"<>|]/.test(n) || n === "." || n === "..")
    return "The name contains characters a folder name cannot have";
  return null;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name.trim()}` : `${dir}${sep}${name.trim()}`;
}

/** Joins a project root and a template path (`src/main.rs`). */
export function joinRelative(root: string, relative: string): string {
  return relative.split("/").reduce((dir, part) => joinPath(dir, part), root);
}

/** Splits a full project path into its parent directory and folder name. */
export function splitProjectPath(full: string): { parent: string; name: string } {
  const trimmed = full.trim().replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return { parent: "", name: trimmed };
  return { parent: trimmed.slice(0, index), name: trimmed.slice(index + 1) };
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Creates `path` (or reuses it when it is an empty folder) and runs `git init` when asked. */
export async function createProjectFolder(path: string, gitInit: boolean): Promise<void> {
  let entries: unknown[] | null;
  try {
    entries = await call(commands.fsReadDir(path));
  } catch {
    entries = null;
  }
  if (entries && entries.length) throw new Error(`${path} already exists and is not empty`);
  if (!entries) await call(commands.fsCreateDir(path));
  if (gitInit) await call(commands.vcsInit(path));
}

/** Default Project Directory, else the parent of the open project. */
function initialLocation(): string {
  const preset = defaultProjectDirectory();
  if (preset) return preset;
  const root = useProject.getState().project?.root;
  return root ? root.slice(0, Math.max(root.lastIndexOf("/"), 1)) : "";
}

function NewProjectDialog({ kindId, onClose }: { kindId: string | null; onClose: () => void }) {
  const initialParent = initialLocation();
  const [selected, setSelected] = useState(() => projectKind(kindId).id);
  const [location, setLocation] = useState(initialParent ? joinPath(initialParent, "untitled") : "");
  const [git, setGit] = useState(true);
  const [fields, setFields] = useState<Record<string, string | boolean>>(() =>
    defaultFieldValues(projectKind(kindId).id),
  );
  const [requestedKind, setRequestedKind] = useState(kindId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tx = useTx();
  const txTemplate = useTxTemplate();
  if (kindId && kindId !== requestedKind) {
    const next = projectKind(kindId).id;
    setRequestedKind(kindId);
    setSelected(next);
    setFields(defaultFieldValues(next));
  }
  const kind = projectKind(selected);
  const hasOptions = projectFields(kind.id).length > 0;

  useEffect(() => {
    document.getElementById(`new-project-kind-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (location) return;
    // Otherwise the user's home, with the PhpStorm default folder name.
    void import("@tauri-apps/api/path")
      .then((p) => p.homeDir())
      .then((home) => setLocation((current) => current || joinPath(home, "untitled")))
      .catch(() => {});
  }, [location]);

  const projectName = splitProjectPath(location).name;
  const nameError = projectNameError(projectName);
  const fieldWarning = projectFieldWarning(kind.id, fields);
  const path = location.trim().replace(/[\\/]+$/, "");
  const invalid = !!nameError || !path || !!fieldWarning;

  const browse = async () => {
    if (!isTauri()) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Project Location",
      defaultPath: location || undefined,
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (dir) setLocation(dir);
  };

  const browseInto = async (id: string) => {
    if (!isTauri()) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "Project Location" });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (dir) setFields((current) => ({ ...current, [id]: dir }));
  };

  const showsGit = !hasOptions || projectFields(kind.id).some((field) => field.type === "git");

  const create = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createProjectFolder(path, false);
      for (const starter of starterFiles(kind.id, projectName, starterChoices(kind.id, fields))) {
        const data = Array.from(new TextEncoder().encode(starter.contents));
        await call(commands.fsCreateFileBytes(joinRelative(path, starter.path), data));
      }
      if (showsGit && git) await call(commands.vcsInit(path));
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
      return;
    }
    onClose();
    await openProjectInWindow(path, useProject.getState().project !== null);
  };

  return (
    <Dialog
      open
      title="New Project"
      onClose={onClose}
      width={980}
      buttons={[
        { label: "Create", role: "default", disabled: invalid || busy, onClick: () => void create() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.wizard}>
        <div
          className={styles.kindPane}
          role="listbox"
          aria-label="New Project"
          aria-activedescendant={`new-project-kind-${selected}`}
        >
          {groupedProjectKinds().map((group) => (
            <div key={group.name} className={styles.kindGroup}>
              {group.name !== "General" && <div className={styles.kindHeading}>{tx(group.name)}</div>}
              {group.kinds.map((item) => (
                <button
                  key={item.id}
                  id={`new-project-kind-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={item.id === selected}
                  className={clsx(styles.kindRow, item.id === selected && styles.kindRowSelected)}
                  onClick={() => {
                    setSelected(item.id);
                    setFields(defaultFieldValues(item.id));
                    setGit(true);
                  }}
                >
                  <span className={styles.kindIcon}>
                    <Icon name={projectKindIcon(item)} size={16} />
                  </span>
                  <span className={styles.kindName}>{tx(projectKindLabel(item))}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <form
          className={styles.kindDetail}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h2 className={styles.kindTitle}>{hasOptions ? <T>New Project</T> : tx(projectKindLabel(kind))}</h2>
          {!hasOptions && (
            <p className={styles.kindBlurb}>
              {kind.id === "empty" ? (
                <T>Creates an empty folder.</T>
              ) : (
                <T>Creates a standard starter for this language.</T>
              )}
            </p>
          )}
          <div className={styles.formRow}>
            <span className={styles.formLabel}>
              <T>Location:</T>
            </span>
            <Input
              data-autofocus
              value={location}
              invalid={!!nameError}
              onChange={(e) => setLocation(e.target.value)}
              aria-label="Location"
            />
            <IconButton icon="folder" title="Browse…" disabled={!isTauri()} onClick={() => void browse()} />
          </div>
          {!hasOptions && <Checkbox checked={git} onChange={setGit} label="Create Git repository" />}
          <ProjectOptions
            kindId={kind.id}
            values={fields}
            onChange={(id, value) => setFields((current) => ({ ...current, [id]: value }))}
            git={git}
            onGit={setGit}
            browseDisabled={!isTauri()}
            onBrowse={(id) => void browseInto(id)}
          />
          {nameError && <div className={styles.newProjectHint}>{txTemplate(nameError)}</div>}
          {fieldWarning && (
            <div className={styles.optionWarn}>
              <Icon name="warning" size={16} />
              <span>{tx(fieldWarning)}</span>
            </div>
          )}
          {error && <div className={styles.newProjectError}>{txTemplate(error)}</div>}
        </form>
      </div>
    </Dialog>
  );
}
