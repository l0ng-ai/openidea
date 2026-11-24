/** Commit tool window state shared with actions (selection, message draft). */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import type { ChangedFile, Commit, CommitMessages } from "@/bindings";
import type { CheckState } from "./changes";
import type { CommitCheckRun } from "./commitChecks";
import type { EarlierAmend } from "./amendTargets";
import {
  addAppliedCommitList,
  appliedCommitList,
  changelistForCommit,
  DEFAULT_LIST_ID,
  updateChangelists,
  useChangelists,
} from "./changelists";
import { gitPersonKey, readConfiguredGitIdentity } from "./gitIdentity";
import { stagingAreaOn } from "./staging";
import { currentRepo, useVcs } from "./store";

export type AmendPreview =
  | { root: string; status: "loading" }
  | {
      root: string;
      status: "ready";
      head: Commit;
      expectedHead: string;
      files: ChangedFile[];
      differentCommitter: boolean;
    };

interface CommitAuthorDetails {
  author: string;
  authorDate: string | null;
}

const DEFAULT_COMMIT_AUTHOR: CommitAuthorDetails = { author: "", authorDate: null };

interface CommitState extends CommitAuthorDetails {
  message: string;
  messageChangelist: string;
  amend: boolean;
  amendPreview: AmendPreview | null;
  amendTarget: EarlierAmend | null;
  signOff: boolean;
  /** Commit Options › Run Git hooks. */
  runHooks: boolean;
  groupByDir: boolean;
  /** Group the changes into Staged / Unstaged instead of one "Changes" group. */
  groupByStaging: boolean;
  /** With several repositories, a node per repository above their files. */
  groupByRepo: boolean;
  /** Keep untracked files in their own group instead of Changes / Unstaged Changes. */
  showUnversionedSeparately: boolean;
  /** Project-specific visibility of Git-ignored files in the staging tree. */
  ignoredVisibility: ReadonlyMap<string, boolean>;
  /** Whether the Git window's Local Changes tab previews the selection's diff. */
  diffPreview: boolean;
  /** Whether the Commit tool window previews the selection's diff beside the changes (#1599). */
  commitDiffPreview: boolean;
  /** User overrides of the inclusion checkboxes (absolute path → state). */
  checks: Map<string, CheckState>;
  /** Staged repositories the user unchecked for this commit. */
  excludedStagedRepos: ReadonlySet<string>;
  /** Changed blocks left out of the commit (absolute path → `hunkKeys`) of `hunks` files. */
  excludedHunks: Map<string, Set<string>>;
  /** Excluded offsets in partially included blocks (path, hunk key, side). */
  excludedHunkLines: Map<string, Map<string, ExcludedHunkLines>>;
  /** Absolute paths selected in the changes tree. */
  selection: string[];
  /** Keys of the selected tree nodes: which staging side of a partially staged file. */
  selectionKeys: string[];
  /** Selected unstaged files that can be restored from the index. */
  unstagedSelection: string[];
  /** Bumped to focus the message field. */
  focusTick: number;
  /** Bumped to open the commit message history popup. */
  historyTick: number;
  checkResult: (CommitCheckRun & { stale?: boolean }) | null;
  operation: "commit" | "check" | null;
  tab: CommitTab;
  /** Change list of the selected tree node (list actions without an argument). */
  selectedList: string | null;
  /** Selected shelf tree key: shelf id, optionally followed by NUL and a file path. */
  selectedShelf: string | null;
  /** Commit a Fixup… / Squash Into… message was prepared for: offers Commit and Rebase. */
  fixupTarget: Commit | null;
}

export type CommitTab = "changes" | "shelf" | "stashes";

export interface ExcludedHunkLines {
  old: ReadonlySet<number>;
  current: ReadonlySet<number>;
}

