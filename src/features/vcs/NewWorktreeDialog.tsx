import { useEffect, useRef, useState } from "react";
import type { Branch, RequestId, Worktree, WorktreeCreation, WorktreeInclude } from "@/bindings";
import { choosePath } from "@/platform/choosePath";
import { cleanUpBranchNameOnTyping } from "@/platform/gitRefName";
import { tx } from "@/platform/i18n";
import { call, commands, isErrorKind, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Button, Checkbox, Dialog, IconButton, Input, Select, T, useSanitizedField } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { branchRef, validateBranchName } from "./branchOps";
import { shortRemoteName, sortLocal, sortRemote } from "./branches";
import { openDialog } from "./dialogs";
import { RepoPicker } from "./RepoPicker";
import { baseName } from "./model";
import { errorMessage } from "./ops";
import { currentRepo, loadBranches, useVcs } from "./store";
import { openWorktree } from "./openWorktree";
import { worktreeLocation, worktreePath } from "./worktrees";
import { cancelWorktreeIncludeEdit, trackWorktreeIncludeEdit, worktreeIncludeTemplate } from "./worktreeInclude";
import styles from "./common.module.css";

interface WorktreeOptions {
  repo?: string | null;
  source?: string;
  onCreated?: (path: string) => void;
}

export function showNewWorktree(options: WorktreeOptions = {}) {
  cancelWorktreeIncludeEdit();
  openDialog((close) => <NewWorktreeDialog {...options} onClose={close} />);
}

