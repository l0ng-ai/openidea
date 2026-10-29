/** Git menu dialogs: Pull…, Merge…, Rebase…, Manage Remotes… and Worktrees. */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Branch, MergeOptions, Remote, Worktree } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { Checkbox, Dialog, IconButton, Input, Select, T, type SelectOption } from "@/ui";
import { sortLocal, sortRemote } from "./branches";
import { conflictActions, openConflictsInstead, validateBranchName } from "./branchOps";
import { confirmDialog, openDialog } from "./dialogs";
import { errorMessage, runOp, runRemote, saveAll } from "./ops";
import { currentRepo, loadBranches, refreshNow, repoName, selectRepo, useVcs } from "./store";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

// --- shared -----------------------------------------------------------------

export type MergeFlag = "noFf" | "ffOnly" | "squash" | "noCommit";

/** Flags git refuses together with `flag`. */
const EXCLUSIVE: Record<MergeFlag, MergeFlag[]> = {
  noFf: ["ffOnly", "squash"],
  ffOnly: ["noFf", "squash", "noCommit"],
  squash: ["noFf", "ffOnly"],
  noCommit: ["ffOnly"],
};

/** Merge flags that cannot be turned on next to the `on` ones (and with `--rebase`). */
export function disabledMergeFlags(on: ReadonlySet<MergeFlag>, rebase = false): Set<MergeFlag> {
  if (rebase) return new Set<MergeFlag>(["noFf", "ffOnly", "squash", "noCommit"]);
  const out = new Set<MergeFlag>();
  for (const f of on) for (const x of EXCLUSIVE[f]) out.add(x);
  return out;
}

export function mergeOptionsOf(on: ReadonlySet<MergeFlag>, message: string | null = null): MergeOptions {
  return {
    noFf: on.has("noFf"),
    ffOnly: on.has("ffOnly"),
    squash: on.has("squash"),
    noCommit: on.has("noCommit"),
    message: message?.trim() || null,
  };
}

const FLAG_LABELS: Array<[MergeFlag, string]> = [
  ["noFf", "--no-ff"],
  ["ffOnly", "--ff-only"],
  ["squash", "--squash"],
  ["noCommit", "--no-commit"],
];

function MergeFlags({
  on,
  setOn,
  rebase = false,
}: {
  on: Set<MergeFlag>;
  setOn: (next: Set<MergeFlag>) => void;
  rebase?: boolean;
}) {
  const disabled = disabledMergeFlags(on, rebase);
  return (
    <div className={styles.optionGrid} role="group" aria-label={tx("Merge options")}>
      {FLAG_LABELS.map(([flag, label]) => (
        <Checkbox
          key={flag}
          label={label}
          checked={on.has(flag)}
          disabled={disabled.has(flag) && !on.has(flag)}
          onChange={(v) => {
            const next = new Set(on);
            if (v) next.add(flag);
            else next.delete(flag);
            setOn(next);
          }}
        />
      ))}
    </div>
  );
}

