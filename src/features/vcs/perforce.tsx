/**
 * Perforce: what a workspace offers beyond the Changes view it shares with Git
 * (commit = submit, rollback = revert, diff, history, annotate and changelists
 * work through the common actions). Sync, open for edit, reconcile, shelves,
 * resolve, integrate and login.
 */
import { useState } from "react";
import type { IntegrateKind, OperationResult, ResolveMode } from "@/bindings";
import { activeEditor } from "@/editor/api";
import { registerActions, type Action } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, Input, Select, T, type MenuItem } from "@/ui";
import { registerMenuGroup } from "@/workbench/contributions";
import { DEFAULT_LIST_ID, perforceChange, perforceRoot, useChangelists } from "./changelists";
import { useCommit } from "./commitStore";
import { confirmDialog, openDialog, promptText } from "./dialogs";
import { baseName } from "./model";
import { notify, runOp } from "./ops";
import { vcsKindOf } from "./store";
import styles from "./common.module.css";

const P4 = "vcsAvailable && vcsPerforce";

function argPaths(arg: unknown): string[] {
  if (Array.isArray(arg)) return arg.filter((x): x is string => typeof x === "string");
  if (typeof arg === "string") return [arg];
  if (arg && typeof arg === "object" && "path" in arg && typeof arg.path === "string") return [arg.path];
  return [];
}

/** The action's files: its argument, else the Commit window's selection, else the focused editor's file. */
function targets(arg: unknown): string[] {
  const explicit = argPaths(arg);
  if (explicit.length) return explicit;
  const selection = useCommit.getState().selection;
  if (selection.length) return [...selection];
  const path = activeEditor()?.ctx.path;
  return path ? [path] : [];
}

/** Notes of the server worth showing: files that need a resolve, files others hold open. */
function report(title: string, result: OperationResult | undefined) {
  const notes = result?.messages.filter((m) => /must resolve|can't|cannot|locked|also opened/i.test(m)) ?? [];
  if (notes.length) notify({ level: "warning", title, body: notes.slice(0, 8).join("\n") });
}

function fileCountText(n: number, one: string, many: (n: number) => string): string {
  return n === 1 ? one : many(n);
}

async function sync(paths: string[], rev: string | null) {
  const root = perforceRoot();
  const result = await runOp("Perforce Sync", () => call(commands.p4Sync(root, paths, rev, false, false)), {
    success: (r) =>
      r.files.length
        ? fileCountText(r.files.length, tx("1 file synced"), (n) => tx`${n} files synced`)
        : tx("All files are up to date"),
  });
  report(tx("Files need to be resolved"), result);
}

async function syncToRevision(paths: string[]) {
  const answer = await promptText({
    title: "Sync to Revision",
    label: "Changelist number, label or date:",
    placeholder: "123456",
    okLabel: "Sync",
    mono: true,
    validate: (v) => (v.trim() ? null : "Enter a revision"),
  });
  if (answer) await sync(paths, answer.value.trim());
}

async function openForEdit(paths: string[]) {
  if (!paths.length) return;
  const active = useChangelists.getState().state.active;
  const result = await runOp("Open for Edit", () => call(commands.p4Edit(paths, perforceChange(active))), {
    success: (r) => fileCountText(r.files.length, tx("1 file opened"), (n) => tx`${n} files opened`),
  });
  report(tx("Some files were not opened"), result);
}

async function revertUnchanged() {
  await runOp("Revert Unchanged Files", () => call(commands.p4RevertUnchanged(perforceRoot(), null)), {
    success: (r) =>
      r.files.length
        ? fileCountText(r.files.length, tx("1 unchanged file reverted"), (n) => tx`${n} unchanged files reverted`)
        : tx("No unchanged files are opened"),
  });
}

async function reconcile(paths: string[]) {
  const root = perforceRoot();
  const found = await runOp("Reconcile Offline Work", () => call(commands.p4Reconcile(root, paths, null, true)), {
    refresh: false,
  });
  if (!found) return;
  if (!found.files.length) {
    notify({ level: "info", title: tx("No offline changes found") });
    return;
  }
  const lines = found.files.slice(0, 12).map((f) => `${f.action}  ${baseName(f.path ?? f.depotFile)}`);
  if (found.files.length > lines.length) lines.push("…");
  const ok = await confirmDialog({
    title: "Reconcile Offline Work",
    okLabel: "Open Files",
    message: (
      <>
        <T>These files changed outside Perforce. Open them in the active changelist?</T>
        <pre className={styles.mono}>{lines.join("\n")}</pre>
      </>
    ),
  });
  if (!ok) return;
  const change = perforceChange(useChangelists.getState().state.active);
  await runOp("Reconcile Offline Work", () => call(commands.p4Reconcile(root, paths, change, false)), {
    success: (r) => fileCountText(r.files.length, tx("1 file opened"), (n) => tx`${n} files opened`),
  });
}

/** Asks for one of the numbered changelists; null when cancelled or there is none. */
function chooseChangelist(title: string, okLabel: string, only?: (id: string) => boolean): Promise<number | null> {
  const state = useChangelists.getState().state;
  const lists = state.lists.filter((l) => l.id !== DEFAULT_LIST_ID && (!only || only(l.id)));
  if (!lists.length) {
    notify({ level: "info", title: tx("No numbered changelist to choose from") });
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <ChooseDialog
        title={title}
        okLabel={okLabel}
        label="Changelist:"
        options={lists.map((l) => ({ value: l.id, label: `${l.id}: ${l.name}` }))}
        initial={lists.some((l) => l.id === state.active) ? state.active : lists[0]!.id}
        onDone={(id) => {
          close();
          resolve(id === null ? null : perforceChange(id));
        }}
      />
    ));
  });
}

