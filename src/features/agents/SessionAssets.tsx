/**
 * Session Pull Requests, created Issues, References (Issues, Commits, Discussions), and
 * Artifacts (Websites, Files) surfaced as interactive pills right above the composer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEntry, AgentTask, PullRequestSummary } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { Icon, IconButton, Popup, copyText, fileIconName, type IconName } from "@/ui";
import { mentionOf, type FileRef } from "./composerModel";
import { branchLabel, isBusy } from "./model";
import {
  extractSessionAssets,
  isFeatureBranch,
  loadTaskDismissed,
  saveTaskDismissed,
  type IssueAssetState,
  type PullRequestAssetState,
  type RemoteItemMeta,
  type SessionArtifact,
  type SessionIssue,
  type SessionPullRequest,
  type SessionReference,
} from "./sessionAssetsModel";
import { composerDraft, updateComposer } from "./store";
import styles from "./SessionAssets.module.css";

const MAX_REMOTE_FETCHES = 10;
const NO_BRANCH_PRS: readonly PullRequestSummary[] = [];

type CategoryId = "prs" | "issues" | "references" | "artifacts";

interface PopupItem {
  key: string;
  icon: IconName;
  idLabel?: string;
  title: string;
  tooltip: string;
  copyValue: string;
  isFile?: boolean;
  onOpen: () => void;
  onInsert: () => void;
}

interface PopupSection {
  id: string;
  header: string;
  items: PopupItem[];
}

/** Shared per-process cache so repeated renders/tabs never re-query `gh api` for the same PR or issue. */
const ghMetaCache = new Map<string, Promise<RemoteItemMeta | null>>();
const ghResolvedMeta = new Map<string, RemoteItemMeta | null>();

function snapshotResolvedMeta(): Map<string, RemoteItemMeta> {
  const map = new Map<string, RemoteItemMeta>();
  for (const [k, v] of ghResolvedMeta) {
    if (v) map.set(k, v);
  }
  return map;
}

export function resetSessionAssetsCacheForTests() {
  ghMetaCache.clear();
  ghResolvedMeta.clear();
}

function parseGhItemResponse(raw: string, kind: "pr" | "issue"): RemoteItemMeta | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title.trim() : undefined;
    if (kind === "pr") {
      const merged = data.merged === true || (typeof data.merged_at === "string" && data.merged_at.length > 0);
      const draft = data.draft === true;
      const rawState = typeof data.state === "string" ? data.state.toLowerCase() : "";
      const state: PullRequestAssetState | undefined = merged
        ? "merged"
        : draft
          ? "draft"
          : rawState === "closed"
            ? "closed"
            : rawState === "open"
              ? "open"
              : undefined;
      return title || state ? { title, state } : null;
    }
    const rawState = typeof data.state === "string" ? data.state.toLowerCase() : "";
    const state: IssueAssetState | undefined =
      rawState === "closed" ? "closed" : rawState === "open" ? "open" : undefined;
    return title || state ? { title, state } : null;
  } catch {
    return null;
  }
}

function fetchGithubMeta(
  repoRoot: string | null,
  cacheKey: string,
  githubRepo: string,
  kind: "pr" | "issue",
  number: number,
): Promise<RemoteItemMeta | null> {
  const existing = ghMetaCache.get(cacheKey);
  if (existing) return existing;
  const segment = kind === "pr" ? "pulls" : "issues";
  const req = call(
    commands.ghApi(repoRoot, {
      method: "GET",
      endpoint: `repos/${githubRepo}/${segment}/${number}`,
      body: null,
      paginate: false,
    }),
  )
    .then((text) => parseGhItemResponse(text, kind))
    .catch(() => null)
    .then((meta) => {
      ghResolvedMeta.set(cacheKey, meta);
      return meta;
    });
  ghMetaCache.set(cacheKey, req);
  return req;
}

function prIcon(state: PullRequestAssetState): IconName {
  switch (state) {
    case "merged":
      return "github-pr-merged";
    case "closed":
      return "github-pr-closed";
    case "draft":
      return "github-pr-draft";
    case "open":
      return "github-pr-open";
  }
}

function issueIcon(state: IssueAssetState | undefined): IconName {
  return state === "closed" ? "issue-closed" : "issue-open";
}

