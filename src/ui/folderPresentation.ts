/** Shared folder-role, module-glyph, and package-icon resolution for Project and Commit trees. */
import { effectiveRoots, rootFor, rootRole, type FolderRole, type RootFolder } from "@/platform/languageSettings";
import { basename, relativePath } from "@/platform/project";
import { moduleFolderIcon, type BuildPresentation } from "@/platform/projectPresentation";
import type { AttachedProject } from "@/platform/projectRoots";
import { folderIconName, themedFolderIconName, type FolderKind, type IconName } from "./icons";

const ROLE_KIND: Record<FolderRole, FolderKind> = {
  source: "source",
  test: "test",
  resources: "resources",
  testResources: "testResources",
  excluded: "excluded",
};

// `Gradle` / `<module>/Gradle` marks the source sets a Gradle sync reported (ide-host `with_gradle_roots`).
const JVM_BUILD = /(^|\/)(Gradle|pom\.xml|build\.gradle(\.kts)?|\.classpath)$/;
const JVM_DIR = /(^|\/)(java|kotlin|scala|groovy)$/;

const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

export interface ProjectScope {
  ownerRoot: string | null;
  ownerRoots: readonly RootFolder[];
  ownerDetected: readonly RootFolder[];
  attachedMember: boolean;
}

/** Resolves the Project Structure scope holding `path` (attached workspace member or main project). */
export function projectScopeForPath(
  path: string,
  root: string | null,
  roots: readonly RootFolder[],
  detected: readonly RootFolder[] = [],
  attached: readonly AttachedProject[] = [],
): ProjectScope {
  const member = attached
    .filter((p) => path === p.root || path.startsWith(`${p.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (member) {
    return {
      ownerRoot: member.root,
      ownerRoots: effectiveRoots(member.detected, member.structure),
      ownerDetected: member.detected,
      attachedMember: true,
    };
  }
  return {
    ownerRoot: root,
    ownerRoots: roots,
    ownerDetected: detected,
    attachedMember: false,
  };
}

/** Inside a Java / Kotlin source or test root, where IDEA shows "Package" instead of "Directory". */
export function isJvmSourcePackage(rel: string, roots: readonly RootFolder[]): boolean {
  const root = rootFor(roots, rel);
  if (root?.kind === "excluded") return false;
  return (
    (root?.kind === "source" || root?.kind === "test") &&
    (JVM_BUILD.test(root.detectedFrom ?? "") || JVM_DIR.test(root.path))
  );
}

/** Output roles are relative to detected JVM modules, never arbitrary package names. */
export function outputFolderKind(
  rel: string,
  modules: BuildPresentation["modules"],
  ownerRoot?: string | null,
  attachedMember = false,
): FolderKind | null {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    const output = parts[i];
    if (output !== "target" && output !== "build") continue;
    const prefix = parts.slice(0, i).join("/");
    const absPrefix = ownerRoot ? (prefix ? `${ownerRoot}/${prefix}` : ownerRoot) : null;
    const tool = attachedMember
      ? absPrefix
        ? modules.get(absPrefix)
        : undefined
      : (modules.get(prefix) ?? (absPrefix ? modules.get(absPrefix) : undefined));
    if (tool !== (output === "target" ? "maven" : "gradle")) continue;
    const path = parts.slice(i + 1).join("/");
    if (/^generated-test-sources(\/|$)/.test(path) || /^generated\/.*\btest\b/.test(path)) return "generatedTest";
    if (/^(generated-sources|generated)(\/|$)/.test(path)) return "generatedSource";
    if (/^(classes|test-classes)(\/|$)/.test(path)) return "compiled";
    if (/^(site\/apidocs|apidocs|docs\/javadoc|javadoc)(\/|$)/.test(path)) return "javadoc";
  }
  return null;
}

/**
 * Project Structure marks and roots detected from build files. Like IDEA, only
 * excluded folders get the excluded icon; git-ignored ones keep the plain one.
 */
export function directoryFolderKind(
  path: string,
  roots: readonly RootFolder[],
  root: string | null,
  build?: BuildPresentation,
  _detected: readonly RootFolder[] = [],
  excluded = false,
  attachedMember = false,
): FolderKind {
  const rel = root ? (path === root ? "" : relativePath(root, path)) : null;
  const role = rel === null ? null : rootRole(roots, rel);
  const exact = roots.find((r) => r.path === rel);
  const output = rel === null ? null : outputFolderKind(rel, build?.modules ?? new Map(), root, attachedMember);
  if (role && (exact?.detectedFrom === null || output === "generatedSource" || output === "generatedTest"))
    return ROLE_KIND[role];
  const containing = rel === null ? null : rootFor(roots, rel);
  if (excluded || containing?.kind === "excluded") return "excluded";
  if (role) return ROLE_KIND[role];
  if (output) return output;
  if (rel !== null && (containing?.kind === "source" || containing?.kind === "test")) {
    const inModule = [...(build?.modules.keys() ?? [])].some((dir) =>
      isAbsolute(dir)
        ? path === dir || path.startsWith(`${dir}/`)
        : !attachedMember && (!dir || rel.startsWith(`${dir}/`)),
    );
    if (inModule || isJvmSourcePackage(rel, roots)) return "package";
  }
  return basename(path) === ".github" ? "github" : "plain";
}

export interface DirectoryIconOptions {
  path: string;
  root: string | null;
  roots: readonly RootFolder[];
  detected?: readonly RootFolder[];
  attached?: readonly AttachedProject[];
  build?: BuildPresentation;
  excluded?: boolean;
  expanded?: boolean;
  holdsOpen?: boolean;
}

/** Icon name for a working-tree directory row, matching the Project tree. */
export function directoryIconName(opts: DirectoryIconOptions): IconName {
  const { path, root, roots, detected = [], attached = [], build } = opts;
  const { ownerRoot, ownerRoots, ownerDetected, attachedMember } = projectScopeForPath(
    path,
    root,
    roots,
    detected,
    attached,
  );
  const kind = directoryFolderKind(path, ownerRoots, ownerRoot, build, ownerDetected, !!opts.excluded, attachedMember);
  if (kind !== "plain") return folderIconName(kind);
  const rel = ownerRoot ? (path === ownerRoot ? "" : relativePath(ownerRoot, path)) : null;
  if (build) {
    const key = ownerRoot && rel !== null && !attachedMember && build.modules.has(rel) ? rel : path;
    const mod = moduleFolderIcon(key, !!ownerRoot && path === ownerRoot, build.modules);
    if (mod) return mod as IconName;
  }
  if (ownerRoot && path === ownerRoot) return "module";
  const themed = themedFolderIconName(basename(path), !!opts.expanded, !!opts.holdsOpen, path);
  if (themed) return themed;
  return opts.expanded ? "folder-open" : "folder";
}
