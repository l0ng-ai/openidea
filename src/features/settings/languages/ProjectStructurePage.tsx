/**
 * Settings › Project Structure (IDEA's module "Sources" tab): the content
 * root's Sources / Tests / Resources / Test Resources / Excluded folders.
 * Roots detected from build files (`pom.xml`, `build.gradle`, `Cargo.toml`,
 * `go.mod`, `pyproject.toml`, `package.json`) apply until the user marks or
 * unmarks the folder (`projectStructure.*`, project scope). Roots drive the
 * project tree icons, package inference for new classes, the "Project
 * Production / Test Files" scopes, and Excluded folders are skipped by the
 * tree, Find in Files and indexing. Content roots besides the project folder
 * (`projectStructure.contentRoots`) are listed in the Project view and searched
 * by Find in Files; "Exclude files" name patterns (`projectStructure.excludeFiles`)
 * are hidden from the tree and skipped by search and indexing.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import clsx from "clsx";
import { Button, Icon, IconButton, Input, Tree, folderIconName, type FolderKind, T } from "@/ui";
import { call, commands, isTauri, type FileEntry } from "@/platform/ipc";
import { relativePath, useProject } from "@/platform/project";
import {
  PROJECT_STRUCTURE_KEYS,
  effectiveRoots,
  markFolder,
  restoreDetected,
  rootRole,
  unmarkedRoots,
  type FolderListKey,
  type FolderRole,
  type ProjectStructureValid,
} from "@/platform/languageSettings";
import { initProjectRoots, useDetectedRoots } from "@/platform/projectRoots";
import { choosePath } from "./api";
import { useProjectSetting } from "./components";
import styles from "./Sdk.module.css";
import { tx } from "@/platform/i18n";

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
  const [excludeFiles] = useProjectSetting<string | undefined>("projectStructure.excludeFiles");
  const ps = useMemo<ProjectStructureValid>(
    () => ({
      sourceRoots: sourceRoots ?? [],
      testRoots: testRoots ?? [],
      resourceRoots: resourceRoots ?? [],
      testResourceRoots: testResourceRoots ?? [],
      excluded: excluded ?? [],
      unmarked: unmarked ?? [],
      contentRoots: contentRoots ?? [],
      excludeFiles: excludeFiles ?? "",
    }),
    [sourceRoots, testRoots, resourceRoots, testResourceRoots, excluded, unmarked, contentRoots, excludeFiles],
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

export function ProjectStructurePage() {
  const root = useProject((s) => s.project?.root ?? null);
  const name = useProject((s) => s.project?.name ?? "");
  const [ps, setPs] = useStructure();
  const detected = useDetectedRoots();
  const roots = useMemo(() => effectiveRoots(detected, ps), [detected, ps]);
  useEffect(() => initProjectRoots(), []);
  const [children, setChildren] = useState<Map<string, DirNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(root ? [root] : []));
  const [selected, setSelected] = useState<DirNode | null>(null);

  const load = useCallback(
    async (node: DirNode) => {
      if (!root) return;
      const dirs = await readDirs(root, node.path);
      setChildren((m) => new Map(m).set(node.path, dirs));
    },
    [root],
  );

  const rootNode = useMemo<DirNode | null>(() => (root ? { path: root, name, rel: "" } : null), [root, name]);
  const treeRoots = useMemo<DirNode[]>(
    () =>
      rootNode
        ? [
            rootNode,
            ...ps.contentRoots.map((p) => ({
              path: p,
              name: p.slice(p.lastIndexOf("/") + 1) || p,
              rel: null,
              contentRoot: true,
            })),
          ]
        : [],
    [rootNode, ps.contentRoots],
  );
  useEffect(() => {
    if (!root) return;
    let live = true;
    for (const dir of [root, ...ps.contentRoots])
      void readDirs(root, dir)
        .then((dirs) => live && setChildren((m) => new Map(m).set(dir, dirs)))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [root, ps.contentRoots]);

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
  const unmarkedDetected = unmarkedRoots(detected, ps);
  const restore = () => setPs(restoreDetected(ps, detected));

  return (
    <div className={styles.page}>
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
          <ExcludeFiles />
        </div>
        <div className={styles.roots} aria-label={tx("Marked folders")}>
          <ContentRoots root={rootNode.path} />
          {ROLES.map((r) => {
            const list = roots.filter((x) => x.kind === r.role);
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
                "Folders are detected from build files (pom.xml, build.gradle, Cargo.toml, go.mod, pyproject.toml, package.json); marking or unmarking a folder overrides detection. Excluded folders are skipped by the Project view, Find in Files and the index (reopen the project to re-index)."
              }
            </T>
          </div>
        </div>
      </div>
    </div>
  );
}