function isAbsolutePath(path: string) {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

interface Source {
  ref: string;
  name: string;
  kind: "local" | "remote" | "tag";
  current?: boolean;
}

interface RepositoryData {
  branches: Branch[];
  worktrees: Worktree[];
  sources: Source[];
}

async function loadRepository(repo: string | null): Promise<RepositoryData> {
  const [branches, tags, worktrees] = await Promise.all([
    call(commands.vcsBranches(repo)),
    call(commands.vcsTags(repo)),
    call(commands.vcsWorktrees(repo)),
  ]);
  const fromBranch = (b: Branch): Source => ({
    ref: branchRef(b.name, b.remote),
    name: b.name,
    kind: b.remote ? "remote" : "local",
    current: b.current,
  });
  const sources = [
    ...sortLocal(branches).map(fromBranch),
    ...sortRemote(branches).map(fromBranch),
    ...tags.map((name): Source => ({ ref: `refs/tags/${name}`, name, kind: "tag" })),
  ];
  return { branches, worktrees, sources };
}

function NewWorktreeDialog({
  repo: initialRepo,
  source: initialSource,
  onCreated,
  onClose,
}: WorktreeOptions & {
  onClose: () => void;
}) {
  const [repo, setRepo] = useState(() => initialRepo ?? currentRepo() ?? useVcs.getState().roots[0] ?? null);
  return (
    <WorktreeForm
      key={repo}
      repo={repo}
      source={initialSource}
      onCreated={onCreated}
      onClose={onClose}
      onRepoChange={setRepo}
    />
  );
}

function WorktreeForm({
  repo,
  source: initialSource,
  onCreated,
  onClose,
  onRepoChange,
}: WorktreeOptions & {
  repo: string | null;
  onClose: () => void;
  onRepoChange: (repo: string) => void;
}) {
  const [projectRoot] = useState(() => useProject.getState().project?.root);
  const [data, setData] = useState<RepositoryData>();
  const [sourceRef, setSourceRef] = useState(initialSource);
  const [createBranch, setCreateBranch] = useState<boolean>();
  const [branch, setBranch] = useState<string>();
  const [name, setName] = useState<string>();
  const [location, setLocation] = useState<string>();
  const [include, setInclude] = useState<WorktreeInclude>();
  const [includeError, setIncludeError] = useState<string>();
  const [includeStage, setIncludeStage] = useState<"idle" | "opening" | "editing">("idle");
  const [copyConfig, setCopyConfig] = useState<boolean>();
  const [runSetup, setRunSetup] = useState(false);
  const [setupPath, setSetupPath] = useState("");
  const [setupRequest, setSetupRequest] = useState<RequestId>();
  const [skippingSetup, setSkippingSetup] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const liveForm = useRef(false);
  const leaveFocusInEditor = useRef(false);
  const disposeIncludeEdit = useRef<(() => void) | undefined>(undefined);
  const { ref: branchInput, clean: cleanBranch } = useSanitizedField(cleanUpBranchNameOnTyping);

  useEffect(() => {
    let live = true;
    liveForm.current = true;
    void loadRepository(repo).then(
      (result) => {
        if (live) setData(result);
      },
      (e) => {
        if (live) setError(errorMessage(e));
      },
    );
    void call(commands.vcsWorktreeInclude(repo)).then(
      (result) => {
        if (live) setInclude(result);
      },
      (e) => {
        if (live) setIncludeError(errorMessage(e));
      },
    );
    return () => {
      live = false;
      liveForm.current = false;
      disposeIncludeEdit.current?.();
    };
  }, [repo]);

  const source = sourceRef
    ? data?.sources.find((ref) => ref.ref === sourceRef)
    : (data?.sources.find((ref) => ref.current) ?? data?.sources[0]);
  const occupied = source?.kind === "local" && data?.worktrees.find((tree) => tree.branch === source.name);
  const createLocal = createBranch ?? !!occupied;
  const shortName = source?.kind === "remote" ? shortRemoteName(source.name) : (source?.name ?? "");
  const branchName = (branch ?? (occupied ? `${shortName}-wt` : shortName)).trim();
  const main = data?.worktrees.find((tree) => tree.main);
  const base = main?.path ?? repo ?? "";
  const folderName = (
    name ??
    (source ? `${baseName(base.replace(/\\/g, "/"))}-${(createLocal ? branchName : shortName).split("/").pop()}` : "")
  ).trim();
  const parent = (location ?? worktreeLocation(main?.submodule && projectRoot ? projectRoot : base)).trim();
  const target = worktreePath(parent, folderName);
  const localBranch = createLocal ? branchName : source?.kind === "remote" ? shortName : null;
  const branchError = localBranch === null ? null : validateBranchName(localBranch, false, data?.branches);
  const sourceError = !source
    ? "Choose what to check out"
    : occupied && !createLocal
      ? tx`Branch '${source.name}' is already checked out in a worktree at:\n${occupied.path}`
      : null;
  const nameError =
    !folderName || folderName === "." || folderName === ".." || /[\\/]/.test(folderName)
      ? "Enter a valid worktree name"
      : null;
  const locationError = isAbsolutePath(parent) ? null : "Enter an absolute location";
  const script = runSetup ? setupPath : null;
  const scriptError = script !== null && !isAbsolutePath(script) ? "Choose an absolute path to a setup script" : null;
  const invalid = sourceError ?? branchError ?? nameError ?? locationError ?? scriptError;
  const copyLocal = !!include?.exists && (copyConfig ?? true);
  const formBusy = busy || includeStage !== "idle";
  const includeLoading = !include && !includeError;

  const create = async (openAfter: boolean) => {
    if (
      invalid ||
      !source ||
      includeLoading ||
      submitting.current ||
      projectRoot !== useProject.getState().project?.root
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    let result: WorktreeCreation;
    try {
      if (script) {
        const kind = await call(commands.fsEntryKind(script)).catch(() => null);
        if (kind !== "file") throw new Error(tx("Choose an existing setup script"));
        if (projectRoot !== useProject.getState().project?.root) {
          onClose();
          return;
        }
      }
      const setup = script ? { script, request: nextRequestId() } : null;
      setSetupRequest(setup?.request);
      const ref = !createLocal && source.kind === "local" ? source.name : source.ref;
      result = await call(commands.vcsAddWorktree(repo, target, ref, localBranch, copyLocal, setup));
    } catch (e) {
      if (projectRoot !== useProject.getState().project?.root) {
        onClose();
        return;
      }
      submitting.current = false;
      setBusy(false);
      setSetupRequest(undefined);
      setSkippingSetup(false);
      setError(errorMessage(e));
      return;
    }
    onClose();
    if (projectRoot !== useProject.getState().project?.root) return;
    notifications().notify({ group: "vcs", level: "info", title: tx`Created worktree at ${target}` });
    if (result.copyWarning) {
      notifications().notify({
        group: "vcs",
        level: "warning",
        title: tx("Some worktree configuration could not be copied"),
        body: result.copyWarning,
      });
    }
    if (result.setupWarning) {
      notifications().notify({
        group: "vcs",
        level: "warning",
        title: tx("Worktree setup script failed"),
        body: result.setupWarning,
        userInitiated: true,
      });
    }
    void loadBranches().catch(() => undefined);
    onCreated?.(target);
    if (openAfter) await openWorktree(target, true);
  };

  const editInclude = async () => {
    if (!include || submitting.current || projectRoot !== useProject.getState().project?.root) return;
    submitting.current = true;
    setIncludeStage("opening");
    setIncludeError(undefined);
    try {
      let file = await call(commands.vcsWorktreeInclude(repo));
      if (!liveForm.current) return;
      if (projectRoot !== useProject.getState().project?.root) {
        onClose();
        return;
      }
      if (!file.exists) {
        try {
          await call(commands.fsCreateFileBytes(file.path, [...new TextEncoder().encode(worktreeIncludeTemplate())]));
        } catch (e) {
          if (!isErrorKind(e, "alreadyExists")) throw e;
        }
        file = await call(commands.vcsWorktreeInclude(repo));
      }
      if (!liveForm.current) return;
      setInclude(file);
      const probe = await call(commands.fsProbe(file.path));
      if (probe.binary || probe.tooLarge) throw new Error(tx("Choose an editable text .worktreeinclude file"));
      const text = await call(commands.fsReadText(file.path));
      if (!liveForm.current) return;
      if (projectRoot !== useProject.getState().project?.root) {
        onClose();
        return;
      }
      leaveFocusInEditor.current = true;
      setIncludeStage("editing");
      const editor = editorService();
      await editor.openFile(file.path, { focus: true });
      if (!liveForm.current) return;
      if (projectRoot !== useProject.getState().project?.root) {
        onClose();
        return;
      }
      if (editor.openPaths && !editor.openPaths().includes(file.path))
        throw new Error(tx("Could not open .worktreeinclude"));
      disposeIncludeEdit.current = trackWorktreeIncludeEdit(
        file.path,
        text,
        () => {
          disposeIncludeEdit.current = undefined;
          leaveFocusInEditor.current = false;
          submitting.current = false;
          setIncludeStage("idle");
          setInclude(undefined);
          void call(commands.vcsWorktreeInclude(repo)).then(
            (result) => {
              if (liveForm.current) setInclude(result);
            },
            (e) => {
              if (liveForm.current) setIncludeError(errorMessage(e));
            },
          );
        },
        onClose,
      );
    } catch (e) {
      if (!liveForm.current) return;
      leaveFocusInEditor.current = false;
      submitting.current = false;
      setIncludeStage("idle");
      setIncludeError(errorMessage(e));
    }
  };

  const browse = async () => {
    const folder = await choosePath({
      directory: true,
      title: tx("Worktree Location"),
      defaultPath: parent || undefined,
    });
    if (folder) setLocation(folder);
  };

  const browseSetupScript = async () => {
    const path = await choosePath({
      directory: false,
      title: tx("Choose Setup Script"),
      defaultPath: setupPath || repo || undefined,
    });
    if (path) {
      setSetupPath(path);
      setError(undefined);
    }
  };

  return (
    <Dialog
      open={includeStage !== "editing"}
      title="New Worktree"
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      width={560}
      restoreFocus={() => !leaveFocusInEditor.current}
      buttons={[
        {
          label: "Create and Open",
          role: "default",
          disabled: formBusy || includeLoading || !!invalid,
          onClick: () => void create(true),
        },
        { label: "Create", disabled: formBusy || includeLoading || !!invalid, onClick: () => void create(false) },
        setupRequest
          ? {
              label: "Skip Setup",
              role: "cancel",
              disabled: skippingSetup,
              onClick: () => {
                setSkippingSetup(true);
                void commands.cancelRequest(setupRequest);
              },
            }
          : { label: "Cancel", role: "cancel", disabled: formBusy },
      ]}
    >
      <div className={styles.form}>
        {!initialSource && (
          <RepoPicker
            repo={repo}
            onChange={(next) => {
              if (!submitting.current) onRepoChange(next);
            }}
          />
        )}
        {main?.submodule && (
          <div className={styles.worktreeTarget}>
            {tx("This worktree has its own checkout, separate from the submodule in the parent repository.")}
          </div>
        )}
        <div className={styles.fieldLabel}>
          <T>Check out:</T>
        </div>
        <Select
          aria-label="Check out"
          searchable
          disabled={formBusy || !data}
          value={source?.ref ?? null}
          placeholder="Select branch or tag"
          options={(data?.sources ?? []).map((ref) => ({
            value: ref.ref,
            label: ref.name,
            icon: ref.kind === "tag" ? "tag" : "branch",
            verbatim: true,
          }))}
          onChange={(ref) => {
            setSourceRef(ref);
            setCreateBranch(undefined);
            setBranch(undefined);
            setError(undefined);
          }}
        />
        <Checkbox label="Create a new branch" disabled={formBusy} checked={createLocal} onChange={setCreateBranch} />
        {createLocal && (
          <Input
            ref={branchInput}
            aria-label="New branch name"
            mono
            disabled={formBusy}
            value={branch ?? branchName}
            onChange={(e) => setBranch(cleanBranch(e))}
          />
        )}
        <label className={styles.fieldLabel} htmlFor="worktree-name">
          <T>Name:</T>
        </label>
        <Input
          id="worktree-name"
          mono
          disabled={formBusy}
          value={name ?? folderName}
          onChange={(e) => setName(e.target.value)}
        />
        <label className={styles.fieldLabel} htmlFor="worktree-location">
          <T>Location:</T>
        </label>
        <div className={styles.worktreeLocation}>
          <Input
            id="worktree-location"
            mono
            disabled={formBusy}
            value={location ?? parent}
            onChange={(e) => setLocation(e.target.value)}
          />
          <IconButton icon="folder-open" title="Browse" disabled={formBusy} onClick={() => void browse()} />
        </div>
        {parent && folderName && <div className={styles.worktreeTarget}>{tx`Worktree location: ${target}`}</div>}
        <div className={styles.worktreeLocation}>
          <Checkbox
            label="Copy local files listed in .worktreeinclude"
            disabled={formBusy || !include?.exists}
            checked={copyLocal}
            onChange={setCopyConfig}
          />
          {include && (
            <Button disabled={formBusy} onClick={() => void editInclude()}>
              <T>{include.exists ? "Edit .worktreeinclude…" : "Create .worktreeinclude…"}</T>
            </Button>
          )}
        </div>
        {includeError && (
          <div className={styles.error} role="alert">
            {includeError}
          </div>
        )}
        <Checkbox
          label="Run setup script"
          disabled={formBusy}
          checked={runSetup}
          onChange={(enabled) => {
            setRunSetup(enabled);
            setError(undefined);
          }}
        />
        {runSetup && (
          <>
            <label className={styles.fieldLabel} htmlFor="worktree-setup-script">
              <T>Setup script:</T>
            </label>
            <div className={styles.worktreeLocation}>
              <Input
                id="worktree-setup-script"
                mono
                disabled={formBusy}
                value={setupPath}
                onChange={(e) => {
                  setSetupPath(e.target.value);
                  setError(undefined);
                }}
              />
              <IconButton
                icon="folder-open"
                title="Choose Setup Script"
                disabled={formBusy}
                onClick={() => void browseSetupScript()}
              />
            </div>
          </>
        )}
        {busy && (
          <div className={styles.worktreeTarget} role="status">
            {setupRequest && !skippingSetup ? tx("Creating worktree and running setup…") : tx("Creating worktree…")}
          </div>
        )}
        {(error || (data && invalid)) && (
          <div className={styles.error} role="alert">
            {error || tx(invalid ?? "")}
          </div>
        )}
      </div>
    </Dialog>
  );
}
