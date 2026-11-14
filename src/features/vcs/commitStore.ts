/** Commit tool window state shared with actions (selection, message draft). */
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import type { Commit } from "@/bindings";
import type { CheckState } from "./changes";
import type { CommitProblem } from "./commitChecks";
import { currentRepo, useVcs } from "./store";

interface CommitState {
  message: string;
  amend: boolean;
  signOff: boolean;
  /** Commit Options › Author (`Name <mail>`); blank uses the configured user. */
  author: string;
  /** Commit Options › Run Git hooks. */
  runHooks: boolean;
  groupByDir: boolean;
  /** Group the changes into Staged / Unstaged instead of one "Changes" group. */
  groupByStaging: boolean;
  /** Whether the Git window's Local Changes tab previews the selection's diff. */
  diffPreview: boolean;
  /** Whether the Commit tool window previews the selection's diff beside the changes (#1599). */
  commitDiffPreview: boolean;
  /** User overrides of the inclusion checkboxes (absolute path → state). */
  checks: Map<string, CheckState>;
  /** Changed blocks left out of the commit (absolute path → `hunkKeys`) of `hunks` files. */
  excludedHunks: Map<string, Set<string>>;
  /** Absolute paths selected in the changes tree. */
  selection: string[];
  /** Keys of the selected tree nodes: which staging side of a partially staged file. */
  selectionKeys: string[];
  /** Bumped to focus the message field. */
  focusTick: number;
  /** Bumped to open the commit message history popup. */
  historyTick: number;
  /** Failed before-commit checks; while any are shown, Commit means "Commit Anyway". */
  checkProblems: CommitProblem[];
  tab: CommitTab;
  /** Change list of the selected tree node (list actions without an argument). */
  selectedList: string | null;
  /** Selected shelf tree key: shelf id, optionally followed by NUL and a file path. */
  selectedShelf: string | null;
  /** Commit a Fixup… / Squash Into… message was prepared for: offers Commit and Rebase. */
  fixupTarget: Commit | null;
}

export type CommitTab = "changes" | "shelf" | "stashes";

export const useCommit = create<CommitState>(() => ({
  message: "",
  amend: false,
  signOff: false,
  author: "",
  runHooks: true,
  groupByDir: readBool("openidea.vcs.groupByDir", false),
  groupByStaging: readBool("openidea.vcs.groupByStaging", false),
  diffPreview: readBool("openidea.vcs.diffPreview", true),
  commitDiffPreview: readBool("openidea.vcs.commitDiffPreview", false),
  checks: new Map(),
  excludedHunks: new Map(),
  selection: [],
  selectionKeys: [],
  focusTick: 0,
  historyTick: 0,
  checkProblems: [],
  tab: "changes",
  selectedList: null,
  selectedShelf: null,
  fixupTarget: null,
}));

/** The Fixup… / Squash Into… target while the message still is the one prepared for it. */
export function pendingFixup(message: string, target: Commit | null): Commit | null {
  if (!target) return null;
  return message.startsWith(`fixup! ${target.summary}`) || message.startsWith(`squash! ${target.summary}`)
    ? target
    : null;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}

export function setGroupByDir(v: boolean) {
  useCommit.setState({ groupByDir: v });
  try {
    localStorage.setItem("openidea.vcs.groupByDir", String(v));
  } catch {
    // ignore
  }
}

export function setGroupByStaging(v: boolean) {
  useCommit.setState({ groupByStaging: v });
  try {
    localStorage.setItem("openidea.vcs.groupByStaging", String(v));
  } catch {
    // ignore
  }
}

export function setDiffPreview(v: boolean) {
  useCommit.setState({ diffPreview: v });
  try {
    localStorage.setItem("openidea.vcs.diffPreview", String(v));
  } catch {
    // ignore
  }
}

export function setCommitDiffPreview(v: boolean) {
  useCommit.setState({ commitDiffPreview: v });
  try {
    localStorage.setItem("openidea.vcs.commitDiffPreview", String(v));
  } catch {
    // ignore
  }
}

const historyKey = () => `openidea.vcs.commitMessages:${useVcs.getState().root ?? ""}`;
const MAX_HISTORY = 20;

