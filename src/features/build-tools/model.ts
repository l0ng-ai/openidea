/**
 * Tree model and run configurations of the Maven and Gradle tool windows (pure).
 *
 * Maven (IDEA): Profiles, then one node per top-level project; each project has
 * Lifecycle, Plugins (expandable to goals), Dependencies (transitive after a
 * sync), Run Configurations and its modules. Gradle: the root project with
 * Tasks (grouped), Run Configurations and its subprojects.
 */
import type {
  GradleModel,
  GradleProject,
  GradleTask,
  MavenDependency,
  MavenModel,
  MavenPlugin,
  MavenProfile,
  MavenProject,
  RunConfig,
} from "@/platform/ipc";

export const LIFECYCLE = ["clean", "validate", "compile", "test", "package", "verify", "install", "site", "deploy"];

/** Every phase of the clean, default and site lifecycles (Execute Maven Goal completion). */
export const ALL_PHASES = [
  "pre-clean",
  "clean",
  "post-clean",
  "validate",
  "initialize",
  "generate-sources",
  "process-sources",
  "generate-resources",
  "process-resources",
  "compile",
  "process-classes",
  "generate-test-sources",
  "process-test-sources",
  "generate-test-resources",
  "process-test-resources",
  "test-compile",
  "process-test-classes",
  "test",
  "prepare-package",
  "package",
  "pre-integration-test",
  "integration-test",
  "post-integration-test",
  "verify",
  "install",
  "deploy",
  "pre-site",
  "site",
  "post-site",
  "site-deploy",
];

export type BuildNode =
  | { kind: "profiles"; key: string }
  | { kind: "profile"; key: string; profile: MavenProfile }
  | { kind: "mavenProject"; key: string; project: MavenProject }
  | { kind: "lifecycle"; key: string; project: MavenProject }
  | { kind: "phase"; key: string; project: MavenProject; phase: string }
  | { kind: "plugins"; key: string; project: MavenProject }
  | { kind: "plugin"; key: string; project: MavenProject; plugin: MavenPlugin }
  | { kind: "goal"; key: string; project: MavenProject; plugin: MavenPlugin; goal: string }
  | { kind: "dependencies"; key: string; project: MavenProject; dependencies: MavenDependency[] }
  | { kind: "dependency"; key: string; dependency: MavenDependency }
  | { kind: "runConfigs"; key: string; configs: RunConfig[] }
  | { kind: "runConfig"; key: string; config: RunConfig }
  | { kind: "gradleProject"; key: string; project: GradleProject }
  | { kind: "tasks"; key: string; project: GradleProject }
  | { kind: "taskGroup"; key: string; project: GradleProject; group: string; tasks: GradleTask[] }
  | { kind: "task"; key: string; project: GradleProject; task: GradleTask };

/** Options applied to every Maven run (toolbar toggles, Profiles checkboxes). */
export interface MavenRunOptions {
  offline: boolean;
  skipTests: boolean;
  /** Explicit profile choices: id → checked. Unlisted profiles keep their default. */
  profiles: Record<string, boolean>;
}

export interface GradleRunOptions {
  offline: boolean;
}

// ---------------------------------------------------------------------------
// Maven tree

const projectKey = (p: MavenProject) => `mvn:${p.pom}`;

export function dependencyLabel(d: MavenDependency): string {
  const parts = [d.groupId, d.artifactId];
  if (d.classifier) parts.push(d.classifier);
  if (d.version) parts.push(d.version);
  return parts.join(":");
}

export function pluginLabel(p: MavenPlugin): string {
  return `${p.prefix} (${p.groupId}:${p.artifactId}${p.version ? `:${p.version}` : ""})`;
}

/** Whether a profile is active for runs: the explicit choice, else `activeByDefault`. */
export function profileChecked(profile: MavenProfile, choices: Record<string, boolean>): boolean {
  return choices[profile.id] ?? profile.activeByDefault;
}

