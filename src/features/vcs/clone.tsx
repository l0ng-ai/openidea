/** Get from VCS: clone a repository into a new folder and open it as a project. */
import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tx } from "@/platform/i18n";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { openProject } from "@/platform/project";
import { Button, Dialog, Input, ProgressBar, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { openDialog } from "./dialogs";
import { progressFraction } from "./model";
import styles from "./common.module.css";

const PARENT_KEY = "openidea.vcs.cloneParent";

/** Folder name git would pick for `url` (`https://h/o/repo.git` → `repo`, `git@h:o/r` → `r`). */
export function cloneDirName(url: string): string {
  let u = url.trim().replace(/[?#].*$/, "");
  u = u
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/i, "")
    .replace(/[/\\]+$/, "");
  const name =
    u
      .split(/[/\\:]/)
      .filter(Boolean)
      .pop() ?? "";
  return name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "");
}

/** Joins a parent directory and a child name with one separator. */
export function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  return name ? `${parent.replace(/[/\\]+$/, "")}/${name}` : parent;
}

/** Validates the clone form; null when it can be submitted. */
export function validateClone(url: string, dir: string): string | null {
  const u = url.trim();
  if (!u) return "Enter a repository URL";
  if (/\s/.test(u)) return "The URL must not contain spaces";
  if (u.startsWith("-")) return "Invalid repository URL";
  if (!dir.trim()) return "Choose a directory";
  if (!dir.trim().startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(dir.trim()))
    return "The directory must be an absolute path";
  return null;
}

function readParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeParent(path: string) {
  try {
    localStorage.setItem(PARENT_KEY, path);
  } catch {
    // remembering the folder is a convenience only
  }
}

const parentOf = (p: string) => p.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]*$/, "");

async function defaultParent(): Promise<string> {
  const saved = readParent();
  if (saved) return saved;
  try {
    const recent = await commands.recentProjects();
    if (recent[0]?.path) return parentOf(recent[0].path);
  } catch {
    // no recents
  }
  return "";
}

export function showCloneDialog(initialUrl = "") {
  if (!isTauri()) {
    notifications().notify({ group: "vcs", level: "warning", title: "Cloning requires the desktop app" });
    return;
  }
  openDialog((close) => <CloneDialog onClose={close} initialUrl={initialUrl} />);
}

function CloneDialog({ onClose, initialUrl }: { onClose: () => void; initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [parent, setParent] = useState("");
  /** Directory edited by hand: stop deriving it from the URL. */
  const [customDir, setCustomDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ line: string; fraction: number | null }>({ line: "", fraction: null });
  const [error, setError] = useState<string | null>(null);
  const request = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void defaultParent().then((p) => alive && setParent((cur) => cur || p));
    return () => {
      alive = false;
    };
  }, []);

  const dir = customDir ?? joinPath(parent, cloneDirName(url));
  const invalid = validateClone(url, dir);

  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Directory to Clone Into",
      defaultPath: parent || undefined,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    setParent(path);
    setCustomDir(null);
  };

  const cancel = () => {
    if (request.current !== null) void commands.cancelRequest(request.current);
    else onClose();
  };

  const clone = async () => {
    if (invalid || busy) return;
    const target = dir.trim();
    setBusy(true);
    setError(null);
    const id = nextRequestId();
    request.current = id;
    const channel = new Channel<string>();
    channel.onmessage = (line) => {
      const text = line.trim();
      if (text) setProgress({ line: text, fraction: progressFraction(text) });
    };
    try {
      await call(commands.vcsClone(id, url.trim(), target, channel));
      writeParent(parentOf(target));
      onClose();
      try {
        await openProject(target);
      } catch (e) {
        notifications().notify({
          group: "vcs",
          level: "error",
          title: "Cloned, but the project could not be opened",
          body: e instanceof Error ? e.message : String(e),
        });
      }
    } catch (e) {
      if (isCancelled(e)) setError("Clone cancelled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      request.current = null;
      setBusy(false);
      setProgress({ line: "", fraction: null });
    }
  };

  return (
    <Dialog
      open
      title="Get from Version Control"
      onClose={cancel}
      width={560}
      buttons={[
        { label: "Clone", role: "default", disabled: !!invalid || busy, onClick: () => void clone() },
        { label: "Cancel", role: "cancel", onClick: cancel },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void clone();
        }}
      >
        <label className={styles.fieldLabel} htmlFor="vcs-clone-url">
          <T>URL:</T>
        </label>
        <Input
          id="vcs-clone-url"
          data-autofocus
          mono
          value={url}
          disabled={busy}
          placeholder="https://github.com/user/repository.git"
          onChange={(e) => setUrl(e.target.value)}
        />
        <label className={styles.fieldLabel} htmlFor="vcs-clone-dir">
          <T>Directory:</T>
        </label>
        <div className={styles.cloneDirRow}>
          <Input
            id="vcs-clone-dir"
            className={styles.cloneDirInput}
            mono
            value={dir}
            disabled={busy}
            onChange={(e) => setCustomDir(e.target.value)}
          />
          <Button disabled={busy} onClick={() => void browse()}>
            <T>Browse…</T>
          </Button>
        </div>
        {busy && (
          <div className={styles.cloneProgress} aria-live="polite">
            <ProgressBar value={progress.fraction} aria-label="Clone progress" />
            <span className={styles.hint}>{progress.line || tx("Cloning…")}</span>
          </div>
        )}
        {error && <div className={styles.error}>{error}</div>}
        {!busy && !error && url.trim() && invalid && <div className={styles.hint}>{invalid}</div>}
      </form>
    </Dialog>
  );
}
