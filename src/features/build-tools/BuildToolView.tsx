/** The Maven and Gradle tool windows: toolbar, status banner and the project tree. */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import clsx from "clsx";
import type { BuildTool, GradleModel, MavenModel, RunConfig } from "@/platform/ipc";
import { downloadJdkActions } from "@/platform/jdk";
import { useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  Spinner,
  Tree,
  showContextMenu,
  type MenuItem,
  type TreeRowState,
  T,
} from "@/ui";
import {
  gradleChildren,
  gradleRoots,
  gradleTaskConfig,
  isRunnable,
  mavenChildren,
  mavenGoalConfig,
  mavenRoots,
  nodeIcon,
  nodeLabel,
  profileChecked,
  withGradleOptions,
  type BuildNode,
} from "./model";
import {
  createRunConfig,
  initialExpanded,
  runConfig,
  setCurrentProject,
  setExpanded,
  setProfile,
  syncTool,
  useBuild,
} from "./store";
import styles from "./BuildTools.module.css";
import { tx } from "@/platform/i18n";

export function MavenView() {
  return <BuildToolView tool="maven" />;
}

export function GradleView() {
  return <BuildToolView tool="gradle" />;
}

/** The run configuration a runnable node (or several of one project) starts. */
export function nodeConfig(
  nodes: readonly BuildNode[],
  model: { maven?: MavenModel | null; gradle?: GradleModel | null },
) {
  const settings = useBuild.getState().settings;
  const first = nodes[0];
  if (!first) return null;
  if (first.kind === "runConfig")
    return first.config.kind === "gradle" ? withGradleOptions(first.config, settings.gradle) : first.config;
  if ((first.kind === "phase" || first.kind === "goal") && model.maven) {
    const same = nodes.filter(
      (n): n is Extract<BuildNode, { kind: "phase" | "goal" }> =>
        (n.kind === "phase" || n.kind === "goal") && n.project.pom === first.project.pom,
    );
    const goals = same.map((n) => (n.kind === "phase" ? n.phase : `${n.plugin.prefix}:${n.goal}`));
    return mavenGoalConfig(first.project, goals, model.maven, settings.maven);
  }
  if (first.kind === "task" && model.gradle) {
    const same = nodes.filter(
      (n): n is Extract<BuildNode, { kind: "task" }> => n.kind === "task" && n.project.path === first.project.path,
    );
    return gradleTaskConfig(
      model.gradle,
      first.project,
      same.map((n) => n.task.name),
      settings.gradle,
    );
  }
  return null;
}

/** Memoised children lookup (node objects stay stable while the model is unchanged). */
function childrenOf(
  tool: BuildTool,
  maven: MavenModel | null,
  gradle: GradleModel | null,
  configs: readonly RunConfig[],
) {
  const cache = new Map<string, BuildNode[] | undefined>();
  return (n: BuildNode) => {
    if (cache.has(n.key)) return cache.get(n.key);
    const kids =
      tool === "maven"
        ? maven
          ? mavenChildren(n, maven, configs)
          : undefined
        : gradle
          ? gradleChildren(n, gradle, configs)
          : undefined;
    cache.set(n.key, kids);
    return kids;
  };
}

/** Maven `pom` / Gradle project path of the project a node belongs to. */
function nodeProject(n: BuildNode): string | undefined {
  if ("project" in n) return "pom" in n.project ? n.project.pom : n.project.path;
  return undefined;
}

function Toolbar({ tool, selection }: { tool: BuildTool; selection: BuildNode[] }) {
  const syncing = useBuild((s) => !!s.syncing[tool]);
  const settings = useBuild((s) => s.settings);
  const model = useBuild((s) => s.model);
  const runnable = selection.filter(isRunnable);
  const runSelected = () => {
    const config = model && nodeConfig(runnable, model);
    if (config) runConfig(config, "run");
  };
  const maven = tool === "maven";
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={maven ? "Maven actions" : "Gradle actions"}>
      {syncing ? (
        <IconButton icon="stop" size="small" iconSize={16} action={`${tool}.cancelReload`} />
      ) : (
        <IconButton icon="refresh" size="small" iconSize={16} action={`${tool}.reload`} />
      )}
      {maven && <IconButton icon="plus" size="small" iconSize={16} action="maven.addProjects" />}
      <span className={styles.sep} />
      <IconButton
        icon="run"
        size="small"
        iconSize={16}
        title={maven ? "Run Maven Build" : "Run Gradle Task"}
        disabled={!runnable.length}
        onClick={runSelected}
      />
      <IconButton
        icon="run-anything"
        size="small"
        iconSize={16}
        action={maven ? "maven.executeGoal" : "gradle.executeTask"}
      />
      <IconButton
        icon="build-offline"
        size="small"
        iconSize={16}
        action={`${tool}.toggleOffline`}
        pressed={maven ? settings.maven.offline : settings.gradle.offline}
      />
      {maven && <IconButton icon="build-dependencies" size="small" iconSize={16} action="maven.analyzeDependencies" />}
      {maven && (
        <IconButton
          icon="skip-tests"
          size="small"
          iconSize={16}
          action="maven.toggleSkipTests"
          pressed={settings.maven.skipTests}
        />
      )}
      <span className={styles.sep} />
      <IconButton icon="expand-all" size="small" iconSize={16} action={`${tool}.expandAll`} />
      <IconButton icon="collapse-all" size="small" iconSize={16} action={`${tool}.collapseAll`} />
    </div>
  );
}

