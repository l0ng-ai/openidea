/**
 * The Pull Requests tool window shell (IntelliJ's `GHPRToolWindowFactory` /
 * `GHPRToolWindowTabComponentFactory`): gh availability states, the repository selector
 * (projects with several GitHub remotes), then the content tabs — the list tab named after
 * the repository, `#N` tabs and "New Pull Request at {repo}" — in the header.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { GhProjectAccountStatus } from "@/bindings";
import type { GhAvailability } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { GH_MANUAL_INSTALL_URL, installGhTool } from "@/platform/ghTool";
import { isCancelled } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Button, EmptyState, IconButton, Select, Spinner, Tabs, T, showContextMenu, type MenuItem } from "@/ui";
import { CreatePanel } from "../create/CreatePanel";
import { DetailsPanel } from "../details/DetailsPanel";
import { ListPanel } from "../list/ListPanel";
import {
  loadProjectGithubAccount,
  projectAccountOptions,
  setProjectGithubAccount,
  useGhProjectAccount,
} from "../data/account";
import { reloadList, useGhPrList } from "../data/list";
import { cancelBusy, openInBrowser, useGhBusy } from "../data/local";
import { repositoryDisplayName } from "../data/model";
import { cachedDetails } from "../data/pullRequest";
import {
  connect,
  disconnect,
  nameWithOwner,
  refreshConnection,
  sameRepository,
  useGhRepository,
} from "../data/repository";
import { closeTab, selectTab, tabId, useGhTabs, type GhTabId } from "./store";
import styles from "./ToolWindow.module.css";

function ProjectAccountInline() {
  const status = useGhProjectAccount((s) => s.status);
  const saving = useGhProjectAccount((s) => s.saving);
  if (!status || status.accounts.length === 0) return null;
  const suggested = !status.configuredAccount ? status.suggestedAccount : null;
  return (
    <div className={styles.accountInline}>
      {suggested && (
        <Button
          size="small"
          variant="primary"
          disabled={saving}
          onClick={() => void setProjectGithubAccount(suggested)}
        >
          {tx`Use ${suggested} for this project`}
        </Button>
      )}
      <Select
        aria-label="GitHub account"
        value={status.configuredAccount}
        disabled={saving}
        options={projectAccountOptions(status)}
        onChange={(next) => void setProjectGithubAccount(next)}
      />
      {status.configuredAccount && (
        <div className={styles.hint}>
          <T>
            Passes this account&apos;s GH_TOKEN to processes started in this project (terminals, agents, Git, and run
            configurations).
          </T>
        </div>
      )}
    </div>
  );
}

function Unavailable({ availability }: { availability: GhAvailability }) {
  const [installingGh, setInstallingGh] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const installGh = () => {
    if (installingGh) return;
    setInstallingGh(true);
    setInstallError(null);
    void installGhTool()
      .promise.then((installed) => {
        if (installed) void refreshConnection();
      })
      .catch((e: unknown) => {
        if (!isCancelled(e)) setInstallError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setInstallingGh(false));
  };
  const retry = (
    <Button size="small" onClick={() => void refreshConnection()}>
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
              <Button size="small" variant="primary" disabled={installingGh} onClick={installGh}>
                {installingGh ? (
                  <>
                    <Spinner size={12} /> <T>Installing…</T>
                  </>
                ) : (
                  <T>Install GitHub CLI</T>
                )}
              </Button>
              <Button size="small" onClick={() => void openInBrowser(GH_MANUAL_INSTALL_URL)}>
                <T>Download manually…</T>
              </Button>
              {retry}
            </>
          }
        >
          <T>Pull requests use the</T> <code>gh</code> <T>command line tool. Install it, then run</T>{" "}
          <code>gh auth login</code>.{installError && <div className={styles.hint}>{installError}</div>}
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
          <ProjectAccountInline />
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
          <div>{availability.message}</div>
          <ProjectAccountInline />
        </EmptyState>
      );
    default:
      return null;
  }
}

/** IntelliJ's repository selector: the repositories (owner always shown), project account, and "View Pull Requests". */
function RepositorySelector() {
  const remotes = useGhRepository((s) => s.remotes);
  const defaultRemote = useGhRepository((s) => s.defaultRemote);
  const connecting = useGhRepository((s) => s.connecting);
  const error = useGhRepository((s) => s.connectionError);
  const status = useGhProjectAccount((s) => s.status);
  const savingAccount = useGhProjectAccount((s) => s.saving);
  const [chosen, setChosen] = useState<string | null>(null);
  const value =
    chosen ??
    nameWithOwner(remotes.find((r) => sameRepository(r, defaultRemote)) ?? remotes[0] ?? { owner: "", name: "" });
  const target = remotes.find((r) => nameWithOwner(r) === value);
  return (
    <div className={styles.selector}>
      {status && status.accounts.length > 0 && (
        <>
          <div className={styles.selectorRow}>
            <Select
              aria-label="GitHub account"
              value={status.configuredAccount}
              disabled={savingAccount}
              options={projectAccountOptions(status)}
              onChange={(next) => void setProjectGithubAccount(next)}
            />
            {!status.configuredAccount && status.suggestedAccount && (
              <Button
                size="small"
                disabled={savingAccount}
                onClick={() => void setProjectGithubAccount(status.suggestedAccount!)}
              >
                {tx`Use ${status.suggestedAccount} for this project`}
              </Button>
            )}
          </div>
          {status.configuredAccount && (
            <div className={styles.hint}>
              <T>
                Passes this account&apos;s GH_TOKEN to processes started in this project (terminals, agents, Git, and
                run configurations).
              </T>
            </div>
          )}
        </>
      )}
      <div className={styles.selectorRow}>
        <Select
          value={value}
          options={remotes.map((r) => ({
            value: nameWithOwner(r),
            verbatim: true,
            label: repositoryDisplayName(remotes, r, true),
          }))}
          onChange={setChosen}
          aria-label="Repository"
        />
        <Button
          size="small"
          variant="primary"
          disabled={!target || connecting}
          onClick={() => target && void connect(target)}
        >
          <T>View Pull Requests</T>
        </Button>
        {connecting && <Spinner size={14} />}
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

function BusyBanner() {
  const busy = useGhBusy((s) => s.busy);
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

/** Calls `onShown` whenever `ref` becomes visible (the tool window shown, its tab selected). */
function useOnShown(ref: RefObject<HTMLElement | null>, onShown: () => void) {
  const callback = useRef(onShown);
  useEffect(() => {
    callback.current = onShown;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let visible = el.offsetParent !== null;
    const ro = new ResizeObserver(() => {
      const now = el.offsetParent !== null;
      if (now && !visible) callback.current();
      visible = now;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

function Connected() {
  const tabs = useGhTabs((s) => s.tabs);
  const active = useGhTabs((s) => s.active);
  const listRef = useRef<HTMLDivElement>(null);
  // IntelliJ refreshes the list whenever its tab is selected or the window is shown with it.
  useOnShown(listRef, () => {
    if (useGhPrList.getState().loaded) void reloadList();
  });
  const pr = tabs.find((t) => tabId(t) === active);
  return (
    <div className={styles.root}>
      <BusyBanner />
      <div ref={listRef} className={`${styles.content} ${styles.listTab}`} hidden={active !== "list"}>
        <ListPanel />
      </div>
      {pr?.kind === "pr" && (
        <div className={styles.content}>
          <DetailsPanel key={pr.number} number={pr.number} />
        </div>
      )}
      {pr?.kind === "create" && (
        <div className={styles.content}>
          <CreatePanel />
        </div>
      )}
    </div>
  );
}

/** The tool window's content. */
export function PullRequestsToolWindow() {
  const availability = useGhRepository((s) => s.availability);
  const checking = useGhRepository((s) => s.checking);
  const connected = useGhRepository((s) => !!s.connection);
  const connecting = useGhRepository((s) => s.connecting);
  useEffect(() => {
    if (!useGhProjectAccount.getState().status) void loadProjectGithubAccount();
    if (!useGhRepository.getState().availability) void refreshConnection();
  }, []);
  if (!availability)
    return (
      <div className={styles.loading}>
        {checking && <Spinner size={14} />} {tx("Connecting to GitHub…")}
      </div>
    );
  if (availability.kind !== "ready") return <Unavailable availability={availability} />;
  if (connected) return <Connected />;
  if (connecting)
    return (
      <div className={styles.loading}>
        <Spinner size={14} /> {tx("Connecting to GitHub…")}
      </div>
    );
  return <RepositorySelector />;
}

/** The tab's context menu: Close Tab / Close Other Tabs for `#N` and New Pull Request tabs. */
function tabMenu(id: GhTabId, all: GhTabId[]): MenuItem[] {
  return [
    { label: "Close Tab", disabled: id === "list", run: () => closeTab(id) },
    {
      label: "Close Other Tabs",
      disabled: all.filter((t) => t !== "list" && t !== id).length === 0,
      run: () => all.forEach((t) => t !== id && closeTab(t)),
    },
  ];
}

/** Header content: the closable content tabs while connected. */
export function PullRequestsTabs() {
  const connection = useGhRepository((s) => s.connection);
  const remotes = useGhRepository((s) => s.remotes);
  const tabs = useGhTabs((s) => s.tabs);
  const active = useGhTabs((s) => s.active);
  if (!connection) return null;
  const repo = repositoryDisplayName(remotes, connection.coordinates);
  const ids: GhTabId[] = ["list", ...tabs.map(tabId)];
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Pull request tabs"
      activeId={active}
      onSelect={(id) => selectTab(id as GhTabId)}
      onClose={(id) => closeTab(id as GhTabId)}
      onContextMenu={(id, e) => showContextMenu(e, tabMenu(id as GhTabId, ids))}
      items={[
        { id: "list", label: repo, verbatim: true, tooltip: nameWithOwner(connection.coordinates), closable: false },
        ...tabs.map((t) =>
          t.kind === "pr"
            ? {
                id: tabId(t),
                label: `#${t.number}`,
                closable: true,
                tooltip: cachedDetails(t.number)?.title,
              }
            : { id: tabId(t), label: tx`New Pull Request at ${repo}`, closable: true },
        ),
      ]}
    />
  );
}

/** Title actions: account switcher (when multi-account), Create Pull Request… (+) and Select Opened Pull Request. */
export function PullRequestsHeaderActions() {
  const connection = useGhRepository((s) => s.connection);
  const status = useGhProjectAccount((s) => s.status);
  if (!connection) return null;
  const showAccount = (status?.accounts.length ?? 0) > 1 || !!status?.configuredAccount;
  const activeLogin = connection.currentUser.login || status?.effectiveAccount || "";
  const suggested = !status?.configuredAccount ? (status?.suggestedAccount ?? null) : null;
  return (
    <>
      {showAccount && status && activeLogin && (
        <button
          type="button"
          className={styles.accountBadge}
          title={suggested ? tx`Use ${suggested} for this project` : tx`GitHub account: @${activeLogin}`}
          onClick={(e) => {
            const configured = status.configuredAccount;
            const defaultLogin = status.accounts.find((a) => a.active)?.login ?? null;
            const autoLabel = defaultLogin ? tx`Automatic (${defaultLogin})` : tx("Automatic");
            const items: MenuItem[] = [
              ...(suggested
                ? [
                    {
                      label: tx`Use ${suggested} for this project`,
                      verbatim: true,
                      run: () => void setProjectGithubAccount(suggested),
                    },
                    { kind: "separator" as const },
                  ]
                : []),
              {
                label: autoLabel,
                verbatim: true,
                checked: configured === "",
                run: () => void setProjectGithubAccount(""),
              },
              ...status.accounts.map((a) => ({
                label: `@${a.login}`,
                verbatim: true,
                checked: configured === a.login,
                run: () => void setProjectGithubAccount(a.login),
              })),
            ];
            showContextMenu(e, items);
          }}
        >
          @{activeLogin}
        </button>
      )}
      <IconButton icon="plus" size="small" iconSize={16} action="github.createPullRequest" />
      <IconButton icon="locate" size="small" iconSize={16} action="github.selectOpenedPullRequest" />
    </>
  );
}

/** The "⋮" menu's own items: suggested account (if any) and Change Repository or Account…. */
export function headerMenu(
  s: Pick<ReturnType<typeof useGhRepository.getState>, "connection" | "remotes">,
  acct?: GhProjectAccountStatus | null,
): MenuItem[] {
  if (!s.connection) return NONE;
  const suggested = !acct?.configuredAccount ? (acct?.suggestedAccount ?? null) : null;
  const multipleAccounts = (acct?.accounts.length ?? 0) > 1 || !!acct?.configuredAccount;
  if (!suggested && s.remotes.length <= 1 && !multipleAccounts) return NONE;
  return [
    ...(suggested
      ? [
          {
            label: tx`Use ${suggested} for this project`,
            verbatim: true,
            run: () => void setProjectGithubAccount(suggested),
          },
        ]
      : []),
    ...CHANGE_REPOSITORY,
  ];
}

const NONE: MenuItem[] = [];
const CHANGE_REPOSITORY: MenuItem[] = [
  { label: "Change Repository or Account…", run: () => void executeAction("github.changeRepository") },
];

/** "Change Repository or Account…": forgets the choice and shows the selector. */
export function changeRepository() {
  disconnect({ forget: true });
}