function useBranches(): Branch[] {
  const [repo] = useState(currentRepo);
  const [branches, setBranches] = useState<Branch[]>([]);
  useEffect(() => {
    let live = true;
    void call(commands.vcsBranches(repo))
      .then((b) => live && setBranches(b))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return branches;
}

const branchOptions = (list: readonly Branch[]): SelectOption[] =>
  list.filter((b) => !b.name.endsWith("/HEAD")).map((b) => ({ value: b.name, label: b.name, icon: "branch" }));

/** Remote branches of `remote` without the remote prefix (`origin/main` → `main`). */
export function remoteBranchesOf(branches: readonly Branch[], remote: string): string[] {
  const prefix = `${remote}/`;
  return sortRemote(branches)
    .filter((b) => b.name.startsWith(prefix) && b.name !== `${prefix}HEAD`)
    .map((b) => b.name.slice(prefix.length));
}

// --- Pull -------------------------------------------------------------------

export function showPullDialog() {
  openDialog((close) => <PullDialog onClose={close} />);
}

function PullDialog({ onClose }: { onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [info] = useState(() => useVcs.getState().branch);
  const branches = useBranches();
  const [remotes, setRemotes] = useState<Remote[] | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [chosenBranch, setBranch] = useState<string | null>(null);
  const [rebase, setRebase] = useState(false);
  const [flags, setFlags] = useState<Set<MergeFlag>>(() => new Set());

  useEffect(() => {
    let alive = true;
    call(commands.vcsRemotes(repo))
      .then((list) => {
        if (!alive) return;
        setRemotes(list);
        const upstreamRemote = info?.upstream?.split("/")[0];
        setRemote(list.find((r) => r.name === upstreamRemote)?.name ?? list[0]?.name ?? null);
      })
      .catch(() => alive && setRemotes([]));
    return () => {
      alive = false;
    };
  }, [info?.upstream]);

  const remoteBranches = useMemo(() => (remote ? remoteBranchesOf(branches, remote) : []), [branches, remote]);
  // Default: the upstream's branch, else the same name as the current branch.
  const upstream = remote && info?.upstream?.startsWith(`${remote}/`) ? info.upstream.slice(remote.length + 1) : null;
  const preferred = upstream ?? info?.head ?? null;
  const branch =
    chosenBranch && remoteBranches.includes(chosenBranch)
      ? chosenBranch
      : preferred && remoteBranches.includes(preferred)
        ? preferred
        : (remoteBranches[0] ?? null);

  const run = async () => {
    if (!remote) return;
    onClose();
    await saveAll();
    await runRemote(
      {
        op: "pullFrom",
        remote,
        branches: branch ? [branch] : [],
        rebase,
        options: mergeOptionsOf(rebase ? new Set() : flags),
      },
      `${info?.head ?? "HEAD"} ← ${remote}${branch ? `/${branch}` : ""}`,
      [repo],
    );
  };

  return (
    <Dialog
      open
      title={tx`Pull to ${info?.head ?? "HEAD"}`}
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Pull", role: "default", disabled: !remote, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        {remotes && !remotes.length ? (
          <div className={styles.hint}>
            <T>No remotes are configured. Add one with Git › Manage Remotes….</T>
          </div>
        ) : (
          <div className={styles.fieldRow}>
            <Select
              aria-label="Remote"
              value={remote}
              options={(remotes ?? []).map((r) => ({ value: r.name, label: r.name, detail: r.url }))}
              onChange={setRemote}
            />
            <Select
              aria-label="Remote branch"
              className={styles.grow}
              value={branch}
              placeholder="Branch"
              options={remoteBranches.map((b) => ({ value: b, label: b, icon: "branch" }))}
              onChange={setBranch}
            />
          </div>
        )}
        <div className={styles.fieldLabel}>
          <T>Options:</T>
        </div>
        <Checkbox label="--rebase" checked={rebase} onChange={setRebase} />
        <MergeFlags on={flags} setOn={setFlags} rebase={rebase} />
        <div className={styles.hint}>
          <T>Uncommitted changes are stashed before the pull and restored afterwards.</T>
        </div>
      </div>
    </Dialog>
  );
}

// --- Merge ------------------------------------------------------------------

export function showMergeDialog() {
  openDialog((close) => <MergeDialog onClose={close} />);
}

function MergeDialog({ onClose }: { onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [head] = useState(() => useVcs.getState().branch?.head ?? null);
  const branches = useBranches();
  const [branch, setBranch] = useState<string | null>(null);
  const [flags, setFlags] = useState<Set<MergeFlag>>(() => new Set());
  const [withMessage, setWithMessage] = useState(false);
  const [message, setMessage] = useState("");
  const options = useMemo(
    () => [...branchOptions(sortLocal(branches).filter((b) => !b.current)), ...branchOptions(sortRemote(branches))],
    [branches],
  );

  const run = async () => {
    if (!branch) return;
    onClose();
    await saveAll();
    const target = head ?? "HEAD";
    await runOp(
      `Merge ${branch} into ${target}`,
      () => call(commands.vcsMergeWith(repo, [branch], mergeOptionsOf(flags, withMessage ? message : null))),
      { success: `Merged ${branch} into ${target}`, errorActions: conflictActions, onError: openConflictsInstead },
    );
    await refreshNow();
  };

  return (
    <Dialog
      open
      title={tx`Merge into ${head ?? "HEAD"}`}
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Merge", role: "default", disabled: !branch, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.fieldLabel}>
          <T>Branch to merge:</T>
        </div>
        <Select
          aria-label="Branch to merge"
          value={branch}
          placeholder="Select branch"
          options={options}
          onChange={setBranch}
        />
        <div className={styles.fieldLabel}>
          <T>Options:</T>
        </div>
        <MergeFlags on={flags} setOn={setFlags} />
        <Checkbox label="-m (commit message)" checked={withMessage} onChange={setWithMessage} />
        {withMessage && (
          <Input
            aria-label="Commit message"
            value={message}
            placeholder={branch ? tx`Merge branch '${branch}' into ${head ?? "HEAD"}` : ""}
            onChange={(e) => setMessage(e.target.value)}
          />
        )}
      </div>
    </Dialog>
  );
}

// --- Rebase -----------------------------------------------------------------

export function showRebaseDialog() {
  openDialog((close) => <RebaseDialog onClose={close} />);
}

function RebaseDialog({ onClose }: { onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [head] = useState(() => useVcs.getState().branch?.head ?? null);
  const branches = useBranches();
  const [upstream, setUpstream] = useState<string | null>(null);
  const [useOnto, setUseOnto] = useState(false);
  const [onto, setOnto] = useState<string | null>(null);
  const [rebaseMerges, setRebaseMerges] = useState(false);
  const [keepEmpty, setKeepEmpty] = useState(false);
  const options = useMemo(
    () => [...branchOptions(sortLocal(branches).filter((b) => !b.current)), ...branchOptions(sortRemote(branches))],
    [branches],
  );
  const ready = !!upstream && (!useOnto || !!onto);

  const run = async () => {
    if (!upstream) return;
    onClose();
    await saveAll();
    const target = useOnto && onto ? onto : upstream;
    const current = head ?? "HEAD";
    await runOp(
      `Rebase ${current} onto ${target}`,
      () =>
        call(
          commands.vcsRebaseWith(repo, upstream, {
            onto: useOnto ? onto : null,
            rebaseMerges,
            keepEmpty,
          }),
        ),
      { success: `Rebased ${current} onto ${target}`, errorActions: conflictActions, onError: openConflictsInstead },
    );
    await refreshNow();
  };

  return (
    <Dialog
      open
      title="Rebase"
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Rebase", role: "default", disabled: !ready, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.fieldLabel}>
          {useOnto ? tx`Rebase commits of ${head ?? "HEAD"} not on:` : `Rebase ${head ?? "HEAD"} onto:`}
        </div>
        <Select
          aria-label="Upstream"
          value={upstream}
          placeholder="Select branch"
          options={options}
          onChange={setUpstream}
        />
        <Checkbox label="--onto" checked={useOnto} onChange={setUseOnto} />
        {useOnto && (
          <Select aria-label="New base" value={onto} placeholder="New base" options={options} onChange={setOnto} />
        )}
        <Checkbox label="--rebase-merges" checked={rebaseMerges} onChange={setRebaseMerges} />
        <Checkbox label="--keep-empty" checked={keepEmpty} onChange={setKeepEmpty} />
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

function RemotesDialog({ onClose }: { onClose: () => void }) {
  const [repo] = useState(currentRepo);
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

  return (
    <Dialog
      open
      title="Git Remotes"
      onClose={onClose}
      width={560}
      buttons={[{ label: "OK", role: "default", autoFocus: true, onClick: onClose }]}
    >
      <div className={styles.form}>
        <div className={styles.manageBar} role="toolbar" aria-label={tx("Remotes")}>
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
        <div className={styles.choiceList} role="listbox" aria-label={tx("Remotes")}>
          {!remotes.length && (
            <div className={styles.empty}>
              <T>No remotes</T>
            </div>
          )}
          {remotes.map((r) => (
            <button
              key={r.name}
              type="button"
              role="option"
              aria-selected={r.name === selected}
              className={clsx(styles.manageRow, r.name === selected && styles.manageRowSelected)}
              onClick={() => setSelected(r.name)}
              onDoubleClick={() => edit(r)}
            >
              <span className={styles.fileName}>{r.name}</span>
              <span className={clsx(styles.fileDir, styles.mono)}>{r.url}</span>
            </button>
          ))}
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  );
}

function RemoteEditDialog({
  remote,
  existing,
  onDone,
}: {
  remote?: Remote;
  existing: readonly string[];
  onDone: (r: { name: string; url: string } | null) => void;
}) {
  const [name, setName] = useState(remote?.name ?? (existing.includes("origin") ? "" : "origin"));
  const [url, setUrl] = useState(remote?.url ?? "");
  const error = validateRemoteName(name, existing) ?? (url.trim() ? null : "Enter the remote URL");
  const submit = () => {
    if (!error) onDone({ name: name.trim(), url: url.trim() });
  };
  return (
    <Dialog
      open
      title={remote ? "Edit Remote" : "Define Remote"}
      onClose={() => onDone(null)}
      width={460}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={styles.fieldLabel}>
          <T>Name:</T>
        </label>
        <Input data-autofocus aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className={styles.fieldLabel}>
          <T>URL:</T>
        </label>
        <Input aria-label="URL" mono value={url} onChange={(e) => setUrl(e.target.value)} />
        {error && (name || url) && <div className={styles.error}>{error}</div>}
      </form>
    </Dialog>
  );
}

// --- Worktrees --------------------------------------------------------------

/** Default folder of a new worktree: next to the repository, `<repo>-<branch>`. */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const sep = repoRoot.includes("\\") && !repoRoot.includes("/") ? "\\" : "/";
  const trimmed = repoRoot.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  const name = trimmed.slice(cut + 1);
  const suffix = branch.replace(/[\\/]/g, "-");
  return `${parent}${sep}${name}-${suffix || "worktree"}`;
}

export function showWorktrees() {
  openDialog((close) => <WorktreesDialog onClose={close} />);
}

export function showNewWorktree(onCreated?: () => void) {
  openDialog((close) => (
    <NewWorktreeDialog
      onClose={(created) => {
        close();
        if (created) onCreated?.();
      }}
    />
  ));
}

function WorktreesDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      title="Worktrees"
      onClose={onClose}
      width={620}
      buttons={[{ label: "Close", role: "default", autoFocus: true, onClick: onClose }]}
    >
      <WorktreesPanel className={styles.form} />
    </Dialog>
  );
}

/**
 * The worktrees of the current repository with New / Remove / Open: the Worktrees
 * dialog's content and the Git tool window's Worktrees tab. `listClassName` replaces
 * the dialog's bordered list box.
 */
export function WorktreesPanel({ className, listClassName }: { className?: string; listClassName?: string }) {
  const repo = useVcs((s) => s.repo);
  const repos = useVcs((s) => s.roots);
  const [list, setList] = useState<Worktree[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    call(commands.vcsWorktrees(repo))
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void reload();
  }, [repo]);
  const current = list.find((w) => w.path === selected);

  const remove = async () => {
    if (!current || current.main) return;
    const ok = await confirmDialog({
      title: "Remove Worktree",
      message: tx`Remove the worktree at ${current.path}? Its folder is deleted.`,
      okLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(commands.vcsRemoveWorktree(repo, current.path, false));
    } catch (e) {
      const force = await confirmDialog({
        title: "Remove Worktree",
        message: tx`${errorMessage(e)}\n\nRemove it anyway, discarding its changes?`,
        okLabel: "Force Remove",
        danger: true,
      });
      if (force)
        await call(commands.vcsRemoveWorktree(repo, current.path, true)).catch((x) => setError(errorMessage(x)));
    }
    setSelected(null);
    await reload();
  };

  return (
    <div className={className}>
      <div className={styles.manageBar} role="toolbar" aria-label={tx("Worktrees")}>
        {repos.length > 1 && (
          <Select
            aria-label="Repository"
            value={repo}
            options={repos.map((r) => ({ value: r, label: repoName(r) }))}
            onChange={(r) => void selectRepo(r)}
          />
        )}
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reload()} />
        <IconButton
          icon="plus"
          title="New Worktree…"
          size="small"
          onClick={() => showNewWorktree(() => void reload())}
        />
        <IconButton
          icon="minus"
          title="Remove Worktree"
          size="small"
          disabled={!current || current.main}
          onClick={() => void remove()}
        />
        <IconButton
          icon="folder"
          title="Open in New Window"
          size="small"
          disabled={!current}
          onClick={() => current && void executeAction("file.openProjectPath", current.path)}
        />
      </div>
      <div className={listClassName ?? styles.choiceList} role="listbox" aria-label={tx("Worktrees")}>
        {list.map((w) => (
          <button
            key={w.path}
            type="button"
            role="option"
            aria-selected={w.path === selected}
            className={clsx(styles.manageRow, w.path === selected && styles.manageRowSelected)}
            onClick={() => setSelected(w.path)}
            onDoubleClick={() => void executeAction("file.openProjectPath", w.path)}
          >
            <span className={styles.fileName}>{w.branch ?? (w.head ? w.head.slice(0, 8) : <T>(bare)</T>)}</span>
            <span className={clsx(styles.fileDir, styles.mono)}>{w.path}</span>
            {(w.main || w.locked || w.prunable) && (
              <span className={styles.fileDir}>{w.main ? "main" : w.locked ? tx("locked") : tx("prunable")}</span>
            )}
          </button>
        ))}
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

function NewWorktreeDialog({ onClose }: { onClose: (created: boolean) => void }) {
  const [repo] = useState(currentRepo);
  const [root] = useState(() => useVcs.getState().repo ?? useVcs.getState().root ?? "");
  const branches = useBranches();
  const [source, setSource] = useState<string | null>(null);
  const [createBranch, setCreateBranch] = useState(true);
  const [newBranch, setNewBranch] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(
    () => [...branchOptions(sortLocal(branches)), ...branchOptions(sortRemote(branches))],
    [branches],
  );
  const sourceRemote = branches.find((b) => b.name === source)?.remote ?? false;
  // A remote branch `origin/x` suggests the local name `x`.
  const shortSource = source && sourceRemote ? source.slice(source.indexOf("/") + 1) : (source ?? "");
  const suggestedBranch = source ? (sourceRemote ? shortSource : `${shortSource}-wt`) : "";
  const branchName = newBranch.trim() || suggestedBranch;
  const target = path ?? (source ? defaultWorktreePath(root, createBranch ? branchName : shortSource) : "");
  const invalid = !source
    ? "Choose what to check out"
    : createBranch
      ? validateBranchName(branchName)
      : !target.trim()
        ? "Enter a folder"
        : null;

  const create = async () => {
    if (invalid || !source) return;
    try {
      await call(commands.vcsAddWorktree(repo, target.trim(), source, createBranch ? branchName : null));
      notifications().notify({ group: "vcs", level: "info", title: `Created worktree at ${target.trim()}` });
      void loadBranches().catch(() => undefined);
      onClose(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      title="New Worktree"
      onClose={() => onClose(false)}
      width={520}
      buttons={[
        { label: "Create", role: "default", disabled: !!invalid, onClick: () => void create() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.fieldLabel}>
          <T>Check out:</T>
        </div>
        <Select
          aria-label="Check out"
          value={source}
          placeholder="Select branch"
          options={options}
          onChange={setSource}
        />
        <Checkbox label="Create a new branch" checked={createBranch} onChange={setCreateBranch} />
        {createBranch && (
          <Input
            aria-label="New branch name"
            mono
            value={newBranch}
            placeholder={suggestedBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
        )}
        <div className={styles.fieldLabel}>
          <T>Folder:</T>
        </div>
        <Input aria-label="Folder" mono value={target} onChange={(e) => setPath(e.target.value)} />
        {(error ?? (source && invalid)) && <div className={styles.error}>{error ?? invalid}</div>}
      </div>
    </Dialog>
  );
}