/** `-P` value for the choices that differ from the defaults (`a,!b`), or null. */
export function profilesArg(profiles: readonly MavenProfile[], choices: Record<string, boolean>): string | null {
  const ids: string[] = [];
  for (const p of profiles) {
    const checked = profileChecked(p, choices);
    if (checked && !p.activeByDefault) ids.push(p.id);
    else if (!checked && p.activeByDefault) ids.push(`!${p.id}`);
  }
  return ids.length ? ids.join(",") : null;
}

/** Profile list for a sync (`-P` entries). */
export function profilesList(profiles: readonly MavenProfile[], choices: Record<string, boolean>): string[] {
  return profilesArg(profiles, choices)?.split(",") ?? [];
}

export function mavenRoots(model: MavenModel): BuildNode[] {
  const out: BuildNode[] = [];
  if (model.profiles.length) out.push({ kind: "profiles", key: "mvn:profiles" });
  for (const p of model.projects) if (!p.aggregated) out.push({ kind: "mavenProject", key: projectKey(p), project: p });
  return out;
}

/** Run configurations of a Maven project: `maven` configs whose directory is the project's. */
export function mavenRunConfigs(project: MavenProject, configs: readonly RunConfig[]): RunConfig[] {
  return configs.filter((c) => c.kind === "maven" && normalizeDir(c.cwd) === project.dir);
}

/** Run configurations of a Gradle build: every `gradle` config. */
export function gradleRunConfigs(configs: readonly RunConfig[]): RunConfig[] {
  return configs.filter((c) => c.kind === "gradle");
}

