/** The Maven and Gradle tool windows: toolbar, status banner and the project tree. */
import { writeClipboardText } from "@/platform/clipboard";
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
  gradleProjectKey,
  gradleTaskConfig,
  isRunnable,
  mavenChildren,
  mavenGoalConfig,
  mavenRoots,
  nodeIcon,
  nodeLabel,
  profileChecked,
  withGradleOptions,
  gradleHasTestTask,
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
  model: { maven?: MavenModel | null; gradle?: readonly GradleModel[] },
) {
  const settings = useBuild.getState().settings;
  const first = nodes[0];
  if (!first) return null;
  if (first.kind === "runConfig")
    return first.config.kind === "gradle"
      ? withGradleOptions(first.config, settings.gradle, gradleHasTestTask(model.gradle ?? []))
      : first.config;
  if ((first.kind === "phase" || first.kind === "goal") && model.maven) {
    const same = nodes.filter(
      (n): n is Extract<BuildNode, { kind: "phase" | "goal" }> =>
        (n.kind === "phase" || n.kind === "goal") && n.project.pom === first.project.pom,
    );
    const goals = same.map((n) => (n.kind === "phase" ? n.phase : `${n.plugin.prefix}:${n.goal}`));
    return mavenGoalConfig(first.project, goals, model.maven, settings.maven);
  }
  if (first.kind === "task") {
    const build = model.gradle?.find((g) => g.dir === first.build.dir);
    const project = build?.projects.find((p) => p.path === first.project.path);
    if (!build || !project) return null;
    const same = nodes.filter(
      (n): n is Extract<BuildNode, { kind: "task" }> =>
        n.kind === "task" && n.build.dir === first.build.dir && n.project.path === first.project.path,
    );
    return gradleTaskConfig(
      build,
      project,
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
  gradle: readonly GradleModel[],
  configs: readonly RunConfig[],
  root: string,
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
          ? gradleChildren(n, gradle, configs, root)
          : undefined;
    cache.set(n.key, kids);
    return kids;
  };
}

/** Maven `pom` / Gradle project path of the project a node belongs to. */
function nodeProject(n: BuildNode): string | undefined {
  if ("project" in n)
    return "pom" in n.project ? n.project.pom : "build" in n ? gradleProjectKey(n.build, n.project) : undefined;
  return undefined;
}

function Toolbar({ tool, selection }: { tool: BuildTool; selection: BuildNode[] }) {
  const syncing = useBuild((s) => !!s.syncing[tool]);
  const settings = useBuild((s) => s.settings);
  const model = useBuild((s) => s.model);
  const config = model && nodeConfig(selection.filter(isRunnable), model);
  const runSelected = () => {
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
      {maven && <IconButton icon="folder-generated-source" size="small" iconSize={16} action="maven.generateSources" />}
      <IconButton icon="plus" size="small" iconSize={16} action={maven ? "maven.addProjects" : "gradle.linkProjects"} />
      <span className={styles.sep} />
      <IconButton
        icon="run"
        size="small"
        iconSize={16}
        title={maven ? "Run Maven Build" : "Run Gradle Task"}
        disabled={!config}
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
      <IconButton
        icon="build-dependencies"
        size="small"
        iconSize={16}
        action={maven ? "maven.analyzeDependencies" : "gradle.analyzeDependencies"}
      />
      <IconButton
        icon="skip-tests"
        size="small"
        iconSize={16}
        action={`${tool}.toggleSkipTests`}
        pressed={maven ? settings.maven.skipTests : settings.gradle.skipTests}
      />
      <span className={styles.sep} />
      <IconButton icon="expand-all" size="small" iconSize={16} action={`${tool}.expandAll`} />
      <IconButton icon="collapse-all" size="small" iconSize={16} action={`${tool}.collapseAll`} />
      {maven && (
        <IconButton icon="settings" size="small" iconSize={16} action="maven.settings" title="Maven Settings…" />
      )}
    </div>
  );
}

function Banner({ tool }: { tool: BuildTool }) {
  const sync = useBuild((s) => s.syncing[tool]);
  const model = useBuild((s) => s.model);
  const infos = tool === "maven" ? (model?.maven ? [model.maven] : []) : (model?.gradle ?? []);
  if (sync)
    return (
      <div className={styles.banner} role="status">
        <Spinner size={12} />
        <span className={styles.bannerText}>{sync.message}</span>
        {sync.fraction != null && <span className={styles.bannerPct}>{Math.round(sync.fraction * 100)}%</span>}
      </div>
    );
  return infos.map((info) => <BuildBanner key={"dir" in info ? info.dir : "maven"} info={info} tool={tool} />);
}

function BuildBanner({ info, tool }: { info: MavenModel | GradleModel; tool: BuildTool }) {
  if (info.stale)
    return (
      <div className={styles.banner}>
        <Icon name={tool === "maven" ? "maven-load-changes" : "gradle-load-changes"} size={16} />
        <span className={styles.bannerText}>
          <T>Build files changed since the last reload</T>
        </span>
        <Button size="small" variant="ghost" onClick={() => void syncTool(tool, "dir" in info ? info.dir : null)}>
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
  // Each toggle strikes through only its own tool's tree: the Maven `test` phase, or the Gradle `test` task.
  const mavenSkipTests = useBuild((s) => s.settings.maven.skipTests);
  const gradleSkipTests = useBuild((s) => s.settings.gradle.skipTests);
  if (node.kind === "profile") {
    return (
      <span className={styles.row} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={profileChecked(node.profile, choices)}
          onChange={(v) => setProfile(node.profile, v)}
          label={node.profile.id}
          className={styles.profile}
        />
      </span>
    );
  }
  const detail =
    node.kind === "profiles" && node.projectRoot
      ? node.projectRoot.split("/").pop()
      : node.kind === "dependency" && node.dependency.scope !== "compile"
        ? `(${node.dependency.scope}${node.dependency.optional ? ", optional" : ""})`
        : node.kind === "dependency" && node.dependency.optional
          ? "(optional)"
          : node.kind === "task"
            ? node.task.description
            : null;
  const skipped =
    (mavenSkipTests && node.kind === "phase" && node.phase === "test") ||
    (gradleSkipTests && node.kind === "task" && node.task.name === "test");
  return (
    <span className={styles.row} title={node.kind === "task" ? (node.task.description ?? undefined) : undefined}>
      <Icon name={nodeIcon(node)} size={16} className={styles.icon} />
      <span className={clsx(styles.label, state.selected && styles.selectedLabel, skipped && styles.skippedGoal)}>
        {nodeLabel(node)}
      </span>
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
  const gradle = model?.gradle;

  const roots = useMemo(
    () => (tool === "maven" ? (maven ? mavenRoots(maven) : []) : gradleRoots(gradle ?? [])),
    [tool, maven, gradle],
  );
  const getChildren = useMemo(
    () => childrenOf(tool, maven, gradle ?? [], configs, root),
    [tool, maven, gradle, configs, root],
  );

  const hasModel = tool === "maven" ? !!maven : !!gradle?.length;
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
      items.push({ kind: "action", action: "maven.unlinkProjects", arg: { pom: node.project.pom } });
      items.push(
        {
          label: "Open pom.xml",
          icon: "file-maven",
          run: () =>
            void editorService().openFile(node.project.projectRoot ? node.project.pom : `${root}/${node.project.pom}`),
        },
        { kind: "action", action: "maven.reload", label: "Reload All Maven Projects" },
        {
          kind: "action",
          action: "maven.generateSources",
          arg: { pom: node.project.pom },
          label: "Generate Sources and Update Folders",
        },
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
          run: () => void editorService().openFile(/^(?:[A-Za-z]:[\\/]|\/)/.test(file) ? file : `${root}/${file}`),
        });
      if (node.project.path === ":")
        items.push({ kind: "action", action: "gradle.unlinkProjects", arg: { buildDir: node.build.dir } });
      items.push(
        { kind: "action", action: "gradle.reload", label: "Reload Gradle Project", arg: { buildDir: node.build.dir } },
        {
          kind: "action",
          action: "gradle.executeTask",
          arg: { projectKey: gradleProjectKey(node.build, node.project) },
        },
        {
          kind: "action",
          action: "gradle.analyzeDependencies",
          arg: { buildDir: node.build.dir, gradlePath: node.project.path },
        },
      );
    }
    if (node.kind === "dependency") {
      const d = node.dependency;
      const coords = [d.groupId, d.artifactId, d.version].filter(Boolean).join(":");
      items.push({ label: "Copy Coordinates", icon: "copy", run: () => void writeClipboardText(coords) });
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
              setProfile(n.profile, !profileChecked(n.profile, useBuild.getState().settings.maven.profiles));
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