function ChooseDialog(props: {
  title: string;
  okLabel: string;
  label: string;
  options: { value: string; label: string }[];
  initial: string;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <Dialog
      open
      title={props.title}
      width={420}
      onClose={() => props.onDone(null)}
      buttons={[
        { label: props.okLabel, role: "default", onClick: () => props.onDone(value) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <span className={styles.fieldLabel}>
          <T>{props.label}</T>
        </span>
        <Select value={value} aria-label={props.label} onChange={setValue} options={props.options} />
      </div>
    </Dialog>
  );
}

async function shelve() {
  const change = await chooseChangelist("Shelve Changelist", "Shelve");
  if (change === null) return;
  await runOp("Perforce Shelve", () => call(commands.p4Shelve(perforceRoot(), change, [])), {
    success: () => tx`Changelist ${change} shelved`,
  });
}

async function shelvedChangelists(): Promise<Set<string>> {
  const lists = await call(commands.p4Changelists(perforceRoot()));
  return new Set(lists.filter((l) => l.shelved).map((l) => String(l.number)));
}

async function unshelve() {
  const shelved = await shelvedChangelists();
  const change = await chooseChangelist("Unshelve", "Unshelve", (id) => shelved.has(id));
  if (change === null) return;
  const result = await runOp(
    "Perforce Unshelve",
    () => call(commands.p4Unshelve(perforceRoot(), change, null, [], false)),
    {
      success: (r) => fileCountText(r.files.length, tx("1 file unshelved"), (n) => tx`${n} files unshelved`),
    },
  );
  report(tx("Files need to be resolved"), result);
}

async function deleteShelf() {
  const shelved = await shelvedChangelists();
  const change = await chooseChangelist("Delete Shelved Files", "Delete", (id) => shelved.has(id));
  if (change === null) return;
  await runOp("Delete Shelved Files", () => call(commands.p4ShelfDelete(perforceRoot(), change, [])), {
    success: () => tx`Shelved files of changelist ${change} deleted`,
  });
}

const RESOLVE_MODES: { value: ResolveMode; label: string }[] = [
  { value: "merge", label: "Merge automatically, skip files with conflicts" },
  { value: "safe", label: "Accept the side that changed, skip files both changed" },
  { value: "yours", label: "Accept yours (keep the workspace files)" },
  { value: "theirs", label: "Accept theirs (take the depot files)" },
  { value: "forceMerge", label: "Merge and leave conflict markers in the files" },
];

async function resolve(paths: string[]) {
  const root = perforceRoot();
  const unresolved = await runOp("Perforce Resolve", () => call(commands.p4Unresolved(root)), { refresh: false });
  if (!unresolved) return;
  const wanted = paths.length ? unresolved.filter((f) => paths.includes(f.path)) : unresolved;
  if (!wanted.length) {
    notify({ level: "info", title: tx("No files need to be resolved") });
    return;
  }
  const mode = await new Promise<ResolveMode | null>((done) => {
    const close = openDialog(() => (
      <ChooseDialog
        title={fileCountText(wanted.length, tx("Resolve 1 File"), (n) => tx`Resolve ${n} Files`)}
        okLabel="Resolve"
        label="How to resolve:"
        options={RESOLVE_MODES.map((m) => ({ value: m.value, label: tx(m.label) }))}
        initial="merge"
        onDone={(value) => {
          close();
          done(value as ResolveMode | null);
        }}
      />
    ));
  });
  if (!mode) return;
  await runOp(
    "Perforce Resolve",
    () =>
      call(
        commands.p4Resolve(
          root,
          wanted.map((f) => f.path),
          mode,
        ),
      ),
    {},
  );
  const left = await call(commands.p4Unresolved(root)).catch(() => []);
  if (left.length)
    notify({
      level: "warning",
      title: fileCountText(left.length, tx("1 file still has conflicts"), (n) => tx`${n} files still have conflicts`),
      body: left
        .slice(0, 8)
        .map((f) => f.relPath)
        .join("\n"),
    });
  else notify({ level: "info", title: tx("All files are resolved") });
}

function login() {
  const root = perforceRoot();
  openDialog((close) => <LoginDialog root={root} onClose={close} />);
}

function LoginDialog({ root, onClose }: { root: string | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const submit = () => {
    if (!password) return;
    onClose();
    void runOp("Perforce Login", () => call(commands.p4Login(root, password)), {
      success: (s) => tx`Logged in to Perforce as ${s.user}`,
    });
  };
  return (
    <Dialog
      open
      title="Log In to Perforce"
      width={380}
      onClose={onClose}
      buttons={[
        { label: "Log In", role: "default", disabled: !password, onClick: submit },
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
        <label className={styles.fieldLabel} htmlFor="openidea-p4-password">
          <T>Password:</T>
        </label>
        <Input
          id="openidea-p4-password"
          type="password"
          data-autofocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </form>
    </Dialog>
  );
}

const INTEGRATE_KINDS: { value: IntegrateKind; label: string }[] = [
  { value: "integrate", label: "Integrate (branch or propagate changes)" },
  { value: "merge", label: "Merge (bring changes in for resolving)" },
  { value: "copy", label: "Copy (make the target identical)" },
];

function integrate() {
  openDialog((close) => <IntegrateDialog onClose={close} />);
}

function IntegrateDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<IntegrateKind>("integrate");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState(false);
  const ready = !!source.trim() && !!target.trim();
  const run = () => {
    if (!ready) return;
    onClose();
    const change = perforceChange(useChangelists.getState().state.active);
    void runOp(
      "Perforce Integrate",
      () => call(commands.p4Integrate(perforceRoot(), { kind, source, target, change, preview })),
      {
        success: (r) =>
          preview
            ? fileCountText(r.files.length, tx("1 file would be opened"), (n) => tx`${n} files would be opened`)
            : fileCountText(r.files.length, tx("1 file opened"), (n) => tx`${n} files opened`),
      },
    ).then((r) => report(tx("Files need to be resolved"), r));
  };
  return (
    <Dialog
      open
      title="Integrate"
      width={520}
      onClose={onClose}
      buttons={[
        { label: "Integrate", role: "default", disabled: !ready, onClick: run },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <span className={styles.fieldLabel}>
          <T>Operation:</T>
        </span>
        <Select
          value={kind}
          aria-label="Operation"
          onChange={(v) => setKind(v as IntegrateKind)}
          options={INTEGRATE_KINDS.map((k) => ({ value: k.value, label: tx(k.label) }))}
        />
        <label className={styles.fieldLabel} htmlFor="openidea-p4-source">
          <T>Source:</T>
        </label>
        <Input
          id="openidea-p4-source"
          data-autofocus
          mono
          placeholder="//depot/main/..."
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <label className={styles.fieldLabel} htmlFor="openidea-p4-target">
          <T>Target:</T>
        </label>
        <Input
          id="openidea-p4-target"
          mono
          placeholder="//depot/release/..."
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <Checkbox checked={preview} onChange={setPreview} label="Preview only" />
      </div>
    </Dialog>
  );
}

const actions: Action[] = [
  {
    id: "p4.sync",
    title: "Sync to Head",
    category: "Perforce",
    icon: "download",
    when: P4,
    keywords: ["update", "get latest"],
    run: ({ arg }) => void sync(argPaths(arg), null),
  },
  {
    id: "p4.syncToRevision",
    title: "Sync to Revision…",
    category: "Perforce",
    when: P4,
    run: ({ arg }) => void syncToRevision(argPaths(arg)),
  },
  {
    id: "p4.edit",
    title: "Open for Edit",
    category: "Perforce",
    when: P4,
    keywords: ["checkout", "check out"],
    run: ({ arg }) => void openForEdit(targets(arg)),
  },
  {
    id: "p4.revertUnchanged",
    title: "Revert Unchanged Files",
    category: "Perforce",
    when: P4,
    run: () => void revertUnchanged(),
  },
  {
    id: "p4.reconcile",
    title: "Reconcile Offline Work…",
    category: "Perforce",
    when: P4,
    keywords: ["offline", "unversioned"],
    run: ({ arg }) => void reconcile(argPaths(arg)),
  },
  {
    id: "p4.shelve",
    title: "Shelve Changelist…",
    category: "Perforce",
    when: P4,
    run: () => void shelve(),
  },
  {
    id: "p4.unshelve",
    title: "Unshelve…",
    category: "Perforce",
    when: P4,
    run: () => void unshelve(),
  },
  {
    id: "p4.deleteShelf",
    title: "Delete Shelved Files…",
    category: "Perforce",
    when: P4,
    run: () => void deleteShelf(),
  },
  {
    id: "p4.resolve",
    title: "Resolve…",
    category: "Perforce",
    when: P4,
    keywords: ["conflict", "merge"],
    run: ({ arg }) => void resolve(argPaths(arg)),
  },
  {
    id: "p4.integrate",
    title: "Integrate…",
    category: "Perforce",
    when: P4,
    keywords: ["branch", "merge", "copy"],
    run: () => integrate(),
  },
  {
    id: "p4.login",
    title: "Log In to Perforce…",
    category: "Perforce",
    when: P4,
    run: () => login(),
  },
];

function menuItems(paths: string[]): MenuItem[] {
  if (!paths.length || paths.some((p) => vcsKindOf(p) !== "perforce")) return [];
  const item = (action: string, label: string): MenuItem => ({ kind: "action", action, arg: paths, label });
  return [
    {
      label: "Perforce",
      submenu: [
        item("p4.edit", "Open for Edit"),
        item("p4.sync", "Sync to Head"),
        item("p4.syncToRevision", "Sync to Revision…"),
        { kind: "separator" },
        item("p4.reconcile", "Reconcile Offline Work…"),
        item("p4.resolve", "Resolve…"),
        item("p4.revertUnchanged", "Revert Unchanged Files"),
      ],
    },
  ];
}

export function registerPerforce(): () => void {
  const disposers = [
    registerActions(actions),
    registerMenuGroup({
      id: "vcs.perforce",
      menus: ["projectView", "editor", "changes"],
      order: 12,
      items: (_menu, { paths }) => menuItems(paths),
    }),
  ];
  return () => disposers.forEach((d) => d());
}
