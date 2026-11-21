/** Git menu dialogs: Pull…, Merge…, Rebase…, Manage Remotes… and Worktrees. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { Branch, BranchInfo, MergeOptions, Remote, Worktree } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { openWorktree } from "./openWorktree";
import {
  Button,
  Checkbox,
  Dialog,
  HighlightedText,
  Icon,
  IconButton,
  Input,
  Menu,
  Select,
  T,
  Tree,
  listNavigate,
  useSanitizedField,
  type SelectOption,
  type SelectProps,
  type MenuItem,
} from "@/ui";
import { useRowHeight } from "@/ui/density";
import { sortLocal, sortRemote } from "./branches";
import { branchRef, conflictActions, openConflictsInstead, validateBranchName } from "./branchOps";
import { joinPath } from "./clone";
import { cleanUpBranchNameOnTyping } from "@/platform/gitRefName";
import { confirmDialog, openDialog } from "./dialogs";
import { errorMessage, runOp, runRemote, saveAll } from "./ops";
import { baseName } from "./model";
import { currentRepo, loadBranches, refreshNow, repoName, useVcs } from "./store";
import {
  groupWorktrees,
  isCurrentWorktree,
  worktreeContainsProject,
  worktreeMoveTarget,
  type RepoWorktrees,
} from "./worktrees";
import styles from "./common.module.css";
import remoteStyles from "./GitRemotes.module.css";
import commandStyles from "./GitCommandDialog.module.css";
import worktreeStyles from "./Worktrees.module.css";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";

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

function mergeFlagItems(
  flags: ReadonlySet<MergeFlag>,
  setFlags: (flags: Set<MergeFlag>) => void,
  rebase = false,
): MenuItem[] {
  const disabled = disabledMergeFlags(flags, rebase);
  return FLAG_LABELS.map(([flag, label]) => ({
    label,
    verbatim: true,
    checked: flags.has(flag),
    disabled: disabled.has(flag) && !flags.has(flag),
    run: () => {
      const next = new Set(flags);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      setFlags(next);
    },
  }));
}

function ModifyOptions({ items }: { items: MenuItem[] }) {
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

const emptyBranches: Branch[] = [];

function useBranches(repo: string | null): Branch[] {
  const [loaded, setLoaded] = useState<{ repo: string | null; branches: Branch[] } | null>(null);
  useEffect(() => {
    let live = true;
    void call(commands.vcsBranches(repo))
      .then((branches) => live && setLoaded({ repo, branches }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo]);
  return loaded?.repo === repo ? loaded.branches : emptyBranches;
}

const branchOptions = (list: readonly Branch[]): SelectOption[] =>
  list.filter((b) => !b.name.endsWith("/HEAD")).map((b) => ({ value: b.name, label: b.name, icon: "branch" }));

/** Every branch choice in these dialogs: repositories hold hundreds of branches, so type to filter, Enter picks. */
function BranchSelect(props: Omit<SelectProps, "searchable">) {
  return <Select {...props} searchable />;
}

/** Remote branches of `remote` without the remote prefix (`origin/main` → `main`). */
export function remoteBranchesOf(branches: readonly Branch[], remote: string): string[] {
  const prefix = `${remote}/`;
  return sortRemote(branches)
    .filter((b) => b.name.startsWith(prefix) && b.name !== `${prefix}HEAD`)
    .map((b) => b.name.slice(prefix.length));
}

// --- Pull -------------------------------------------------------------------

/** `repo`: the repository it starts on (the context's), else the selected one. */
export function showPullDialog(repo?: string | null) {
  openDialog((close) => <PullDialog initialRepo={repo} onClose={close} />);
}