function normalizeDir(cwd: string | null | undefined): string {
  return (cwd ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
}

export function mavenChildren(node: BuildNode, model: MavenModel): BuildNode[] | undefined {
  switch (node.kind) {
    case "profiles":
      return model.profiles.map((profile) => ({ kind: "profile", key: `mvn:profile:${profile.id}`, profile }));
    case "mavenProject": {
      const p = node.project;
      const k = projectKey(p);
      const out: BuildNode[] = [
        { kind: "lifecycle", key: `${k}:lifecycle`, project: p },
        { kind: "plugins", key: `${k}:plugins`, project: p },
      ];
      if (p.dependencies.length)
        out.push({ kind: "dependencies", key: `${k}:deps`, project: p, dependencies: p.dependencies });
      for (const pom of p.modules) {
        const m = model.projects.find((x) => x.pom === pom);
        if (m) out.push({ kind: "mavenProject", key: projectKey(m), project: m });
      }
      return out;
    }
    case "lifecycle":
      return LIFECYCLE.map((phase) => ({ kind: "phase", key: `${node.key}:${phase}`, project: node.project, phase }));
    case "plugins":
      return node.project.plugins.map((plugin) => ({
        kind: "plugin",
        key: `${node.key}:${plugin.groupId}:${plugin.artifactId}`,
        project: node.project,
        plugin,
      }));
    case "plugin":
      return node.plugin.goals.map((goal) => ({
        kind: "goal",
        key: `${node.key}:${goal}`,
        project: node.project,
        plugin: node.plugin,
        goal,
      }));
    case "dependencies":
      return dependencyNodes(node.key, node.dependencies);
    case "dependency": {
      const kids = dependencyNodes(node.key, node.dependency.children);
      return kids.length ? kids : undefined;
    }
    case "runConfigs":
      return node.configs.map((config) => ({ kind: "runConfig", key: `${node.key}:${config.id}`, config }));
    default:
      return undefined;
  }
}

/** The resolved dependencies; occurrences Maven omitted are shown by the Dependency Analyzer only. */
function dependencyNodes(parent: string, deps: readonly MavenDependency[]): BuildNode[] {
  return deps.flatMap((dependency, i) =>
    dependency.omitted == null
      ? [
          {
            kind: "dependency" as const,
            key: `${parent}/${dependency.groupId}:${dependency.artifactId}:${i}`,
            dependency,
          },
        ]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Gradle tree

export function gradleTaskGroups(project: GradleProject): Array<{ group: string; tasks: GradleTask[] }> {
  const groups = new Map<string, GradleTask[]>();
  for (const t of project.tasks) {
    const g = t.group || "other";
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  // IDEA: alphabetical groups, "other" last; tasks alphabetical.
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)))
    .map(([group, tasks]) => ({ group, tasks: [...tasks].sort((a, b) => a.name.localeCompare(b.name)) }));
}

export function gradleRoots(model: GradleModel): BuildNode[] {
  const root = model.projects.find((p) => p.path === ":") ?? model.projects[0];
  return root ? [{ kind: "gradleProject", key: `gradle:${root.path}`, project: root }] : [];
}

/** Direct subprojects of `path` (`:a` and `:b` under `:`, `:a:x` under `:a`). */
export function gradleSubprojects(model: GradleModel, path: string): GradleProject[] {
  return model.projects.filter((p) => {
    if (p.path === path || p.path === ":") return false;
    const parent = p.path.slice(0, p.path.lastIndexOf(":")) || ":";
    if (parent === path) return true;
    // `include(":a:b")` without `:a`: shown under the root.
    return path === ":" && !model.projects.some((q) => q.path === parent);
  });
}

export function gradleChildren(node: BuildNode, model: GradleModel): BuildNode[] | undefined {
  switch (node.kind) {
    case "gradleProject": {
      const p = node.project;
      const out: BuildNode[] = [{ kind: "tasks", key: `${node.key}:tasks`, project: p }];
      for (const sub of gradleSubprojects(model, p.path))
        out.push({ kind: "gradleProject", key: `gradle:${sub.path}`, project: sub });
      return out;
    }
    case "tasks":
      return gradleTaskGroups(node.project).map(({ group, tasks }) => ({
        kind: "taskGroup",
        key: `${node.key}:${group}`,
        project: node.project,
        group,
        tasks,
      }));
    case "taskGroup":
      return node.tasks.map((task) => ({ kind: "task", key: `${node.key}:${task.name}`, project: node.project, task }));
    case "runConfigs":
      return node.configs.map((config) => ({ kind: "runConfig", key: `${node.key}:${config.id}`, config }));
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Labels, icons

export function nodeLabel(node: BuildNode): string {
  switch (node.kind) {
    case "profiles":
      return "Profiles";
    case "profile":
      return node.profile.id;
    case "mavenProject":
      return node.project.displayName;
    case "lifecycle":
      return "Lifecycle";
    case "phase":
      return node.phase;
    case "plugins":
      return "Plugins";
    case "plugin":
      return pluginLabel(node.plugin);
    case "goal":
      return `${node.plugin.prefix}:${node.goal}`;
    case "dependencies":
      return "Dependencies";
    case "dependency":
      return dependencyLabel(node.dependency);
    case "runConfigs":
      return "Run Configurations";
    case "runConfig":
      return node.config.name;
    case "gradleProject":
      return node.project.name;
    case "tasks":
      return "Tasks";
    case "taskGroup":
      return node.group;
    case "task":
      return node.task.name;
  }
}

export function nodeIcon(node: BuildNode): string {
  switch (node.kind) {
    case "profiles":
      return "maven-profiles";
    case "profile":
      return "maven-profiles";
    case "mavenProject":
      return node.project.aggregated ? "maven-module" : "maven-project";
    case "lifecycle":
    case "plugins":
    case "runConfigs":
    case "tasks":
      return "folder";
    case "phase":
      return "maven-goal";
    case "plugin":
      return "maven-plugin";
    case "goal":
      return "maven-plugin-goal";
    case "dependencies":
      return "folder-library";
    case "dependency":
      return "library";
    case "runConfig":
      return node.config.kind === "gradle" ? "build-task" : "maven-goal";
    case "gradleProject":
      return "file-gradle";
    case "taskGroup":
      return "build-task-group";
    case "task":
      return "build-task";
  }
}

/** Nodes that run something on double-click / Enter. */
export function isRunnable(node: BuildNode): boolean {
  return node.kind === "phase" || node.kind === "goal" || node.kind === "task" || node.kind === "runConfig";
}

// ---------------------------------------------------------------------------
// Run configurations

const MAVEN_TEST_GOALS = /^(test|verify|integration-test|install|deploy|surefire:test|failsafe:integration-test)$/;

/** Splits a command line into arguments (double / single quotes group). */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Goals typed in "Execute Maven Goal" (a leading `mvn` / `mvnw` is ignored). */
export function parseGoalLine(line: string): string[] {
  const args = splitArgs(line.trim());
  if (args[0] && /^(\.\/)?mvnw?(\.cmd)?$/.test(args[0])) args.shift();
  return args;
}

/** Tasks typed in "Execute Gradle Task" (a leading `gradle` / `gradlew` is ignored). */
export function parseTaskLine(line: string): string[] {
  const args = splitArgs(line.trim());
  if (args[0] && /^(\.\/)?gradlew?(\.bat)?$/.test(args[0])) args.shift();
  return args;
}

export function mavenArgs(
  goals: readonly string[],
  model: Pick<MavenModel, "profiles">,
  options: MavenRunOptions,
): string[] {
  const args = [...goals];
  const has = (flag: string) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  if (options.offline && !has("-o") && !has("--offline")) args.push("-o");
  if (options.skipTests && !has("-DskipTests")) args.push("-DskipTests");
  const profiles = profilesArg(model.profiles, options.profiles);
  if (profiles && !args.some((a) => a.startsWith("-P"))) args.push(`-P${profiles}`);
  return args;
}

/** Skip Tests mode: running the bare `test` phase alone is refused, as in IntelliJ —
 * `-DskipTests` would skip it, so the run could only ever do nothing. Mixed selections
 * (e.g. `clean` + `test`) and plugin goals like `surefire:test` stay runnable. */
export function skippedTestRun(nodes: readonly BuildNode[], skipTests: boolean): boolean {
  return skipTests && nodes.length > 0 && nodes.every((n) => n.kind === "phase" && n.phase === "test");
}

/** IDEA names Maven configurations `<project> [goal1,goal2]`. */
export function mavenConfigName(project: MavenProject, goals: readonly string[]): string {
  return `${project.displayName} [${goals.filter((g) => !g.startsWith("-")).join(",")}]`;
}

export function mavenGoalConfig(
  project: MavenProject,
  goals: readonly string[],
  model: Pick<MavenModel, "profiles">,
  options: MavenRunOptions,
): RunConfig {
  const args = [...project.options, ...mavenArgs(goals, model, options)];
  return {
    id: `maven:goal:${project.pom}:${goals.join(" ")}`,
    name: mavenConfigName(project, goals),
    kind: "maven",
    command: project.command,
    args,
    cwd: project.dir || null,
    env: { ...project.env },
    detected: false,
    isTest: !options.skipTests && !args.includes("-DskipTests") && goals.some((g) => MAVEN_TEST_GOALS.test(g)),
    debugAdapter: null,
  };
}

/** `:app:test` for task `test` of `:app`, plain `test` in the root project. */
export function gradleTaskPath(project: GradleProject, task: string): string {
  return project.path === ":" ? task : `${project.path}:${task}`;
}

export function gradleTaskConfig(
  model: GradleModel,
  project: GradleProject,
  tasks: readonly string[],
  options: GradleRunOptions,
): RunConfig {
  const args = tasks.map((t) => (t.startsWith("-") || t.startsWith(":") ? t : gradleTaskPath(project, t)));
  if (options.offline && !args.includes("--offline")) args.push("--offline");
  const names = tasks.filter((t) => !t.startsWith("-"));
  return {
    id: `gradle:task:${project.path}:${tasks.join(" ")}`,
    name: `${project.name} [${names.join(",")}]`,
    kind: "gradle",
    command: model.command,
    args,
    cwd: model.dir || null,
    env: { ...model.env },
    detected: false,
    isTest: names.some((t) => /(^|:)(test|check|build|integrationTest)$/.test(t)),
    debugAdapter: null,
  };
}

/** Applies the current toggles to a saved configuration started from the tree. */
export function withGradleOptions(config: RunConfig, options: GradleRunOptions): RunConfig {
  if (!options.offline || config.args.includes("--offline")) return config;
  return { ...config, args: [...config.args, "--offline"] };
}

// ---------------------------------------------------------------------------
// Execute Goal completion

export interface Completion {
  /** The whole line after accepting. */
  line: string;
  /** The completed word. */
  label: string;
  detail?: string;
}

/** Completes the last word of `line` with phases and `prefix:goal`s of `plugins`. */
export function goalCompletions(
  line: string,
  plugins: readonly MavenPlugin[],
  history: readonly string[] = [],
): Completion[] {
  const at = /\S*$/.exec(line)!.index;
  const head = line.slice(0, at);
  const word = line.slice(at).toLowerCase();
  const out: Completion[] = [];
  const seen = new Set<string>();
  const push = (label: string, detail?: string) => {
    if (seen.has(label) || !label.toLowerCase().startsWith(word)) return;
    seen.add(label);
    out.push({ line: head + label, label, detail });
  };
  if (!head.trim())
    for (const h of history)
      if (h.toLowerCase().startsWith(line.toLowerCase()) && h !== line)
        out.push({ line: h, label: h, detail: "recent" });
  if (word.startsWith("-")) return out;
  for (const phase of [...LIFECYCLE, ...ALL_PHASES]) push(phase, "phase");
  const goals = plugins.flatMap((p) => p.goals.map((g) => ({ label: `${p.prefix}:${g}`, detail: p.artifactId })));
  goals.sort((a, b) => a.label.localeCompare(b.label));
  for (const g of goals) push(g.label, g.detail);
  return out;
}

/** Completes the last word of `line` with `tasks` (names and `:project:task` paths). */
export function taskCompletions(line: string, model: GradleModel, history: readonly string[] = []): Completion[] {
  const at = /\S*$/.exec(line)!.index;
  const head = line.slice(0, at);
  const word = line.slice(at).toLowerCase();
  const out: Completion[] = [];
  const seen = new Set<string>();
  if (!head.trim())
    for (const h of history)
      if (h.toLowerCase().startsWith(line.toLowerCase()) && h !== line)
        out.push({ line: h, label: h, detail: "recent" });
  for (const p of model.projects) {
    for (const t of p.tasks) {
      const label = p.path === ":" ? t.name : `${p.path}:${t.name}`;
      if (seen.has(label) || !(label.toLowerCase().startsWith(word) || t.name.toLowerCase().startsWith(word))) continue;
      seen.add(label);
      out.push({ line: head + label, label, detail: t.group });
    }
  }
  return out.sort((a, b) =>
    a.detail === "recent"
      ? -1
      : b.detail === "recent"
        ? 1
        : a.label.length - b.label.length || a.label.localeCompare(b.label),
  );
}

/**
 * Keys of every expandable node below `roots` (Expand All). Dependency nodes are
 * not opened (transitive trees can be huge); their "Dependencies" folder is.
 */
export function expandableKeys(
  roots: readonly BuildNode[],
  children: (n: BuildNode) => BuildNode[] | undefined,
): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly BuildNode[]) => {
    for (const n of nodes) {
      if (n.kind === "dependency") continue;
      const kids = children(n);
      if (!kids?.length) continue;
      out.add(n.key);
      walk(kids);
    }
  };
  walk(roots);
  return out;
}
