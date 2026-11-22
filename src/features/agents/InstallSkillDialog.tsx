import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentSkillState,
  McpScope,
  RemoteSkillBrowseResult,
  RemoteSkillCandidate,
  RemoteSkillPreview,
  RequestId,
  SkillScanWarningKind,
} from "@/bindings";
import { formatMessage, useTx } from "@/platform/i18n";
import { commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { Button, Checkbox, Dialog, Icon, Input, Select, Tabs, T, selectableText } from "@/ui";
import type { SkillsBackend } from "./skillsModel";
import page from "./SettingsPage.module.css";
import styles from "./SkillsPage.module.css";

type PreviewTab = "markdown" | "files";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const WARNING_KIND_LABELS: Record<SkillScanWarningKind, string> = {
  hiddenUnicode: "Hidden Unicode",
  outOfRootSymlink: "Out-of-root symlink",
  executableScript: "Executable script",
  allowedToolsShell: "Shell tool grant",
};

export function InstallSkillDialog({
  backend,
  hasTrustedProject,
  onInstalled,
  onClose,
}: {
  backend: SkillsBackend;
  hasTrustedProject: boolean;
  onInstalled: (next: AgentSkillState[]) => void;
  onClose: () => void;
}) {
  const tx = useTx();
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<McpScope>("user");
  const [browseResult, setBrowseResult] = useState<RemoteSkillBrowseResult | null>(null);
  const [selectedSubpath, setSelectedSubpath] = useState<string | null>(null);
  const [preview, setPreview] = useState<RemoteSkillPreview | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("markdown");
  const [confirmedWarnings, setConfirmedWarnings] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeReq = useRef<RequestId | null>(null);

  const cancelInFlight = useCallback(() => {
    if (activeReq.current != null) {
      void commands.cancelRequest?.(activeReq.current);
      activeReq.current = null;
    }
  }, []);

  useEffect(() => () => cancelInFlight(), [cancelInFlight]);

  const loadPreview = useCallback(
    async (res: RemoteSkillBrowseResult, candidate: RemoteSkillCandidate) => {
      if (!backend.preview) return;
      cancelInFlight();
      const req = nextRequestId();
      activeReq.current = req;
      setSelectedSubpath(candidate.subpath);
      setPreview(null);
      setConfirmedWarnings(false);
      setOverwrite(false);
      setError(null);
      setLoading(true);
      try {
        const loaded = await backend.preview(res.owner, res.repo, res.gitRef, candidate.subpath, req);
        if (activeReq.current === req) {
          setPreview(loaded);
          activeReq.current = null;
        }
      } catch (e: unknown) {
        if (!isCancelled(e)) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (activeReq.current === req || activeReq.current == null) {
          setLoading(false);
        }
      }
    },
    [backend, cancelInFlight],
  );

  const fetchRepository = useCallback(async () => {
    const trimmed = source.trim();
    if (!trimmed || !backend.browse) return;
    cancelInFlight();
    const req = nextRequestId();
    activeReq.current = req;
    setLoading(true);
    setError(null);
    setBrowseResult(null);
    setPreview(null);
    setSelectedSubpath(null);
    setConfirmedWarnings(false);
    setOverwrite(false);
    try {
      const res = await backend.browse(trimmed, req);
      if (activeReq.current !== req) return;
      activeReq.current = null;
      setBrowseResult(res);
      const first = res.skills[0];
      if (first) {
        await loadPreview(res, first);
      } else {
        setLoading(false);
      }
    } catch (e: unknown) {
      if (!isCancelled(e)) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setLoading(false);
    }
  }, [backend, cancelInFlight, loadPreview, source]);

  const alreadyExists =
    preview != null && (scope === "workspace" ? preview.alreadyInstalledWorkspace : preview.alreadyInstalledUser);
  const needsWarningConfirm = (preview?.scanWarnings.length ?? 0) > 0;
  const canInstall =
    !!preview &&
    !loading &&
    !installing &&
    (!needsWarningConfirm || confirmedWarnings) &&
    (!alreadyExists || overwrite);

  const handleInstall = async () => {
    if (!preview || !backend.install || !canInstall) return;
    cancelInFlight();
    const req = nextRequestId();
    activeReq.current = req;
    setInstalling(true);
    setError(null);
    try {
      const next = await backend.install(
        {
          owner: preview.owner,
          repo: preview.repo,
          gitRef: preview.gitRef,
          subpath: preview.subpath,
          scope,
          confirmWarnings: confirmedWarnings,
          overwrite,
        },
        req,
      );
      activeReq.current = null;
      onInstalled(next);
    } catch (e: unknown) {
      if (!isCancelled(e)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleClose = () => {
    cancelInFlight();
    onClose();
  };

  return (
    <Dialog
      open
      onClose={handleClose}
      title={tx("Install Agent Skill")}
      width={680}
      buttons={[
        {
          label: installing ? "Installing…" : "Install",
          role: "default",
          disabled: !canInstall,
          onClick: () => void handleInstall(),
        },
        { label: "Cancel", role: "cancel", onClick: handleClose },
      ]}
    >
      <div className={styles.installBody}>
        <p className={styles.hint}>
          <T>
            Enter a GitHub repository (owner/repo, owner/repo@skill, owner/repo/path@ref, or a GitHub URL). Only the
            chosen skill folder is downloaded after preview and static scan.
          </T>
        </p>

        <div className={styles.installSourceRow}>
          <Input
            className={styles.installSourceInput}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void fetchRepository();
              }
            }}
            placeholder={tx("owner/repo, owner/repo@skill, or GitHub URL")}
            aria-label={tx("Skill repository")}
            autoFocus
          />
          <Button
            variant="secondary"
            disabled={!source.trim() || loading || installing}
            onClick={() => void fetchRepository()}
          >
            {loading && !browseResult ? <T>Fetching…</T> : <T>Fetch</T>}
          </Button>
        </div>

        <div className={styles.installScopeRow}>
          <span>
            <T>Install location</T>
          </span>
          <Select
            className={styles.installScopeSelect}
            variant="framed"
            aria-label={tx("Install location")}
            value={scope}
            disabled={installing}
            options={[
              { value: "user" as McpScope, label: tx("User (~/.agents/skills)") },
              ...(hasTrustedProject
                ? [{ value: "workspace" as McpScope, label: tx("Workspace (.agents/skills)") }]
                : []),
            ]}
            onChange={setScope}
          />
        </div>

        {error && (
          <div className={page.error} role="alert">
            <Icon name="error" size={14} />
            <span>{error}</span>
          </div>
        )}

        {browseResult && (
          <div className={styles.candidateSection}>
            <div className={styles.candidateHeader}>
              <span>
                {browseResult.owner}/{browseResult.repo}@{browseResult.gitRef}
              </span>
              <span>{formatMessage(tx("{count} skills found"), { count: browseResult.skills.length })}</span>
            </div>
            {browseResult.skills.length > 1 && (
              <div className={styles.candidateList} role="listbox" aria-label={tx("Available skills")}>
                {browseResult.skills.map((candidate) => {
                  const active = selectedSubpath === candidate.subpath;
                  return (
                    <button
                      key={candidate.subpath || candidate.folderName}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={clsx(styles.candidateBtn, active && styles.candidateBtnActive)}
                      onClick={() => void loadPreview(browseResult, candidate)}
                    >
                      <span>{candidate.folderName}</span>
                      <span className={styles.candidateMeta}>{formatBytes(candidate.totalBytes)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {loading && browseResult && !preview && (
          <div className={styles.hint}>
            <T>Scanning SKILL.md and bundled files…</T>
          </div>
        )}

        {preview && (
          <>
            {preview.scanWarnings.length === 0 ? (
              <div className={styles.scanClean} role="status">
                <Icon name="check" size={14} className={styles.scanCleanIcon} />
                <span>
                  <T>
                    Static scan passed: no hidden Unicode, out-of-root symlinks, shell tool grants, or executable
                    scripts detected.
                  </T>
                </span>
              </div>
            ) : (
              <div className={styles.scanWarnBox} role="region" aria-label={tx("Static security scan warnings")}>
                <div className={styles.scanWarnTitle}>
                  <Icon name="warning" size={14} />
                  <span>
                    {formatMessage(tx("Static security scan found {count} warnings"), {
                      count: preview.scanWarnings.length,
                    })}
                  </span>
                </div>
                <ul className={styles.scanWarnList}>
                  {preview.scanWarnings.map((w, idx) => (
                    <li key={`${w.kind}:${w.file}:${idx}`}>
                      <strong>{tx(WARNING_KIND_LABELS[w.kind])}:</strong>{" "}
                      <span className={styles.scanWarnCode}>{w.file}</span> — {w.message}
                    </li>
                  ))}
                </ul>
                <Checkbox
                  checked={confirmedWarnings}
                  onChange={setConfirmedWarnings}
                  label={tx("I reviewed these warnings and want to install this skill")}
                />
              </div>
            )}

            {alreadyExists && (
              <Checkbox
                checked={overwrite}
                onChange={setOverwrite}
                label={formatMessage(tx("Replace existing {name} folder in the selected location"), {
                  name: preview.skillName,
                })}
              />
            )}

            <div className={clsx(styles.previewBox, selectableText)}>
              <div className={styles.previewMeta}>
                <div className={page.cardTitleRow}>
                  <span className={styles.skillName}>{preview.skillName}</span>
                  {preview.subpath && <span className={page.tag}>{preview.subpath}</span>}
                </div>
                {preview.description && <span className={styles.subtitle}>{preview.description}</span>}
              </div>

              <Tabs
                variant="compact"
                aria-label={tx("Skill preview")}
                activeId={previewTab}
                onSelect={(id) => setPreviewTab(id as PreviewTab)}
                items={[
                  { id: "markdown", label: "SKILL.md", text: "SKILL.md" },
                  {
                    id: "files",
                    label: formatMessage(tx("Files ({count})"), { count: preview.files.length }),
                    text: tx("Files"),
                  },
                ]}
              />

              {previewTab === "markdown" ? (
                <pre className={styles.previewMarkdown}>{preview.skillMarkdown}</pre>
              ) : (
                <div className={styles.fileList} role="list">
                  {preview.files.map((f) => (
                    <div key={f.path} role="listitem" className={styles.fileRow}>
                      <span className={styles.filePath}>{f.path}</span>
                      <span className={styles.fileRight}>
                        {f.executable && (
                          <span className={clsx(page.tag, page.tagWarning)}>
                            <T>Executable</T>
                          </span>
                        )}
                        {f.symlink && (
                          <span className={page.tag}>
                            <T>Symlink</T>
                          </span>
                        )}
                        <span>{formatBytes(f.size)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
