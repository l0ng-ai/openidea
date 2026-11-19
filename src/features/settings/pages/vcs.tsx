/**
 * Version Control pages (IDEA layout): Version Control, Commit, Confirmation,
 * Directory Mappings, Issue Navigation, Shelf, Git (the vcs feature adds Log).
 * Behaviour lives in the vcs feature, which reads `vcs.*` through
 * `platform/workflowSettings`.
 */
import { useEffect, useId, useMemo, useState } from "react";
import clsx from "clsx";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { WORKFLOW_LIMITS, type IssueLinkValid } from "@/platform/workflowSettings";
import { showInFileManagerLabel } from "@/platform/fileManager";
import { Button, Icon, IconButton, Input, Select, type SelectOption, T } from "@/ui";
import { choosePath } from "@/platform/choosePath";
import { Row, SettingSelect } from "../components/Form";
import { useSetting } from "../components/context";
import type { AgentModelCatalog, AgentProvider } from "@/bindings";
import type { PageSpec } from "./spec";
import { BoundToggle, Grid, Indented, RadioRow, TableEditor, ToggleNumber } from "./workflowControls";
import styles from "./Workflow.module.css";
import { tx } from "@/platform/i18n";

const L = WORKFLOW_LIMITS;

// ---------------------------------------------------------------------------
// Version Control

function HistoryLimitRow() {
  return (
    <ToggleNumber
      toggleKey="vcs.limitHistory"
      numberKey="vcs.historyLimit"
      label="Limit history to"
      unit="rows"
      {...L.historyLimit}
    />
  );
}

type VcsChoice = "git" | "none";
const VCS_OPTIONS: SelectOption<VcsChoice>[] = [
  { value: "git", label: "Git" },
  { value: "none", label: "<none>" },
];

/** A mapping's directory as stored: relative to the project root (`.` for the root), absolute outside it. */
export function mappingKey(root: string, path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  if (p === root) return ".";
  return p.startsWith(root + "/") || p.startsWith(root + "\\") ? p.slice(root.length + 1).replace(/\\/g, "/") : p;
}

function mappingPath(root: string, key: string): string {
  if (key === "." || key === "") return root;
  return /^([A-Za-z]:)?[\\/]/.test(key) ? key : `${root}/${key}`;
}

/**
 * IDEA's Directory Mappings: the detected repositories plus those added by hand. Choosing
 * `<none>` leaves a repository out of the Git and Commit tool windows; its files stay in the project.
 */
