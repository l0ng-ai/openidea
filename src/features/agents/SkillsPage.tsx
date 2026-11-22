/**
 * Settings › Agents › Skills: every skill the CLI folders expose in one list, grouped by the
 * source it was discovered in (workspace, user, and each CLI's own folders, symlinked copies
 * collapsed by the backend), with the auto / slash-only / off modes settable globally or per
 * workspace, and an expandable inspector showing the canonical path and SKILL.md validation.
 */
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentSkillMode, AgentSkillState, McpScope } from "@/bindings";
import { revealInFileManager, revealInFileManagerLabel } from "@/platform/fileManager";
import { formatMessage, useTx } from "@/platform/i18n";
import { isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Button, Icon, IconButton, SearchField, Select, Tabs, T } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { InstallSkillDialog } from "./InstallSkillDialog";
import { providerIcon } from "./model";
import {
  SKILL_SOURCE_GROUPS,
  defaultSkillsBackend,
  isDiscoveredSource,
  useSkillsCatalog,
  type SkillsBackend,
} from "./skillsModel";
import page from "./SettingsPage.module.css";
import styles from "./SkillsPage.module.css";

export { defaultSkillsBackend, type SkillsBackend };

type SourceTab = "all" | "workspace" | "user" | "plugin" | "cli";

/** A key of the source-group table (and so, a skill source). */
type SkillSource = keyof typeof SKILL_SOURCE_GROUPS;

const MODE_OPTIONS: ReadonlyArray<{ value: AgentSkillMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "slashOnly", label: "Slash only" },
  { value: "off", label: "Off" },
];

/** Groups a tab shows, in source precedence order. */
function groupsForTab(tab: SourceTab): readonly SkillSource[] {
  const order = Object.keys(SKILL_SOURCE_GROUPS) as SkillSource[];
  if (tab === "all") return order;
  if (tab === "workspace") return order.filter((s) => s === "workspace" || s.endsWith("Workspace"));
  if (tab === "user") return order.filter((s) => s === "user" || s.endsWith("User"));
  if (tab === "plugin") return ["plugin"];
  return order.filter(isDiscoveredSource);
}

