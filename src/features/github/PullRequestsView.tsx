/** The Pull Requests tool window: filterable list on the left, the selected pull request on the right. */
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import clsx from "clsx";
import type { GhAvailability, PrCheck, PrStateFilter, PullRequestDetails, PullRequestSummary } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { useMarkupHtml } from "@/editor/lsp/markdown";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  List,
  SearchField,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  showContextMenu,
  type MenuItem,
  T,
} from "@/ui";
import {
  checksSummary,
  checksText,
  relativeTime,
  reviewDecisionLabel,
  reviewStateLabel,
  reviewThreads,
  stateLabel,
} from "./model";
import { addComment, checkoutPullRequest, openCommentLocation, openFileDiff, openUrl, submitReview } from "./ops";
import { cancelBusy, loadDetails, refreshAll, select, setQuery, useGithub, type DetailTab } from "./store";
import styles from "./Github.module.css";
import { t, tx } from "@/platform/i18n";

const STATES: PrStateFilter[] = ["open", "merged", "closed", "all"];

function Unavailable({ availability }: { availability: GhAvailability }) {
  const retry = (
    <Button size="small" onClick={() => void refreshAll()}>
      <T>Retry</T>
    </Button>
  );
  switch (availability.kind) {
    case "notInstalled":
      return (
        <EmptyState
          title="GitHub CLI is not installed"
          actions={
            <>
              <Button size="small" onClick={() => void openUrl("https://cli.github.com")}>
                <T>Install gh…</T>
              </Button>
              {retry}
            </>
          }
        >
          <T>Pull requests use the</T> <code>gh</code> <T>command line tool. Install it, then run</T>{" "}
          <code>gh auth login</code>.
        </EmptyState>
      );
    case "notLoggedIn":
      return (
        <EmptyState
          title="Not logged in to GitHub"
          actions={
            <>
              <Button
                size="small"
                variant="primary"
                onClick={() =>
                  void executeAction("terminal.runCommand", {
                    program: "gh",
                    args: ["auth", "login"],
                    name: "gh auth login",
                  })
                }
              >
                <T>Run gh auth login</T>
              </Button>
              {retry}
            </>
          }
        >
          <T>Run</T> <code>gh auth login</code> <T>in a terminal, then retry.</T>
        </EmptyState>
      );
    case "notGitHub":
      return (
        <EmptyState title="No GitHub repository" actions={retry}>
          <div>
            <T>This project has no remote on GitHub.</T>
          </div>
          <div className={styles.hint}>{availability.message}</div>
        </EmptyState>
      );
    case "error":
      return (
        <EmptyState title="Could not reach GitHub" actions={retry}>
          {availability.message}
        </EmptyState>
      );
    default:
      return null;
  }
}

function StateBadge({ pr }: { pr: PullRequestSummary }) {
  const tone = pr.state === "merged" ? "accent" : pr.state === "closed" ? "danger" : pr.isDraft ? "neutral" : "success";
  return <Badge tone={tone}>{stateLabel(pr)}</Badge>;
}

function Filters() {
  const query = useGithub((s) => s.query);
  const loading = useGithub((s) => s.listLoading);
  const [search, setSearch] = useState(query.search);
  useEffect(() => {
    if (search === useGithub.getState().query.search) return;
    const t = setTimeout(() => setQuery({ search }), 400);
    return () => clearTimeout(t);
  }, [search]);
  return (
    <div className={styles.filters}>
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder="Search (GitHub syntax)"
        aria-label="Search pull requests"
        className={styles.search}
      />
      <div className={styles.filterRow}>
        <Select
          value={query.state}
          options={STATES.map((value) => ({ value, label: t(`github.prState.${value}`) }))}
          onChange={(state) => setQuery({ state })} aria-label="State" />
        <Checkbox checked={query.authorMe} onChange={(authorMe) => setQuery({ authorMe })} label="Mine" />
        <Checkbox
          checked={query.reviewRequested}
          onChange={(reviewRequested) => setQuery({ reviewRequested })}
          label="Review requested"
        />
        <span className={styles.flex} />
        {loading ? <Spinner size={14} /> : <IconButton icon="refresh" size="small" action="github.refresh" />}
        <IconButton icon="plus" size="small" action="github.createPullRequest" />
      </div>
    </div>
  );
}

