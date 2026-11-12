/**
 * File › Project Structure… (⌘; / Ctrl+Alt+Shift+S):
 * IntelliJ IDEA-style Project Structure configuration across Project, Modules
 * (Sources, Paths, Dependencies), Libraries, Facets, Artifacts, and SDKs.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import clsx from "clsx";
import { Channel } from "@tauri-apps/api/core";
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  Select,
  Tree,
  folderIconName,
  type DialogButton,
  type FolderKind,
  type IconName,
  type SelectOption,
  T,
} from "@/ui";
import { SettingsFormContext } from "@/workbench/contributions";
import { call, commands, isTauri, nextRequestId, type FileEntry } from "@/platform/ipc";
import { mergeLibraryGroups } from "@/platform/libraries";
import type { BuildModel, LibraryGroup, WebArtifact } from "@/bindings";
import { relativePath, useProject } from "@/platform/project";
import { PageContext, useSettingsFormFor } from "../components/context";
import {
  applySettings,
  closeProjectStructure,
  pendingChanges,
  resetPage,
  selectProjectStructureSection,
  useSettingsDialog,
} from "../model/staging";
import {
  ARTIFACT_KINDS,
  DEPENDENCY_SCOPES,
  JAVA_LANGUAGE_LEVELS,
  PROJECT_STRUCTURE_KEYS,
  effectiveRoots,
  markFolder,
  normalizeFolder,
  restoreDetected,
  rootRole,
  unmarkedRoots,
  validateProjectStructure,
  type ArtifactConfigValid,
  type ArtifactKindValid,
  type DependencyScopeValid,
  type FacetConfigValid,
  type FolderListKey,
  type FolderRole,
  type ModuleStructureValid,
  type ProjectLibraryValid,
  type ProjectStructureValid,
} from "@/platform/languageSettings";
import { initProjectRoots, useDetectedRoots } from "@/platform/projectRoots";
import { Row, Section } from "../components/Form";
import { choosePath, detectSdks, useSdks, type SdkKind } from "./api";
import { DownloadJdkDialog } from "./DownloadJdkDialog";
import { SdkField, tildify, useDetected, useProjectSetting } from "./components";
import styles from "./Sdk.module.css";
import { tx } from "@/platform/i18n";

export type ProjectStructureSectionId =
  | "project"
  | "modules"
  | "dependencies"
  | "libraries"
  | "facets"
  | "artifacts"
  | "sdks";

interface DirNode {
  path: string;
  name: string;
  /** Project-relative; null outside the project (another content root). */
  rel: string | null;
  /** A content root besides the project folder. */
  contentRoot?: boolean;
}

const inside = (root: string, path: string) => path === root || path.startsWith(root + "/");

const ROLES: Array<{ role: FolderRole; label: string; title: string; kind: FolderKind; cls: string }> = [
  { role: "source", label: "Sources", title: "Source Folders", kind: "source", cls: styles.sourceTitle! },
  { role: "test", label: "Tests", title: "Test Source Folders", kind: "test", cls: styles.testTitle! },
  { role: "resources", label: "Resources", title: "Resource Folders", kind: "resources", cls: styles.resourcesTitle! },
  {
    role: "testResources",
    label: "Test Resources",
    title: "Test Resource Folders",
    kind: "testResources",
    cls: styles.testResourcesTitle!,
  },
  { role: "excluded", label: "Excluded", title: "Excluded Folders", kind: "excluded", cls: styles.excludedTitle! },
];

const PROJECT_JAVA_LEVEL_OPTIONS: SelectOption[] = JAVA_LANGUAGE_LEVELS.map((level) =>
  level ? { value: level, label: level } : { value: "", label: "SDK default", detail: "from build / JDK" },
);

const MODULE_JAVA_LEVEL_OPTIONS: SelectOption[] = JAVA_LANGUAGE_LEVELS.map((level) =>
  level ? { value: level, label: level } : { value: "", label: "Project default", detail: "inherit project" },
);

const SCOPE_OPTIONS: SelectOption[] = DEPENDENCY_SCOPES.map((s) => ({
  value: s,
  label: s === "compile" ? "Compile" : s === "test" ? "Test" : s === "runtime" ? "Runtime" : "Provided",
}));

const ARTIFACT_KIND_OPTIONS: SelectOption[] = ARTIFACT_KINDS.map((k) => ({
  value: k,
  label: k === "jar" ? "JAR" : k === "war" ? "WAR Archive" : "WAR (exploded)",
}));

const FACET_KIND_OPTIONS: SelectOption[] = [
  { value: "web", label: "Web" },
  { value: "spring", label: "Spring" },
  { value: "jpa", label: "JPA" },
];

const SDK_KINDS: Array<{ kind: SdkKind; label: string }> = [
  { kind: "jdk", label: "JDK" },
  { kind: "python", label: "Python" },
  { kind: "node", label: "Node.js" },
  { kind: "go", label: "Go" },
  { kind: "rust", label: "Rust" },
  { kind: "php", label: "PHP" },
  { kind: "ruby", label: "Ruby" },
  { kind: "maven", label: "Maven" },
];