async function openFileArtifact(artifact: Extract<SessionArtifact, { kind: "file" }>) {
  if (artifact.externalBinary && isTauri()) {
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(artifact.path);
      return;
    } catch {
      /* fall back to editor */
    }
  }
  await editorService().openFile(artifact.path, { focus: true });
}

function insertTextIntoComposer(taskId: string, token: string, fileRef?: FileRef) {
  const current = composerDraft(taskId);
  const glue = current.text && !/\s$/.test(current.text) ? " " : "";
  const files =
    fileRef && !current.files.some((f) => f.path === fileRef.path) ? [...current.files, fileRef] : current.files;
  updateComposer(taskId, {
    text: `${current.text}${glue}${token} `,
    files,
  });
}

export interface SessionAssetsProps {
  task: AgentTask;
  entries: readonly AgentEntry[] | null;
  head: string | null;
  onFocusComposer?: () => void;
}

export function SessionAssets({ task, entries, head, onFocusComposer }: SessionAssetsProps) {
  const tx = useTx();
  const workspace = useProject((s) => !!s.project?.workspace);
  const projectRoot = useProject((s) => s.project?.root ?? null);
  const repoRoot = workspace ? (task.projectRoot ?? projectRoot) : null;
  const activeBranch = task.isolation === "worktree" ? branchLabel(task.branch) || task.branch : head;
  const busy = isBusy(task.status);

  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [branchPrs, setBranchPrs] = useState<readonly PullRequestSummary[]>([]);
  const [remoteMeta, setRemoteMeta] = useState<ReadonlyMap<string, RemoteItemMeta>>(snapshotResolvedMeta);
  const [dismissedState, setDismissedState] = useState<{ taskId: string; keys: Set<string> }>(() => ({
    taskId: task.id,
    keys: loadTaskDismissed(task.id),
  }));
  const dismissed = useMemo(
    () => (dismissedState.taskId === task.id ? dismissedState.keys : loadTaskDismissed(task.id)),
    [dismissedState, task.id],
  );
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null);

  const prsAnchor = useRef<HTMLButtonElement>(null);
  const issuesAnchor = useRef<HTMLButtonElement>(null);
  const refsAnchor = useRef<HTMLButtonElement>(null);
  const artifactsAnchor = useRef<HTMLButtonElement>(null);

  // Read `remote.origin.url` so `gh pr checks 123` / `gh issue view 456` resolve to `<owner>/<repo>`.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    call(commands.vcsConfigGet(repoRoot, "remote.origin.url"))
      .then((url) => {
        if (alive) setRemoteUrl(url || null);
      })
      .catch(() => {
        if (alive) setRemoteUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, task.id]);

  // Discover PRs opened from the session's current feature branch (`head:<branch>`).
  useEffect(() => {
    if (!isTauri() || !isFeatureBranch(activeBranch)) return;
    let alive = true;
    const loadBranchPrs = () => {
      void call(
        commands.ghPrList(repoRoot, {
          state: "all",
          authorMe: false,
          reviewRequested: false,
          assigneeMe: false,
          search: `head:${activeBranch}`,
          limit: 5,
        }),
      )
        .then((list) => {
          if (alive) setBranchPrs(list);
        })
        .catch(() => {
          if (alive) setBranchPrs([]);
        });
    };
    loadBranchPrs();
    const off = onIdeEvent("vcsChanged", () => {
      loadBranchPrs();
    });
    return () => {
      alive = false;
      off();
    };
  }, [repoRoot, activeBranch, busy]);

  const effectiveBranchPrs = isFeatureBranch(activeBranch) ? branchPrs : NO_BRANCH_PRS;

  const assets = useMemo(
    () =>
      extractSessionAssets({
        task,
        entries,
        remoteUrl,
        branchPullRequests: effectiveBranchPrs,
        remoteMeta,
        dismissed,
      }),
    [task, entries, remoteUrl, effectiveBranchPrs, remoteMeta, dismissed],
  );

  // Enrich GitHub PRs and Issues whose title or state wasn't present in the conversation text.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const targets: Array<{ key: string; repo: string; kind: "pr" | "issue"; number: number }> = [];
    for (const pr of assets.pullRequests) {
      if (pr.githubRepo && (!pr.hasExplicitTitle || !pr.hasExplicitState) && !ghResolvedMeta.has(pr.key)) {
        targets.push({ key: pr.key, repo: pr.githubRepo, kind: "pr", number: pr.number });
      }
    }
    for (const issue of assets.createdIssues) {
      if (
        issue.githubRepo &&
        issue.number !== null &&
        (!issue.hasExplicitTitle || !issue.hasExplicitState) &&
        !ghResolvedMeta.has(issue.key)
      ) {
        targets.push({ key: issue.key, repo: issue.githubRepo, kind: "issue", number: issue.number });
      }
    }
    for (const ref of assets.references) {
      if (ref.githubIssue && (!ref.hasExplicitTitle || !ref.hasExplicitState) && !ghResolvedMeta.has(ref.key)) {
        targets.push({
          key: ref.key,
          repo: ref.githubIssue.repo,
          kind: "issue",
          number: ref.githubIssue.number,
        });
      }
    }
    const batch = targets.slice(0, MAX_REMOTE_FETCHES);
    if (!batch.length) return;
    void Promise.all(batch.map((t) => fetchGithubMeta(repoRoot, t.key, t.repo, t.kind, t.number))).then((results) => {
      if (alive && results.some((r) => r !== null)) {
        setRemoteMeta(snapshotResolvedMeta());
      }
    });
    return () => {
      alive = false;
    };
  }, [assets.pullRequests, assets.createdIssues, assets.references, repoRoot]);

  const dismissItem = useCallback(
    (key: string) => {
      const next = new Set(dismissed);
      next.add(key);
      saveTaskDismissed(task.id, next);
      setDismissedState({ taskId: task.id, keys: next });
    },
    [dismissed, task.id],
  );

  const insertAndFocus = useCallback(
    (token: string, fileRef?: FileRef) => {
      insertTextIntoComposer(task.id, token, fileRef);
      setOpenCategory(null);
      onFocusComposer?.();
    },
    [task.id, onFocusComposer],
  );

  const prItem = (pr: SessionPullRequest): PopupItem => ({
    key: pr.key,
    icon: prIcon(pr.state),
    idLabel: pr.idLabel,
    title: pr.title,
    tooltip: `${pr.repo}${pr.idLabel} — ${pr.title}\n${pr.url}`,
    copyValue: pr.url,
    onOpen: () => {
      setOpenCategory(null);
      void openExternalUrl(pr.url);
    },
    onInsert: () => insertAndFocus(pr.url),
  });

  const issueItem = (issue: SessionIssue): PopupItem => ({
    key: issue.key,
    icon: issueIcon(issue.state),
    idLabel: issue.idLabel,
    title: issue.title,
    tooltip: `${issue.repo}${issue.number !== null ? issue.idLabel : ` ${issue.idLabel}`} — ${issue.title}\n${issue.url}`,
    copyValue: issue.url,
    onOpen: () => {
      setOpenCategory(null);
      void openExternalUrl(issue.url);
    },
    onInsert: () => insertAndFocus(issue.url),
  });

  const referenceItem = (ref: SessionReference): PopupItem => ({
    key: ref.key,
    icon: ref.kind === "issue" ? issueIcon(ref.state) : ref.kind === "commit" ? "commit" : "review-comment",
    idLabel: ref.idLabel,
    title: ref.title,
    tooltip: `${ref.repo} ${ref.idLabel} — ${ref.title}\n${ref.url}`,
    copyValue: ref.url,
    onOpen: () => {
      setOpenCategory(null);
      void openExternalUrl(ref.url);
    },
    onInsert: () => insertAndFocus(ref.url),
  });

  const artifactItem = (artifact: SessionArtifact): PopupItem => {
    if (artifact.kind === "website") {
      return {
        key: artifact.key,
        icon: "web",
        title: artifact.title,
        tooltip: `${artifact.title}\n${artifact.url}`,
        copyValue: artifact.url,
        onOpen: () => {
          setOpenCategory(null);
          void openExternalUrl(artifact.url);
        },
        onInsert: () => insertAndFocus(artifact.url),
      };
    }
    const canMention = !!artifact.rel && !/\s/.test(artifact.rel);
    return {
      key: artifact.key,
      icon: fileIconName(artifact.name, artifact.path),
      title: artifact.name,
      tooltip: artifact.path,
      copyValue: artifact.path,
      isFile: true,
      onOpen: () => {
        setOpenCategory(null);
        void openFileArtifact(artifact);
      },
      onInsert: () =>
        canMention
          ? insertAndFocus(mentionOf(artifact.rel!), { path: artifact.path, rel: artifact.rel! })
          : insertAndFocus(artifact.path),
    };
  };

  const prSections: PopupSection[] =
    assets.pullRequests.length > 0
      ? [{ id: "prs", header: tx("Pull Requests"), items: assets.pullRequests.map(prItem) }]
      : [];

  const createdIssueSections: PopupSection[] =
    assets.createdIssues.length > 0
      ? [{ id: "issues", header: tx("Issues"), items: assets.createdIssues.map(issueItem) }]
      : [];

  const refIssues = assets.references.filter((r) => r.kind === "issue").map(referenceItem);
  const refCommits = assets.references.filter((r) => r.kind === "commit").map(referenceItem);
  const refDiscussions = assets.references.filter((r) => r.kind === "discussion").map(referenceItem);
  const referenceSections: PopupSection[] = [
    ...(refIssues.length > 0 ? [{ id: "ref-issues", header: tx("Issues"), items: refIssues }] : []),
    ...(refCommits.length > 0 ? [{ id: "ref-commits", header: tx("Commits"), items: refCommits }] : []),
    ...(refDiscussions.length > 0 ? [{ id: "ref-discussions", header: tx("Discussions"), items: refDiscussions }] : []),
  ];

  const websites = assets.artifacts
    .filter((a): a is Extract<SessionArtifact, { kind: "website" }> => a.kind === "website")
    .map(artifactItem);
  const files = assets.artifacts
    .filter((a): a is Extract<SessionArtifact, { kind: "file" }> => a.kind === "file")
    .map(artifactItem);
  const artifactSections: PopupSection[] = [
    ...(websites.length > 0 ? [{ id: "websites", header: tx("Websites"), items: websites }] : []),
    ...(files.length > 0 ? [{ id: "files", header: tx("Files"), items: files }] : []),
  ];

  const hasAny =
    prSections.length > 0 ||
    createdIssueSections.length > 0 ||
    referenceSections.length > 0 ||
    artifactSections.length > 0;
  if (!hasAny) return null;

  const activeCategory =
    (openCategory === "prs" && prSections.length > 0) ||
    (openCategory === "issues" && createdIssueSections.length > 0) ||
    (openCategory === "references" && referenceSections.length > 0) ||
    (openCategory === "artifacts" && artifactSections.length > 0)
      ? openCategory
      : null;

  const toggle = (cat: CategoryId) => setOpenCategory((prev) => (prev === cat ? null : cat));

  const prCount = assets.pullRequests.length;
  const prPillLabel =
    prCount === 1 ? assets.pullRequests[0]!.idLabel : tx("{count} Pull Requests").replace("{count}", String(prCount));
  const prAriaLabel =
    prCount === 1 ? tx("1 Pull Request") : tx("{count} Pull Requests").replace("{count}", String(prCount));

  const issueCount = assets.createdIssues.length;
  const issuePillLabel =
    issueCount === 1 ? assets.createdIssues[0]!.idLabel : tx("{count} Issues").replace("{count}", String(issueCount));
  const issueAriaLabel = issueCount === 1 ? tx("1 Issue") : tx("{count} Issues").replace("{count}", String(issueCount));

  const refCount = assets.references.length;
  const refPillLabel =
    refCount === 1 ? tx("1 Reference") : tx("{count} References").replace("{count}", String(refCount));

  const artifactCount = assets.artifacts.length;
  const artifactPillLabel =
    artifactCount === 1 ? tx("1 Artifact") : tx("{count} Artifacts").replace("{count}", String(artifactCount));

  return (
    <div className={styles.bar} role="toolbar" aria-label={tx("Session references and artifacts")}>
      {prCount > 0 && (
        <>
          <button
            ref={prsAnchor}
            type="button"
            className={styles.pill}
            aria-label={prAriaLabel}
            aria-haspopup="dialog"
            aria-expanded={activeCategory === "prs"}
            title={
              prCount === 1 ? `${assets.pullRequests[0]!.idLabel} — ${assets.pullRequests[0]!.title}` : prAriaLabel
            }
            onClick={() => toggle("prs")}
          >
            <Icon name={prCount === 1 ? prIcon(assets.pullRequests[0]!.state) : "github-pr-open"} size={13} />
            <span className={styles.pillLabel}>{prPillLabel}</span>
            <Icon name="chevron-down" size={11} className={styles.chevron} />
          </button>
          <AssetPopup
            open={activeCategory === "prs"}
            anchor={prsAnchor}
            label={tx("Pull Requests")}
            sections={prSections}
            onDismiss={dismissItem}
            onClose={() => setOpenCategory(null)}
          />
        </>
      )}

      {issueCount > 0 && (
        <>
          <button
            ref={issuesAnchor}
            type="button"
            className={styles.pill}
            aria-label={issueAriaLabel}
            aria-haspopup="dialog"
            aria-expanded={activeCategory === "issues"}
            title={
              issueCount === 1
                ? `${assets.createdIssues[0]!.idLabel} — ${assets.createdIssues[0]!.title}`
                : issueAriaLabel
            }
            onClick={() => toggle("issues")}
          >
            <Icon name={issueCount === 1 ? issueIcon(assets.createdIssues[0]!.state) : "issue-open"} size={13} />
            <span className={styles.pillLabel}>{issuePillLabel}</span>
            {issueCount > 1 && <Icon name="chevron-down" size={11} className={styles.chevron} />}
          </button>
          <AssetPopup
            open={activeCategory === "issues"}
            anchor={issuesAnchor}
            label={tx("Issues")}
            sections={createdIssueSections}
            onDismiss={dismissItem}
            onClose={() => setOpenCategory(null)}
          />
        </>
      )}

      {refCount > 0 && (
        <>
          <button
            ref={refsAnchor}
            type="button"
            className={styles.pill}
            aria-label={refPillLabel}
            aria-haspopup="dialog"
            aria-expanded={activeCategory === "references"}
            onClick={() => toggle("references")}
          >
            <Icon name="toolwindow-bookmarks" size={13} />
            <span className={styles.pillLabel}>{refPillLabel}</span>
            <Icon name="chevron-down" size={11} className={styles.chevron} />
          </button>
          <AssetPopup
            open={activeCategory === "references"}
            anchor={refsAnchor}
            label={tx("References")}
            sections={referenceSections}
            onDismiss={dismissItem}
            onClose={() => setOpenCategory(null)}
          />
        </>
      )}

      {artifactCount > 0 && (
        <>
          <button
            ref={artifactsAnchor}
            type="button"
            className={styles.pill}
            aria-label={artifactPillLabel}
            aria-haspopup="dialog"
            aria-expanded={activeCategory === "artifacts"}
            onClick={() => toggle("artifacts")}
          >
            <Icon name="artifact" size={13} />
            <span className={styles.pillLabel}>{artifactPillLabel}</span>
            <Icon name="chevron-down" size={11} className={styles.chevron} />
          </button>
          <AssetPopup
            open={activeCategory === "artifacts"}
            anchor={artifactsAnchor}
            label={tx("Artifacts")}
            sections={artifactSections}
            onDismiss={dismissItem}
            onClose={() => setOpenCategory(null)}
          />
        </>
      )}
    </div>
  );
}