export function SkillsPage({ backend = defaultSkillsBackend }: { backend?: SkillsBackend }) {
  const tx = useTx();
  const hasProject = useProject((s) => !!s.project?.root);
  const hasTrustedProject = useProject((s) => !!s.project?.root && !!s.project?.trusted);
  const [tab, setTab] = useState<SourceTab>("all");
  const [skills, setSkills] = useState<AgentSkillState[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // The scope the row's mode selector writes to; defaults follow where the mode came from.
  const [scopes, setScopes] = useState<Record<string, McpScope>>({});

  const syncCatalog = useCallback(
    (next: AgentSkillState[]) => {
      setSkills(next);
      if (backend === defaultSkillsBackend) {
        useSkillsCatalog.setState({ skills: next, loaded: true });
      }
    },
    [backend],
  );

  const load = useCallback(() => {
    backend
      .list()
      .then((list) => {
        syncCatalog(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [backend, syncCatalog]);

  useEffect(() => {
    load();
    if (backend !== defaultSkillsBackend || !isTauri() || typeof onIdeEvent !== "function") return;
    return onIdeEvent("settingsChanged", (e) => {
      if (!e.key || e.key.startsWith("agents.skills")) {
        load();
      }
    });
  }, [load, backend]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.skill.name.toLowerCase().includes(q) ||
        s.skill.description.toLowerCase().includes(q) ||
        s.skill.path.toLowerCase().includes(q),
    );
  }, [skills, query]);

  const grouped = useMemo(() => {
    const order = groupsForTab(tab);
    const map = new Map<SkillSource, AgentSkillState[]>();
    for (const source of order) {
      const items = filtered.filter((s) => s.skill.source === source);
      if (items.length > 0) map.set(source, items);
    }
    return [...map.entries()];
  }, [filtered, tab]);

  const tabCount = (tab: SourceTab): number => {
    if (tab === "all") return skills.length;
    const sources = groupsForTab(tab);
    return skills.filter((s) => (sources as readonly SkillSource[]).includes(s.skill.source)).length;
  };

  const setMode = async (state: AgentSkillState, scope: McpScope, mode: AgentSkillMode) => {
    setBusyName(state.skill.name);
    setError(null);
    try {
      const next = await backend.setMode(state.skill.name, scope, mode);
      syncCatalog(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    } finally {
      setBusyName(null);
    }
  };

  const scopeOf = (state: AgentSkillState): McpScope =>
    scopes[state.skill.name] ?? (state.origin === "workspace" || state.origin === "trust" ? "workspace" : "user");

  return (
    <div className={page.page}>
      <div className={page.header}>
        <h2 className={page.title}>
          <T>Skills</T>
        </h2>
        <div className={page.headerActions}>
          {backend.browse && backend.preview && backend.install && (
            <Button variant="primary" onClick={() => setInstallOpen(true)}>
              <Icon name="plus" size={14} /> <T>Install Skill…</T>
            </Button>
          )}
          <Button variant="secondary" onClick={load}>
            <Icon name="refresh" size={14} /> <T>Rescan</T>
          </Button>
        </div>
      </div>

      <p className={page.lead}>
        <T>
          Skills are SKILL.md folders the coding agents load: the workspace's and your user folders first, then what
          each CLI discovers on its own. A mode set here never edits the skill's files, and a repo can quiet a global
          skill without rules in AGENTS.md.
        </T>
      </p>

      <div className={page.topControls}>
        <div className={page.tabBar}>
          <Tabs
            variant="compact"
            aria-label={tx("Skill sources")}
            activeId={tab}
            onSelect={(id) => setTab(id as SourceTab)}
            items={[
              {
                id: "all",
                label: tx("All Sources"),
                text: tx("All Sources"),
                trailing: <span className={page.badge}>{skills.length}</span>,
              },
              {
                id: "workspace",
                label: tx("Workspace"),
                text: tx("Workspace"),
                trailing: <span className={page.badge}>{tabCount("workspace")}</span>,
              },
              {
                id: "user",
                label: tx("User"),
                text: tx("User"),
                trailing: <span className={page.badge}>{tabCount("user")}</span>,
              },
              {
                id: "plugin",
                label: tx("Plugins"),
                text: tx("Plugins"),
                trailing: <span className={page.badge}>{tabCount("plugin")}</span>,
              },
              {
                id: "cli",
                label: tx("Agent Folders"),
                text: tx("Agent Folders"),
                trailing: <span className={page.badge}>{tabCount("cli")}</span>,
              },
            ]}
          />
        </div>

        <SearchField
          className={page.search}
          value={query}
          onChange={setQuery}
          placeholder={tx("Type to search...")}
          aria-label={tx("Search skills")}
        />
      </div>

      {error && (
        <div className={page.error} role="alert">
          <Icon name="error" size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className={page.sections}>
        {grouped.map(([source, items]) => {
          const group = SKILL_SOURCE_GROUPS[source];
          const isCollapsed = collapsed[source];
          return (
            <section key={source} className={page.section} aria-label={tx(group.label)}>
              <div className={page.sectionBar}>
                <button
                  type="button"
                  className={page.sectionToggle}
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [source]: !prev[source] }))}
                >
                  <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={14} className={page.chevron} />
                  <span className={page.sectionTitle}>{tx(group.label)}</span>
                  <span className={page.badge}>{items.length}</span>
                  <span className={page.sectionHint}>{group.paths}</span>
                </button>
              </div>

              {!isCollapsed && (
                <div className={page.sectionBody} role="list">
                  {items.map((state) => (
                    <SkillCard
                      key={`${state.skill.source}:${state.skill.name}`}
                      state={state}
                      scope={scopeOf(state)}
                      hasProject={hasProject}
                      busy={busyName === state.skill.name}
                      isExpanded={!!expanded[`${state.skill.source}:${state.skill.name}`]}
                      onToggleExpand={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [`${state.skill.source}:${state.skill.name}`]:
                            !prev[`${state.skill.source}:${state.skill.name}`],
                        }))
                      }
                      onScopeChange={(scope) => setScopes((prev) => ({ ...prev, [state.skill.name]: scope }))}
                      onModeChange={(mode) => void setMode(state, scopeOf(state), mode)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {grouped.length === 0 && !error && (
          <div className={page.emptyBox}>
            <T>
              No skills found in .agents/skills, .openidea/skills, ~/.agents/skills, or the CLI folders of Claude Code,
              GitHub Copilot, Codex, and Cursor.
            </T>
          </div>
        )}
      </div>

      {installOpen && (
        <InstallSkillDialog
          backend={backend}
          hasTrustedProject={hasTrustedProject}
          onInstalled={(next) => {
            syncCatalog(next);
            setInstallOpen(false);
          }}
          onClose={() => setInstallOpen(false)}
        />
      )}
    </div>
  );
}

function SkillCard({
  state,
  scope,
  hasProject,
  busy,
  isExpanded,
  onToggleExpand,
  onScopeChange,
  onModeChange,
}: {
  state: AgentSkillState;
  scope: McpScope;
  hasProject: boolean;
  busy: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onScopeChange: (scope: McpScope) => void;
  onModeChange: (mode: AgentSkillMode) => void;
}) {
  const tx = useTx();
  const { skill } = state;
  const group = SKILL_SOURCE_GROUPS[skill.source];
  return (
    <div role="listitem" className={page.card}>
      <div className={page.cardHeader}>
        <button type="button" className={page.cardExpandBtn} aria-expanded={isExpanded} onClick={onToggleExpand}>
          <Icon name={isExpanded ? "chevron-down" : "chevron-right"} size={13} className={page.chevron} />
          <div className={page.cardMain}>
            <div className={page.cardTitleRow}>
              <span className={styles.skillName}>{skill.name}</span>
              {state.mode === "off" ? (
                <span className={page.tag}>
                  <T>Off</T>
                </span>
              ) : state.mode === "slashOnly" ? (
                <span className={page.tag}>
                  <T>Slash only</T>
                </span>
              ) : (
                <span className={page.tag}>
                  <T>Auto</T>
                </span>
              )}
              {state.origin === "user" && (
                <span className={page.tag}>
                  <T>Global</T>
                </span>
              )}
              {state.origin === "workspace" && (
                <span className={clsx(page.tag, page.tagAccent)}>
                  <T>Workspace</T>
                </span>
              )}
              {state.origin === "trust" && (
                <span className={clsx(page.tag, page.tagWarning)}>
                  <T>Untrusted workspace</T>
                </span>
              )}
              {isDiscoveredSource(skill.source) && (
                <span className={page.tag}>
                  <T>CLI-discovered</T>
                </span>
              )}
              {(skill.alsoIn?.length ?? 0) > 0 && (
                <span className={page.tag} title={skill.alsoIn?.map((s) => SKILL_SOURCE_GROUPS[s].paths).join(", ")}>
                  <Icon name="symlink-mark" size={12} />
                  {skill.alsoIn?.map((s) => tx(SKILL_SOURCE_GROUPS[s].label)).join(", ")}
                </span>
              )}
              {skill.contextFork && (
                <span className={page.tag} title={tx("Runs in a subagent where supported (context: fork)")}>
                  context: fork
                </span>
              )}
              {(skill.paths?.length ?? 0) > 0 && (
                <span className={page.tag} title={skill.paths?.join(", ")}>
                  {formatMessage(tx("paths ({count})"), { count: skill.paths?.length ?? 0 })}
                </span>
              )}
              {!skill.valid && (
                <span className={clsx(page.tag, page.tagWarning)}>
                  <T>Invalid SKILL.md</T>
                </span>
              )}
            </div>
            {skill.description && (
              <span className={styles.subtitle} title={skill.description}>
                {skill.description}
              </span>
            )}
          </div>
        </button>

        <div className={page.rowActions}>
          <div className={styles.modeControls}>
            <Select
              className={styles.scopeSelect}
              variant="framed"
              aria-label={tx`Scope for ${skill.name}`}
              value={scope}
              disabled={busy}
              options={[
                { value: "user", label: tx("Global") },
                ...(hasProject ? [{ value: "workspace" as McpScope, label: tx("Workspace") }] : []),
              ]}
              onChange={onScopeChange}
            />
            <Select
              className={styles.modeSelect}
              variant="framed"
              aria-label={tx`Mode for ${skill.name}`}
              value={state.mode}
              disabled={busy}
              options={MODE_OPTIONS.map((o) => ({ value: o.value, label: tx(o.label) }))}
              onChange={onModeChange}
            />
          </div>
          <span
            className={clsx(page.statusDot, state.mode !== "off" && page.statusOn)}
            title={state.mode === "off" ? tx("Off") : tx("Active")}
          />
        </div>
      </div>

      {isExpanded && (
        <div className={page.cardDrawer}>
          <div className={page.metaGrid}>
            <span className={page.metaLabel}>
              <T>Path</T>
            </span>
            <span className={page.metaValue}>{skill.path}</span>
            {(skill.alsoIn?.length ?? 0) > 0 && (
              <>
                <span className={page.metaLabel}>
                  <T>Also linked in</T>
                </span>
                <span className={page.metaValue}>
                  {skill.alsoIn
                    ?.map((s) => `${tx(SKILL_SOURCE_GROUPS[s].label)} (${SKILL_SOURCE_GROUPS[s].paths})`)
                    .join(" · ")}
                </span>
              </>
            )}
            {(skill.paths?.length ?? 0) > 0 && (
              <>
                <span className={page.metaLabel}>
                  <T>Paths</T>
                </span>
                <span className={page.metaValue}>{skill.paths?.join(", ")}</span>
              </>
            )}
            <span className={page.metaLabel}>
              <T>Validation</T>
            </span>
            <span className={page.metaValue}>
              {skill.valid
                ? tx("SKILL.md is valid")
                : (skill.warnings.length > 0 ? skill.warnings : [tx("SKILL.md failed validation")]).join("; ")}
            </span>
          </div>

          {isDiscoveredSource(skill.source) && group.agent && (
            <span className={styles.hint}>
              <Icon name={providerIcon(group.agent)} size={12} />{" "}
              <T>
                This CLI discovers the folder itself: off hides the skill from OpenIDEA's / menu and applies only where
                the CLI supports disabling.
              </T>
            </span>
          )}

          <div className={page.drawerFooter}>
            <div className={page.drawerButtons}>
              <Button
                variant="secondary"
                onClick={() => void editorService().openFile(`${skill.path}/SKILL.md`, { focus: true })}
              >
                <Icon name="file" size={12} /> <T>Open SKILL.md</T>
              </Button>
              <Button variant="secondary" onClick={() => void revealInFileManager(skill.path)}>
                <Icon name="folder" size={12} /> {tx(revealInFileManagerLabel())}
              </Button>
            </div>
            <IconButton
              icon="copy"
              size="small"
              title={tx("Copy path")}
              aria-label={formatMessage(tx("Copy the path of {name}"), { name: skill.name })}
              onClick={() => void navigator.clipboard.writeText(skill.path)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