/** IDEA's Git Root choice: shown only when the project holds several repositories. */
export function RepoPicker({
  id,
  repo,
  onChange,
  className,
}: {
  id?: string;
  repo: string | null;
  onChange: (root: string) => void;
  className?: string;
}) {
  const [roots] = useState(() => useVcs.getState().roots);
  if (roots.length < 2) return null;
  return (
    <Select
      id={id}
      aria-label="Repository"
      className={className}
      value={repo ?? roots[0] ?? null}
      options={roots.map((root) => ({ value: root, label: repoName(root), verbatim: true }))}
      onChange={onChange}
    />
  );
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

function PullDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const [repo, setRepo] = useState(() => (initialRepo === undefined ? currentRepo() : initialRepo));
  const info = useBranchInfo(repo);
  const branches = useBranches(repo);
  const [remotes, setRemotes] = useState<Remote[] | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [chosenBranch, setBranch] = useState<string | null>(null);
  const [rebase, setRebase] = useState(false);
  const [flags, setFlags] = useState<Set<MergeFlag>>(() => new Set());

  const chooseRepo = (root: string) => {
    if (root === repo) return;
    setRepo(root);
    setRemotes(null);
    setRemote(null);
    setBranch(null);
  };

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
  }, [repo, info?.upstream]);

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
  const selectedFlags = rebase
    ? ["--rebase"]
    : FLAG_LABELS.filter(([flag]) => flags.has(flag)).map(([, label]) => label);
  const options: MenuItem[] = [
    { label: "--rebase", verbatim: true, checked: rebase, run: () => setRebase(!rebase) },
    ...mergeFlagItems(flags, setFlags, rebase),
  ];

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
      width={640}
      footerStart={<ModifyOptions items={options} />}
      buttons={[
        { label: "Pull", role: "default", disabled: !remote, onClick: () => void run() },
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
                onChange={setRemote}
              />
              <BranchSelect
                aria-label="Remote branch"
                className={commandStyles.branch}
                value={branch}
                renderValue={(option) => (option ? <span title={option.label}>{option.label}</span> : <T>Branch</T>)}
                options={remoteBranches.map((b) => ({ value: b, label: b, icon: "branch", verbatim: true }))}
                onChange={setBranch}
              />
            </div>
          )}
        </div>
        {selectedFlags.length > 0 && (
          <div className={commandStyles.flags} role="group" aria-label={tx("Options:")}>
            {selectedFlags.map((label) => (
              <code key={label}>{label}</code>
            ))}
          </div>
        )}
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

function MergeDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const messageId = useId();
  const [repo, setRepo] = useState(() => (initialRepo === undefined ? currentRepo() : initialRepo));
  const head = useBranchInfo(repo)?.head ?? null;
  const branches = useBranches(repo);
  const [branch, setBranch] = useState<string | null>(null);
  const [flags, setFlags] = useState<Set<MergeFlag>>(() => new Set());
  const [withMessage, setWithMessage] = useState(false);
  const [message, setMessage] = useState("");
  const branchChoices = useMemo(
    () => [...branchOptions(sortLocal(branches).filter((b) => !b.current)), ...branchOptions(sortRemote(branches))],
    [branches],
  );
  const optionItems: MenuItem[] = [
    ...mergeFlagItems(flags, setFlags),
    { label: "-m (commit message)", checked: withMessage, run: () => setWithMessage(!withMessage) },
  ];
  const selectedFlags = FLAG_LABELS.filter(([flag]) => flags.has(flag)).map(([, label]) => label);
  if (withMessage) selectedFlags.push("-m");

  const chooseRepo = (root: string) => {
    if (root === repo) return;
    setRepo(root);
    setBranch(null);
  };

  const run = async () => {
    if (!branch) return;
    onClose();
    await saveAll();
    const target = head ?? "HEAD";
    await runOp(
      tx`Merge ${branch} into ${target}`,
      () => call(commands.vcsMergeWith(repo, [branch], mergeOptionsOf(flags, withMessage ? message : null))),
      { success: tx`Merged ${branch} into ${target}`, errorActions: conflictActions, onError: openConflictsInstead },
    );
    await refreshNow();
  };

  return (
    <Dialog
      open
      title={tx`Merge into ${head ?? "HEAD"}`}
      onClose={onClose}
      width={640}
      footerStart={<ModifyOptions items={optionItems} />}
      buttons={[
        { label: "Merge", role: "default", disabled: !branch, onClick: () => void run() },
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
              value={branch}
              placeholder="Select branch"
              options={branchChoices}
              onChange={setBranch}
            />
          </div>
        </div>
        {selectedFlags.length > 0 && (
          <div className={commandStyles.flags} role="group" aria-label={tx("Merge options")}>
            {selectedFlags.map((label) => (
              <code key={label}>{label}</code>
            ))}
          </div>
        )}
        {withMessage && (
          <div className={commandStyles.message}>
            <label htmlFor={messageId}>
              <T>Commit message</T>
            </label>
            <textarea
              id={messageId}
              className={styles.textarea}
              rows={4}
              value={message}
              placeholder={branch ? tx`Merge branch '${branch}' into ${head ?? "HEAD"}` : ""}
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

function RebaseDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const upstreamId = useId();
  const [repo, setRepo] = useState(() => (initialRepo === undefined ? currentRepo() : initialRepo));
  const head = useBranchInfo(repo)?.head ?? null;
  const branches = useBranches(repo);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [useOnto, setUseOnto] = useState(false);
  const [onto, setOnto] = useState<string | null>(null);
  const [rebaseMerges, setRebaseMerges] = useState(false);
  const [keepEmpty, setKeepEmpty] = useState(false);
  const branchChoices = useMemo(
    () => [...branchOptions(sortLocal(branches).filter((b) => !b.current)), ...branchOptions(sortRemote(branches))],
    [branches],
  );
  const optionItems: MenuItem[] = [
    { label: "--onto", verbatim: true, checked: useOnto, run: () => setUseOnto(!useOnto) },
    { label: "--rebase-merges", verbatim: true, checked: rebaseMerges, run: () => setRebaseMerges(!rebaseMerges) },
    { label: "--keep-empty", verbatim: true, checked: keepEmpty, run: () => setKeepEmpty(!keepEmpty) },
  ];
  const selectedFlags = [rebaseMerges ? "--rebase-merges" : null, keepEmpty ? "--keep-empty" : null].filter(
    (label) => label !== null,
  );
  const ready = !!upstream && (!useOnto || !!onto);
  const upstreamPicker = (
    <BranchSelect
      id={upstreamId}
      aria-label={useOnto ? "Old base" : "Upstream"}
      className={commandStyles.branch}
      value={upstream}
      placeholder="Select branch"
      options={branchChoices}
      onChange={setUpstream}
    />
  );

  const chooseRepo = (root: string) => {
    if (root === repo) return;
    setRepo(root);
    setUpstream(null);
    setOnto(null);
  };

  const run = async () => {
    if (!ready || !upstream) return;
    onClose();
    await saveAll();
    const target = useOnto && onto ? onto : upstream;
    const current = head ?? "HEAD";
    await runOp(
      tx`Rebase ${current} onto ${target}`,
      () =>
        call(
          commands.vcsRebaseWith(repo, upstream, {
            onto: useOnto ? onto : null,
            rebaseMerges,
            keepEmpty,
          }),
        ),
      { success: tx`Rebased ${current} onto ${target}`, errorActions: conflictActions, onError: openConflictsInstead },
    );
    await refreshNow();
  };

  return (
    <Dialog
      open
      title={tx`Rebase ${head ?? "HEAD"}`}
      onClose={onClose}
      width={640}
      footerStart={<ModifyOptions items={optionItems} />}
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
                <BranchSelect
                  aria-label="New base"
                  className={commandStyles.branch}
                  value={onto}
                  placeholder="New base"
                  options={branchChoices}
                  onChange={setOnto}
                />
              </>
            ) : (
              upstreamPicker
            )}
          </div>
        </div>
        {useOnto && (
          <div className={commandStyles.rebaseBase}>
            <label htmlFor={upstreamId} title={tx`Rebase commits of ${head ?? "HEAD"} not on:`}>
              <T>Old base</T>
            </label>
            {upstreamPicker}
          </div>
        )}
        {selectedFlags.length > 0 && (
          <div className={commandStyles.flags} role="group" aria-label={tx("Rebase options")}>
            {selectedFlags.map((label) => (
              <code key={label}>{label}</code>
            ))}
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
  onDone: (r: { name: string; url: string } | null) => void;
}) {
  const [name, setName] = useState(remote?.name ?? (existing.includes("origin") ? "" : "origin"));
  const [url, setUrl] = useState(remote?.url ?? "");
  const nameId = useId();
  const urlId = useId();
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
        className={remoteStyles.editor}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={nameId}>
          <T>Name:</T>
        </label>
        <Input id={nameId} data-autofocus aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor={urlId}>
          <T>URL:</T>
        </label>
        <Input id={urlId} aria-label="URL" mono value={url} onChange={(e) => setUrl(e.target.value)} />
        {error && (name || url) && (
          <div className={clsx(styles.error, remoteStyles.error)} role="alert">
            {error}
          </div>
        )}
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

type WorktreeSource = Pick<Branch, "name" | "remote" | "current">;

export function showNewWorktree({
  onCreated,
  repo,
  branch,
  open = false,
}: {
  onCreated?: () => void;
  repo?: string | null;
  branch?: WorktreeSource;
  open?: boolean;
} = {}) {
  openDialog((close) => (
    <NewWorktreeDialog
      repo={repo}
      branch={branch}
      openAfterCreate={open}
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

/** A repository section of the Worktrees tree; its children are the repository's worktrees. */
interface WorktreeNode {
  key: string;
  label: string;
  worktree?: { entry: Worktree; branch: string };
  children?: WorktreeNode[];
}

/**
 * The worktrees of every project repository, shown in the dialog and in the Git tool window.
 */
export function WorktreesPanel({ className, listClassName }: { className?: string; listClassName?: string }) {
  const rowHeight = useRowHeight(40);
  const projectRoot = useProject((s) => s.project?.root);
  const repo = useVcs((s) => s.repo);
  const repos = useVcs((s) => s.roots);
  const [groups, setGroups] = useState<RepoWorktrees[]>([]);
  /** The selected tree row (`r:` repository, `w:` worktree). */
  const [selected, setSelected] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<{ project: string | undefined; message: string } | null>(null);
  /** The last reload wins: a scan of the roots may change them while it runs. */
  const run = useRef(0);
  const mutationRun = useRef(0);
  const reload = () => {
    const id = ++run.current;
    return Promise.all(
      useVcs.getState().roots.map((root) =>
        call(commands.vcsWorktrees(root)).then(
          (worktrees): RepoWorktrees => ({ root, worktrees }),
          (e): RepoWorktrees => ({ root, worktrees: [], error: errorMessage(e) }),
        ),
      ),
    ).then((lists) => {
      if (id !== run.current) return;
      setGroups(groupWorktrees(lists));
    });
  };
  useEffect(() => {
    void reload();
  }, [repos]);
  const tree = useMemo(
    () =>
      groups.map((group): WorktreeNode => ({
        // The main worktree names a repository across reloads (its linked roots come and go).
        key: `r:${group.worktrees.find((w) => w.main)?.path ?? group.root}`,
        label: repoName(group.root),
        children: group.worktrees.map((w): WorktreeNode => ({
          key: `w:${w.path}`,
          label: baseName(w.path.replaceAll("\\", "/")) || w.path,
          worktree: { entry: w, branch: w.branch ?? (w.head ? w.head.slice(0, 8) : tx("(bare)")) },
        })),
      })),
    [groups],
  );
  const currentGroup = selected?.startsWith("w:")
    ? groups.find((g) => g.worktrees.some((w) => `w:${w.path}` === selected))
    : undefined;
  const current = currentGroup?.worktrees.find((w) => `w:${w.path}` === selected);
  const containsProject = !!current && worktreeContainsProject(current.path, projectRoot);
  const selectedKeys = useMemo(() => new Set(selected ? [selected] : []), [selected]);
  const isCurrent = (path: string) => repos.some((root) => isCurrentWorktree(path, root));

  const mutate = async (task: () => Promise<unknown>, selection: string | null) => {
    if (projectRoot !== useProject.getState().project?.root) return;
    const id = ++mutationRun.current;
    let failure: string | null = null;
    try {
      await task();
    } catch (e) {
      failure = errorMessage(e);
    }
    if (projectRoot !== useProject.getState().project?.root) return;
    if (id === mutationRun.current) {
      setMutationError(failure === null ? null : { project: projectRoot, message: failure });
      if (failure === null) setSelected(selection);
    }
    await reload();
  };

  const remove = async () => {
    if (!current || !currentGroup || current.main || containsProject) return;
    const ok = await confirmDialog({
      title: "Remove Worktree",
      message: tx`Remove the worktree at ${current.path}? Its folder is deleted.`,
      okLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await mutate(async () => {
      try {
        await call(commands.vcsRemoveWorktree(currentGroup.root, current.path, false));
      } catch (e) {
        if (projectRoot !== useProject.getState().project?.root) return;
        const force = await confirmDialog({
          title: "Remove Worktree",
          message: tx`${errorMessage(e)}\n\nRemove it anyway, discarding its changes?`,
          okLabel: "Force Remove",
          danger: true,
        });
        if (!force) throw e;
        if (projectRoot === useProject.getState().project?.root)
          await call(commands.vcsRemoveWorktree(currentGroup.root, current.path, true));
      }
    }, null);
  };

  const move = async () => {
    if (!current || !currentGroup || current.main || containsProject) return;
    const { open } = await import("@/platform/dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: tx("Move Worktree"),
      defaultPath: current.path.replace(/[\\/][^\\/]+[\\/]?$/, "") || undefined,
    });
    const folder = Array.isArray(picked) ? picked[0] : picked;
    if (!folder) return;
    const to = worktreeMoveTarget(current.path, folder);
    if (isCurrentWorktree(to, current.path)) return;
    const ok = await confirmDialog({
      title: "Move Worktree",
      message: tx`Move the worktree at ${current.path} to ${to}?`,
      okLabel: "Move",
    });
    if (!ok) return;
    await mutate(() => call(commands.vcsMoveWorktree(currentGroup.root, current.path, to)), `w:${to}`);
  };

  return (
    <div className={clsx(worktreeStyles.panel, className)}>
      <div className={worktreeStyles.body}>
        <div className={worktreeStyles.toolbar} role="toolbar" aria-label={tx("Worktrees")} aria-orientation="vertical">
          <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reload()} />
          <IconButton
            icon="plus"
            title="New Worktree…"
            size="small"
            onClick={() =>
              showNewWorktree({ onCreated: () => void reload(), repo: currentGroup?.root ?? repo ?? repos[0] })
            }
          />
          <IconButton
            icon="minus"
            title={containsProject ? "Cannot remove a worktree containing the open project." : "Remove Worktree"}
            aria-label="Remove Worktree"
            size="small"
            disabled={!current || current.main || containsProject}
            onClick={() => void remove()}
          />
          <IconButton
            icon="export"
            title={containsProject ? "Cannot move a worktree containing the open project." : "Move Worktree…"}
            aria-label="Move Worktree…"
            size="small"
            disabled={!current || current.main || containsProject}
            onClick={() => void move()}
          />
          <IconButton
            icon="folder"
            title="Open in New Window"
            size="small"
            disabled={!current}
            onClick={() => current && void openWorktree(current.path)}
          />
        </div>
        <Tree<WorktreeNode>
          // A new set of repositories starts with every section expanded.
          key={tree.map((n) => n.key).join("|")}
          roots={tree}
          getKey={(n) => n.key}
          getLabel={(n) => (n.worktree ? `${n.label} ${n.worktree.branch}` : n.label)}
          getChildren={(n) => n.children}
          isExpandable={(n) => !!n.children}
          renderNode={(node, { matches }) => {
            if (!node.worktree) {
              return (
                <>
                  <Icon name="folder" size={16} className={worktreeStyles.icon} />
                  <HighlightedText
                    className={worktreeStyles.truncated}
                    text={node.label}
                    indices={matches}
                    tone="accent"
                  />
                </>
              );
            }
            const { entry, branch } = node.worktree;
            const current = isCurrent(entry.path);
            const branchStart = node.label.length + 1;
            return (
              <>
                <Icon
                  name={current ? "check" : "folder"}
                  size={16}
                  label={current ? tx("current") : undefined}
                  className={clsx(worktreeStyles.icon, worktreeStyles.leading)}
                />
                <div className={worktreeStyles.details}>
                  <span className={worktreeStyles.line}>
                    <HighlightedText
                      className={clsx(worktreeStyles.truncated, entry.main && worktreeStyles.main)}
                      text={node.label}
                      indices={matches?.filter((i) => i < node.label.length)}
                      tone="accent"
                    />
                    {entry.locked && <Icon name="lock" size={12} label={tx("locked")} />}
                    {entry.prunable && <Icon name="warning" size={12} label={tx("prunable")} />}
                  </span>
                  <span className={worktreeStyles.secondary}>
                    <Icon name="branch" size={12} />
                    <HighlightedText
                      className={worktreeStyles.truncated}
                      text={branch}
                      indices={matches?.filter((i) => i >= branchStart).map((i) => i - branchStart)}
                      tone="accent"
                    />
                    <span className={clsx(worktreeStyles.path, worktreeStyles.truncated)} title={entry.path}>
                      {entry.path}
                    </span>
                  </span>
                </div>
              </>
            );
          }}
          defaultExpanded={tree.map((n) => n.key)}
          selected={selectedKeys}
          multiSelect={false}
          onSelectionChange={(selection) => setSelected([...selection][0] ?? null)}
          onActivate={(n) => n.worktree && void openWorktree(n.worktree.entry.path)}
          className={clsx(worktreeStyles.tree, listClassName ?? worktreeStyles.dialogTree)}
          rowHeight={rowHeight}
          aria-label="Worktrees"
        />
      </div>
      {groups.map(
        (group) =>
          group.error && (
            <div key={group.root} className={styles.error}>
              {group.error}
            </div>
          ),
      )}
      {mutationError && mutationError.project === projectRoot && (
        <div className={styles.error} role="alert">
          {mutationError.message}
        </div>
      )}
    </div>
  );
}

function NewWorktreeDialog({
  repo: initialRepo,
  branch,
  openAfterCreate,
  onClose,
}: {
  /** The repository to add the worktree to; the selected one when omitted. */
  repo?: string | null;
  branch?: WorktreeSource;
  openAfterCreate: boolean;
  onClose: (created: boolean) => void;
}) {
  const [repo] = useState(() => initialRepo ?? currentRepo());
  const [root] = useState(() => initialRepo ?? useVcs.getState().repo ?? useVcs.getState().root ?? "");
  const branches = useBranches(repo);
  const initialRef = branch ? branchRef(branch.name, branch.remote) : null;
  const [source, setSource] = useState(initialRef);
  const [createBranchChoice, setCreateBranch] = useState<boolean | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const { ref: branchInput, clean: cleanBranch } = useSanitizedField(cleanUpBranchNameOnTyping);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  useEffect(() => {
    let live = true;
    call(commands.vcsWorktrees(repo)).then(
      (worktrees) => live && setWorktrees(worktrees),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [repo]);
  const sources = useMemo(
    () => [...sortLocal(branches), ...sortRemote(branches)].filter((b) => !b.remote || !b.name.endsWith("/HEAD")),
    [branches],
  );
  const options: SelectOption[] = sources.map((b) => ({
    value: branchRef(b.name, b.remote),
    label: b.name,
    icon: "branch",
  }));
  if (branch && initialRef && !options.some((option) => option.value === initialRef)) {
    options.unshift({ value: initialRef, label: branch.name, icon: "branch" });
  }
  const selected =
    sources.find((b) => branchRef(b.name, b.remote) === source) ?? (source === initialRef ? branch : null);
  const checkedOut =
    !!selected && !selected.remote && (selected.current || worktrees.some((w) => w.branch === selected.name));
  const createBranch = checkedOut || selected?.remote || (createBranchChoice ?? !branch);
  const shortSource = selected?.remote ? selected.name.slice(selected.name.indexOf("/") + 1) : (selected?.name ?? "");
  const suggestedBranch =
    selected?.remote && !sources.some((b) => !b.remote && b.name === shortSource)
      ? shortSource
      : shortSource && `${shortSource}-wt`;
  const branchName = newBranch.trim() || suggestedBranch;
  const target = path ?? (source ? defaultWorktreePath(root, createBranch ? branchName : shortSource) : "");
  const invalid = !source
    ? "Choose what to check out"
    : !target.trim()
      ? "Enter a folder"
      : createBranch
        ? validateBranchName(branchName)
        : null;

  const create = async () => {
    if (invalid || !source || !selected || busy) return;
    const folder = target.trim();
    const absolute = /^([a-zA-Z]:)?[\\/]/.test(folder) ? folder : joinPath(root, folder);
    setBusy(true);
    setError(null);
    try {
      await call(
        commands.vcsAddWorktree(
          repo,
          absolute,
          createBranch ? source : selected.name,
          createBranch ? branchName : null,
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    notifications().notify({ group: "vcs", level: "info", title: `Created worktree at ${absolute}` });
    void loadBranches().catch(() => undefined);
    onClose(true);
    if (openAfterCreate) void openWorktree(absolute, true);
  };

  return (
    <Dialog
      open
      title="New Worktree"
      onClose={() => onClose(false)}
      width={520}
      buttons={[
        {
          label: openAfterCreate ? "Create and Open Worktree" : "Create",
          role: "default",
          disabled: busy || !!invalid,
          onClick: () => void create(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.fieldLabel}>
          <T>Check out:</T>
        </div>
        <BranchSelect
          aria-label="Check out"
          value={source}
          placeholder="Select branch"
          options={options}
          onChange={setSource}
        />
        <Checkbox
          label="Create a new branch"
          checked={!!createBranch}
          disabled={checkedOut || selected?.remote}
          onChange={setCreateBranch}
        />
        {createBranch && (
          <Input
            ref={branchInput}
            aria-label="New branch name"
            mono
            value={newBranch}
            placeholder={suggestedBranch}
            onChange={(e) => setNewBranch(cleanBranch(e))}
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
