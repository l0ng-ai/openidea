/**
 * External Libraries: the project's SDK / library source folders (the Python
 * interpreter's standard library and site-packages, the JDK, node_modules
 * packages, Cargo crates and the Rust standard library, GOROOT and Go modules,
 * Maven / Gradle dependency jars) as a Project view root. Their files open
 * read-only, like IDEA's library sources. Archives (the JDK's `src.zip`, jars)
 * are browsed through the backend's `<archive>!/<entry>` paths.
 */
import { commands, type LibraryGroup } from "@/bindings";
import { registerActions } from "@/platform/actions";
import { setLibraryRoots } from "@/editor/api";
import { call, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerProjectViewRoot, type ProjectViewRootContribution } from "@/workbench/contributions";

export const EXTERNAL_LIBRARIES_LABEL = "External Libraries";

const GROUP_ICONS: Record<string, string> = {
  python: "file-python",
  jdk: "file-java",
  nodeCore: "file-js",
  nodeModules: "file-npm",
  rust: "file-rust",
  cargo: "file-cargo",
  go: "file-go",
  goModules: "file-gomod",
  maven: "maven-project",
  gradle: "file-gradle",
  ruby: "file-ruby",
  gems: "file-ruby",
};

/** An archive's root (`/jdk/lib/src.zip!`): its entries live below `<archive>!/`. */
const isArchiveRoot = (path: string) => path.endsWith("!");

/** Files whose change can change the libraries (the backend re-detects only the affected ecosystem). */
const MANIFESTS = new Set([
  "pyvenv.cfg",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  "go.mod",
  "go.sum",
  "go.work",
]);

/** Whether an `fsChanged` event touches a library manifest. */
export function touchesManifest(paths: readonly string[]): boolean {
  return paths.some(
    (p) =>
      !/[\\/]node_modules[\\/]/.test(p) &&
      MANIFESTS.has(p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1)),
  );
}

/** The "External Libraries" node for `groups` (`< Python 3.12 (.venv) >` › `python3.12`, `site-packages`). */
export function librariesRoot(groups: readonly LibraryGroup[]): ProjectViewRootContribution | null {
  if (!groups.length) return null;
  return {
    id: "externalLibraries",
    label: EXTERNAL_LIBRARIES_LABEL,
    icon: "library",
    // After the project, before Scratches and Consoles (IDEA's order).
    order: 5,
    readOnly: true,
    children: groups.map((g) => ({
      label: `< ${g.name} >`,
      icon: GROUP_ICONS[g.kind] ?? "library",
      children: g.roots.map((r) => ({
        label: r.name,
        icon: isArchiveRoot(r.path) ? "file-archive" : "folder-library",
        path: r.path,
        detail: "library root",
      })),
    })),
  };
}

/** Settings that change which SDKs the project uses. */
const sdkKey = (s: ReturnType<typeof useProject.getState>) => {
  const l = s.settings?.languages;
  return JSON.stringify([
    s.project?.root ?? null,
    s.project?.trusted,
    l?.python?.interpreter,
    l?.java?.jdk,
    l?.node?.interpreter,
    l?.rust?.toolchain,
    l?.rust?.stdlib,
    l?.go?.goroot,
    l?.go?.gopath,
    l?.go?.modules,
  ]);
};

const MANIFEST_REFRESH_DELAY = 500;

export function activate(): () => void {
  let disposeRoot = () => {};
  let disposeReadOnly = () => {};
  let seq = 0;
  let shown = "";
  const clear = () => {
    disposeRoot();
    disposeReadOnly();
    disposeRoot = disposeReadOnly = () => {};
    shown = "";
  };
  const refresh = () => {
    const id = ++seq;
    if (!useProject.getState().project || useProject.getState().project?.trusted === false || !isTauri())
      return clear();
    call(commands.sdkProjectLibraries())
      .then((groups) => {
        if (id !== seq) return;
        const key = JSON.stringify(groups);
        if (key === shown) return;
        clear();
        shown = key;
        const root = librariesRoot(groups);
        if (!root) return;
        disposeReadOnly = setLibraryRoots(
          "externalLibraries",
          groups.flatMap((g) => g.roots.map((r) => r.path)),
        );
        disposeRoot = registerProjectViewRoot(root);
      })
      .catch((e: unknown) => console.warn("external libraries: cannot list SDK roots", e));
  };
  refresh();
  const disposeActions = registerActions([
    { id: "libraries.reload", title: "Reload External Libraries", category: "Go", hidden: true, run: refresh },
  ]);
  const unsub = useProject.subscribe((s, prev) => {
    if (sdkKey(s) !== sdkKey(prev)) refresh();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubFs = onIdeEvent("fsChanged", (e) => {
    if (!touchesManifest([...e.created, ...e.modified, ...e.removed])) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, MANIFEST_REFRESH_DELAY);
  });
  return () => {
    seq++;
    clearTimeout(timer);
    unsub();
    unsubFs();
    disposeActions();
    clear();
  };
}
