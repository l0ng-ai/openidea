/** Git menu dialogs: Pull…, Merge…, Rebase…, Manage Remotes… and Worktrees. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { Branch, BranchInfo, MergeOptions, Remote } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import {
  Button,
  Dialog,
  Icon,
  IconButton,
  Input,
  Menu,
  Select,
  T,
  listNavigate,
  type SelectOption,
  type SelectProps,
  type MenuItem,
} from "@/ui";
import { sortLocal, sortRemote } from "./branches";
import { branchRef, conflictActions, openConflictsInstead, openMergeConflicts } from "./branchOps";
import { confirmDialog, openDialog } from "./dialogs";
import { rebaseFeedback } from "./operations";
import { errorMessage, notifyUpdated, runOp, runRemote, saveAll } from "./ops";
import { splitTracked } from "./pushTarget";
import { runRebaseWithEditor } from "./rebaseEditor";
import { RepoPicker } from "./RepoPicker";
import { currentRepo, loadBranches, refreshNow, selectRepo, useVcs } from "./store";
import styles from "./common.module.css";
import remoteStyles from "./GitRemotes.module.css";
import commandStyles from "./GitCommandDialog.module.css";
import { tx } from "@/platform/i18n";

// --- shared -----------------------------------------------------------------

type IntegrationFlag = "noFf" | "ffOnly" | "squash" | "noCommit";
const EXCLUSIVE: Record<IntegrationFlag, IntegrationFlag[]> = {
  noFf: ["ffOnly", "squash"],
  ffOnly: ["noFf", "squash"],
  squash: ["noFf", "ffOnly"],
  noCommit: [],
};

function mergeOptionsOf(on: Pick<ReadonlySet<IntegrationFlag>, "has">): MergeOptions {
  return {
    noFf: on.has("noFf"),
    ffOnly: on.has("ffOnly"),
    squash: on.has("squash"),
    noCommit: on.has("noCommit"),
  };
}

const FLAG_LABELS: Array<[IntegrationFlag, string]> = [
  ["noFf", "--no-ff"],
  ["ffOnly", "--ff-only"],
  ["squash", "--squash"],
  ["noCommit", "--no-commit"],
];

function GitOptionMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={anchor} variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <T>Modify options</T>
        <Icon name="chevron-down" size={12} />
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="top-start"
        aria-label="Modify options"
        items={items}
      />
    </>
  );
}

function GitOptionChips({ labels, name = tx("Options:") }: { labels: string[]; name?: string }) {
  if (!labels.length) return null;
  return (
    <div className={styles.optionChips} role="group" aria-label={name}>
      {labels.map((label) => (
        <code key={label}>{label}</code>
      ))}
    </div>
  );
}

type GitVersion = readonly [number, number];

function gitVersionAtLeast(version: GitVersion | null, major: number, minor: number): boolean {
  return !!version && (version[0] > major || (version[0] === major && version[1] >= minor));
}

function useGitVersion(): GitVersion | null {
  const [gitVersion, setVersion] = useState<GitVersion | null>(null);
  const executable = workflowSettings().vcs.git.executable;
  useEffect(() => {
    let active = true;
    void call(commands.vcsGitVersion(executable))
      .then(({ version }) => {
        const [, major, minor] = /^git version (\d+)\.(\d+)/.exec(version) ?? [];
        if (active) setVersion(major && minor ? [Number(major), Number(minor)] : null);
      })
      .catch(() => {
        if (active) setVersion(null);
      });
    return () => {
      active = false;
    };
  }, [executable]);
  return gitVersion;
}

function useGitSupportsNoVerify(): boolean {
  return gitVersionAtLeast(useGitVersion(), 2, 24);
}

function restoreFlags<F extends string>(
  saved: unknown,
  options: ReadonlyArray<readonly [F, string]>,
  exclusive: Record<F, readonly F[]>,
): Set<F> {
  const flags = new Set<F>();
  if (Array.isArray(saved)) {
    for (const [flag] of options) {
      if (saved.includes(flag) && !exclusive[flag].some((other) => flags.has(other))) flags.add(flag);
    }
  }
  return flags;
}

const NO_BRANCHES: Branch[] = [];

export function useBranches(repo: string | null, enabled = true, refresh = 0): Branch[] {
  const [loaded, setLoaded] = useState<{ repo: string | null; branches: Branch[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void call(commands.vcsBranches(repo))
      .then((branches) => live && setLoaded({ repo, branches }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, repo, refresh]);
  return loaded?.repo === repo ? loaded.branches : NO_BRANCHES;
}

const branchOptions = (list: readonly Branch[]): SelectOption[] =>
  list.filter((b) => !b.name.endsWith("/HEAD")).map((b) => ({ value: b.name, label: b.name, icon: "branch" }));

/** Every branch choice in these dialogs: repositories hold hundreds of branches, so type to filter, Enter picks. */
function BranchSelect(props: Omit<SelectProps, "searchable">) {
  return <Select {...props} searchable />;
}