function ListRow({ pr }: { pr: PullRequestSummary }) {
  const decision = reviewDecisionLabel(pr.reviewDecision);
  return (
    <div className={styles.listRow}>
      <div className={styles.listTitle}>
        <span className={styles.ellipsis}>{pr.title}</span>
        <StateBadge pr={pr} />
      </div>
      <div className={styles.listMeta}>
        #{pr.number} {tx`by ${pr.author}`} · {relativeTime(pr.updatedAt)}
        {decision ? ` · ${decision}` : ""}
        {pr.labels.length ? ` · ${pr.labels.map((l) => l.name).join(", ")}` : ""}
      </div>
    </div>
  );
}

function PullRequestList() {
  const list = useGithub((s) => s.list);
  const error = useGithub((s) => s.listError);
  const loading = useGithub((s) => s.listLoading);
  const selected = useGithub((s) => s.selected);
  const index = list.findIndex((p) => p.number === selected);
  const menu = (pr: PullRequestSummary, e: MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Checkout", icon: "branch", run: () => void checkoutPullRequest(pr.number) },
      { label: "Open in Browser", icon: "external-link", run: () => void openUrl(pr.url) },
      { label: "Copy URL", icon: "copy", run: () => void navigator.clipboard?.writeText(pr.url) },
    ];
    showContextMenu({ x: e.clientX, y: e.clientY }, items);
  };
  return (
    <div className={styles.listPane}>
      <Filters />
      {error ? (
        <div className={styles.error}>{error}</div>
      ) : (
        <List<PullRequestSummary>
          items={list}
          getKey={(p) => String(p.number)}
          rowHeight={46}
          activeIndex={index}
          onActiveChange={(i) => list[i] && select(list[i]!.number)}
          onActivate={(p) => select(p.number)}
          onContextMenu={(p, _i, e) => menu(p, e)}
          renderItem={(p) => <ListRow pr={p} />}
          empty={<EmptyState title={loading ? "Loading pull requests…" : "No pull requests"} />}
          aria-label="Pull requests"
          className={styles.list}
        />
      )}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  const html = useMarkupHtml({ kind: "markdown", value: text });
  if (!text.trim())
    return (
      <div className={styles.dim}>
        <T>No description provided.</T>
      </div>
    );
  return (
    <div
      className={styles.markdown}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a?.href && /^https?:/.test(a.href)) {
          e.preventDefault();
          void openUrl(a.href);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const CHECK_ICON: Record<PrCheck["status"], string> = {
  success: "success",
  failure: "error",
  pending: "clock",
  cancelled: "stop",
  skipped: "minus",
  neutral: "info",
};

function Overview({ pr }: { pr: PullRequestDetails }) {
  const summary = checksSummary(pr.checks);
  return (
    <div className={styles.scroll}>
      <Markdown text={pr.body} />
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{tx`Checks · ${checksText(summary)}`}</h3>
        {pr.checks.map((c, i) => (
          <div key={i} className={styles.checkRow}>
            <Icon name={CHECK_ICON[c.status]} size={14} className={styles[`check-${c.status}`]} />
            <span className={styles.ellipsis}>
              {c.workflow ? `${c.workflow} / ` : ""}
              {c.name}
            </span>
            {c.url && (
              <button type="button" className={styles.link} onClick={() => void openUrl(c.url!)}>
                <T>Details</T>
              </button>
            )}
          </div>
        ))}
      </section>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          <T>Reviewers</T>
        </h3>
        {pr.reviewers.length === 0 && (
          <div className={styles.dim}>
            <T>No reviews</T>
          </div>
        )}
        {pr.reviewers.map((r) => (
          <div key={r.login} className={styles.checkRow}>
            <Icon
              name={
                r.state === "APPROVED"
                  ? "success"
                  : r.state === "CHANGES_REQUESTED"
                    ? "error"
                    : r.state === "REQUESTED"
                      ? "clock"
                      : "info"
              }
              size={14}
              className={styles[`review-${r.state}`]}
            />
            <span>{r.login}</span>
            <span className={styles.dim}>{reviewStateLabel(r.state)}</span>
          </div>
        ))}
      </section>
      {(pr.summary.labels.length > 0 || pr.assignees.length > 0) && (
        <section className={styles.section}>
          {pr.summary.labels.length > 0 && (
            <div className={styles.labels}>
              {pr.summary.labels.map((l) => (
                <span key={l.name} className={styles.label}>
                  {l.name}
                </span>
              ))}
            </div>
          )}
          {pr.assignees.length > 0 && <div className={styles.dim}>{tx`Assignees: ${pr.assignees.join(", ")}`}</div>}
        </section>
      )}
    </div>
  );
}

function Files({ pr }: { pr: PullRequestDetails }) {
  const comments = useGithub((s) => s.reviewComments);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [comments]);
  return (
    <div className={styles.scroll} role="list" aria-label={tx("Changed files")}>
      {pr.files.map((f) => {
        const slash = f.path.lastIndexOf("/");
        return (
          <button
            key={f.path}
            type="button"
            role="listitem"
            className={styles.fileRow}
            onClick={(e) => e.detail <= 1 && void openFileDiff(pr, f)}
            title={f.path}
          >
            <Icon name="diff" size={14} className={styles[`change-${f.changeType}`]} />
            <span className={clsx(styles.fileName, styles[`change-${f.changeType}`])}>{f.path.slice(slash + 1)}</span>
            <span className={clsx(styles.dim, styles.ellipsis)}>{slash > 0 ? f.path.slice(0, slash) : ""}</span>
            <span className={styles.flex} />
            {counts.get(f.path) ? <span className={styles.dim}>{tx`${counts.get(f.path)} comments`}</span> : null}
            <span className={styles.added}>+{f.additions}</span>
            <span className={styles.deleted}>−{f.deletions}</span>
          </button>
        );
      })}
    </div>
  );
}

function Commits({ pr }: { pr: PullRequestDetails }) {
  return (
    <div className={styles.scroll} role="list" aria-label={tx("Commits")}>
      {pr.commits.map((c) => (
        <div
          key={c.oid}
          role="listitem"
          className={styles.commitRow}
          title={c.body || c.headline}
          onContextMenu={(e) => {
            e.preventDefault();
            showContextMenu({ x: e.clientX, y: e.clientY }, [
              { label: "Copy Revision Number", icon: "copy", run: () => void navigator.clipboard?.writeText(c.oid) },
              {
                label: "Open in Browser",
                icon: "external-link",
                run: () => void openUrl(`${pr.summary.url}/commits/${c.oid}`),
              },
            ]);
          }}
        >
          <span className={styles.ellipsis}>{c.headline}</span>
          <span className={styles.flex} />
          <span className={styles.dim}>{c.author}</span>
          <span className={styles.dim}>{relativeTime(c.date)}</span>
          <code className={styles.oid}>{c.oid.slice(0, 8)}</code>
        </div>
      ))}
    </div>
  );
}

function Conversation({ pr }: { pr: PullRequestDetails }) {
  const comments = useGithub((s) => s.reviewComments);
  const threads = useMemo(() => reviewThreads(comments), [comments]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  return (
    <div className={styles.scroll}>
      {pr.timeline.map((t, i) => (
        <article key={i} className={styles.comment}>
          <header className={styles.commentHead}>
            <strong>{t.author}</strong>
            {t.reviewState && (
              <span className={styles[`review-${t.reviewState}`]}>{reviewStateLabel(t.reviewState)}</span>
            )}
            <span className={styles.dim}>{relativeTime(t.createdAt)}</span>
          </header>
          {t.body.trim() && <Markdown text={t.body} />}
        </article>
      ))}
      {threads.length > 0 && (
        <h3 className={styles.sectionTitle}>
          <T>Review comments</T>
        </h3>
      )}
      {threads.map((t) => (
        <article key={t.root.id} className={styles.comment}>
          <header className={styles.commentHead}>
            <button type="button" className={styles.link} onClick={() => void openCommentLocation(pr, t.root.path)}>
              {t.root.path}:{t.root.line ?? t.root.originalLine ?? "?"}
            </button>
            {t.root.line == null && (
              <span className={styles.dim}>
                <T>outdated</T>
              </span>
            )}
          </header>
          {[t.root, ...t.replies].map((c) => (
            <div key={c.id} className={styles.threadItem}>
              <div className={styles.commentHead}>
                <strong>{c.author}</strong>
                <span className={styles.dim}>{relativeTime(c.createdAt)}</span>
              </div>
              <Markdown text={c.body} />
            </div>
          ))}
        </article>
      ))}
      <div className={styles.newComment}>
        <textarea
          aria-label={tx("New comment")}
          placeholder={tx("Add a comment (Markdown)")}
          className={styles.textarea}
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className={styles.filterRow}>
          <span className={styles.flex} />
          <Button
            size="small"
            variant="primary"
            disabled={!draft.trim() || posting}
            onClick={async () => {
              setPosting(true);
              if (await addComment(pr.summary.number, draft)) setDraft("");
              setPosting(false);
            }}
          >
            <T>Comment</T>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Details() {
  const pr = useGithub((s) => s.details);
  const loading = useGithub((s) => s.detailsLoading);
  const error = useGithub((s) => s.detailsError);
  const selected = useGithub((s) => s.selected);
  const tab = useGithub((s) => s.tab);
  const comments = useGithub((s) => s.reviewComments);
  if (!pr || pr.summary.number !== selected) {
    if (error) return <EmptyState title="Could not load the pull request">{error}</EmptyState>;
    return loading ? (
      <div className={styles.loading}>
        <Spinner size={14} /> <T>Loading…</T>
      </div>
    ) : (
      <EmptyState title="Select a pull request" />
    );
  }
  const s = pr.summary;
  const reviewMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu({ x: r.left, y: r.bottom + 2 }, [
      { label: "Approve…", icon: "success", run: () => void submitReview(s.number, "approve") },
      { label: "Request Changes…", icon: "error", run: () => void submitReview(s.number, "requestChanges") },
      { label: "Comment…", icon: "edit", run: () => void submitReview(s.number, "comment") },
    ]);
  };
  return (
    <div className={styles.details}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{s.title}</h2>
          {loading && <Spinner size={12} />}
        </div>
        <div className={styles.metaRow}>
          <StateBadge pr={s} />
          <span>
            #{s.number} {tx`by ${s.author}`} · {s.baseRef} ← {s.headRef}
          </span>
          {reviewDecisionLabel(s.reviewDecision) && (
            <span className={styles.dim}>· {reviewDecisionLabel(s.reviewDecision)}</span>
          )}
          {pr.mergeable === "CONFLICTING" && (
            <span className={styles.conflict}>
              <T>· Conflicts</T>
            </span>
          )}
        </div>
        <div className={styles.actions}>
          <Button size="small" icon="branch" onClick={() => void checkoutPullRequest(s.number)}>
            <T>Checkout</T>
          </Button>
          <Button size="small" icon="edit" onClick={reviewMenu}>
            <T>Review ▾</T>
          </Button>
          <Button size="small" icon="external-link" onClick={() => void openUrl(s.url)}>
            <T>Open in Browser</T>
          </Button>
          <span className={styles.flex} />
          <IconButton icon="refresh" size="small" title="Reload" onClick={() => void loadDetails(s.number)} />
        </div>
      </header>
      <Tabs
        variant="compact"
        activeId={tab}
        onSelect={(id) => useGithub.setState({ tab: id as DetailTab })}
        aria-label="Pull request"
        items={[
          { id: "overview", label: "Overview" },
          { id: "files", label: tx`Files ${pr.files.length}` },
          { id: "commits", label: tx`Commits ${pr.commits.length}` },
          { id: "conversation", label: tx`Conversation ${pr.timeline.length + comments.length}` },
        ]}
      />
      {tab === "overview" && <Overview pr={pr} />}
      {tab === "files" && <Files pr={pr} />}
      {tab === "commits" && <Commits pr={pr} />}
      {tab === "conversation" && <Conversation pr={pr} />}
    </div>
  );
}

function BusyBanner() {
  const busy = useGithub((s) => s.busy);
  if (!busy) return null;
  return (
    <div className={styles.banner} role="status">
      <Spinner size={12} />
      <span>{busy.title}</span>
      <span className={styles.bannerText}>{busy.line}</span>
      <IconButton icon="close" size="small" title="Cancel" onClick={cancelBusy} />
    </div>
  );
}

/** Below this width the list sits above the details instead of beside them. */
const SIDE_BY_SIDE_MIN = 560;

function useNarrow(el: HTMLElement | null): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? Infinity) < SIDE_BY_SIDE_MIN));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return narrow;
}

