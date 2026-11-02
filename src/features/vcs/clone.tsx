/** Get from VCS: clone a repository into a new folder and open it as a project. */
import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { tx } from "@/platform/i18n";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { openProject } from "@/platform/project";
import { Checkbox, Dialog, Icon, IconButton, Input, ProgressBar, Select, T, showContextMenu } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { openDialog } from "./dialogs";
import { progressFraction } from "./model";
import logo from "../../../src-tauri/icons/128x128.png";
import styles from "./clone.module.css";

const PARENT_KEY = "openidea.vcs.cloneParent";
const RECENT_URLS_KEY = "openidea.vcs.cloneRecentUrls";
const MAX_RECENT_URLS = 10;

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

/** A valid `git clone --depth` value, or null while the field is invalid. */
export function parseCloneDepth(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const depth = Number(text);
  return Number.isSafeInteger(depth) && depth > 0 && depth <= 4_294_967_295 ? depth : null;
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

function readRecentUrls(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_URLS_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT_URLS)
      : [];
  } catch {
    return [];
  }
}

function rememberUrl(url: string) {
  try {
    const urls = [url, ...readRecentUrls().filter((item) => item !== url)].slice(0, MAX_RECENT_URLS);
    localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(urls));
  } catch {
    // URL history is a convenience only
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
  const [shallow, setShallow] = useState(false);
  const [depthInput, setDepthInput] = useState("1");
  const [progress, setProgress] = useState<{ line: string; fraction: number | null }>({ line: "", fraction: null });
  const [error, setError] = useState<string | null>(null);
  const request = useRef<number | null>(null);
  const urlField = useRef<HTMLDivElement>(null);
  const [recentUrls] = useState(readRecentUrls);

  useEffect(() => {
    let alive = true;
    void defaultParent().then((p) => alive && setParent((cur) => cur || p));
    return () => {
      alive = false;
    };
  }, []);

  const dir = customDir ?? joinPath(parent, cloneDirName(url));
  const depth = shallow ? parseCloneDepth(depthInput) : null;
  const invalid = validateClone(url, dir) ?? (shallow && depth === null ? "Enter a positive number of commits" : null);

  const showUrlHistory = () => {
    const rect = urlField.current?.getBoundingClientRect();
    if (!rect || !recentUrls.length) return;
    showContextMenu(
      { x: rect.left, y: rect.bottom },
      recentUrls.map((item) => ({ label: item, verbatim: true, run: () => setUrl(item) })),
    );
  };

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
      await call(commands.vcsClone(id, url.trim(), target, depth, channel));
      writeParent(parentOf(target));
      rememberUrl(url.trim());
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
      title={
        <span className={styles.dialogTitle}>
          <img src={logo} alt="" draggable={false} />
          <T>Clone Repository</T>
        </span>
      }
      aria-label="Clone Repository"
      onClose={cancel}
      width="min(920px, calc(100vw - 48px))"
      resizable="both"
      className={styles.dialog}
      buttons={[
        { label: "Clone", role: "default", disabled: !!invalid || busy, onClick: () => void clone() },
        { label: "Cancel", role: "cancel", onClick: cancel },
      ]}
    >
      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label={tx("Clone source")}>
          <div className={styles.sourceItem} data-selected="">
            <Icon name="branch" size={22} />
            <span className={styles.sourceName}>
              <T>Repository URL</T>
            </span>
          </div>
        </aside>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void clone();
          }}
        >
          <div className={styles.versionRow}>
            <label id="vcs-clone-version-label">
              <T>Version control:</T>
            </label>
            <Select
              aria-label="Version control"
              className={styles.versionSelect}
              value="git"
              options={[{ value: "git", label: "Git" }]}
              onChange={() => {}}
              disabled={busy}
            />
          </div>

          <div className={styles.fieldRow}>
            <label htmlFor="vcs-clone-url">
              <T>URL:</T>
            </label>
            <div ref={urlField} className={styles.comboField}>
              <Input
                id="vcs-clone-url"
                data-autofocus
                variant="bare"
                className={styles.fieldInput}
                value={url}
                disabled={busy}
                placeholder="https://github.com/user/repository.git"
                onChange={(e) => setUrl(e.target.value)}
              />
              <IconButton
                icon="chevron-down"
                size="normal"
                className={styles.fieldButton}
                title={recentUrls.length ? "Recent repository URLs" : "No recent repository URLs"}
                disabled={busy || !recentUrls.length}
                onClick={showUrlHistory}
              />
            </div>
          </div>

          <div className={styles.fieldRow}>
            <label htmlFor="vcs-clone-dir">
              <T>Directory:</T>
            </label>
            <div className={styles.comboField}>
              <Input
                id="vcs-clone-dir"
                variant="bare"
                className={styles.fieldInput}
                value={dir}
                disabled={busy}
                onChange={(e) => setCustomDir(e.target.value)}
              />
              <IconButton
                icon="folder-open"
                size="normal"
                className={styles.fieldButton}
                title="Browse…"
                disabled={busy}
                onClick={() => void browse()}
              />
            </div>
          </div>

          <div className={styles.shallowRow}>
            <Checkbox
              checked={shallow}
              disabled={busy}
              onChange={setShallow}
              label={<T>Shallow clone with a history truncated to</T>}
            />
            <Input
              aria-label="Clone depth"
              className={styles.depthInput}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={depthInput}
              disabled={busy || !shallow}
              invalid={shallow && depth === null}
              onChange={(e) => setDepthInput(e.target.value)}
            />
            <T>commits</T>
          </div>

          <div className={styles.feedback}>
            {busy && (
              <div className={styles.progress} aria-live="polite">
                <ProgressBar value={progress.fraction} aria-label="Clone progress" />
                <span className={styles.hint}>{progress.line || tx("Cloning…")}</span>
              </div>
            )}
            {error && <div className={styles.error}>{error}</div>}
            {!busy && !error && url.trim() && invalid && (
              <div className={styles.hint}>
                <T>{invalid}</T>
              </div>
            )}
          </div>
        </form>
      </div>
    </Dialog>
  );
}