/** Remote branches of `remote` without the remote prefix (`origin/main` → `main`). */
export function remoteBranchesOf(branches: readonly Branch[], remote: string, remotes = [remote]): string[] {
  const prefix = `${remote}/`;
  return sortRemote(branches).flatMap(({ name }) => {
    if (!name.startsWith(prefix)) return [];
    const ref = splitTracked(name, remotes);
    return ref.remote === remote && ref.branch !== "HEAD" ? [ref.branch] : [];
  });
}

// --- Pull -------------------------------------------------------------------

/** `repo`: the repository it starts on (the context's), else the selected one. */
export function showPullDialog(repo?: string | null) {
  openDialog((close) => <PullDialog initialRepo={repo} onClose={close} />);
}

/** The repository's branch info: the store's for the selected repository, else read from git. */
export function useBranchInfo(repo: string | null) {
  const [initial] = useState(() => ({ repo: currentRepo(), info: useVcs.getState().branch }));
  const [loaded, setLoaded] = useState<{ repo: string | null; info: BranchInfo | null } | null>(null);
  useEffect(() => {
    if (repo === initial.repo) return;
    let live = true;
    void call(commands.vcsBranchInfo(repo))
      .then((info) => live && setLoaded({ repo, info }))
      .catch(() => live && setLoaded({ repo, info: null }));
    return () => {
      live = false;
    };
  }, [repo, initial.repo]);
  if (repo === initial.repo) return initial.info;
  return loaded?.repo === repo ? loaded.info : null;
}

type PullFlag = IntegrationFlag | "rebase" | "noVerify";

const PULL_FLAGS: Array<[PullFlag, string]> = [["rebase", "--rebase"], ...FLAG_LABELS, ["noVerify", "--no-verify"]];
const PULL_EXCLUSIVE: Record<PullFlag, readonly PullFlag[]> = {
  rebase: ["noFf", "ffOnly", "squash", "noCommit"],
  noFf: [...EXCLUSIVE.noFf, "rebase"],
  ffOnly: ["noFf", "squash", "rebase"],
  squash: [...EXCLUSIVE.squash, "rebase"],
  noCommit: ["rebase"],
  noVerify: [],
};

function savedPullFlags(key: string): Set<PullFlag> {
  try {
    return restoreFlags(JSON.parse(localStorage.getItem(key) ?? "null"), PULL_FLAGS, PULL_EXCLUSIVE);
  } catch {
    return new Set();
  }
}

function PullDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const [repo, setRepo] = useState(() => (initialRepo === undefined ? currentRepo() : initialRepo));
  const [source, setSource] = useState<{ repo: string | null; info: BranchInfo | null; remotes: Remote[] } | null>(
    null,
  );
  const [selectedRemote, setRemote] = useState<string | null>(null);
  const [chosenBranch, setBranch] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const remoteBusy = useVcs((s) => s.remoteBusy);
  const branches = useBranches(repo, true, refresh);
  const [optionsKey] = useState(() => `openidea.vcs.pullOptions:${useVcs.getState().root ?? ""}`);
  const [flags, setFlags] = useState(() => savedPullFlags(optionsKey));
  const supportsNoVerify = useGitSupportsNoVerify();

  const chooseRepo = (root: string) => {
    if (root === repo) return;
    setRepo(root);
    setRemote(null);
    setBranch(null);
  };

  useEffect(() => {
    let alive = true;
    void Promise.all([
      call(commands.vcsBranchInfo(repo)).catch(() => null),
      call(commands.vcsRemotes(repo)).catch(() => []),
    ]).then(([info, remotes]) => {
      if (alive) setSource({ repo, info, remotes });
    });
    return () => {
      alive = false;
    };
  }, [repo]);

  const current = source?.repo === repo ? source : null;
  const info = current?.info;
  const remotes = current?.remotes;
  const remoteNames = useMemo(() => remotes?.map((r) => r.name) ?? [], [remotes]);
  const upstream = info?.upstreamTracking ?? (info?.upstream ? splitTracked(info.upstream, remoteNames) : null);
  const remote =
    [selectedRemote, upstream?.remote, "origin"].find((name) => name && remoteNames.includes(name)) ??
    remoteNames[0] ??
    null;
  const availableBranches = useMemo(
    () => (remote ? remoteBranchesOf(branches, remote, remoteNames) : []),
    [branches, remote, remoteNames],
  );
  const remoteBranches =
    upstream &&
    remote === upstream.remote &&
    !availableBranches.includes(upstream.branch) &&
    branches.some((b) => b.remote && b.name === info?.upstream)
      ? [upstream.branch, ...availableBranches]
      : availableBranches;
  const branch =
    [chosenBranch, upstream?.branch, info?.head].find((name) => name && remoteBranches.includes(name)) ?? null;
  const availableFlags = PULL_FLAGS.filter(([flag]) => flag !== "noVerify" || supportsNoVerify);
  const selectedFlags = availableFlags.filter(([flag]) => flags.has(flag)).map(([, label]) => label);
  const options: MenuItem[] = availableFlags.map(([flag, label]) => ({
    label,
    verbatim: true,
    checked: flags.has(flag),
    disabled: !flags.has(flag) && PULL_EXCLUSIVE[flag].some((other) => flags.has(other)),
    run: () => {
      const next = new Set(flags);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      setFlags(next);
    },
  }));

  const fetchBranches = async () => {
    if (remote && !remoteBusy && (await executeAction("vcs.fetch", { repo, remote }))) {
      setRefresh((value) => value + 1);
    }
  };

  const run = async () => {
    if (!remote || !branch || remoteBusy) return;
    try {
      localStorage.setItem(optionsKey, JSON.stringify([...flags]));
    } catch {
      // Workspace preferences may be unavailable.
    }
    onClose();
    await saveAll();
    await runRemote(
      {
        op: "pullFrom",
        remote,
        branches: [branch],
        rebase: flags.has("rebase") ? true : null,
        options: { ...mergeOptionsOf(flags), noVerify: supportsNoVerify && flags.has("noVerify") },
      },
      `${info?.head ?? "HEAD"} ← ${remote}/${branch}`,
      [repo],
    );
  };

  return (
    <Dialog
      open
      title={tx`Pull to ${info?.head ?? "HEAD"}`}
      onClose={onClose}
      width={640}
      footerStart={<GitOptionMenu items={options} />}
      buttons={[
        { label: "Pull", role: "default", disabled: !branch || !!remoteBusy, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={commandStyles.form}>
        <div className={commandStyles.source}>
          <RepoPicker repo={repo} onChange={chooseRepo} className={commandStyles.repository} />
          {remotes && !remotes.length ? (
            <div className={clsx(styles.hint, commandStyles.noRemotes)}>
              <T>No remotes are configured. Add one with Git › Manage Remotes….</T>
            </div>
          ) : (
            <div className={commandStyles.command}>
              <code className={commandStyles.verb}>git pull</code>
              <Select
                aria-label="Remote"
                className={commandStyles.remote}
                value={remote}
                options={(remotes ?? []).map((r) => ({ value: r.name, label: r.name, verbatim: true, detail: r.url }))}
                onChange={(name) => {
                  setRemote(name);
                  setBranch(branch);
                }}
              />
              <BranchSelect
                aria-label="Remote branch"
                className={commandStyles.branch}
                value={branch}
                disabled={!remote}
                renderValue={(option) => (option ? <span title={option.label}>{option.label}</span> : <T>Branch</T>)}
                options={remoteBranches.map((b) => ({ value: b, label: b, icon: "branch", verbatim: true }))}
                onChange={setBranch}
              />
              <IconButton
                icon="refresh"
                aria-label={tx("Fetch remote branches")}
                title={tx("Fetch remote branches")}
                disabled={!remote || !!remoteBusy}
                onClick={() => void fetchBranches()}
              />
            </div>
          )}
        </div>
        <GitOptionChips labels={selectedFlags} />
        <div className={styles.hint}>
          <T>Uncommitted changes are stashed before the pull and restored afterwards.</T>
        </div>
      </div>
    </Dialog>
  );
}

// --- Merge ------------------------------------------------------------------

/** `repo`: the repository it starts on (the context's), else the selected one. */
export function showMergeDialog(repo?: string | null) {
  openDialog((close) => <MergeDialog initialRepo={repo} onClose={close} />);
}

type MergeFlag = IntegrationFlag | "message" | "noVerify" | "allowUnrelatedHistories";
const MERGE_FLAGS: Array<[MergeFlag, string]> = [
  ...FLAG_LABELS,
  ["message", "-m"],
  ["noVerify", "--no-verify"],
  ["allowUnrelatedHistories", "--allow-unrelated-histories"],
];
const MERGE_EXCLUSIVE: Record<MergeFlag, readonly MergeFlag[]> = {
  ...EXCLUSIVE,
  ffOnly: [...EXCLUSIVE.ffOnly, "message"],
  squash: [...EXCLUSIVE.squash, "message"],
  noCommit: ["message"],
  message: ["ffOnly", "squash", "noCommit"],
  noVerify: [],
  allowUnrelatedHistories: [],
};

function savedMerge(key: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as { ref?: unknown; flags?: unknown } | null;
    return {
      ref: typeof saved?.ref === "string" ? saved.ref : null,
      flags: restoreFlags(saved?.flags, MERGE_FLAGS, MERGE_EXCLUSIVE),
    };
  } catch {
    return { ref: null, flags: new Set<MergeFlag>() };
  }
}

function MergeDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const messageId = useId();
  const [repo, setRepo] = useState(() => (initialRepo === undefined ? currentRepo() : initialRepo));
  const info = useBranchInfo(repo);
  const liveHead = useVcs((state) => state.heads[repo ?? state.roots[0] ?? ""]);
  const head = liveHead ? liveHead.head : info?.head;
  const version = useVcs((state) => state.version);
  const branches = useBranches(repo, true, version);
  const [settingsKey] = useState(() => `openidea.vcs.mergeOptions:${useVcs.getState().root ?? ""}`);
  const [saved] = useState(() => savedMerge(settingsKey));
  const [chosenRef, setRef] = useState(saved.ref);
  const [flags, setFlags] = useState(saved.flags);
  const [message, setMessage] = useState("");
  const supportsNoVerify = useGitSupportsNoVerify();
  const options = useMemo(() => {
    const choices = [...sortLocal(branches).filter((b) => !b.current), ...sortRemote(branches)];
    const local = new Set(choices.filter((b) => !b.remote).map((b) => b.name));
    const remote = new Set(choices.filter((b) => b.remote).map((b) => b.name));
    return choices.map((branch) => ({
      branch,
      value: branchRef(branch.name, branch.remote),
      label: branch.name,
      verbatim: true,
      icon: "branch",
      detail: local.has(branch.name) && remote.has(branch.name) ? (branch.remote ? "Remote" : "Local") : undefined,
    }));
  }, [branches]);
  const selected =
    options.find(({ value }) => value === chosenRef) ??
    options.find(({ branch }) => branch.remote && branch.name === info?.upstream) ??
    (info ? options[0] : undefined);
  const tip = selected?.branch.commit || null;
  const [validation, setValidation] = useState<{
    repo: string | null;
    version: number;
    tip: string;
    merged: boolean;
  } | null>(null);
  useEffect(() => {
    if (!tip) return;
    let active = true;
    void call(commands.vcsMergeBase(repo, "HEAD", tip))
      .catch(() => null)
      .then((base) => {
        if (active) setValidation({ repo, version, tip, merged: base === tip });
      });
    return () => {
      active = false;
    };
  }, [repo, version, tip]);
  const checked = validation?.repo === repo && validation.version === version && validation.tip === tip;
  const alreadyMerged = checked && validation.merged;
  const canMerge = !!selected && (!tip || (checked && !alreadyMerged));

  const availableFlags = MERGE_FLAGS.filter(([flag]) => flag !== "noVerify" || supportsNoVerify);
  const selectedFlags = availableFlags.filter(([flag]) => flags.has(flag)).map(([, label]) => label);
  const menu: MenuItem[] = availableFlags.map(([flag, label]) => ({
    label: flag === "message" ? tx("-m (commit message)") : label,
    verbatim: true,
    checked: flags.has(flag),
    disabled: !flags.has(flag) && MERGE_EXCLUSIVE[flag].some((other) => flags.has(other)),
    run: () => {
      const next = new Set(flags);
      if (next.delete(flag)) {
        if (flag === "message") setMessage("");
      } else {
        next.add(flag);
      }
      setFlags(next);
    },
  }));

  const chooseRepo = (root: string) => {
    if (root === repo) return;
    setRepo(root);
  };

  const run = async () => {
    if (!selected || !canMerge) return;
    const project = useProject.getState().project;
    const { value: ref, label: branch } = selected;
    try {
      localStorage.setItem(settingsKey, JSON.stringify({ ref, flags: [...flags] }));
    } catch {
      // Workspace preferences may be unavailable.
    }
    onClose();
    await saveAll();
    const target = head ?? "HEAD";
    const root = repo ?? useVcs.getState().roots[0] ?? useVcs.getState().root;
    const key = `vcs.mergeResult:${root}`;
    const isCurrentProject = () => useProject.getState().project === project;
    const publishedTip = () => call(commands.vcsMergeBase(repo, "HEAD", ref)).catch(() => null);
    const before = flags.has("squash") ? null : await publishedTip();
    if (!isCurrentProject()) return;
    const reportCompleted = async () => {
      if (!isCurrentProject()) return;
      const after = before ? await publishedTip() : null;
      if (!isCurrentProject()) return;
      if (before && after && before !== after) await notifyUpdated([{ repo: root, from: before, to: after }], key);
      else {
        notifications().notify({
          group: "vcs",
          userInitiated: true,
          level: "info",
          key,
          title: tx`Merged ${branch} into ${target}`,
        });
      }
    };
    const outcome = await runOp(
      tx`Merge ${branch} into ${target}`,
      () =>
        call(
          commands.vcsMergeWith(repo, [ref], {
            ...mergeOptionsOf(flags),
            noVerify: supportsNoVerify && flags.has("noVerify"),
            allowUnrelatedHistories: flags.has("allowUnrelatedHistories"),
            message: flags.has("message") ? message.trim() || null : null,
          }),
        ),
      {
        errorActions: conflictActions,
        onError: openConflictsInstead,
      },
    );
    if (!isCurrentProject()) return;
    if (outcome?.kind === "done") {
      await reportCompleted();
    } else if (outcome?.kind === "alreadyUpToDate") {
      notifications().notify({
        group: "vcs",
        userInitiated: true,
        level: "info",
        key,
        title: "All files are up to date",
      });
    } else if (outcome?.kind === "readyToCommit" || outcome?.kind === "squashed") {
      notifications().notify({
        group: "vcs",
        userInitiated: true,
        level: "info",
        key,
        title:
          outcome.kind === "readyToCommit" ? tx("Merge is ready to commit") : tx("Squash merge is ready to commit"),
        actions: [
          {
            label: "Commit…",
            run: async () => {
              if (!isCurrentProject()) return;
              if (root) await selectRepo(root);
              if (isCurrentProject()) await executeAction("vcs.commit");
            },
          },
        ],
      });
    } else if (outcome?.kind === "conflicts") {
      if (flags.has("noCommit") || flags.has("squash")) await openConflictsInstead();
      else {
        await openMergeConflicts(root, project, () => void reportCompleted());
      }
    } else if (outcome?.kind === "localChanges") {
      notifications().notify({
        group: "vcs",
        userInitiated: true,
        level: "error",
        title: "Merge failed",
        body: "Merge would overwrite the local changes in these files.",
        actions: [
          {
            label: "View Files…",
            run: () =>
              void import("./LocalChangesReviewDialog").then(({ reviewLocalChanges }) =>
                reviewLocalChanges("blockedMerge", [[root, outcome.files]], false),
              ),
          },
        ],
      });
    }
  };

  return (
    <Dialog
      open
      title={head ? tx`Merge into ${head}` : "Merge"}
      onClose={onClose}
      width={640}
      footerStart={<GitOptionMenu items={menu} />}
      buttons={[
        { label: "Merge", role: "default", disabled: !canMerge, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={commandStyles.form}>
        <div className={commandStyles.source}>
          <RepoPicker repo={repo} onChange={chooseRepo} className={commandStyles.repository} />
          <div className={commandStyles.command}>
            <code className={commandStyles.verb}>git merge</code>
            <BranchSelect
              aria-label="Branch to merge"
              className={commandStyles.branch}
              value={selected?.value ?? null}
              placeholder="Select branch"
              options={options}
              onChange={setRef}
            />
          </div>
        </div>
        {alreadyMerged && selected && (
          <div className={styles.error} role="status">
            {tx`Branch '${selected.label}' is already merged.`}
          </div>
        )}
        <GitOptionChips labels={selectedFlags} name={tx("Merge options")} />
        {flags.has("message") && (
          <div className={commandStyles.message}>
            <label htmlFor={messageId}>
              <T>Commit message</T>
            </label>
            <textarea
              id={messageId}
              className={styles.textarea}
              rows={4}
              value={message}
              placeholder={selected ? tx`Merge branch '${selected.label}' into ${head ?? "HEAD"}` : ""}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// --- Rebase -----------------------------------------------------------------

/** `repo`: the repository it starts on (the context's), else the selected one. */
export function showRebaseDialog(repo?: string | null) {
  openDialog((close) => <RebaseDialog initialRepo={repo} onClose={close} />);
}

type RebaseFlag =
  | "switchBranch"
  | "onto"
  | "interactive"
  | "rebaseMerges"
  | "keepEmpty"
  | "root"
  | "updateRefs"
  | "autosquash"
  | "noAutosquash";
const REBASE_FLAGS: Array<[RebaseFlag, string]> = [
  ["switchBranch", "Switch to branch"],
  ["onto", "--onto"],
  ["interactive", "--interactive"],
  ["rebaseMerges", "--rebase-merges"],
  ["keepEmpty", "--keep-empty"],
  ["root", "--root"],
  ["updateRefs", "--update-refs"],
  ["autosquash", "--autosquash"],
  ["noAutosquash", "--no-autosquash"],
];
const REBASE_EXCLUSIVE: Record<RebaseFlag, readonly RebaseFlag[]> = {
  switchBranch: [],
  onto: [],
  interactive: [],
  rebaseMerges: [],
  keepEmpty: [],
  root: [],
  updateRefs: [],
  autosquash: ["noAutosquash"],
  noAutosquash: ["autosquash"],
};

function savedRebase(key: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as { base?: unknown; flags?: unknown } | null;
    return {
      base: typeof saved?.base === "string" ? saved.base : null,
      flags: restoreFlags(saved?.flags, REBASE_FLAGS, REBASE_EXCLUSIVE),
    };
  } catch {
    return { base: null, flags: new Set<RebaseFlag>() };
  }
}

function useRebaseRevision(repo: string | null, value: string | null) {
  const [checked, setChecked] = useState<{ repo: string | null; value: string; valid: boolean } | null>(null);
  useEffect(() => {
    if (!value) return;
    let active = true;
    void call(commands.vcsHasCommit(repo, value))
      .catch(() => false)
      .then((valid) => {
        if (active) setChecked({ repo, value, valid });
      });
    return () => {
      active = false;
    };
  }, [repo, value]);
  return checked?.repo === repo && checked.value === value ? checked.valid : null;
}

function RebaseRevisionSelect({ options, value, placeholder, ...props }: SelectProps) {
  return (
    <BranchSelect
      {...props}
      options={options}
      value={value}
      placeholder={placeholder}
      renderValue={(option) => option?.label ?? value ?? tx(placeholder ?? "Select branch")}
      customOption={(query) => ({ value: query, label: query, verbatim: true })}
    />
  );
}

function RebaseDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const upstreamId = useId();
  const branchId = useId();
  const [repo, setRepo] = useState(() => (initialRepo === undefined ? currentRepo() : initialRepo));
  const head = useBranchInfo(repo)?.head ?? null;
  const branches = useBranches(repo);
  const operation = useVcs((s) => s.operations[repo ?? s.roots[0] ?? ""]);
  const [tagList, setTagList] = useState<{ repo: string | null; tags: string[] } | null>(null);
  const [settingsKey] = useState(() => `openidea.vcs.rebaseOptions:${useVcs.getState().root ?? ""}`);
  const [saved] = useState(() => savedRebase(settingsKey));
  const [flags, setFlags] = useState(saved.flags);
  const [upstream, setUpstream] = useState(saved.base);
  const [onto, setOnto] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const supportsUpdateRefs = gitVersionAtLeast(useGitVersion(), 2, 38);
  const useOnto = flags.has("onto");
  const root = flags.has("root");
  const switchBranch = flags.has("switchBranch");
  const local = useMemo(() => sortLocal(branches), [branches]);
  const selectedBranch = switchBranch ? local.find((b) => b.name === (branch ?? head))?.name : undefined;
  const current = selectedBranch ?? head ?? "HEAD";

  useEffect(() => {
    let active = true;
    void call(commands.vcsTags(repo))
      .catch(() => [])
      .then((tags) => {
        if (active) setTagList({ repo, tags });
      });
    return () => {
      active = false;
    };
  }, [repo]);

  const options = useMemo(
    () => [
      ...[...local.filter((b) => b.name !== current), ...sortRemote(branches)].map((b) => {
        const value = branchRef(b.name, b.remote);
        return { value, label: b.name, keywords: value, icon: "branch", verbatim: true };
      }),
      ...(tagList?.repo === repo ? tagList.tags : []).map((tag) => ({
        value: `refs/tags/${tag}`,
        label: tag,
        keywords: `refs/tags/${tag}`,
        icon: "tag",
        verbatim: true,
      })),
    ],
    [branches, current, local, repo, tagList],
  );
  const upstreamValid = useRebaseRevision(repo, root ? null : upstream);
  const ontoValid = useRebaseRevision(repo, useOnto ? onto : null);
  const ready =
    !operation &&
    (root || upstreamValid === true) &&
    (!useOnto || ontoValid === true || (root && !onto)) &&
    (!switchBranch || !!selectedBranch);

  const available = REBASE_FLAGS.filter(([flag]) => flag !== "updateRefs" || supportsUpdateRefs);
  const menu: MenuItem[] = available.map(([flag, label]) => ({
    label: flag === "switchBranch" ? tx(label) : label,
    verbatim: true,
    checked: flags.has(flag),
    disabled: !flags.has(flag) && REBASE_EXCLUSIVE[flag].some((other) => flags.has(other)),
    run: () => {
      const next = new Set(flags);
      if (!next.delete(flag)) next.add(flag);
      if (flag === "onto") {
        setUpstream(useOnto ? onto : null);
        setOnto(useOnto ? null : upstream);
      }
      setFlags(next);
    },
  }));

  const chooseRepo = (next: string) => {
    if (next === repo) return;
    setRepo(next);
    setUpstream(null);
    setOnto(null);
    setBranch(null);
  };

  const run = async () => {
    if (!ready) return;
    const base = useOnto ? onto : upstream;
    try {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          base,
          flags: [...flags].filter((flag) => flag !== "switchBranch" && flag !== "onto"),
        }),
      );
    } catch {
      // Workspace preferences may be unavailable.
    }
    onClose();
    const target = root && !(useOnto && onto) ? null : (options.find((item) => item.value === base)?.label ?? base);
    const rebaseOptions = {
      onto: useOnto ? onto : null,
      branch: selectedBranch ?? null,
      rebaseMerges: flags.has("rebaseMerges"),
      keepEmpty: flags.has("keepEmpty"),
      updateRefs: supportsUpdateRefs && flags.has("updateRefs"),
      autosquash: flags.has("autosquash") ? true : flags.has("noAutosquash") ? false : null,
    };
    const feedback = {
      success: target ? tx`Rebased ${current} onto ${target}` : tx`Rebased ${current} from the root`,
      errorActions: conflictActions,
      onError: openConflictsInstead,
    };
    if (flags.has("interactive")) {
      await runRebaseWithEditor(
        repo,
        root ? null : upstream,
        rebaseOptions,
        rebaseFeedback(repo, {
          success: feedback.success,
          errorActions: feedback.errorActions,
          progress: tx("Rebasing"),
          failure: tx("Rebase failed"),
        }),
      );
      return;
    }
    await saveAll();
    await runOp(
      target ? tx`Rebase ${current} onto ${target}` : tx`Rebase ${current} from the root`,
      () => call(commands.vcsRebaseWith(repo, root ? null : upstream, rebaseOptions)),
      feedback,
    );
    await refreshNow();
  };

  const upstreamPicker = (
    <RebaseRevisionSelect
      id={upstreamId}
      aria-label={useOnto ? "Old base" : "Upstream"}
      autoFocus
      className={commandStyles.branch}
      value={upstream}
      placeholder="Select branch"
      options={options}
      onChange={setUpstream}
    />
  );

  return (
    <Dialog
      open
      title={head ? tx`Rebase ${head}` : "Rebase"}
      onClose={onClose}
      width={640}
      footerStart={<GitOptionMenu items={menu} />}
      buttons={[
        { label: "Rebase", role: "default", disabled: !ready, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={commandStyles.form}>
        <div className={commandStyles.source}>
          <RepoPicker repo={repo} onChange={chooseRepo} className={commandStyles.repository} />
          <div className={commandStyles.command}>
            <code className={commandStyles.verb}>git rebase</code>
            {useOnto ? (
              <>
                <code className={commandStyles.verb}>--onto</code>
                <RebaseRevisionSelect
                  aria-label="New base"
                  className={commandStyles.branch}
                  autoFocus={root}
                  value={onto}
                  placeholder="New base"
                  options={options}
                  onChange={setOnto}
                />
              </>
            ) : (
              !root && upstreamPicker
            )}
          </div>
        </div>
        {switchBranch && (
          <div className={commandStyles.rebaseBase}>
            <label htmlFor={branchId}>
              <T>Branch to rebase</T>
            </label>
            <BranchSelect
              id={branchId}
              aria-label="Branch to rebase"
              className={commandStyles.branch}
              value={selectedBranch ?? null}
              options={branchOptions(local)}
              onChange={setBranch}
            />
          </div>
        )}
        {useOnto && !root && (
          <div className={commandStyles.rebaseBase}>
            <label htmlFor={upstreamId} title={tx`Rebase commits of ${current} not on:`}>
              <T>Old base</T>
            </label>
            {upstreamPicker}
          </div>
        )}
        {upstreamValid === false && (
          <div className={styles.error} role="status">{tx`Commit '${upstream}' was not found.`}</div>
        )}
        {ontoValid === false && <div className={styles.error} role="status">{tx`Commit '${onto}' was not found.`}</div>}
        <GitOptionChips
          name={tx("Rebase options")}
          labels={available
            .filter(([flag]) => flag !== "switchBranch" && flag !== "onto" && flags.has(flag))
            .map(([, label]) => label)}
        />
        {operation && (
          <div className={styles.error} role="status">
            {operation === "rebase" ? tx("Rebase in progress") : tx("Another Git operation is in progress.")}
          </div>
        )}
        <div className={styles.hint}>
          <T>Uncommitted changes are stashed before the rebase and restored afterwards.</T>
        </div>
      </div>
    </Dialog>
  );
}

// --- Manage Remotes ---------------------------------------------------------

/** Error for a remote name, or null (`existing`: the other remotes' names). */
export function validateRemoteName(name: string, existing: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return "Enter a remote name";
  if (/\s/.test(n) || n.startsWith("-") || /[~^:?*[\\]/.test(n) || n.includes("..")) return "Invalid remote name";
  if (existing.includes(n)) return `Remote '${n}' already exists`;
  return null;
}

export function showManageRemotes() {
  openDialog((close) => <RemotesDialog onClose={close} />);
}

export interface DefineRemoteTarget {
  repo?: string | null;
  onAdded?: () => void;
}

export async function showDefineRemote(target: DefineRemoteTarget = {}) {
  const repo = target.repo ?? currentRepo();
  const project = useProject.getState().project;
  const remotes = await runOp("Define Remote", () => call(commands.vcsRemotes(repo)), { refresh: false });
  if (!remotes || useProject.getState().project !== project) return;
  openDialog((close) => (
    <RemoteEditDialog
      existing={remotes.map(({ name }) => name)}
      onDone={async (remote) => {
        if (!remote || useProject.getState().project !== project) {
          close();
          return;
        }
        await call(commands.vcsEditRemote(repo, { op: "add", ...remote }));
        close();
        if (useProject.getState().project === project) {
          target.onAdded?.();
          void loadBranches().catch(() => undefined);
        }
      }}
    />
  ));
}

function RemotesDialog({ onClose }: { onClose: () => void }) {
  const [repo, setRepo] = useState(currentRepo);
  return (
    <Dialog
      open
      title="Git Remotes"
      onClose={onClose}
      width={600}
      minWidth={360}
      minHeight={280}
      resizable="both"
      className={remoteStyles.dialog}
      buttons={[{ label: "OK", role: "default", autoFocus: true, onClick: onClose }]}
    >
      <div className={remoteStyles.content}>
        <RepoPicker repo={repo} onChange={setRepo} />
        {/* Keyed: picking another repository starts a fresh list, so answers for the previous one are dropped. */}
        <RemotesList key={repo} repo={repo} />
      </div>
    </Dialog>
  );
}

function RemotesList({ repo }: { repo: string | null }) {
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    call(commands.vcsRemotes(repo))
      .then((list) => {
        setRemotes(list);
        setSelected((s) => (s && list.some((r) => r.name === s) ? s : (list[0]?.name ?? null)));
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void reload();
  }, []);

  const apply = async (edit: Parameters<typeof commands.vcsEditRemote>[1]) => {
    try {
      await call(commands.vcsEditRemote(repo, edit));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
    await reload();
    void loadBranches().catch(() => undefined);
  };
  const edit = (remote?: Remote) =>
    openDialog((close) => (
      <RemoteEditDialog
        remote={remote}
        existing={remotes.map((r) => r.name).filter((n) => n !== remote?.name)}
        onDone={(r) => {
          close();
          if (!r) return;
          void apply(
            remote
              ? { op: "edit", name: remote.name, new_name: r.name, url: r.url }
              : { op: "add", name: r.name, url: r.url },
          );
        }}
      />
    ));
  const remove = async () => {
    if (!selected) return;
    const ok = await confirmDialog({
      title: "Remove Remote",
      message: tx`Remove remote '${selected}'? Its remote-tracking branches are deleted.`,
      okLabel: "Remove",
      danger: true,
    });
    if (ok) await apply({ op: "remove", name: selected });
  };
  const current = remotes.find((r) => r.name === selected);

  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, remote: Remote) => {
    if (event.key === "Enter") {
      event.preventDefault();
      edit(remote);
      return;
    }
    const row = event.currentTarget;
    const index = listNavigate(event.key, { items: remotes, active: row.sectionRowIndex });
    if (index === null) return;
    event.preventDefault();
    const target = row.closest("tbody")?.rows.item(index);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return (
    <>
      <div className={remoteStyles.panel}>
        <div className={remoteStyles.toolbar} role="toolbar" aria-label={tx("Remotes")}>
          <IconButton icon="plus" title="Add Remote…" size="small" onClick={() => edit()} />
          <IconButton
            icon="minus"
            title="Remove Remote"
            size="small"
            disabled={!current}
            onClick={() => void remove()}
          />
          <IconButton icon="edit" title="Edit Remote…" size="small" disabled={!current} onClick={() => edit(current)} />
        </div>
        <div className={remoteStyles.scroller}>
          <table className={remoteStyles.table} role="grid" aria-label={tx("Remotes")}>
            <colgroup>
              <col className={remoteStyles.nameColumn} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <T>Name</T>
                </th>
                <th scope="col">
                  <T>URL</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {!remotes.length && (
                <tr>
                  <td colSpan={2} className={styles.empty}>
                    <T>No remotes</T>
                  </td>
                </tr>
              )}
              {remotes.map((r) => (
                <tr
                  key={r.name}
                  aria-selected={r.name === selected}
                  tabIndex={r.name === selected ? 0 : -1}
                  onFocus={() => setSelected(r.name)}
                  onClick={(e) => e.currentTarget.focus({ preventScroll: true })}
                  onDoubleClick={() => edit(r)}
                  onKeyDown={(e) => onRowKey(e, r)}
                >
                  <td title={r.name}>{r.name}</td>
                  <td title={r.url}>{r.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {error && (
        <div className={clsx(styles.error, remoteStyles.error)} role="alert">
          {error}
        </div>
      )}
    </>
  );
}

function RemoteEditDialog({
  remote,
  existing,
  onDone,
}: {
  remote?: Remote;
  existing: readonly string[];
  onDone: (r: { name: string; url: string } | null) => void | Promise<void>;
}) {
  const [name, setName] = useState(remote?.name ?? (existing.includes("origin") ? "" : "origin"));
  const [url, setUrl] = useState(remote?.url ?? "");
  const nameId = useId();
  const urlId = useId();
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const error = validateRemoteName(name, existing) ?? (url.trim() ? null : "Enter the remote URL");
  const visibleError = error ?? serverError;
  const submit = async () => {
    if (error || saving) return;
    setSaving(true);
    setServerError(null);
    try {
      await onDone({ name: name.trim(), url: url.trim() });
    } catch (e) {
      setServerError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      title={remote ? "Edit Remote" : "Define Remote"}
      onClose={() => {
        if (!saving) void onDone(null);
      }}
      width={460}
      buttons={[
        { label: "OK", role: "default", disabled: !!error || saving, onClick: () => void submit() },
        { label: "Cancel", role: "cancel", disabled: saving },
      ]}
    >
      <form
        className={remoteStyles.editor}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={nameId}>
          <T>Name:</T>
        </label>
        <Input
          id={nameId}
          data-autofocus
          aria-label="Name"
          value={name}
          disabled={saving}
          onChange={(e) => {
            setName(e.target.value);
            setServerError(null);
          }}
        />
        <label htmlFor={urlId}>
          <T>URL:</T>
        </label>
        <Input
          id={urlId}
          aria-label="URL"
          mono
          value={url}
          disabled={saving}
          onChange={(e) => {
            setUrl(e.target.value);
            setServerError(null);
          }}
        />
        {visibleError && (name || url) && (
          <div className={clsx(styles.error, remoteStyles.error)} role="alert">
            {tx(visibleError)}
          </div>
        )}
      </form>
    </Dialog>
  );
}