function AssetPopup({
  open,
  anchor,
  label,
  sections,
  onDismiss,
  onClose,
}: {
  open: boolean;
  anchor: React.RefObject<HTMLElement | null>;
  label: string;
  sections: readonly PopupSection[];
  onDismiss: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <Popup
      open={open}
      anchor={anchor}
      placement="top-start"
      offset={6}
      aria-label={label}
      className={styles.popup}
      onClose={onClose}
    >
      {sections.map((section) => (
        <div key={section.id} className={styles.section}>
          <div className={styles.sectionHeader}>{section.header}</div>
          {section.items.map((item) => (
            <div key={item.key} className={styles.row}>
              <button type="button" className={styles.rowMain} title={item.tooltip} onClick={item.onOpen}>
                <Icon name={item.icon} size={14} className={styles.rowIcon} />
                {item.idLabel && <span className={styles.rowId}>{item.idLabel}</span>}
                <span className={styles.rowTitle}>{item.title}</span>
              </button>
              <span className={styles.rowActions}>
                <IconButton
                  size="small"
                  icon="copy"
                  title={item.isFile ? "Copy Path" : "Copy Link"}
                  onClick={() => void copyText(item.copyValue)}
                />
                <IconButton size="small" icon="plus" title="Add to Message" onClick={item.onInsert} />
                <IconButton size="small" icon="close" title="Remove" onClick={() => onDismiss(item.key)} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </Popup>
  );
}
