/** Rich commit details popup shown when hovering Git blame gutter annotations. */
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import type { BlameLine, Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Popup } from "@/ui";
import { IssueText } from "./issueLinks";
import { formatTime } from "./model";
import { repoOf } from "./store";
import styles from "./BlamePopup.module.css";

interface BlamePopupState {
  view: EditorView;
  anchor: HTMLElement;
  line: BlameLine;
  path: string;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let currentState: BlamePopupState | null = null;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
const commitCache = new Map<string, Promise<Commit | null>>();

function loadCommit(repo: string | null, commitId: string): Promise<Commit | null> {
  const key = `${repo ?? ""}\0${commitId}`;
  let entry = commitCache.get(key);
  if (!entry) {
    entry = call(
      commands.vcsLog(repo, {
        branch: commitId,
        path: null,
        author: null,
        text: null,
        skip: 0,
        limit: 1,
      }),
    ).then(
      (commits) => commits[0] ?? null,
      () => null,
    );
    if (commitCache.size >= 200) commitCache.delete(commitCache.keys().next().value!);
    commitCache.set(key, entry);
  }
  return entry;
}

function render(state: BlamePopupState | null) {
  currentState = state;
  if (!state && !root) return;
  if (!root) {
    host = document.createElement("div");
    host.dataset.vcsBlamePopup = "";
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root.render(state ? <BlamePopupView key={state.line.commit} state={state} /> : null);
}

export function cancelBlamePopupTimers() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
}

export function closeBlamePopup(forView?: EditorView) {
  if (forView && currentState && currentState.view !== forView) return;
  cancelBlamePopupTimers();
  render(null);
}

export function scheduleOpenBlamePopup(state: BlamePopupState, delay = 250) {
  clearTimeout(closeTimer);
  if (currentState?.line.commit === state.line.commit && currentState.anchor === state.anchor) return;
  clearTimeout(openTimer);
  if (currentState) {
    render(state);
    return;
  }
  openTimer = setTimeout(() => {
    if (state.anchor.isConnected) render(state);
  }, delay);
}

export function scheduleCloseBlamePopup(delay = 150) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => render(null), delay);
}

const COMMIT_HASH_RE = /\b(?=[a-fA-F0-9]*[a-fA-F])(?=[a-fA-F0-9]*\d)([a-fA-F0-9]{7,64})\b/g;

function BlameMessageText({ text }: { text: string }) {
  return text.split(COMMIT_HASH_RE).map((part, i) =>
    i % 2 ? (
      <button
        type="button"
        className={styles.hashLink}
        key={i}
        onClick={() => {
          closeBlamePopup();
          void executeAction("vcs.showCommit", part);
        }}
      >
        {part}
      </button>
    ) : (
      <IssueText key={i} text={part} />
    ),
  );
}

function BlamePopupView({ state }: { state: BlamePopupState }) {
  const { line, path, anchor } = state;
  const repo = repoOf(path);
  const [commit, setCommit] = useState<Commit | null>(null);

  useEffect(() => {
    let alive = true;
    void loadCommit(repo, line.commit).then((loaded) => {
      if (alive) setCommit(loaded);
    });
    return () => {
      alive = false;
    };
  }, [repo, line.commit]);

  const author = commit?.author || line.author;
  const email = commit?.email || "";
  const timeMs = commit?.timeMs ?? line.timeMs;
  const rawMessage = (commit?.message || line.summary).replace(/\s+$/, "");
  const [subject, ...bodyLines] = rawMessage.split("\n");
  const body = bodyLines.join("\n").replace(/^\n+/, "");

  return (
    <Popup
      open
      anchor={anchor}
      placement="right-start"
      offset={6}
      role="dialog"
      autoFocus={false}
      restoreFocus={false}
      onClose={() => closeBlamePopup()}
      className={styles.popup}
    >
      <div onPointerEnter={cancelBlamePopupTimers} onPointerLeave={() => scheduleCloseBlamePopup()}>
        <div className={styles.header}>
          <div>
            commit{" "}
            <button
              type="button"
              className={styles.hashLink}
              title={tx("Show Commit in Git Log")}
              onClick={() => {
                closeBlamePopup();
                void executeAction("vcs.showCommit", line.commit);
              }}
            >
              {line.commit}
            </button>
          </div>
          <div>
            {tx("Author")}: {author}
            {email ? ` <${email}>` : ""}
          </div>
          {timeMs ? (
            <div>
              {tx("Date")}: {formatTime(timeMs)}
            </div>
          ) : null}
        </div>
        {subject && (
          <div className={styles.subject}>
            <BlameMessageText text={subject} />
          </div>
        )}
        {body && (
          <div className={styles.body}>
            <BlameMessageText text={body} />
          </div>
        )}
      </div>
    </Popup>
  );
}