export const useCommit = create<CommitState>(() => ({
  message: "",
  messageChangelist: DEFAULT_LIST_ID,
  amend: false,
  amendPreview: null,
  amendTarget: null,
  signOff: false,
  ...DEFAULT_COMMIT_AUTHOR,
  runHooks: true,
  groupByDir: readBool("openidea.vcs.groupByDir", false),
  groupByStaging: readBool("openidea.vcs.groupByStaging", false),
  groupByRepo: readBool("openidea.vcs.groupByRepo", true),
  showUnversionedSeparately: readBool("openidea.vcs.showUnversionedSeparately", true),
  ignoredVisibility: new Map(),
  diffPreview: readBool("openidea.vcs.diffPreview", true),
  commitDiffPreview: readBool("openidea.vcs.commitDiffPreview", false),
  checks: new Map(),
  excludedStagedRepos: new Set(),
  excludedHunks: new Map(),
  excludedHunkLines: new Map(),
  selection: [],
  selectionKeys: [],
  unstagedSelection: [],
  focusTick: 0,
  historyTick: 0,
  checkResult: null,
  operation: null,
  tab: "changes",
  selectedList: null,
  selectedShelf: null,
  fixupTarget: null,
}));

/** Fields that can change the checks or what is about to be committed. */
export function sameCommitDraft(a: CommitState, b: CommitState): boolean {
  return (
    a.message === b.message &&
    a.messageChangelist === b.messageChangelist &&
    a.amend === b.amend &&
    a.amendPreview === b.amendPreview &&
    a.amendTarget === b.amendTarget &&
    a.checks === b.checks &&
    a.excludedStagedRepos === b.excludedStagedRepos &&
    a.groupByRepo === b.groupByRepo &&
    a.excludedHunks === b.excludedHunks &&
    a.excludedHunkLines === b.excludedHunkLines &&
    a.author === b.author &&
    a.authorDate === b.authorDate &&
    a.signOff === b.signOff &&
    a.runHooks === b.runHooks
  );
}

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

export function setGroupByRepo(v: boolean) {
  useCommit.setState({ groupByRepo: v });
  try {
    localStorage.setItem("openidea.vcs.groupByRepo", String(v));
  } catch {
    // ignore
  }
}

export function setShowUnversionedSeparately(v: boolean) {
  useCommit.setState({ showUnversionedSeparately: v });
  try {
    localStorage.setItem("openidea.vcs.showUnversionedSeparately", String(v));
  } catch {
    // ignore
  }
}

const ignoredFilesKey = (root: string) => `openidea.vcs.showIgnoredFiles:${root}`;

export function showsIgnoredFiles(root: string, visibility = useCommit.getState().ignoredVisibility): boolean {
  return visibility.get(root) ?? readBool(ignoredFilesKey(root), false);
}