export function messageHistory(): string[] {
  try {
    const raw = localStorage.getItem(historyKey());
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberMessage(message: string) {
  const m = message.trim();
  if (!m) return;
  try {
    const list = [m, ...messageHistory().filter((x) => x !== m)].slice(0, MAX_HISTORY);
    localStorage.setItem(historyKey(), JSON.stringify(list));
  } catch {
    // ignore
  }
}

/** The message typed before Amend replaced it, and the amended commit's message. */
let amendData: { before: string; amend: string } | null = null;

/**
 * Amend checkbox, as in IDEA: checking it replaces the message
 * with the last commit's (the draft is kept in the message history and restored when
 * Amend is unchecked again, unless the amend message was edited meanwhile).
 */
export async function setAmend(on: boolean) {
  useCommit.setState({ amend: on });
  if (!on) {
    const data = amendData;
    amendData = null;
    if (data && useCommit.getState().message === data.amend) useCommit.setState({ message: data.before });
    return;
  }
  let last: string | undefined;
  try {
    const [head] = await call(
      commands.vcsLog(currentRepo(), {
        branch: "HEAD",
        path: null,
        author: null,
        text: null,
        range: null,
        skip: 0,
        limit: 1,
      }),
    );
    last = head?.message.replace(/\s+$/, "");
  } catch {
    // No commits yet.
  }
  const before = useCommit.getState().message;
  if (!last || !useCommit.getState().amend || before.trim() === last.trim()) return;
  rememberMessage(before);
  amendData = { before, amend: last };
  useCommit.setState((s) => ({ message: last, focusTick: s.focusTick + 1 }));
}

/** After a commit: nothing to restore. */
export function forgetAmendDraft() {
  amendData = null;
}

/** The message a commit left in the field (not typed since). */
let keptMessage: string | null = null;

/**
 * The message field after a commit, as IDEA's: the committed message stays for the
 * next commit unless Settings › Version Control › Commit › "Clear initial commit
 * message" is on.
 */
export function messageAfterCommit(committed: string, clear: boolean): string {
  return clear ? "" : committed.trim();
}

export function keepMessageAfterCommit(committed: string, clear: boolean) {
  const message = messageAfterCommit(committed, clear);
  keptMessage = message || null;
  useCommit.setState({ message });
  if (!message) void loadTemplate();
}

/** The field holds nothing the user typed: empty, or what the last commit left there. */
function messageReplaceable(): boolean {
  const m = useCommit.getState().message.trim();
  return !m || m === keptMessage;
}

/** Operations whose commit message git prepares in `.git/MERGE_MSG`. */
const PREPARED_MESSAGE_OPS = new Set(["merge", "cherry-pick", "revert"]);

/** `MERGE_MSG` without git's `#` comment lines (the conflict list etc.). */
export function preparedMessageText(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}

/** `commit.template` resolved as git does: `~/` in the home directory, a relative path in the repository. */
export function templatePath(value: string, root: string, home: string): string {
  if (value === "~" || value.startsWith("~/")) return home.replace(/[/\\]$/, "") + value.slice(1);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return value;
  return `${root}/${value}`;
}

/** Fills an empty message field with the repository's commit template (`commit.template`), without its `#` lines. */
async function loadTemplate() {
  const root = useVcs.getState().root;
  if (!root || useCommit.getState().message.trim()) return;
  try {
    const value = await call(commands.vcsConfigGet(root, "commit.template"));
    if (!value) return;
    const home = value.startsWith("~") ? await (await import("@tauri-apps/api/path")).homeDir() : "";
    const text = preparedMessageText(await call(commands.fsReadText(templatePath(value, root, home))));
    if (!text || useVcs.getState().root !== root || useCommit.getState().message.trim()) return;
    // Not typed: a prepared merge message may replace it.
    keptMessage = text;
    useCommit.setState({ message: text });
  } catch {
    // No readable template: the field stays empty.
  }
}

/**
 * Like IDEA, pre-fills the commit message (unless something was typed) with the
 * message git prepared for a merge / cherry-pick / revert that stopped (e.g. on conflicts),
 * otherwise with the commit template.
 */
export function installPreparedMessage(): () => void {
  const load = async () => {
    const root = useVcs.getState().root;
    if (!root || !messageReplaceable()) return;
    try {
      const text = preparedMessageText(await call(commands.fsReadText(`${root}/.git/MERGE_MSG`)));
      if (text && messageReplaceable()) useCommit.setState({ message: text });
    } catch {
      // No prepared message (or `.git` is a worktree file): leave the field empty.
    }
  };
  const op = (s = useVcs.getState()) => s.branch?.operation ?? null;
  if (PREPARED_MESSAGE_OPS.has(op() ?? "")) void load();
  else void loadTemplate();
  return useVcs.subscribe((s, prev) => {
    if (s.root !== prev.root) {
      // Another repository: nothing typed or ticked for the previous one carries over (Amend least of all).
      amendData = null;
      keptMessage = null;
      useCommit.setState({
        message: "",
        amend: false,
        checks: new Map(),
        excludedHunks: new Map(),
        selection: [],
        selectionKeys: [],
        tab: "changes",
        selectedList: null,
        selectedShelf: null,
      });
      if (PREPARED_MESSAGE_OPS.has(op(s) ?? "")) void load();
      else void loadTemplate();
      return;
    }
    const now = op(s);
    if (now !== op(prev) && PREPARED_MESSAGE_OPS.has(now ?? "")) void load();
  });
}
