/**
 * Version Control pages (IDEA layout): Version Control, Commit, Confirmation,
 * Directory Mappings, Issue Navigation, Shelf, Git (the vcs feature adds Log).
 * Behaviour lives in the vcs feature, which reads `vcs.*` through
 * `platform/workflowSettings`.
 */
import { useEffect, useId, useState } from "react";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { WORKFLOW_LIMITS, type IssueLinkValid } from "@/platform/workflowSettings";
import { Button, Icon, Input, type SelectOption, T } from "@/ui";
import { Row, SettingSelect } from "../components/Form";
import { useSetting } from "../components/context";
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

function MappingsTable() {
  const project = useProject((s) => s.project);
  return (
    <div className={styles.tableBox}>
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
          {!project ? (
            <tr>
              <td colSpan={2} className={styles.empty}>
                <T>No project is open</T>
              </td>
            </tr>
          ) : (
            <tr>
              <td title={project.root}>
                <Icon name="folder" size={16} className={styles.mappingIcon} />
                {tx("<Project>")} {project.root}
              </td>
              <td>{project.isGit ? "Git" : tx("<none>")}</td>
            </tr>
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
  { value: "reveal", label: "Show in Finder" },
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
        ],
      },
      {
        title: "Commit",
        options: [
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
                hint="Fetches remotes in the background so incoming commits show in the Branches popup. Auto stops after an authentication failure."
              />
            ),
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