export function PullRequestsView() {
  const availability = useGithub((s) => s.availability);
  const checking = useGithub((s) => s.checking);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const narrow = useNarrow(root);
  useEffect(() => {
    if (!useGithub.getState().availability) void refreshAll();
  }, []);
  if (!availability)
    return (
      <div className={styles.loading}>
        {checking && <Spinner size={14} />} {tx("Connecting to GitHub…")}
      </div>
    );
  if (availability.kind !== "ready")
    return (
      <div className={styles.view}>
        <Unavailable availability={availability} />
      </div>
    );
  return (
    <div className={styles.view} ref={setRoot}>
      <BusyBanner />
      <SplitGroup key={narrow ? "v" : "h"} orientation={narrow ? "vertical" : "horizontal"} className={styles.split}>
        <SplitPanel defaultSize={narrow ? "40%" : "38%"} minSize={narrow ? "120px" : "220px"}>
          <PullRequestList />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel minSize={narrow ? "160px" : "280px"}>
          <Details />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

/** Header content: the repository the list is for. */
export function PullRequestsHeader() {
  const availability = useGithub((s) => s.availability);
  if (availability?.kind !== "ready") return null;
  const name = availability.repo.nameWithOwner;
  return (
    <span className={styles.repo} title={name}>
      {name}
    </span>
  );
}