async function readDirs(root: string, path: string): Promise<DirNode[]> {
  if (!isTauri()) return [];
  const entries: FileEntry[] = await call(commands.fsReadDir(path));
  return entries
    .filter((e) => e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir"))
    .filter((e) => e.name !== ".git")
    .map((e) => ({ path: e.path, name: e.name, rel: inside(root, e.path) ? relativePath(root, e.path) : null }));
}

function useStructure(): [ProjectStructureValid, (next: ProjectStructureValid) => void] {
  const [sourceRoots, setSource] = useProjectSetting<string[] | undefined>("projectStructure.sourceRoots");
  const [testRoots, setTest] = useProjectSetting<string[] | undefined>("projectStructure.testRoots");
  const [resourceRoots, setResources] = useProjectSetting<string[] | undefined>("projectStructure.resourceRoots");
  const [testResourceRoots, setTestResources] = useProjectSetting<string[] | undefined>(
    "projectStructure.testResourceRoots",
  );
  const [excluded, setExcluded] = useProjectSetting<string[] | undefined>("projectStructure.excluded");
  const [unmarked, setUnmarked] = useProjectSetting<string[] | undefined>("projectStructure.unmarked");
  const [contentRoots] = useProjectSetting<string[] | undefined>("projectStructure.contentRoots");
  const [dependencies] = useProjectSetting<string[] | undefined>("projectStructure.dependencies");
  const [memberDependencies] = useProjectSetting<Record<string, string[]> | undefined>(
    "projectStructure.memberDependencies",
  );
  const [excludeFiles] = useProjectSetting<string | undefined>("projectStructure.excludeFiles");
  const [compilerOutput] = useProjectSetting<string | undefined>("projectStructure.compilerOutput");
  const [modules] = useProjectSetting<Record<string, ModuleStructureValid> | undefined>("projectStructure.modules");
  const [libraries] = useProjectSetting<ProjectLibraryValid[] | undefined>("projectStructure.libraries");
  const [facets] = useProjectSetting<FacetConfigValid[] | undefined>("projectStructure.facets");
  const [artifacts] = useProjectSetting<ArtifactConfigValid[] | undefined>("projectStructure.artifacts");

  const ps = useMemo<ProjectStructureValid>(
    () =>
      validateProjectStructure({
        sourceRoots: sourceRoots ?? [],
        testRoots: testRoots ?? [],
        resourceRoots: resourceRoots ?? [],
        testResourceRoots: testResourceRoots ?? [],
        excluded: excluded ?? [],
        unmarked: unmarked ?? [],
        contentRoots: contentRoots ?? [],
        dependencies: dependencies ?? [],
        memberDependencies: memberDependencies ?? {},
        excludeFiles: excludeFiles ?? "",
        compilerOutput: compilerOutput ?? "",
        modules: modules ?? {},
        libraries: libraries ?? [],
        facets: facets ?? [],
        artifacts: artifacts ?? [],
      }),
    [
      sourceRoots,
      testRoots,
      resourceRoots,
      testResourceRoots,
      excluded,
      unmarked,
      contentRoots,
      dependencies,
      memberDependencies,
      excludeFiles,
      compilerOutput,
      modules,
      libraries,
      facets,
      artifacts,
    ],
  );
  const set = useCallback(
    (next: ProjectStructureValid) => {
      const setters: Record<FolderListKey, (v: string[]) => void> = {
        sourceRoots: setSource,
        testRoots: setTest,
        resourceRoots: setResources,
        testResourceRoots: setTestResources,
        excluded: setExcluded,
        unmarked: setUnmarked,
      };
      for (const k of PROJECT_STRUCTURE_KEYS)
        if (JSON.stringify(next[k]) !== JSON.stringify(ps[k])) setters[k](next[k]);
    },
    [ps, setSource, setTest, setResources, setTestResources, setExcluded, setUnmarked],
  );
  return [ps, set];
}

function useBuildModelData(root: string | null): BuildModel | null {
  const [model, setModel] = useState<BuildModel | null>(null);
  useEffect(() => {
    if (!root || !isTauri()) return;
    let live = true;
    call(commands.buildModel())
      .then((m) => live && setModel(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [root]);
  return root && isTauri() ? model : null;
}

/** "+ Add Content Root" and the content roots, the project folder first (IDEA's module Sources tab). */
function ContentRoots({ root }: { root: string }) {
  const [roots, setRoots] = useProjectSetting<string[] | undefined>("projectStructure.contentRoots");
  const list = roots ?? [];
  const add = async () => {
    const picked = await choosePath({ directory: true, title: "Add Content Root", defaultPath: root });
    if (!picked || inside(root, picked) || list.includes(picked)) return;
    setRoots([...list, picked]);
  };
  return (
    <div className={styles.rootGroup}>
      <Button size="small" variant="ghost" icon="plus" onClick={() => void add()}>
        <T>Add Content Root</T>
      </Button>
      <div className={clsx(styles.rootItem, styles.contentRoot)}>
        <span className={styles.rootPath} title={root}>
          {root}
        </span>
      </div>
      {list.map((r) => (
        <div key={r} className={clsx(styles.rootItem, styles.contentRoot)}>
          <span className={styles.rootPath} title={r}>
            {r}
          </span>
          <IconButton
            icon="close"
            size="small"
            iconSize={12}
            title={tx`Remove content root ${r}`}
            onClick={() => setRoots(list.filter((x) => x !== r))}
          />
        </div>
      ))}
    </div>
  );
}

function ExcludeFiles() {
  const [value, setValue] = useProjectSetting<string | undefined>("projectStructure.excludeFiles");
  const id = useId();
  return (
    <div className={styles.excludeFiles}>
      <label htmlFor={id}>
        <T>Exclude files:</T>
      </label>
      <Input
        id={id}
        className={styles.excludeInput}
        value={value ?? ""}
        placeholder="*.log;tmp*"
        onChange={(e) => setValue(e.target.value)}
      />
      <div className={styles.excludeHint}>
        <T>Use ; to separate name patterns, * for any number of symbols, ? for one.</T>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Project Section

function ProjectSection() {
  const root = useProject((s) => s.project?.root ?? null);
  const name = useProject((s) => s.project?.name ?? "");
  const [jdk, setJdk] = useProjectSetting<string>("languages.java.jdk");
  const [languageLevel, setLanguageLevel] = useProjectSetting<string>("languages.java.languageLevel");
  const [compilerOutput, setCompilerOutput] = useProjectSetting<string>("projectStructure.compilerOutput");
  const [jdtlsJdk, setJdtlsJdk] = useProjectSetting<string>("languages.java.jdtlsJdk");
  const outId = useId();

  return (
    <div className={styles.page}>
      <Section title="Project">
        <Row label="Project name" hint={root ?? "No project is currently open."}>
          <span className={styles.path}>{name || "Default Project"}</span>
        </Row>
        <Row
          label="SDK"
          hint="Default SDK used by modules, builds, and run configurations unless overridden at the module level."
        >
          <SdkField
            kind="jdk"
            value={jdk ?? ""}
            onChange={setJdk}
            emptyLabel="Auto"
            emptyDetail="per module, the JDK of its Java version"
            directory
            browseTitle="Select JDK Home Directory"
            aria-label="Project SDK"
          />
        </Row>
        <Row
          label="Language level"
          hint="Default Java language level for source code assistance and compilation across project modules."
        >
          <Select
            value={languageLevel ?? ""}
            options={PROJECT_JAVA_LEVEL_OPTIONS}
            onChange={setLanguageLevel}
            aria-label="Project language level"
          />
        </Row>
        <Row
          label="Compiler output"
          htmlFor={outId}
          hint="Default directory where compiled classes are placed when not managed by Maven or Gradle."
        >
          <span className={styles.pathRow}>
            <Input
              id={outId}
              mono
              className={styles.pathInput}
              value={compilerOutput ?? ""}
              placeholder="out"
              onChange={(e) => setCompilerOutput(e.target.value)}
            />
            <IconButton
              icon="folder-open"
              size="small"
              title="Browse…"
              onClick={async () => {
                const picked = await choosePath({
                  directory: true,
                  title: "Select Compiler Output Directory",
                  defaultPath: compilerOutput || root || undefined,
                });
                if (picked) setCompilerOutput(root && inside(root, picked) ? relativePath(root, picked) : picked);
              }}
            />
          </span>
        </Row>
      </Section>
      <Section title="Language Server">
        <Row
          label="JDK"
          hint="JDK used to run the Eclipse JDT Language Server (jdtls 21+), independent of the target Project SDK."
        >
          <SdkField
            kind="jdk"
            value={jdtlsJdk ?? ""}
            onChange={setJdtlsJdk}
            emptyLabel="Auto"
            emptyDetail="auto-managed; uses an installed JDK or downloads a runtime when needed"
            directory
            browseTitle="Select JDK Home Directory"
            aria-label="Language server JDK"
          />
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Modules Section (Sources, Paths, Dependencies)

function ModuleSourcesTab({ moduleKey }: { moduleKey: string }) {
  const root = useProject((s) => s.project?.root ?? null);
  const name = useProject((s) => s.project?.name ?? "");
  const [ps, setPs] = useStructure();
  const detected = useDetectedRoots();
  const roots = useMemo(() => effectiveRoots(detected, ps), [detected, ps]);
  useEffect(() => initProjectRoots(), []);
  const [children, setChildren] = useState<Map<string, DirNode[]>>(new Map());
  const moduleRoot = root ? (moduleKey === "." ? root : `${root}/${moduleKey}`) : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(moduleRoot ? [moduleRoot] : []));
  const [selected, setSelected] = useState<DirNode | null>(null);

  const load = useCallback(
    async (node: DirNode) => {
      if (!root) return;
      const dirs = await readDirs(root, node.path);
      setChildren((m) => new Map(m).set(node.path, dirs));
    },
    [root],
  );

  const rootNode = useMemo<DirNode | null>(
    () =>
      moduleRoot
        ? {
            path: moduleRoot,
            name: moduleKey === "." ? name : moduleKey.split("/").pop()!,
            rel: moduleKey === "." ? "" : moduleKey,
          }
        : null,
    [moduleRoot, moduleKey, name],
  );
  const treeRoots = useMemo<DirNode[]>(
    () =>
      rootNode
        ? [
            rootNode,
            ...(moduleKey === "." ? ps.contentRoots : []).map((p) => ({
              path: p,
              name: p.slice(p.lastIndexOf("/") + 1) || p,
              rel: null,
              contentRoot: true,
            })),
          ]
        : [],
    [rootNode, ps.contentRoots, moduleKey],
  );
  useEffect(() => {
    if (!root) return;
    let live = true;
    for (const dir of [moduleRoot!, ...(moduleKey === "." ? ps.contentRoots : [])])
      void readDirs(root, dir)
        .then((dirs) => live && setChildren((m) => new Map(m).set(dir, dirs)))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [root, ps.contentRoots, moduleRoot, moduleKey]);

  if (!rootNode)
    return (
      <div className={styles.note}>
        <T>Open a project to configure its folders.</T>
      </div>
    );

  const markable = selected?.rel ?? null;
  const role = markable !== null ? rootRole(roots, markable) : null;
  const mark = (r: FolderRole) => {
    if (markable === null) return;
    setPs(markFolder(ps, markable, role === r ? null : r, detected));
  };
  const moduleDetected =
    moduleKey === "."
      ? detected
      : detected.filter((folder) => folder.path === moduleKey || folder.path.startsWith(moduleKey + "/"));
  const unmarkedDetected = unmarkedRoots(moduleDetected, ps);
  const restore = () => setPs(restoreDetected(ps, moduleDetected));

  return (
    <div className={styles.structure}>
      <div className={styles.structureTree}>
        <div className={styles.markBar} role="toolbar" aria-label={tx("Mark as")}>
          <span>
            <T>Mark as:</T>
          </span>
          {ROLES.map((r) => (
            <button
              key={r.role}
              type="button"
              className={styles.markButton}
              aria-pressed={role === r.role}
              disabled={markable === null || (!markable && r.role === "excluded")}
              onClick={() => mark(r.role)}
            >
              <Icon name={folderIconName(r.kind)} size={14} />
              {r.label}
            </button>
          ))}
        </div>
        <div className={styles.treeScroll}>
          <Tree<DirNode>
            aria-label="Content root"
            roots={treeRoots}
            getKey={(n) => n.path}
            getLabel={(n) => n.name}
            getChildren={(n) => children.get(n.path)}
            isExpandable={() => true}
            loadChildren={load}
            expanded={expanded}
            onExpandedChange={(set) => setExpanded(set)}
            multiSelect={false}
            selected={selected ? new Set([selected.path]) : new Set()}
            onSelectionChange={(_s, lead) => setSelected(lead)}
            getIcon={(n) => {
              if (n.rel === null) return n.contentRoot ? "module" : folderIconName("plain");
              const r = rootRole(roots, n.rel);
              if (!n.rel && !r) return "module";
              return folderIconName(r ? ROLES.find((x) => x.role === r)!.kind : "plain");
            }}
            getDetail={(n) => (n.rel === "" ? (root ?? undefined) : n.contentRoot ? n.path : undefined)}
          />
        </div>
        {moduleKey === "." && <ExcludeFiles />}
      </div>
      <div className={styles.roots} aria-label={tx("Marked folders")}>
        {moduleKey === "." && <ContentRoots root={rootNode.path} />}
        {ROLES.map((r) => {
          const list = roots.filter(
            (x) =>
              x.kind === r.role && (moduleKey === "." || x.path === moduleKey || x.path.startsWith(moduleKey + "/")),
          );
          return (
            <div key={r.role} className={styles.rootGroup}>
              <div className={clsx(styles.rootTitle, r.cls)}>
                <Icon name={folderIconName(r.kind)} size={14} />
                {r.title}
              </div>
              {list.length === 0 && (
                <div className={clsx(styles.rootItem, styles.note)}>
                  <T>None</T>
                </div>
              )}
              {list.map((x) => {
                const shown = x.path || name || ".";
                return (
                  <div key={x.path} className={styles.rootItem}>
                    <span className={styles.rootPath} title={x.path || root || undefined}>
                      {shown}
                      {x.detectedFrom && (
                        <span className={styles.rootHint}> {tx`detected from ${x.detectedFrom}`}</span>
                      )}
                    </span>
                    <IconButton
                      icon="close"
                      size="small"
                      iconSize={12}
                      title={tx`Unmark ${shown}`}
                      onClick={() => setPs(markFolder(ps, x.path, null, detected))}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
        {unmarkedDetected.length > 0 && (
          <div className={styles.note}>
            {unmarkedDetected.length === 1
              ? tx("1 detected folder is unmarked.")
              : tx`${unmarkedDetected.length} detected folders are unmarked.`}{" "}
            <button type="button" className={styles.linkButton} onClick={restore}>
              <T>Restore detected roots</T>
            </button>
          </div>
        )}
        <div className={styles.note}>
          <T>
            {
              "Folders are detected from build files (pom.xml, build.gradle, Cargo.toml, go.mod, pyproject.toml, package.json, composer.json); marking or unmarking a folder overrides detection. Excluded folders are skipped by the Project view, Find in Files and the index (reopen the project to re-index)."
            }
          </T>
        </div>
      </div>
    </div>
  );
}

interface DiscoveredModule {
  key: string;
  name: string;
  buildTool: "maven" | "gradle" | "custom";
}

/** One row of the Project Structure › Dependencies checklist. */
export interface DependencyCandidate {
  path: string;
  name: string;
  checked: boolean;
  disabled: boolean;
}

/**
 * Rows of the "project dependencies" checklist of a single root (the project folder, or a
 * workspace member): the configured dependencies. A workspace additionally lists the other
 * roots attached to the window, in MemberDependencies.
 */
export function dependencyCandidates(root: string | null, dependencies: readonly string[]): DependencyCandidate[] {
  const out: DependencyCandidate[] = [];
  const listed = new Set<string>();
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/[\\/]+$/, "") || p;
  const attachable = (p: string) => !!root && p !== root && !p.startsWith(`${root}/`);
  for (const p of dependencies) {
    if (listed.has(p) || !attachable(p)) continue;
    listed.add(p);
    out.push({ path: p, name: nameOf(p), checked: true, disabled: false });
  }
  return out;
}

/** Project Structure › Dependencies. */
function ModuleDependenciesTab() {
  const workspaceProjects = useProject((s) => s.project?.workspace?.projects ?? null);
  // A workspace: every member is an equal root that picks the roots it depends on.
  return workspaceProjects ? <MemberDependencies members={workspaceProjects} /> : <ProjectDependencies />;
}

/** The dependency checklist of a standalone project (no workspace). */
function ProjectDependencies() {
  const root = useProject((s) => s.project?.root ?? null);
  const [deps, setDeps] = useProjectSetting<string[] | undefined>("projectStructure.dependencies");
  const list = deps ?? [];
  // Only the configured projects: candidates come from Add Project…, not every recent project.
  const candidates = useMemo(() => dependencyCandidates(root, deps ?? []), [root, deps]);

  const toggle = (path: string, checked: boolean) =>
    setDeps(checked ? [...list, path] : list.filter((x) => x !== path));
  const add = async () => {
    const picked = await choosePath({
      directory: true,
      title: "Add Project Dependency",
      defaultPath: root ?? undefined,
    });
    if (!picked || !root || picked === root || inside(root, picked) || list.includes(picked)) return;
    setDeps([...list, picked]);
  };

  return (
    <Section title="Project Dependencies">
      <div className={styles.note}>
        <T>
          Dependency projects are indexed and navigable together with this project: Go to Declaration, Find Usages and
          the Project view include them.
        </T>
      </div>
      <div className={styles.entryList} role="group" aria-label={tx("The project depends on these projects")}>
        {candidates.length === 0 && (
          <div className={styles.note}>
            <T>No candidate projects yet. Use Add Project… to pick one.</T>
          </div>
        )}
        {candidates.map((c) => (
          <div key={c.path} className={styles.entryRow}>
            <Checkbox
              checked={c.checked}
              disabled={c.disabled}
              label={c.name}
              onChange={(checked) => toggle(c.path, checked)}
              aria-label={tx`The project depends on ${c.name}`}
            />
            <span className={styles.rootPath} title={c.path}>
              {tildify(c.path)}
            </span>
          </div>
        ))}
      </div>
      <div className={styles.entryActions}>
        <Button size="small" variant="ghost" icon="plus" onClick={() => void add()}>
          <T>Add Project…</T>
        </Button>
      </div>
    </Section>
  );
}

/** The per-root dependency checklist of a workspace: all members are equal roots. */
function MemberDependencies({ members }: { members: readonly string[] }) {
  const [memberDeps, setMemberDeps] = useProjectSetting<Record<string, string[]> | undefined>(
    "projectStructure.memberDependencies",
  );
  const [selected, setSelected] = useState(0);
  const active = members[Math.min(selected, members.length - 1)] ?? "";
  const activeName = active.slice(active.lastIndexOf("/") + 1);
  const deps = useMemo(() => memberDeps?.[active] ?? [], [memberDeps, active]);
  const others = useMemo(() => {
    const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    const extra = deps.filter((d) => !members.includes(d)).map((path) => ({ path, name: nameOf(path) }));
    return members
      .filter((m) => m !== active)
      .map((path) => ({ path, name: nameOf(path) }))
      .concat(extra);
  }, [members, active, deps]);
  const roots = useMemo(
    () => members.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) })),
    [members],
  );
  const setDeps = (next: string[]) => setMemberDeps({ ...(memberDeps ?? {}), [active]: next });
  const toggle = (path: string, checked: boolean) =>
    setDeps(checked ? [...deps, path] : deps.filter((x) => x !== path));
  const add = async () => {
    const picked = await choosePath({
      directory: true,
      title: "Add Project Dependency",
      defaultPath: active,
    });
    if (!picked || picked === active || inside(active, picked) || deps.includes(picked)) return;
    setDeps([...deps, picked]);
  };

  return (
    <div className={styles.page}>
      <div className={styles.note}>
        <T>
          Every root is equal: pick a root on the left, then check the roots it depends on. Go to Declaration in it
          resolves only into its own code and its dependencies.
        </T>
      </div>
      <div className={styles.splitLayout}>
        <div className={styles.sideList}>
          <div className={styles.sideItems} role="listbox" aria-label={tx("Roots")}>
            {roots.map((m, i) => (
              <button
                key={m.path}
                type="button"
                role="option"
                aria-selected={m.path === active}
                className={clsx(styles.sideItem, m.path === active && styles.sideItemActive)}
                onClick={() => setSelected(i)}
                title={m.path}
              >
                <Icon name="module" size={14} />
                <span className={styles.sideItemLabel}>{m.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.detailPane}>
          <Section title={tx`Dependencies of ${activeName}`}>
            <div className={styles.entryList} role="group" aria-label={tx("The root depends on these projects")}>
              {others.length === 0 && (
                <div className={styles.note}>
                  <T>No other roots.</T>
                </div>
              )}
              {others.map((c) => (
                <div key={c.path} className={styles.entryRow}>
                  <Checkbox
                    checked={deps.includes(c.path)}
                    label={c.name}
                    onChange={(checked) => toggle(c.path, checked)}
                    aria-label={tx`The root depends on ${c.name}`}
                  />
                  <span className={styles.rootPath} title={c.path}>
                    {tildify(c.path)}
                  </span>
                </div>
              ))}
            </div>
            <div className={styles.entryActions}>
              <Button size="small" variant="ghost" icon="plus" onClick={() => void add()}>
                <T>Add Project…</T>
              </Button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function ModulesSection() {
  const root = useProject((s) => s.project?.root ?? null);
  const projectName = useProject((s) => s.project?.name ?? "");
  const model = useBuildModelData(root);
  const [modulesMap, setModulesMap] = useProjectSetting<Record<string, ModuleStructureValid> | undefined>(
    "projectStructure.modules",
  );
  const [selectedModule, setSelectedModule] = useState<string>(".");
  const [subTab, setSubTab] = useState<"sources" | "paths">("sources");
  const [moduleError, setModuleError] = useState(false);
  const outId = useId();
  const testOutId = useId();

  const modules = useMemo<DiscoveredModule[]>(() => {
    const seen = new Set<string>();
    const list: DiscoveredModule[] = [];
    const add = (key: string, name: string, buildTool: "maven" | "gradle" | "custom") => {
      const norm = normalizeFolder(key) || ".";
      if (seen.has(norm)) return;
      seen.add(norm);
      list.push({ key: norm, name, buildTool });
    };
    add(".", projectName || "Root Module", model?.maven ? "maven" : model?.gradle?.length ? "gradle" : "custom");
    for (const p of model?.maven?.projects ?? []) {
      add(p.dir, p.displayName || p.artifactId || p.dir, "maven");
    }
    for (const gm of model?.gradle ?? []) {
      for (const p of gm.projects) {
        add(p.dir, p.name || p.path || p.dir, "gradle");
      }
    }
    for (const k of Object.keys(modulesMap ?? {})) {
      add(k, k === "." ? projectName || "Root Module" : k.split("/").pop() || k, "custom");
    }
    return list;
  }, [projectName, model, modulesMap]);

  const activeKey = modules.some((m) => m.key === selectedModule) ? selectedModule : ".";
  const currentModuleCfg: ModuleStructureValid = modulesMap?.[activeKey] ?? {
    jdk: "",
    languageLevel: "",
    compilerOutput: "",
    testCompilerOutput: "",
    dependencies: [],
  };

  const updateModuleCfg = (patch: Partial<ModuleStructureValid>) => {
    const next: ModuleStructureValid = { ...currentModuleCfg, ...patch };
    setModulesMap({ ...(modulesMap ?? {}), [activeKey]: next });
  };

  const addModule = async () => {
    const picked = await choosePath({
      directory: true,
      title: "Select Module Directory",
      defaultPath: root ?? undefined,
    });
    if (!picked) return;
    if (!root || !inside(root, picked)) {
      setModuleError(true);
      return;
    }
    setModuleError(false);
    const rel = normalizeFolder(relativePath(root, picked)) || ".";
    if (!(modulesMap && modulesMap[rel])) {
      setModulesMap({
        ...(modulesMap ?? {}),
        [rel]: { jdk: "", languageLevel: "", compilerOutput: "", testCompilerOutput: "", dependencies: [] },
      });
    }
    setSelectedModule(rel);
  };

  const removeModule = () => {
    if (activeKey === "." || !modulesMap?.[activeKey]) return;
    const next = { ...modulesMap };
    delete next[activeKey];
    setModulesMap(next);
    setSelectedModule(".");
  };

  const activeMod = modules.find((m) => m.key === activeKey) ?? modules[0];

  return (
    <div className={styles.page}>
      {moduleError && (
        <div role="status" className={styles.note}>
          <T>Select a module directory inside the project.</T>
        </div>
      )}
      <div className={styles.splitLayout}>
        <div className={styles.sideList}>
          <div className={styles.tableToolbar}>
            <Button size="small" variant="ghost" icon="plus" onClick={() => void addModule()}>
              <T>Add Module Overrides</T>
            </Button>
            <span className={styles.spacer} />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Module Overrides"
              disabled={activeKey === "." || !modulesMap?.[activeKey]}
              onClick={removeModule}
            />
          </div>
          <div className={styles.sideItems}>
            {modules.map((m) => (
              <button
                key={m.key}
                type="button"
                className={clsx(styles.sideItem, m.key === activeKey && styles.sideItemActive)}
                onClick={() => setSelectedModule(m.key)}
              >
                <Icon name="module" size={14} />
                <span className={styles.sideItemLabel}>{m.name}</span>
                <span className={styles.sideItemMeta}>{m.buildTool}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.detailPane}>
          <div className={styles.psModuleHeader} role="tablist" aria-label={tx("Module settings")}>
            <span className={styles.psModuleTitle}>
              <Icon name="module" size={14} />
              {activeMod?.name ?? activeKey}
            </span>
            {activeKey !== "." && <span className={styles.badge}>{activeKey}</span>}
            <span className={styles.spacer} />
            <button
              type="button"
              role="tab"
              className={styles.sectionTab}
              aria-selected={subTab === "sources"}
              onClick={() => setSubTab("sources")}
            >
              <T>Sources</T>
            </button>
            <button
              type="button"
              role="tab"
              className={styles.sectionTab}
              aria-selected={subTab === "paths"}
              onClick={() => setSubTab("paths")}
            >
              <T>Paths</T>
            </button>
          </div>

          {subTab === "sources" && <ModuleSourcesTab key={activeKey} moduleKey={activeKey} />}

          {subTab === "paths" && (
            <Section title="Module SDK & Compiler Output">
              {activeKey !== "." && (
                <div className={styles.note}>
                  <T>
                    Per-module language levels and compiler output overrides are not supported yet. Configure them in
                    Maven or Gradle.
                  </T>
                </div>
              )}
              <Row
                label="Module SDK"
                hint="JDK used by Run/Debug for this module. Maven and Gradle manage their own compiler JDK."
              >
                <SdkField
                  kind="jdk"
                  value={currentModuleCfg.jdk}
                  onChange={(jdk) => updateModuleCfg({ jdk })}
                  emptyLabel="Project SDK"
                  emptyDetail="inherit from Project"
                  directory
                  browseTitle="Select JDK Home Directory"
                  aria-label="Module SDK"
                />
              </Row>
              <Row label="Language level" hint="Override the Java language level for this module.">
                <Select
                  disabled={activeKey !== "."}
                  value={currentModuleCfg.languageLevel}
                  options={MODULE_JAVA_LEVEL_OPTIONS}
                  onChange={(v) => updateModuleCfg({ languageLevel: v as (typeof JAVA_LANGUAGE_LEVELS)[number] })}
                  aria-label="Module language level"
                />
              </Row>
              <Row
                label="Output path"
                htmlFor={outId}
                hint="Directory for production classes, relative to the project root and inside this module."
              >
                <span className={styles.pathRow}>
                  <Input
                    id={outId}
                    mono
                    className={styles.pathInput}
                    disabled={activeKey !== "."}
                    value={currentModuleCfg.compilerOutput}
                    placeholder={activeKey === "." ? "target/classes" : `${activeKey}/target/classes`}
                    onChange={(e) => updateModuleCfg({ compilerOutput: e.target.value })}
                  />
                  <IconButton
                    disabled={activeKey !== "."}
                    icon="folder-open"
                    size="small"
                    title="Browse…"
                    onClick={async () => {
                      const picked = await choosePath({
                        directory: true,
                        title: "Select Compiler Output Directory",
                        defaultPath: currentModuleCfg.compilerOutput || root || undefined,
                      });
                      if (picked)
                        updateModuleCfg({
                          compilerOutput: root && inside(root, picked) ? relativePath(root, picked) : picked,
                        });
                    }}
                  />
                </span>
              </Row>
              <Row
                label="Test output path"
                htmlFor={testOutId}
                hint="Custom test output paths are not supported yet. Maven and Gradle manage their own test output."
              >
                <span className={styles.pathRow}>
                  <Input
                    id={testOutId}
                    mono
                    className={styles.pathInput}
                    disabled
                    value={currentModuleCfg.testCompilerOutput}
                    placeholder="target/test-classes"
                    onChange={(e) => updateModuleCfg({ testCompilerOutput: e.target.value })}
                  />
                  <IconButton
                    disabled
                    icon="folder-open"
                    size="small"
                    title="Browse…"
                    onClick={async () => {
                      const picked = await choosePath({
                        directory: true,
                        title: "Select Test Output Directory",
                        defaultPath: currentModuleCfg.testCompilerOutput || root || undefined,
                      });
                      if (picked)
                        updateModuleCfg({
                          testCompilerOutput: root && inside(root, picked) ? relativePath(root, picked) : picked,
                        });
                    }}
                  />
                </span>
              </Row>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Libraries Section

function LibrariesSection() {
  const root = useProject((s) => s.project?.root ?? null);
  const [rawLibs, setRawLibs] = useProjectSetting<ProjectLibraryValid[] | undefined>("projectStructure.libraries");
  const libs = rawLibs ?? [];
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [detectedGroups, setDetectedGroups] = useState<LibraryGroup[]>([]);
  const nameId = useId();

  useEffect(() => {
    if (!root || !isTauri()) return;
    let live = true;
    const request = nextRequestId();
    const channel = new Channel<LibraryGroup[]>();
    let collected: LibraryGroup[] = [];
    channel.onmessage = (groups) => {
      collected = mergeLibraryGroups([...collected, ...groups]);
      if (live) setDetectedGroups(collected);
    };
    call(commands.sdkProjectLibraries(request, channel))
      .then((groups) => {
        collected = groups;
        if (live) setDetectedGroups(groups);
      })
      .catch(() => {});
    return () => {
      live = false;
      void commands.cancelRequest(request).catch(() => {});
    };
  }, [root, libs.length]);

  const activeIdx = selectedIdx >= 0 && selectedIdx < libs.length ? selectedIdx : libs.length > 0 ? 0 : -1;
  const current = activeIdx >= 0 ? libs[activeIdx]! : null;

  const updateCurrent = (patch: Partial<ProjectLibraryValid>) => {
    if (!current || activeIdx < 0) return;
    const next = [...libs];
    next[activeIdx] = { ...current, ...patch };
    setRawLibs(next);
  };

  const addLibraryFromJar = async (directory: boolean) => {
    const picked = await choosePath({
      directory,
      title: directory ? "Select Classes Directory" : "Select Library JAR",
      defaultPath: root ?? undefined,
    });
    if (!picked) return;
    const rel = root && inside(root, picked) ? relativePath(root, picked) : picked;
    const baseName =
      picked
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.jar$/i, "") || "Library";
    const created: ProjectLibraryValid = {
      name: baseName,
      classes: [rel],
      sources: [],
      javadocs: [],
      scope: "compile",
    };
    const next = [...libs, created];
    setRawLibs(next);
    setSelectedIdx(next.length - 1);
  };

  const removeSelectedLibrary = () => {
    if (activeIdx < 0) return;
    const next = libs.filter((_, idx) => idx !== activeIdx);
    setRawLibs(next);
    setSelectedIdx(Math.max(0, activeIdx - 1));
  };

  const appendPath = async (field: "classes" | "sources" | "javadocs", directory: boolean, title: string) => {
    if (!current) return;
    const picked = await choosePath({ directory, title, defaultPath: root ?? undefined });
    if (!picked) return;
    const rel = root && inside(root, picked) ? relativePath(root, picked) : picked;
    if (!current[field].includes(rel)) {
      updateCurrent({ [field]: [...current[field], rel] });
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.splitLayout}>
        <div className={styles.sideList}>
          <div className={styles.tableToolbar}>
            <IconButton
              icon="plus"
              size="small"
              title="Add JAR or Directory…"
              onClick={() => void addLibraryFromJar(false)}
            />
            <IconButton
              icon="folder-open"
              size="small"
              title="Add Classes Folder…"
              onClick={() => void addLibraryFromJar(true)}
            />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Library"
              disabled={activeIdx < 0}
              onClick={removeSelectedLibrary}
            />
          </div>
          <div className={styles.sideItems}>
            {libs.length === 0 && (
              <div className={styles.empty}>
                <T>No project libraries added.</T>
              </div>
            )}
            {libs.map((lib, idx) => (
              <button
                key={`${lib.name}-${idx}`}
                type="button"
                className={clsx(styles.sideItem, idx === activeIdx && styles.sideItemActive)}
                onClick={() => setSelectedIdx(idx)}
              >
                <Icon name="folder-library" size={14} />
                <span className={styles.sideItemLabel}>{lib.name}</span>
                <span className={styles.sideItemMeta}>{lib.scope}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.detailPane}>
          {current ? (
            <Section title="Library Details">
              <Row label="Name" htmlFor={nameId}>
                <Input id={nameId} value={current.name} onChange={(e) => updateCurrent({ name: e.target.value })} />
              </Row>
              <Row label="Scope" hint="Scope controls Run/Debug only. JARs are also available to Java code assistance.">
                <Select
                  value={current.scope}
                  options={SCOPE_OPTIONS}
                  onChange={(v) => updateCurrent({ scope: v as DependencyScopeValid })}
                  aria-label="Library scope"
                />
              </Row>
              <Row
                label="Classes"
                stacked
                hint="Binary JAR archives support Java code assistance and Run/Debug. Class folders are used by Run/Debug only."
              >
                <div className={styles.entryList}>
                  <div className={styles.entryActions}>
                    <Button
                      size="small"
                      variant="ghost"
                      icon="plus"
                      onClick={() => void appendPath("classes", false, "Select Library JAR")}
                    >
                      <T>Add JAR…</T>
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      icon="folder-open"
                      onClick={() => void appendPath("classes", true, "Select Classes Directory")}
                    >
                      <T>Add Folder…</T>
                    </Button>
                  </div>
                  {current.classes.length === 0 && (
                    <div className={styles.note}>
                      <T>None</T>
                    </div>
                  )}
                  {current.classes.map((c) => (
                    <div key={c} className={styles.entryRow}>
                      <Icon name="file-archive" size={14} />
                      <span className={styles.rootPath}>{c}</span>
                      <IconButton
                        icon="close"
                        size="small"
                        iconSize={12}
                        title={tx`Remove ${c}`}
                        onClick={() => updateCurrent({ classes: current.classes.filter((x) => x !== c) })}
                      />
                    </div>
                  ))}
                </div>
              </Row>
              <Row
                label="Sources"
                stacked
                hint="Source archives (-sources.jar, .zip) or folders used for Go to Declaration."
              >
                <div className={styles.entryList}>
                  <div className={styles.entryActions}>
                    <Button
                      size="small"
                      variant="ghost"
                      icon="plus"
                      onClick={() => void appendPath("sources", false, "Select Source Archive")}
                    >
                      <T>Attach Sources…</T>
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      icon="folder-open"
                      onClick={() => void appendPath("sources", true, "Select Source Directory")}
                    >
                      <T>Attach Source Folder…</T>
                    </Button>
                  </div>
                  {current.sources.length === 0 && (
                    <div className={styles.note}>
                      <T>None</T>
                    </div>
                  )}
                  {current.sources.map((s) => (
                    <div key={s} className={styles.entryRow}>
                      <Icon name="folder-source" size={14} />
                      <span className={styles.rootPath}>{s}</span>
                      <IconButton
                        icon="close"
                        size="small"
                        iconSize={12}
                        title={tx`Remove ${s}`}
                        onClick={() => updateCurrent({ sources: current.sources.filter((x) => x !== s) })}
                      />
                    </div>
                  ))}
                </div>
              </Row>
            </Section>
          ) : (
            <Section title="Project Libraries">
              <div className={styles.note}>
                <T>
                  Add JARs for Java code assistance and Run/Debug, or class directories for Run/Debug only. Libraries
                  are listed under External Libraries.
                </T>
              </div>
            </Section>
          )}

          {detectedGroups.length > 0 && (
            <Section title="Resolved Build & SDK Libraries">
              <div className={styles.entryList}>
                {detectedGroups.map((g) => (
                  <div key={`${g.kind}-${g.name}`} className={styles.entryRow}>
                    <Icon name="folder-library" size={14} />
                    <span className={styles.rootPath}>{g.name}</span>
                    <span className={styles.badge}>{g.kind}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Facets Section (Web, Spring, JPA)

function FacetsSection() {
  const root = useProject((s) => s.project?.root ?? null);
  const model = useBuildModelData(root);
  const [rawFacets, setRawFacets] = useProjectSetting<FacetConfigValid[] | undefined>("projectStructure.facets");
  const facets = rawFacets ?? [];
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const descId = useId();
  const webRootId = useId();

  const detectedSummary = useMemo(() => {
    const items: Array<{ kind: string; module: string; detail: string }> = [];
    for (const p of model?.maven?.projects ?? []) {
      const mod = p.dir || ".";
      if (p.packaging === "war") {
        items.push({ kind: "Web", module: mod, detail: "Maven WAR packaging" });
      }
      if (p.dependencies.some((d) => d.groupId.includes("spring"))) {
        items.push({ kind: "Spring", module: mod, detail: "Spring dependencies in pom.xml" });
      }
      if (p.dependencies.some((d) => d.artifactId.includes("persistence") || d.artifactId.includes("hibernate"))) {
        items.push({ kind: "JPA", module: mod, detail: "JPA / Hibernate dependencies in pom.xml" });
      }
    }
    return items;
  }, [model]);

  const activeIdx = selectedIdx >= 0 && selectedIdx < facets.length ? selectedIdx : facets.length > 0 ? 0 : -1;
  const current = activeIdx >= 0 ? facets[activeIdx]! : null;

  const updateCurrent = (patch: Partial<FacetConfigValid>) => {
    if (!current || activeIdx < 0) return;
    const next = [...facets];
    next[activeIdx] = { ...current, ...patch };
    setRawFacets(next);
  };

  const addFacet = (kind: "web" | "spring" | "jpa") => {
    const created: FacetConfigValid = {
      kind,
      module: ".",
      descriptor:
        kind === "web"
          ? "src/main/webapp/WEB-INF/web.xml"
          : kind === "jpa"
            ? "src/main/resources/META-INF/persistence.xml"
            : "src/main/resources/application.yml",
      webRoot: kind === "web" ? "src/main/webapp" : "",
    };
    const next = [...facets, created];
    setRawFacets(next);
    setSelectedIdx(next.length - 1);
  };

  const removeFacet = () => {
    if (activeIdx < 0) return;
    const next = facets.filter((_, idx) => idx !== activeIdx);
    setRawFacets(next);
    setSelectedIdx(Math.max(0, activeIdx - 1));
  };

  return (
    <div className={styles.page}>
      <div className={styles.splitLayout}>
        <div className={styles.sideList}>
          <div className={styles.tableToolbar}>
            <Button size="small" variant="ghost" icon="plus" onClick={() => addFacet("web")}>
              <T>Web</T>
            </Button>
            <Button size="small" variant="ghost" icon="plus" onClick={() => addFacet("spring")}>
              <T>Spring</T>
            </Button>
            <Button size="small" variant="ghost" icon="plus" onClick={() => addFacet("jpa")}>
              <T>JPA</T>
            </Button>
            <span className={styles.spacer} />
            <IconButton icon="minus" size="small" title="Remove Facet" disabled={activeIdx < 0} onClick={removeFacet} />
          </div>
          <div className={styles.sideItems}>
            {facets.length === 0 && (
              <div className={styles.empty}>
                <T>No custom facets configured.</T>
              </div>
            )}
            {facets.map((f, idx) => (
              <button
                key={`${f.kind}-${f.module}-${idx}`}
                type="button"
                className={clsx(styles.sideItem, idx === activeIdx && styles.sideItemActive)}
                onClick={() => setSelectedIdx(idx)}
              >
                <Icon name="file-config" size={14} />
                <span className={styles.sideItemLabel}>
                  {f.kind === "web" ? "Web" : f.kind === "spring" ? "Spring" : "JPA"}
                </span>
                <span className={styles.sideItemMeta}>{f.module}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.detailPane}>
          {current ? (
            <Section title="Facet Configuration">
              <Row label="Framework">
                <Select
                  value={current.kind}
                  options={FACET_KIND_OPTIONS}
                  onChange={(v) => updateCurrent({ kind: v as "web" | "spring" | "jpa" })}
                  aria-label="Facet framework"
                />
              </Row>
              <Row label="Module" hint="Module path ('.' for the root module).">
                <Input
                  mono
                  value={current.module}
                  aria-label="Facet module"
                  onChange={(e) => updateCurrent({ module: e.target.value })}
                />
              </Row>
              <Row
                label="Deployment descriptor"
                htmlFor={descId}
                hint="Path to web.xml, persistence.xml, or Spring configuration file."
              >
                <span className={styles.pathRow}>
                  <Input
                    id={descId}
                    mono
                    className={styles.pathInput}
                    value={current.descriptor}
                    onChange={(e) => updateCurrent({ descriptor: e.target.value })}
                  />
                  <IconButton
                    icon="folder-open"
                    size="small"
                    title="Browse…"
                    onClick={async () => {
                      const picked = await choosePath({
                        directory: false,
                        title: "Select Deployment Descriptor",
                        defaultPath: root ?? undefined,
                      });
                      if (picked)
                        updateCurrent({
                          descriptor: root && inside(root, picked) ? relativePath(root, picked) : picked,
                        });
                    }}
                  />
                </span>
              </Row>
              {current.kind === "web" && (
                <Row
                  label="Web resource directory"
                  htmlFor={webRootId}
                  hint="Directory containing web resources and WEB-INF/lib jars (automatically indexed by jdtls)."
                >
                  <span className={styles.pathRow}>
                    <Input
                      id={webRootId}
                      mono
                      className={styles.pathInput}
                      value={current.webRoot}
                      placeholder="src/main/webapp"
                      onChange={(e) => updateCurrent({ webRoot: e.target.value })}
                    />
                    <IconButton
                      icon="folder-open"
                      size="small"
                      title="Browse…"
                      onClick={async () => {
                        const picked = await choosePath({
                          directory: true,
                          title: "Select Web Resource Directory",
                          defaultPath: root ?? undefined,
                        });
                        if (picked)
                          updateCurrent({
                            webRoot: root && inside(root, picked) ? relativePath(root, picked) : picked,
                          });
                      }}
                    />
                  </span>
                </Row>
              )}
            </Section>
          ) : (
            <Section title="Framework Facets">
              <div className={styles.note}>
                <T>
                  Facets describe the frameworks (Web, Spring, JPA) used by a module. Adding a Web facet also registers
                  its WEB-INF/lib/*.jar archives with the Java language server.
                </T>
              </div>
            </Section>
          )}

          {detectedSummary.length > 0 && (
            <Section title="Auto-detected from Build">
              <div className={styles.entryList}>
                {detectedSummary.map((d, i) => (
                  <div key={`${d.kind}-${d.module}-${i}`} className={styles.entryRow}>
                    <Icon name="check" size={14} />
                    <span className={styles.rootPath}>
                      {d.kind} ({d.module})
                    </span>
                    <span className={styles.badge}>{d.detail}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Artifacts Section (JAR, WAR, Exploded WAR)

function ArtifactsSection() {
  const root = useProject((s) => s.project?.root ?? null);
  const projectName = useProject((s) => s.project?.name ?? "app");
  const [rawArtifacts, setRawArtifacts] = useProjectSetting<ArtifactConfigValid[] | undefined>(
    "projectStructure.artifacts",
  );
  const [libraries] = useProjectSetting<ProjectLibraryValid[] | undefined>("projectStructure.libraries");
  const artifacts = rawArtifacts ?? [];
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [webArtifacts, setWebArtifacts] = useState<WebArtifact[]>([]);
  const nameId = useId();
  const outId = useId();
  const mainClassId = useId();

  useEffect(() => {
    if (!root || !isTauri()) return;
    let live = true;
    call(commands.runTomcatArtifacts())
      .then((list) => live && setWebArtifacts(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [root]);

  const activeIdx = selectedIdx >= 0 && selectedIdx < artifacts.length ? selectedIdx : artifacts.length > 0 ? 0 : -1;
  const current = activeIdx >= 0 ? artifacts[activeIdx]! : null;

  const updateCurrent = (patch: Partial<ArtifactConfigValid>) => {
    if (!current || activeIdx < 0) return;
    const next = [...artifacts];
    next[activeIdx] = { ...current, ...patch };
    setRawArtifacts(next);
  };

  const addArtifact = (kind: ArtifactKindValid) => {
    const base = projectName || "app";
    const suffix = kind === "jar" ? "jar" : kind === "war" ? "war" : "war exploded";
    const created: ArtifactConfigValid = {
      name: `${base}:${suffix}`,
      kind,
      module: ".",
      outputDirectory: `out/artifacts/${base}_${suffix.replace(/\s+/g, "_")}`,
      mainClass: "",
      includeLibraries: (libraries ?? []).map((l) => l.name),
    };
    const next = [...artifacts, created];
    setRawArtifacts(next);
    setSelectedIdx(next.length - 1);
  };

  const removeArtifact = () => {
    if (activeIdx < 0) return;
    const next = artifacts.filter((_, idx) => idx !== activeIdx);
    setRawArtifacts(next);
    setSelectedIdx(Math.max(0, activeIdx - 1));
  };

  return (
    <div className={styles.page}>
      <div className={styles.note}>
        <T>Custom artifact packaging is not supported yet. Build and deploy artifacts defined by Maven or Gradle.</T>
      </div>
      <fieldset disabled className={styles.pendingFeature}>
        <div className={styles.splitLayout}>
          <div className={styles.sideList}>
            <div className={styles.tableToolbar}>
              <Button size="small" variant="ghost" icon="plus" onClick={() => addArtifact("jar")}>
                <T>JAR</T>
              </Button>
              <Button size="small" variant="ghost" icon="plus" onClick={() => addArtifact("warExploded")}>
                <T>WAR Exploded</T>
              </Button>
              <Button size="small" variant="ghost" icon="plus" onClick={() => addArtifact("war")}>
                <T>WAR</T>
              </Button>
              <span className={styles.spacer} />
              <IconButton
                icon="minus"
                size="small"
                title="Remove Artifact"
                disabled={activeIdx < 0}
                onClick={removeArtifact}
              />
            </div>
            <div className={styles.sideItems}>
              {artifacts.length === 0 && (
                <div className={styles.empty}>
                  <T>No custom artifacts configured.</T>
                </div>
              )}
              {artifacts.map((a, idx) => (
                <button
                  key={`${a.name}-${idx}`}
                  type="button"
                  className={clsx(styles.sideItem, idx === activeIdx && styles.sideItemActive)}
                  onClick={() => setSelectedIdx(idx)}
                >
                  <Icon name="file-archive" size={14} />
                  <span className={styles.sideItemLabel}>{a.name}</span>
                  <span className={styles.sideItemMeta}>{a.kind}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.detailPane}>
            {current ? (
              <Section title="Artifact Settings">
                <Row label="Name" htmlFor={nameId}>
                  <Input id={nameId} value={current.name} onChange={(e) => updateCurrent({ name: e.target.value })} />
                </Row>
                <Row label="Type">
                  <Select
                    value={current.kind}
                    options={ARTIFACT_KIND_OPTIONS}
                    onChange={(v) => updateCurrent({ kind: v as ArtifactKindValid })}
                    aria-label="Artifact type"
                  />
                </Row>
                <Row label="Module">
                  <Input
                    mono
                    value={current.module}
                    aria-label="Artifact module"
                    onChange={(e) => updateCurrent({ module: e.target.value })}
                  />
                </Row>
                <Row label="Output directory" htmlFor={outId}>
                  <span className={styles.pathRow}>
                    <Input
                      id={outId}
                      mono
                      className={styles.pathInput}
                      value={current.outputDirectory}
                      onChange={(e) => updateCurrent({ outputDirectory: e.target.value })}
                    />
                    <IconButton
                      icon="folder-open"
                      size="small"
                      title="Browse…"
                      onClick={async () => {
                        const picked = await choosePath({
                          directory: true,
                          title: "Select Artifact Output Directory",
                          defaultPath: root ?? undefined,
                        });
                        if (picked)
                          updateCurrent({
                            outputDirectory: root && inside(root, picked) ? relativePath(root, picked) : picked,
                          });
                      }}
                    />
                  </span>
                </Row>
                {current.kind === "jar" && (
                  <Row
                    label="Main class"
                    htmlFor={mainClassId}
                    hint="Entry-point class written to META-INF/MANIFEST.MF."
                  >
                    <Input
                      id={mainClassId}
                      mono
                      value={current.mainClass}
                      placeholder="com.example.Main"
                      onChange={(e) => updateCurrent({ mainClass: e.target.value })}
                    />
                  </Row>
                )}
                {(libraries ?? []).length > 0 && (
                  <Row label="Included libraries" stacked hint="Project libraries packaged into the artifact.">
                    <div className={styles.entryList}>
                      {(libraries ?? []).map((lib) => {
                        const included = current.includeLibraries.includes(lib.name);
                        return (
                          <Checkbox
                            key={lib.name}
                            checked={included}
                            label={lib.name}
                            onChange={(checked) => {
                              const next = checked
                                ? [...current.includeLibraries, lib.name]
                                : current.includeLibraries.filter((n) => n !== lib.name);
                              updateCurrent({ includeLibraries: next });
                            }}
                          />
                        );
                      })}
                    </div>
                  </Row>
                )}
              </Section>
            ) : (
              <Section title="Packaging Artifacts">
                <div className={styles.note}>
                  <T>Configure JAR, WAR, or exploded WAR artifacts for packaging and application server deployment.</T>
                </div>
              </Section>
            )}

            {webArtifacts.length > 0 && (
              <Section title="Detected Build Web Artifacts">
                <div className={styles.entryList}>
                  {webArtifacts.map((w) => (
                    <div key={w.id} className={styles.entryRow}>
                      <Icon name="file-archive" size={14} />
                      <span className={styles.rootPath}>
                        {w.name} ({w.module || "."})
                      </span>
                      <span className={styles.badge}>{w.tool}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
      </fieldset>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. SDKs Section (IDEA 3-Column Master-Detail: SDK List | Selected SDK Details)

function SdksSection() {
  const byKind = useSdks((s) => s.byKind);
  const [downloading, setDownloading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [projectJdk, setProjectJdk] = useProjectSetting<string>("languages.java.jdk");
  useDetected("jdk");

  useEffect(() => {
    for (const { kind } of SDK_KINDS) {
      void detectSdks(kind);
    }
  }, []);

  const refreshAll = () => {
    for (const { kind } of SDK_KINDS) {
      void detectSdks(kind, true);
    }
  };

  const rows = useMemo(() => {
    const out: Array<{ key: string; kind: SdkKind; kindLabel: string; name: string; version: string; path: string }> =
      [];
    for (const { kind, label } of SDK_KINDS) {
      for (const sdk of byKind[kind] ?? []) {
        out.push({
          key: `${kind}:${sdk.path}`,
          kind,
          kindLabel: label,
          name: sdk.name,
          version: sdk.version ?? "",
          path: sdk.path,
        });
      }
    }
    return out;
  }, [byKind]);

  const activeSdk = rows.find((r) => r.key === selectedKey) ?? rows[0];

  return (
    <div className={styles.page}>
      <div className={styles.splitLayout}>
        <div className={styles.sideList}>
          <div className={styles.tableToolbar}>
            <Button size="small" variant="ghost" icon="plus" onClick={() => setDownloading(true)}>
              <T>Download JDK…</T>
            </Button>
            <span className={styles.spacer} />
            <IconButton icon="refresh" size="small" title="Detect again" onClick={refreshAll} />
          </div>
          <div className={styles.sideItems} role="listbox" aria-label={tx("SDKs")}>
            {rows.length === 0 && (
              <div className={styles.empty}>
                <T>No SDK installations detected yet.</T>
              </div>
            )}
            {rows.map((r) => (
              <button
                key={r.key}
                type="button"
                role="option"
                aria-selected={activeSdk?.key === r.key}
                className={clsx(styles.sideItem, activeSdk?.key === r.key && styles.sideItemActive)}
                onClick={() => setSelectedKey(r.key)}
              >
                <Icon name="settings" size={14} />
                <span className={styles.sideItemLabel}>{r.name}</span>
                <span className={styles.badge}>{r.kindLabel}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.detailPane}>
          {activeSdk ? (
            <Section title="SDK Details">
              <div className={styles.psModuleHeader}>
                <span className={styles.badge}>{activeSdk.kindLabel}</span>
                <span className={styles.psModuleTitle}>{activeSdk.name}</span>
                {activeSdk.version && <span className={styles.versionCell}>{activeSdk.version}</span>}
                <span className={styles.spacer} />
                {activeSdk.kind === "jdk" && (
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={projectJdk === activeSdk.path}
                    onClick={() => setProjectJdk(activeSdk.path)}
                  >
                    <T>Use as Project SDK</T>
                  </Button>
                )}
              </div>
              <Row label="SDK home path">
                <Input readOnly value={tildify(activeSdk.path)} title={activeSdk.path} />
              </Row>
            </Section>
          ) : null}

          <div className={styles.tablePanel}>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>
                      <T>Type</T>
                    </th>
                    <th>
                      <T>Name</T>
                    </th>
                    <th>
                      <T>Version</T>
                    </th>
                    <th>
                      <T>Home Path</T>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={4} className={styles.empty}>
                        <T>No SDK installations detected yet.</T>
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.key} onClick={() => setSelectedKey(r.key)}>
                      <td>
                        <span className={styles.badge}>{r.kindLabel}</span>
                      </td>
                      <td>{r.name}</td>
                      <td className={styles.versionCell}>{r.version || "—"}</td>
                      <td className={styles.path} title={r.path}>
                        {tildify(r.path)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {downloading && (
        <DownloadJdkDialog
          onClose={() => setDownloading(false)}
          onDownloaded={(sdk) => {
            setDownloading(false);
            setProjectJdk(sdk.path);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported Pages

const NAV_GROUPS: Array<{
  title: string;
  items: Array<{ id: ProjectStructureSectionId; label: string; icon: IconName }>;
}> = [
  {
    title: "Project Settings",
    items: [
      { id: "project", label: "Project", icon: "folder" },
      { id: "modules", label: "Modules", icon: "module" },
      { id: "dependencies", label: "Dependencies", icon: "build-dependencies" },
      { id: "libraries", label: "Libraries", icon: "folder-library" },
      { id: "facets", label: "Facets", icon: "file-config" },
      { id: "artifacts", label: "Artifacts", icon: "file-archive" },
    ],
  },
  {
    title: "Platform Settings",
    items: [{ id: "sdks", label: "SDKs", icon: "settings" }],
  },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export function ProjectStructureDialog() {
  const open = useSettingsDialog((s) => s.projectStructureOpen);
  if (!open) return null;
  return <ProjectStructureDialogInner />;
}

function ProjectStructureStatus() {
  const error = useSettingsDialog((s) => s.error);
  return (
    <span className={styles.psFooterStatus} role="status">
      {error && (
        <span className={styles.psFooterError}>
          <Icon name="error" size={14} /> {tx`Could not save: ${error}`}
        </span>
      )}
    </span>
  );
}

function ProjectStructureDialogInner() {
  const section = useSettingsDialog((s) => s.projectStructureSection);
  const { staged, base, globalBase, saving } = useSettingsDialog();
  const hasProject = useProject((s) => !!s.project);
  const scope = hasProject ? "project" : "global";
  const pageId = "projectStructure";
  const ctx = useMemo(() => ({ pageId, scope }) as const, [scope]);
  const form = useSettingsFormFor(pageId, scope);
  const pending = useMemo(() => pendingChanges({ base, globalBase, staged }).length > 0, [base, globalBase, staged]);

  const activeGroup = NAV_GROUPS.find((g) => g.items.some((i) => i.id === section)) ?? NAV_GROUPS[0]!;
  const activeItem = activeGroup.items.find((i) => i.id === section) ?? activeGroup.items[0]!;

  const ok = async () => {
    if (await applySettings()) closeProjectStructure();
  };

  const buttons: DialogButton[] = [
    { label: "OK", role: "default", disabled: saving, onClick: () => void ok() },
    { label: "Cancel", role: "cancel", onClick: closeProjectStructure },
    { label: "Apply", disabled: !pending || saving, onClick: () => void applySettings() },
  ];

  const onNavKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const idx = NAV_ITEMS.findIndex((t) => t.id === section);
    const nextIdx = e.key === "ArrowDown" ? Math.min(NAV_ITEMS.length - 1, idx + 1) : Math.max(0, idx - 1);
    const next = NAV_ITEMS[nextIdx];
    if (next) selectProjectStructureSection(next.id);
  };

  return (
    <Dialog
      open
      onClose={closeProjectStructure}
      title={tx("Project Structure")}
      width={1040}
      resizable="both"
      minWidth={760}
      minHeight={480}
      className={styles.psDialog}
      footerStart={<ProjectStructureStatus />}
      buttons={buttons}
    >
      <PageContext.Provider value={ctx}>
        <SettingsFormContext.Provider value={form}>
          <div className={styles.psDialogLayout}>
            <nav className={styles.psNavSidebar} aria-label={tx("Project Structure sections")} onKeyDown={onNavKeyDown}>
              {NAV_GROUPS.map((group) => (
                <div key={group.title} className={styles.psNavGroup}>
                  <div className={styles.psNavGroupHeader}>
                    <T>{group.title}</T>
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={clsx(styles.psNavItem, section === item.id && styles.psNavItemActive)}
                      aria-current={section === item.id ? "page" : undefined}
                      onClick={() => selectProjectStructureSection(item.id)}
                    >
                      <Icon name={item.icon} size={14} />
                      <span>
                        <T>{item.label}</T>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>

            <div className={styles.psDialogMain}>
              <div className={styles.psDialogHeader}>
                <div className={styles.psDialogCrumbs}>
                  <span>
                    <T>{activeGroup.title}</T>
                  </span>
                  <Icon name="chevron-right" size={12} className={styles.psDialogCrumbSep} />
                  <span>
                    <T>{activeItem.label}</T>
                  </span>
                </div>
                {pending && !saving && (
                  <button type="button" className={styles.psDialogReset} onClick={() => resetPage(pageId)}>
                    <T>Reset</T>
                  </button>
                )}
              </div>
              <div className={styles.psDialogBody}>
                {section === "project" && <ProjectSection />}
                {section === "modules" && <ModulesSection />}
                {section === "dependencies" && <ModuleDependenciesTab />}
                {section === "libraries" && <LibrariesSection />}
                {section === "facets" && <FacetsSection />}
                {section === "artifacts" && <ArtifactsSection />}
                {section === "sdks" && <SdksSection />}
              </div>
            </div>
          </div>
        </SettingsFormContext.Provider>
      </PageContext.Provider>
    </Dialog>
  );
}