function Banner({ tool }: { tool: BuildTool }) {
  const sync = useBuild((s) => s.syncing[tool]);
  const info = useBuild((s) => (tool === "maven" ? s.model?.maven : s.model?.gradle));
  if (sync)
    return (
      <div className={styles.banner} role="status">
        <Spinner size={12} />
        <span className={styles.bannerText}>{sync.message}</span>
        {sync.fraction != null && <span className={styles.bannerPct}>{Math.round(sync.fraction * 100)}%</span>}
      </div>
    );
  if (!info) return null;
  if (info.stale)
    return (
      <div className={styles.banner}>
        <Icon name={tool === "maven" ? "maven-load-changes" : "gradle-load-changes"} size={16} />
        <span className={styles.bannerText}>
          <T>Build files changed since the last reload</T>
        </span>
        <Button size="small" variant="ghost" onClick={() => void syncTool(tool)}>
          {tool === "maven" ? "Load Maven Changes" : "Load Gradle Changes"}
        </Button>
      </div>
    );
  if (info.syncError) {
    const [jdkFix] = downloadJdkActions(info.syncError);
    return (
      <div className={clsx(styles.banner, styles.bannerWarning)} title={info.syncError}>
        <Icon name="warning" size={16} />
        <span className={styles.bannerText}>{info.syncError.split("\n")[0]}</span>
        {jdkFix && (
          <Button size="small" variant="ghost" onClick={jdkFix.run}>
            {jdkFix.label}
          </Button>
        )}
      </div>
    );
  }
  return null;
}

function NodeRow({ node, state }: { node: BuildNode; state: TreeRowState }) {
  const choices = useBuild((s) => s.settings.maven.profiles);
  if (node.kind === "profile") {
    return (
      <span className={styles.row} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={profileChecked(node.profile, choices)}
          onChange={(v) => setProfile(node.profile.id, v)}
          label={node.profile.id}
          className={styles.profile}
        />
      </span>
    );
  }
  const detail =
    node.kind === "dependency" && node.dependency.scope !== "compile"
      ? `(${node.dependency.scope}${node.dependency.optional ? ", optional" : ""})`
      : node.kind === "dependency" && node.dependency.optional
        ? "(optional)"
        : node.kind === "task"
          ? node.task.description
          : null;
  return (
    <span className={styles.row} title={node.kind === "task" ? (node.task.description ?? undefined) : undefined}>
      <Icon name={nodeIcon(node)} size={16} className={styles.icon} />
      <span className={clsx(styles.label, state.selected && styles.selectedLabel)}>{nodeLabel(node)}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
    </span>
  );
}