function MappingsTable() {
  const project = useProject((s) => s.project);
  const root = project?.root ?? null;
  const [excluded, setExcluded] = useSetting<string[]>("vcs.mappings.excluded", "project");
  const [added, setAdded] = useSetting<string[]>("vcs.mappings.added", "project");
  const [detected, setDetected] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!root || !isTauri()) return;
    let live = true;
    call(commands.vcsDetectedRoots()).then(
      (roots) => live && setDetected(roots),
      () => live && setDetected([]),
    );
    return () => {
      live = false;
    };
  }, [root]);

  const rows = useMemo(() => {
    if (!root) return [];
    const keys = new Set([...(detected ?? []).map((p) => mappingKey(root, p)), ...added]);
    if (!keys.size) keys.add(".");
    return [...keys]
      .sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)))
      .map((key) => ({
        key,
        path: mappingPath(root, key),
        manual: added.includes(key),
        vcs: (excluded.includes(key) || (!project?.isGit && key === "." && !detected?.length && !added.length)
          ? "none"
          : "git") as VcsChoice,
      }));
  }, [root, detected, added, excluded, project?.isGit]);

  const setVcs = (key: string, vcs: VcsChoice) =>
    setExcluded(vcs === "none" ? [...excluded.filter((k) => k !== key), key] : excluded.filter((k) => k !== key));

  const add = async () => {
    if (!root) return;
    const picked = await choosePath({ directory: true, title: "Select Repository Root", defaultPath: root });
    if (!picked) return;
    const key = mappingKey(root, picked);
    if (excluded.includes(key)) setExcluded(excluded.filter((k) => k !== key));
    if (!rows.some((r) => r.key === key)) setAdded([...added, key]);
    setSelected(key);
  };
  const removable = rows.find((r) => r.key === selected && r.manual);
  const remove = () => {
    if (!removable) return;
    setAdded(added.filter((k) => k !== removable.key));
    setExcluded(excluded.filter((k) => k !== removable.key));
    setSelected(null);
  };

  return (
    <div className={styles.tableBox}>
      {root && (
        <div className={styles.toolbar} role="toolbar" aria-label={tx("Directory mappings actions")}>
          <IconButton icon="plus" title="Add" size="small" onClick={() => void add()} />
          <IconButton icon="minus" title="Remove" size="small" disabled={!removable} onClick={remove} />
        </div>
      )}
      <table className={styles.table} aria-label={tx("Directory mappings")}>
        <thead>
          <tr>
            <th>
              <T>Directory</T>
            </th>
            <th style={{ width: 120 }}>
              <T>VCS</T>
            </th>
          </tr>
        </thead>
        <tbody>
          {!root ? (
            <tr>
              <td colSpan={2} className={styles.empty}>
                <T>No project is open</T>
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const name = row.key === "." ? tx("<Project>") : row.key;
              return (
                <tr
                  key={row.key}
                  aria-selected={selected === row.key}
                  className={clsx(selected === row.key && styles.selectedRow)}
                  onMouseDown={() => setSelected(row.key)}
                >
                  <td title={row.path}>
                    <Icon name="folder" size={16} className={styles.mappingIcon} />
                    {name}
                  </td>
                  <td>
                    <Select
                      value={row.vcs}
                      options={VCS_OPTIONS}
                      variant="ghost"
                      aria-label={tx`VCS of ${name}`}
                      onChange={(v) => setVcs(row.key, v)}
                    />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git

function GitExecutableRow() {
  const [path, setPath] = useSetting<string>("vcs.git.executable");
  const [detected, setDetected] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!isTauri()) return;
    void commands.vcsDetectedGit().then(setDetected, () => undefined);
  }, []);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const info = await call(commands.vcsGitVersion(path));
      setResult({ ok: true, text: `${info.version.replace(/^git version/, "Git version is")} (${info.path})` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <Row
      label="Path to Git executable"
      htmlFor={id}
      hint={
        result ? (
          <span className={result.ok ? styles.ok : styles.error} role="status">
            {result.text}
          </span>
        ) : undefined
      }
    >
      <Input
        id={id}
        mono
        className={styles.wide}
        value={path}
        placeholder={detected ? tx`Auto-detected: ${detected}` : "Auto-detected"}
        onChange={(e) => {
          setPath(e.target.value);
          setResult(null);
        }}
      />
      <Button size="small" disabled={testing || !isTauri()} onClick={() => void test()}>
        <T>Test</T>
      </Button>
    </Row>
  );
}

function ProtectedBranchesRow() {
  const [value, set] = useSetting<string>("vcs.git.protectedBranches");
  const id = useId();
  return (
    <Row
      label="Protected branches"
      htmlFor={id}
      hint="Force push is not allowed to these branches. Separate patterns with ; (wildcards * and ? are supported)."
    >
      <Input id={id} className={styles.medium} value={value} onChange={(e) => set(e.target.value)} />
    </Row>
  );
}

/** Saved git HTTPS credentials (Settings › Git › Passwords): list and forget. */
function GitCredentialsRow() {
  const [hosts, setHosts] = useState<string[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    void commands.gitCredentials().then(setHosts, () => undefined);
  }, []);
  const forget = async (key: string) => {
    await commands.gitCredentialForget(key);
    setHosts((h) => h.filter((k) => k !== key));
  };
  if (hosts.length === 0)
    return (
      <Row
        label="Passwords"
        hint={
          'Credentials the IDE answers git\'s HTTPS prompts with. Saved after a successful fetch / pull / push when "Remember for this host" was checked.'
        }
      >
        <span className={styles.empty}>
          <T>No saved credentials</T>
        </span>
      </Row>
    );
  return (
    <Row
      label="Passwords"
      stacked
      hint={
        "Credentials the IDE answers git's HTTPS prompts with, stored in the app's own secret file (not git's credential.helper). A rejected credential is forgotten automatically."
      }
    >
      <div className={styles.tableBox}>
        <table className={styles.table} aria-label={tx("Saved git credentials")}>
          <tbody>
            {hosts.map((h) => (
              <tr key={h}>
                <td className={styles.mono}>{h}</td>
                <td style={{ width: 90 }}>
                  <Button size="small" onClick={() => void forget(h)}>
                    <T>Forget</T>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Row>
  );
}

function LargeFilesRow() {
  return (
    <ToggleNumber
      toggleKey="vcs.git.warnLargeFiles"
      numberKey="vcs.git.largeFileMb"
      label="Warn when committing files larger than"
      unit="MB"
      {...L.largeFileMb}
    />
  );
}

function InlineBlameRows() {
  const [show] = useSetting<boolean>("vcs.git.inlineBlame");
  return (
    <>
      <BoundToggle k="vcs.git.inlineBlame" label="Show inline blame for the current line" />
      <Indented>
        <BoundToggle
          k="vcs.git.inlineBlameClickable"
          label="Open the commit when the inline blame is clicked"
          disabled={!show}
        />
      </Indented>
    </>
  );
}

function PushDialogRows() {
  const [show] = useSetting<boolean>("vcs.git.showPushDialog");
  return (
    <>
      <BoundToggle k="vcs.git.showPushDialog" label="Show Push dialog for Commit and Push" />
      <Indented>
        <BoundToggle
          k="vcs.git.pushDialogOnlyProtected"
          label="Show Push dialog only when committing to protected branches"
          disabled={!show}
        />
      </Indented>
    </>
  );
}

const PATCH_CREATED: SelectOption[] = [
  { value: "ask", label: "Ask" },
  { value: "no", label: "No" },
  { value: "reveal", label: showInFileManagerLabel() },
];

const INCOMING: SelectOption[] = [
  { value: "auto", label: "Auto" },
  { value: "always", label: "Always" },
  { value: "never", label: "Never" },
];

// ---------------------------------------------------------------------------
// Commit

function MessageLimits() {
  const [limitBody] = useSetting<boolean>("vcs.commit.limitBody");
  const [limitSubject] = useSetting<boolean>("vcs.commit.limitSubject");
  const anyLimit = limitBody || limitSubject;
  return (
    <>
      <ToggleNumber
        toggleKey="vcs.commit.limitSubject"
        numberKey="vcs.commit.subjectLimit"
        label="Limit subject line"
        {...L.messageLimit}
      />
      <ToggleNumber
        toggleKey="vcs.commit.limitBody"
        numberKey="vcs.commit.bodyLimit"
        label="Limit body line"
        {...L.messageLimit}
      />
      <Indented>
        <BoundToggle k="vcs.commit.showRightMargin" label="Show right margin" disabled={!anyLimit} />
        <BoundToggle k="vcs.commit.wrapAtMargin" label="Wrap when typing reaches right margin" disabled={!limitBody} />
      </Indented>
    </>
  );
}

const AUTOMATIC = "";

/** The installed coding agents, as the agents feature reports them; empty where agents can't run. */
function useInstalledAgents(): AgentProvider[] {
  const [agents, setAgents] = useState<AgentProvider[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    call(commands.agentProviders())
      .then((all) => live && setAgents(all.filter((p) => p.installed)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

type ModelCatalog = Pick<AgentModelCatalog, "config" | "thoughtLevels">;

/** The models `agent` offers, from its catalog; asks the agent for it once when it hasn't reported one. */
function useModelCatalog(agent: AgentProvider | undefined): ModelCatalog | undefined {
  const [catalog, setCatalog] = useState<{ provider: string } & ModelCatalog>();
  const id = agent?.id;
  useEffect(() => {
    if (!id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const load = () =>
      call(commands.agentRefreshModels(id, false, null))
        .then((c) => {
          if (!live) return;
          setCatalog(c);
          if (c.refreshing && ++polls < CATALOG_POLLS) timer = setTimeout(load, CATALOG_POLL_MS);
        })
        .catch(() => {});
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id]);
  if (!agent) return undefined;
  const fresh = catalog?.provider === agent.id && catalog.config.some((o) => o.category === "model");
  return fresh ? catalog : { config: agent.config, thoughtLevels: agent.thoughtLevels ?? {} };
}

const CATALOG_POLL_MS = 1_500;
const CATALOG_POLLS = 40;

/** `values` as options after `automatic`, keeping a saved value the agent no longer lists. */
function choiceOptions(
  automatic: string,
  values: readonly { value: string; name: string }[],
  saved: string,
): SelectOption<string>[] {
  const options = [{ value: AUTOMATIC, label: automatic }, ...values.map((v) => ({ value: v.value, label: v.name }))];
  return saved && !values.some((v) => v.value === saved) ? [...options, { value: saved, label: saved }] : options;
}

function CommitAgentRows() {
  const agents = useInstalledAgents();
  const [agent, setAgent] = useSetting<string>("vcs.commit.agent");
  const [model, setModel] = useSetting<string>("vcs.commit.agentModel");
  const [effort, setEffort] = useSetting<string>("vcs.commit.agentEffort");
  const catalog = useModelCatalog(agents.find((p) => p.id === agent));
  const models = catalog?.config.find((o) => o.category === "model");
  const shown = model || models?.current;
  const levels = (shown ? catalog?.thoughtLevels[shown] : undefined)?.find((o) => o.category === "thought_level");
  const agentOptions = choiceOptions(
    tx("Automatic (the agent of the latest task)"),
    agents.map((p) => ({ value: p.id, name: p.name })),
    agent,
  );
  const pick = (next: string) => {
    if (next === agent) return;
    setAgent(next);
    setModel(AUTOMATIC);
    setEffort(AUTOMATIC);
  };
  return (
    <>
      <Row label="Agent" hint="Commit messages are short: a fast model with low effort is usually enough.">
        <Select value={agent} options={agentOptions} onChange={pick} aria-label={tx("Agent")} />
      </Row>
      <Row label="Model" disabled={!agent}>
        <Select
          value={model}
          options={choiceOptions(tx("The agent's current model"), models?.values ?? [], model)}
          onChange={(next) => {
            setModel(next);
            setEffort(AUTOMATIC);
          }}
          disabled={!agent}
          aria-label={tx("Model")}
        />
      </Row>
      <Row label="Effort" disabled={!agent}>
        <Select
          value={effort}
          options={choiceOptions(tx("The agent's default"), levels?.values ?? [], effort)}
          onChange={setEffort}
          disabled={!agent}
          aria-label={tx("Effort")}
        />
      </Row>
    </>
  );
}

function AgentInstructionsRow() {
  const [value, set] = useSetting<string>("vcs.commit.agentInstructions");
  const id = useId();
  return (
    <Row
      label="Instructions for Generate Commit Message with Agent"
      htmlFor={id}
      hint="Added to the agent's prompt, e.g. a commit format, issue key prefixes or the language to write in."
      stacked
    >
      <textarea
        id={id}
        className={styles.instructions}
        rows={4}
        spellCheck={false}
        placeholder={tx(
          "Use Conventional Commits (feat:, fix:, …) and start with the issue key if the branch has one.",
        )}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </Row>
  );
}

function CommitChecks() {
  return (
    <Grid
      left={
        <>
          <BoundToggle
            k="vcs.commit.analyzeCode"
            label="Analyze code"
            hint="Reports errors and warnings from language servers."
          />
          <BoundToggle k="vcs.commit.checkTodo" label="Check TODO" hint="Looks for TODO and FIXME in added lines." />
          <BoundToggle k="vcs.commit.cleanup" label="Cleanup" hint="Applies fix-all code actions." />
        </>
      }
      right={
        <>
          <BoundToggle k="vcs.commit.reformat" label="Reformat code" />
          <BoundToggle k="vcs.commit.optimizeImports" label="Optimize imports" />
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Issue Navigation

const ISSUE_COLUMNS = [
  { key: "pattern", title: "Issue ID", placeholder: "[A-Z]+-\\d+", mono: true },
  { key: "link", title: "Issue Link", placeholder: "https://tracker.example.com/issue/$0", mono: true },
];

function IssueTable() {
  const [links, setLinks] = useSetting<IssueLinkValid[]>("vcs.issueNavigation");
  const invalid = links.filter((l) => {
    try {
      new RegExp(l.pattern);
      return false;
    } catch {
      return true;
    }
  });
  return (
    <Row
      label="Issue navigation"
      stacked
      hint={
        <>
          {tx(
            "Matches of an Issue ID regular expression in commit messages (Git log, commit details) become links; $0 is the whole match, $1… the groups.",
          )}
          {invalid.length > 0 && (
            <span className={styles.error}> {tx`Invalid pattern: ${invalid.map((l) => l.pattern).join(", ")}`}</span>
          )}
        </>
      }
    >
      <TableEditor
        rows={links.map((l) => ({ pattern: l.pattern, link: l.link }))}
        columns={ISSUE_COLUMNS}
        onChange={(rows) => setLinks(rows.map((r) => ({ pattern: r.pattern ?? "", link: r.link ?? "" })))}
        empty="No issue navigation links"
        aria-label="Issue navigation links"
      />
    </Row>
  );
}

function IssuePresets() {
  const [links, setLinks] = useSetting<IssueLinkValid[]>("vcs.issueNavigation");
  const add = (link: IssueLinkValid) => setLinks([...links, link]);
  return (
    <Row label="Add pattern">
      <Button
        size="small"
        onClick={() => add({ pattern: "[A-Z][A-Z0-9]+-\\d+", link: "https://jira.example.com/browse/$0" })}
      >
        <T>Add JIRA Pattern</T>
      </Button>
      <Button
        size="small"
        onClick={() => add({ pattern: "[A-Z][A-Z0-9]+-\\d+", link: "https://youtrack.example.com/issue/$0" })}
      >
        <T>Add YouTrack Pattern</T>
      </Button>
      <Button size="small" onClick={() => add({ pattern: "#(\\d+)", link: "https://github.com/owner/repo/issues/$1" })}>
        <T>Add GitHub Pattern</T>
      </Button>
    </Row>
  );
}

export const VCS_PAGES: PageSpec[] = [
  // No sections: the page links to its sub-pages.
  { id: "vcs", title: "Version Control", order: 300, keywords: ["git", "vcs", "history"] },
  {
    id: "vcs.commit",
    title: "Commit",
    order: 1,
    projectScope: true,
    keywords: ["commit checks", "commit message", "modal commit", "commit dialog"],
    sections: [
      {
        options: [
          {
            kind: "toggle",
            key: "vcs.commit.nonModal",
            label: "Use non-modal commit interface",
            hint: "When off, Local Changes and Stash are tabs of the Git tool window and Commit opens a dialog.",
          },
          { kind: "toggle", key: "vcs.commit.clearInitialMessage", label: "Clear initial commit message" },
        ],
      },
      {
        title: "Commit Message Inspections",
        options: [
          { kind: "toggle", key: "vcs.commit.blankLineAfterSubject", label: "Blank line between subject and body" },
          {
            kind: "custom",
            label: "Limit subject line",
            keywords: ["Limit body line", "Show right margin", "Wrap when typing reaches right margin"],
            component: MessageLimits,
          },
        ],
      },
      {
        title: "Commit Message Generation",
        options: [
          {
            kind: "custom",
            label: "Agent",
            keywords: ["agent", "ai", "model", "effort", "thinking", "reasoning", "generate commit message"],
            component: CommitAgentRows,
          },
          {
            kind: "custom",
            label: "Instructions for Generate Commit Message with Agent",
            keywords: ["agent", "ai", "prompt", "conventional commits"],
            component: AgentInstructionsRow,
          },
        ],
      },
      {
        title: "Commit Checks",
        options: [
          {
            kind: "custom",
            label: "Analyze code",
            keywords: ["Check TODO", "Reformat code", "Optimize imports", "Cleanup", "before commit"],
            component: CommitChecks,
          },
        ],
      },
    ],
  },
  {
    id: "vcs.confirmation",
    title: "Confirmation",
    order: 2,
    projectScope: true,
    keywords: ["add to git", "remove from git", "ask"],
    sections: [
      {
        title: "Confirmation",
        options: [
          {
            kind: "custom",
            label: "When files are created",
            keywords: ["Add silently", "Do not add"],
            component: () => (
              <RadioRow
                k="vcs.confirmation.onCreate"
                label="When files are created"
                choices={[
                  { value: "ask", label: "Ask" },
                  { value: "silently", label: "Add silently" },
                  { value: "never", label: "Do not add" },
                ]}
              />
            ),
          },
          {
            kind: "custom",
            label: "When files are deleted",
            keywords: ["Remove silently", "Do not remove"],
            component: () => (
              <RadioRow
                k="vcs.confirmation.onDelete"
                label="When files are deleted"
                choices={[
                  { value: "ask", label: "Ask" },
                  { value: "silently", label: "Remove silently" },
                  { value: "never", label: "Do not remove" },
                ]}
              />
            ),
          },
          { kind: "toggle", key: "vcs.confirmation.showUpdateOptions", label: "Show options before Update" },
          {
            kind: "toggle",
            key: "vcs.confirmation.confirmDropCommits",
            label: "Ask for confirmation to drop commits",
            hint: "Applicable to Git",
          },
        ],
      },
      {
        title: "Changes",
        options: [
          {
            kind: "toggle",
            key: "vcs.showDirtyDirectories",
            label: "Highlight directories that contain modified files in the Project tree",
          },
          {
            kind: "select",
            key: "vcs.confirmation.onPatchCreated",
            label: "When patch is created",
            options: PATCH_CREATED,
          },
          { kind: "custom", label: "Limit history to", keywords: ["rows", "file history"], component: HistoryLimitRow },
        ],
      },
    ],
  },
  {
    id: "vcs.mappings",
    title: "Directory Mappings",
    order: 3,
    keywords: ["root", "repository", "vcs root"],
    sections: [
      { options: [{ kind: "custom", label: "Directory", keywords: ["VCS", "Git"], component: MappingsTable }] },
    ],
  },
  {
    id: "vcs.git",
    title: "Git",
    order: 8,
    projectScope: true,
    keywords: ["git", "executable", "push", "pull", "update"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Path to Git executable",
            keywords: ["Test", "git version"],
            component: GitExecutableRow,
          },
          {
            kind: "custom",
            label: "Show inline blame for the current line",
            keywords: ["Open the commit when the inline blame is clicked"],
            component: InlineBlameRows,
          },
          {
            kind: "toggle",
            key: "vcs.git.showBranchInProjectView",
            label: "Show branch and incoming/outgoing commits in the Project view",
          },
          {
            kind: "toggle",
            key: "vcs.git.cliStatus",
            label: "Detect changes with the Git command line",
            hint: "Slower, but matches git status where encryption or file protection software makes files look modified.",
          },
        ],
      },
      {
        title: "Commit",
        options: [
          {
            kind: "toggle",
            key: "vcs.git.stagingArea",
            label: "Enable staging area",
            hint: "Commit works on the Git index: stage and unstage changes instead of checking them. Change lists are not used. Only for the non-modal commit interface.",
          },
          { kind: "toggle", key: "vcs.git.warnCrlf", label: "Warn if CRLF line separators are about to be committed" },
          {
            kind: "toggle",
            key: "vcs.git.warnDetachedHead",
            label: "Warn when committing in detached HEAD or during rebase",
          },
          {
            kind: "toggle",
            key: "vcs.git.signOff",
            label: "Sign-off commit",
            hint: "Adds a Signed-off-by trailer by default; it can still be switched per commit in Commit Options.",
          },
          {
            kind: "custom",
            label: "Warn when committing files larger than",
            keywords: ["MB"],
            component: LargeFilesRow,
          },
          {
            kind: "toggle",
            key: "vcs.git.warnBadFileNames",
            label: "Warn when committing files with names that might cause issues on other systems",
          },
        ],
      },
      {
        title: "Push",
        options: [
          {
            kind: "toggle",
            key: "vcs.git.autoUpdateOnPushRejected",
            label: "Auto-update if push of the current branch was rejected",
          },
          {
            kind: "custom",
            label: "Show Push dialog for Commit and Push",
            keywords: ["Show Push dialog only when committing to protected branches"],
            component: PushDialogRows,
          },
          { kind: "custom", label: "Protected branches", keywords: ["force push"], component: ProtectedBranchesRow },
        ],
      },
      {
        title: "Update",
        options: [
          {
            kind: "custom",
            label: "Update method",
            keywords: ["Merge", "Rebase", "pull"],
            component: () => (
              <RadioRow
                k="vcs.git.updateMethod"
                label="Update method"
                choices={[
                  { value: "merge", label: "Merge" },
                  { value: "rebase", label: "Rebase" },
                ]}
              />
            ),
          },
          {
            kind: "custom",
            label: "Explicitly check for incoming commits on remotes",
            keywords: ["Auto", "Always", "Never", "fetch"],
            component: () => (
              <SettingSelect
                k="vcs.git.incomingCheck"
                label="Explicitly check for incoming commits on remotes"
                options={INCOMING}
                hint="Fetches the remotes of every repository in the background so incoming commits show in the Branches popup and the Project view. Auto stops checking a repository after it fails, for example on an authentication failure."
              />
            ),
          },
          {
            kind: "number",
            key: "vcs.git.incomingCheckInterval",
            label: "Check for incoming commits every",
            ...L.incomingCheckInterval,
            integer: true,
            unit: "min",
          },
        ],
      },
      {
        title: "Passwords",
        options: [
          {
            kind: "custom",
            label: "Passwords",
            keywords: ["credentials", "remember", "forget", "https"],
            component: GitCredentialsRow,
          },
        ],
      },
      {
        title: "Stash",
        options: [
          { kind: "toggle", key: "vcs.git.combineStashAndShelf", label: "Combine stashes and shelves in one tab" },
        ],
      },
    ],
  },
  {
    id: "vcs.shelf",
    title: "Shelf",
    order: 7,
    projectScope: true,
    keywords: ["shelve", "unshelve"],
    sections: [
      {
        options: [
          {
            kind: "toggle",
            key: "vcs.shelf.removeApplied",
            label: "Remove successfully applied files from the shelf",
          },
        ],
      },
    ],
  },
  {
    id: "vcs.issueNavigation",
    title: "Issue Navigation",
    order: 5,
    projectScope: true,
    keywords: ["issue", "tracker", "jira", "youtrack", "link"],
    sections: [
      {
        options: [
          { kind: "custom", label: "Issue ID", keywords: ["Issue Link", "regex"], component: IssueTable },
          {
            kind: "custom",
            label: "Add JIRA Pattern",
            keywords: ["Add YouTrack Pattern", "GitHub"],
            component: IssuePresets,
          },
        ],
      },
    ],
  },
];