export function toggleIgnoredFiles(root: string) {
  const value = !showsIgnoredFiles(root);
  useCommit.setState((s) => ({ ignoredVisibility: new Map(s.ignoredVisibility).set(root, value) }));
  try {
    localStorage.setItem(ignoredFilesKey(root), String(value));
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

const historyKey = (root = useVcs.getState().root) => `openidea.vcs.commitMessages:${root ?? ""}`;
const MAX_HISTORY = 20;

export function messageHistory(root = useVcs.getState().root): string[] {
  try {
    const raw = localStorage.getItem(historyKey(root));
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberMessage(message: string, root = useVcs.getState().root) {
  const m = message.trim();
  if (!m) return;
  try {
    const list = [m, ...messageHistory(root).filter((x) => x !== m)].slice(0, MAX_HISTORY);
    localStorage.setItem(historyKey(root), JSON.stringify(list));
  } catch {
    // ignore
  }
}

const draftKey = (root: string, list: string) =>
  list === DEFAULT_LIST_ID
    ? `openidea.vcs.commitDraft:${root}`
    : `openidea.vcs.changelistDraft:${JSON.stringify([root, list])}`;

function readDraft(root: string, list: string): string | null {
  try {
    return localStorage.getItem(draftKey(root, list));
  } catch {
    return null;
  }
}

export function savedDraft(root: string, list = DEFAULT_LIST_ID): string {
  return readDraft(root, list) ?? "";
}

function writeDraft(root: string, list: string, text: string | null) {
  try {
    const key = draftKey(root, list);
    if (text === null) localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch {
    // ignore
  }
}

const authorKey = (root: string, list: string) => `openidea.vcs.commitAuthor:${JSON.stringify([root, list])}`;

function defaultCommitAuthor(root: string, list: string): CommitAuthorDetails {
  const changelists = useChangelists.getState();
  const source =
    changelists.root === root ? changelists.state.lists.find((item) => item.id === list)?.appliedCommit : null;
  return source && source.kind !== "revert"
    ? {
        author: source.author ?? "",
        authorDate: source.authorDate && Number.isFinite(Date.parse(source.authorDate)) ? source.authorDate : null,
      }
    : DEFAULT_COMMIT_AUTHOR;
}

function savedCommitAuthor(root: string | null, list: string): CommitAuthorDetails {
  if (!root) return DEFAULT_COMMIT_AUTHOR;
  const defaults = defaultCommitAuthor(root, list);
  try {
    const saved = JSON.parse(
      localStorage.getItem(authorKey(root, list)) ?? "null",
    ) as Partial<CommitAuthorDetails> | null;
    if (!saved) return defaults;
    return {
      author: typeof saved?.author === "string" ? saved.author : "",
      authorDate:
        typeof saved?.authorDate === "string" && Number.isFinite(Date.parse(saved.authorDate))
          ? saved.authorDate
          : null,
    };
  } catch {
    return defaults;
  }
}

export function setCommitAuthor(update: Partial<CommitAuthorDetails>) {
  const { author, authorDate, amend, messageChangelist } = useCommit.getState();
  const root = useVcs.getState().root;
  const details = { author, authorDate, ...update };
  useCommit.setState(details);
  if (root && !amend) saveCommitAuthor(root, messageChangelist, details);
}

function saveCommitAuthor(root: string, list: string, details: CommitAuthorDetails) {
  try {
    const key = authorKey(root, list);
    const defaults = defaultCommitAuthor(root, list);
    if (details.author !== defaults.author || details.authorDate !== defaults.authorDate)
      localStorage.setItem(key, JSON.stringify(details));
    else localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** The user's draft before Amend or another automatic message filled the field. */
function draftText(): string | null {
  const message = amendData?.before ?? useCommit.getState().message;
  if (message.trim() === keptMessage || message === appliedMessage?.text) return null;
  return message.trim() ? message : "";
}

let pendingDraft: { root: string; list: string; text: string } | null = null;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
const DRAFT_DELAY_MS = 500;

export function flushDraft() {
  clearTimeout(draftTimer);
  const p = pendingDraft;
  pendingDraft = null;
  if (p) writeDraft(p.root, p.list, p.text);
}

function scheduleDraft() {
  const root = useVcs.getState().root;
  const list = useCommit.getState().messageChangelist;
  const text = draftText();
  if (!root || text === null) return;
  if (pendingDraft && (pendingDraft.root !== root || pendingDraft.list !== list)) flushDraft();
  pendingDraft = { root, list, text };
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, DRAFT_DELAY_MS);
}

function changelistMessage() {
  const root = useVcs.getState().root;
  const list = useCommit.getState().messageChangelist;
  const changelists = useChangelists.getState();
  if (!root || changelists.root !== root || stagingAreaOn()) return null;
  if (pendingDraft?.root === root && pendingDraft.list === list) return null;
  if (readDraft(root, list) !== null) return null;
  const entry = changelists.state.lists.find((item) => item.id === list);
  if (entry?.comment?.trim()) return entry.comment;
  return list === DEFAULT_LIST_ID ? null : (entry?.name ?? null);
}

let displayingDraft = false;

function displayCommitDraft(update: Partial<CommitState>) {
  displayingDraft = true;
  try {
    useCommit.setState(update);
  } finally {
    displayingDraft = false;
  }
}

/** The message typed before Amend replaced it, and the amended commit's message. */
let amendData: { before: string; amend: string } | null = null;
let amendAuthor: { before: CommitAuthorDetails; applied: string } | null = null;
let amendRequest = 0;

/**
 * Amend checkbox, as in IDEA: checking it replaces the message
 * with the last commit's (the draft is kept in the message history and restored when
 * Amend is unchecked again, unless the amend message was edited meanwhile).
 */
export async function setAmend(on: boolean, target: EarlierAmend | null = null) {
  const { root: project, roots } = useVcs.getState();
  // The original commit is unambiguous only in a single root.
  const previewRoot = roots.length === 1 ? roots[0]! : null;
  if (on && target && previewRoot !== target.root) return;
  const request = ++amendRequest;
  const before = useCommit.getState();
  if (on && !before.amend) {
    amendAuthor = { before: { author: before.author, authorDate: before.authorDate }, applied: before.author };
  }
  useCommit.setState({
    amend: on,
    amendPreview: on && previewRoot ? { root: previewRoot, status: "loading" } : null,
    amendTarget: on ? target : null,
    ...(on && { authorDate: null }),
  });
  if (!on) {
    const data = amendData;
    const original = amendAuthor;
    amendData = null;
    amendAuthor = null;
    const details = original
      ? {
          author: before.author === original.applied ? original.before.author : before.author,
          authorDate: original.before.authorDate,
        }
      : {};
    useCommit.setState((state) => ({
      message: data && state.message === data.amend ? data.before : state.message,
    }));
    setCommitAuthor(details);
    applyCommitMessages();
    if (data) scheduleDraft();
    return;
  }
  const current = () => request === amendRequest && useCommit.getState().amend && useVcs.getState().root === project;
  let head = target?.commit;
  try {
    if (!head)
      [head] = await call(
        commands.vcsLog(previewRoot ?? currentRepo(), {
          branch: "HEAD",
          path: null,
          author: null,
          text: null,
          range: null,
          skip: 0,
          limit: 1,
        }),
      );
  } catch {
    // No commits yet.
  }
  if (!current()) return;
  const last = head?.message.replace(/\s+$/, "");
  const beforeMessage = useCommit.getState().message;
  if (last && beforeMessage.trim() !== last.trim()) {
    if (!amendData) rememberMessage(beforeMessage);
    amendData = { before: amendData?.before ?? beforeMessage, amend: last };
    useCommit.setState((s) => ({ message: last, focusTick: s.focusTick + 1 }));
  }
  if (previewRoot && head) {
    const [files, configured] = await Promise.all([
      call(commands.vcsCommitFiles(previewRoot, head.id)).catch(() => null),
      readConfiguredGitIdentity(previewRoot),
    ]);
    if (!current()) return;
    const defaultUser = gitPersonKey(configured.name, configured.email);
    const author = gitPersonKey(head.author, head.email);
    const committer = gitPersonKey(head.committer, head.committerEmail);
    const differentCommitter = !!(configured.name && committer && committer !== defaultUser);
    const nextAuthor =
      head.author && head.email && (!configured.name || author !== defaultUser) ? `${head.author} <${head.email}>` : "";
    const authorUnchanged = useCommit.getState().author === before.author;
    if (authorUnchanged && amendAuthor) amendAuthor.applied = nextAuthor;
    useCommit.setState({
      amendPreview: files
        ? {
            root: previewRoot,
            status: "ready",
            head,
            expectedHead: target?.head.commit ?? head.id,
            files,
            differentCommitter,
          }
        : null,
      ...(authorUnchanged && { author: nextAuthor }),
    });
    return;
  }
  if (current()) useCommit.setState({ amendPreview: null });
}

function resetAmendDraft() {
  const author = amendAuthor?.before;
  amendData = null;
  amendAuthor = null;
  amendRequest++;
  return { amend: false, amendPreview: null, amendTarget: null, ...author };
}

/** The messages supplied by the commit workflow rather than typed into the draft. */
let keptMessage: string | null = null;
const NO_COMMIT_MESSAGES: CommitMessages = { template: null, prepared: null };
let latestMessages = NO_COMMIT_MESSAGES;
let appliedMessage: { text: string; previousCommit: string | null } | null = null;

/**
 * The message field after a commit, as IDEA's: the committed message stays for the
 * next commit unless Settings › Version Control › Commit › "Clear initial commit
 * message" is on.
 */
export function messageAfterCommit(committed: string, clear: boolean): string {
  return clear ? "" : committed.trim();
}

export function captureCommitDraft() {
  const { message, messageChangelist: list } = useCommit.getState();
  return { root: useVcs.getState().root, list, message, text: draftText() };
}

/** Takes the message from Undo Commit into the list receiving its restored changes. */
export function setChangelistDraft(list: string, message: string) {
  const root = useVcs.getState().root;
  if (!root) return;
  flushDraft();
  writeDraft(root, list, message);
  if (useCommit.getState().messageChangelist === list) {
    keptMessage = null;
    appliedMessage = null;
    displayCommitDraft({ ...resetAmendDraft(), message, fixupTarget: null });
  }
}

export function keepMessageAfterCommit(committed: string, clear: boolean, finished = captureCommitDraft()) {
  const current = captureCommitDraft();
  const active =
    current.root === finished.root && current.list === finished.list && current.message === finished.message;
  flushDraft();
  if (
    finished.root &&
    (active || (finished.text !== null && readDraft(finished.root, finished.list) === finished.text))
  ) {
    writeDraft(finished.root, finished.list, clear ? "" : null);
  }
  if (!active) return;
  const message = messageAfterCommit(committed, clear);
  keptMessage = message || null;
  appliedMessage = null;
  // The worktree watcher may still be processing the removal of the prepared message.
  latestMessages = { ...latestMessages, prepared: null, pendingApply: null };
  const { amend } = useCommit.getState();
  displayCommitDraft({ ...resetAmendDraft(), message, ...(amend && { author: "" }) });
  if (amend) setCommitAuthor({ author: "" });
  if (!message) applyCommitMessages(false);
}

function applyCommitMessages(useChangelist = true) {
  const { message, amend, messageChangelist } = useCommit.getState();
  if (amend) return;
  const automatic = message === appliedMessage?.text ? appliedMessage : null;
  const { pendingApply } = latestMessages;
  const state = useChangelists.getState().state;
  const operationList = pendingApply && !stagingAreaOn() ? appliedCommitList(state, pendingApply.source) : null;
  const prepared = operationList
    ? operationList.id === messageChangelist
      ? operationList.comment
      : null
    : latestMessages.prepared;
  if (prepared) {
    const trimmed = message.trim();
    const committed = trimmed === keptMessage ? keptMessage : null;
    if (trimmed && !automatic && !committed) return;
    const previousCommit = automatic ? automatic.previousCommit : committed;
    appliedMessage = { text: prepared, previousCommit };
    if (message !== prepared) displayCommitDraft({ message: prepared });
    return;
  }
  if (message && !automatic) return;
  const template = latestMessages.template ?? (useChangelist ? changelistMessage() : null);
  const previousCommit = automatic?.previousCommit;
  appliedMessage = previousCommit || !template ? null : { text: template, previousCommit: null };
  const next = previousCommit ?? template ?? "";
  if (message !== next) displayCommitDraft({ message: next });
}

function includedChangelist(checks = useCommit.getState().checks): string {
  const { root, status } = useVcs.getState();
  const changelists = useChangelists.getState();
  if (!root || changelists.root !== root || stagingAreaOn()) return DEFAULT_LIST_ID;
  return changelistForCommit(
    status,
    root,
    changelists.state,
    checks,
    workflowSettings().vcs.commit.includeChangesByDefault,
  );
}

/** Prefills and restores Git's messages around operations while preserving the draft. */
export function installCommitMessages(): () => void {
  const repoFor = (s: ReturnType<typeof useVcs.getState>) =>
    s.root ? (s.repo ?? s.roots[0] ?? (s.available ? s.root : null)) : null;
  let stopMessages: (() => void) | undefined;
  const syncAppliedCommit = () => {
    const { prepared, pendingApply } = latestMessages;
    if (!prepared || !pendingApply || stagingAreaOn() || !workflowSettings().vcs.createChangelistsAutomatically) return;
    const { root, status, statusLoaded } = useVcs.getState();
    const lists = useChangelists.getState();
    if (!root || !statusLoaded || !lists.loaded || lists.root !== root) return;
    updateChangelists((state) => addAppliedCommitList(state, root, status, pendingApply, prepared));
  };
  const watchMessages = (s: ReturnType<typeof useVcs.getState>) => {
    stopMessages?.();
    stopMessages = undefined;
    latestMessages = NO_COMMIT_MESSAGES;
    applyCommitMessages();
    const repo = repoFor(s);
    if (!repo || !isTauri()) return;
    let active = true;
    let pending = true;
    const request = nextRequestId();
    const channel = new Channel<CommitMessages>((messages) => {
      if (!active) return;
      latestMessages = messages;
      syncAppliedCommit();
      applyCommitMessages();
    });
    void call(commands.vcsWatchCommitMessages(repo, request, channel))
      .catch(() => undefined)
      .finally(() => {
        pending = false;
      });
    stopMessages = () => {
      active = false;
      if (pending) void commands.cancelRequest(request).catch(() => undefined);
    };
  };
  const syncChangelist = () => {
    const root = useVcs.getState().root;
    const list = includedChangelist();
    if (!root || list === useCommit.getState().messageChangelist) return;
    flushDraft();
    keptMessage = null;
    appliedMessage = null;
    displayCommitDraft({
      ...resetAmendDraft(),
      ...savedCommitAuthor(root, list),
      fixupTarget: null,
      messageChangelist: list,
      message: savedDraft(root, list),
    });
    applyCommitMessages();
  };
  const offDraft = useCommit.subscribe((s, prev) => {
    if (displayingDraft) return;
    if (s.message !== prev.message) scheduleDraft();
    if (s.checks !== prev.checks) syncChangelist();
  });
  const initialRoot = useVcs.getState().root;
  if (initialRoot) {
    const list = includedChangelist();
    const current = useCommit.getState();
    displayCommitDraft({
      ...savedCommitAuthor(initialRoot, list),
      messageChangelist: list,
      message: current.messageChangelist === list && current.message ? current.message : savedDraft(initialRoot, list),
    });
  }
  watchMessages(useVcs.getState());
  const offLists = useChangelists.subscribe((s, prev) => {
    if (s.loaded !== prev.loaded) syncAppliedCommit();
    syncChangelist();
    if (s.root !== prev.root || s.state.lists !== prev.state.lists) applyCommitMessages();
  });
  const offSettings = onWorkflowSettingsChange(
    (s) => [
      s.vcs.git.stagingArea,
      s.vcs.commit.nonModal,
      s.vcs.commit.includeChangesByDefault,
      s.vcs.createChangelistsAutomatically,
    ],
    () => {
      syncAppliedCommit();
      syncChangelist();
      applyCommitMessages();
    },
  );
  const onHide = () => flushDraft();
  const onPageHide = () => {
    stopMessages?.();
    stopMessages = undefined;
    onHide();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onHide);
    window.addEventListener("blur", onHide);
  }
  const offVcs = useVcs.subscribe((s, prev) => {
    if (s.root !== prev.root) {
      flushDraft();
      keptMessage = null;
      appliedMessage = null;
      const checks = new Map<string, CheckState>();
      const list = includedChangelist(checks);
      displayCommitDraft({
        ...resetAmendDraft(),
        ...savedCommitAuthor(s.root, list),
        messageChangelist: list,
        message: s.root ? savedDraft(s.root, list) : "",
        fixupTarget: null,
        checks,
        excludedStagedRepos: new Set(),
        excludedHunks: new Map(),
        excludedHunkLines: new Map(),
        selection: [],
        selectionKeys: [],
        unstagedSelection: [],
        tab: "changes",
        selectedList: null,
        selectedShelf: null,
      });
      watchMessages(s);
      return;
    }
    if (repoFor(s) !== repoFor(prev)) watchMessages(s);
    if (s.status !== prev.status) {
      syncAppliedCommit();
      syncChangelist();
    }
  });
  return () => {
    stopMessages?.();
    offVcs();
    offDraft();
    offLists();
    offSettings();
    flushDraft();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onHide);
      window.removeEventListener("blur", onHide);
    }
  };
}