function BuildToolView({ tool }: { tool: BuildTool }) {
  const model = useBuild((s) => s.model);
  const configs = useBuild((s) => s.configs);
  const loading = useBuild((s) => s.loading);
  const error = useBuild((s) => s.error);
  const expanded = useBuild((s) => s.expanded[tool]);
  const root = useProject((s) => s.project?.root ?? "");
  const [selection, setSelection] = useState<BuildNode[]>([]);
  const maven = model?.maven ?? null;
  const gradle = model?.gradle ?? null;

  const roots = useMemo(
    () => (tool === "maven" ? (maven ? mavenRoots(maven) : []) : gradle ? gradleRoots(gradle) : []),
    [tool, maven, gradle],
  );
  const getChildren = useMemo(() => childrenOf(tool, maven, gradle, configs), [tool, maven, gradle, configs]);

  const hasModel = tool === "maven" ? !!maven : !!gradle;
  useEffect(() => {
    if (model && hasModel && useBuild.getState().expanded[tool].size === 0)
      setExpanded(tool, initialExpanded(tool, model));
  }, [model, hasModel, tool]);

  const nodesByKey = useCallback(
    (keys: Set<string>) => {
      const out: BuildNode[] = [];
      const walk = (nodes: readonly BuildNode[]) => {
        for (const n of nodes) {
          if (keys.has(n.key)) out.push(n);
          if (expanded.has(n.key)) walk(getChildren(n) ?? []);
        }
      };
      walk(roots);
      return out;
    },
    [roots, expanded, getChildren],
  );

  const run = (nodes: BuildNode[], mode: "run" | "debug") => {
    const config = model && nodeConfig(nodes, model);
    if (config) runConfig(config, mode);
  };

  const contextMenu = (node: BuildNode | null, keys: Set<string>, e: MouseEvent) => {
    if (!node) return;
    e.preventDefault();
    const nodes = keys.has(node.key) ? nodesByKey(keys) : [node];
    const items: MenuItem[] = [];
    const config = isRunnable(node) && model ? nodeConfig(nodes.filter(isRunnable), model) : null;
    if (config) {
      items.push(
        { label: tx`Run '${config.name}'`, icon: "run", run: () => runConfig(config, "run") },
        { label: tx`Debug '${config.name}'`, icon: "debug", run: () => runConfig(config, "debug") },
        { kind: "separator" },
      );
      if (node.kind === "runConfig")
        items.push({ kind: "action", action: "run.editConfigs", arg: node.config.id, label: "Edit Configuration…" });
      else items.push({ label: "Create Run Configuration…", icon: "edit", run: () => void createRunConfig(config) });
    }
    if (node.kind === "mavenProject") {
      if (!node.project.aggregated)
        items.push({ kind: "action", action: "maven.unlinkProjects", arg: { pom: node.project.pom } });
      items.push(
        {
          label: "Open pom.xml",
          icon: "file-maven",
          run: () => void editorService().openFile(`${root}/${node.project.pom}`),
        },
        { kind: "action", action: "maven.reload", label: "Reload All Maven Projects" },
        { kind: "action", action: "maven.executeGoal" },
        { kind: "action", action: "maven.analyzeDependencies", arg: { pom: node.project.pom } },
      );
    }
    if (node.kind === "dependencies")
      items.push({ kind: "action", action: "maven.analyzeDependencies", arg: { pom: node.project.pom } });
    if (node.kind === "gradleProject") {
      const file = node.project.buildFile;
      if (file)
        items.push({
          label: tx`Open ${file.split("/").pop()}`,
          icon: "file-gradle",
          run: () => void editorService().openFile(`${root}/${file}`),
        });
      items.push(
        { kind: "action", action: "gradle.reload", label: "Reload All Gradle Projects" },
        { kind: "action", action: "gradle.executeTask" },
      );
    }
    if (node.kind === "dependency") {
      const d = node.dependency;
      const coords = [d.groupId, d.artifactId, d.version].filter(Boolean).join(":");
      items.push({ label: "Copy Coordinates", icon: "copy", run: () => void navigator.clipboard?.writeText(coords) });
    }
    if (items.length) showContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  if (!model) {
    return (
      <div className={styles.view}>
        <div className={styles.loading}>
          {error ? (
            error
          ) : loading ? (
            <>
              <Spinner size={14} /> <T>Loading…</T>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <Toolbar tool={tool} selection={selection} />
      <Banner tool={tool} />
      <div className={styles.body}>
        <Tree<BuildNode>
          roots={roots}
          getKey={(n) => n.key}
          getLabel={nodeLabel}
          getChildren={getChildren}
          isExpandable={(n) => !!getChildren(n)?.length}
          expanded={expanded}
          onExpandedChange={(next) => setExpanded(tool, next)}
          onSelectionChange={(keys, lead) => {
            setSelection(nodesByKey(keys));
            if (lead) setCurrentProject(tool, nodeProject(lead));
          }}
          renderNode={(n, state) => <NodeRow node={n} state={state} />}
          onActivate={(n) => {
            if (n.kind === "profile") {
              setProfile(n.profile.id, !profileChecked(n.profile, useBuild.getState().settings.maven.profiles));
              return;
            }
            if (isRunnable(n)) run([n], "run");
          }}
          onContextMenu={contextMenu}
          aria-label={tool === "maven" ? "Maven projects" : "Gradle projects"}
          empty={<EmptyState title={tool === "maven" ? "No Maven projects" : "No Gradle projects"} />}
        />
      </div>
    </div>
  );
}
