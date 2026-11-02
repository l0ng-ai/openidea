/** Folder icon kind in the project view, from the effective roots. */
import { rootFor, rootRole, type FolderRole, type RootFolder } from "@/platform/languageSettings";
import { basename, relativePath } from "@/platform/project";
import type { FolderKind } from "@/ui";
import type { ProjectNode } from "./model";
import { packageKindAt } from "./packages";
import type { BuildPresentation } from "@/platform/projectPresentation";

const ROLE_KIND: Record<FolderRole, FolderKind> = {
  source: "source",
  test: "test",
  resources: "resources",
  testResources: "testResources",
  excluded: "excluded",
};

/**
 * Project Structure marks and roots detected from build files. Like IDEA, only
 * excluded folders get the excluded icon; git-ignored ones keep the plain one.
 */
export function folderKind(
  node: Pick<ProjectNode, "path" | "excluded">,
  roots: readonly RootFolder[],
  root: string | null,
  build?: BuildPresentation,
  detected: readonly RootFolder[] = [],
): FolderKind {
  const rel = root ? (node.path === root ? "" : relativePath(root, node.path)) : null;
  const role = rel === null ? null : rootRole(roots, rel);
  const exact = roots.find((r) => r.path === rel);
  const output = rel === null ? null : outputFolderKind(rel, build?.modules ?? new Map());
  if (role && (exact?.detectedFrom === null || output === "generatedSource" || output === "generatedTest"))
    return ROLE_KIND[role];
  const containing = rel === null ? null : rootFor(roots, rel);
  if (node.excluded || containing?.kind === "excluded") return "excluded";
  if (role) return ROLE_KIND[role];
  if (output) return output;
  if (rel !== null && (containing?.kind === "source" || containing?.kind === "test")) {
    const inModule = [...(build?.modules.keys() ?? [])].some((dir) => !dir || rel.startsWith(`${dir}/`));
    if (inModule || packageKindAt(rel, roots, detected) === "jvm") return "package";
  }
  return basename(node.path) === ".github" ? "github" : "plain";
}

/** Output roles are relative to detected JVM modules, never arbitrary package names. */
export function outputFolderKind(rel: string, modules: BuildPresentation["modules"]): FolderKind | null {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    const output = parts[i];
    if (output !== "target" && output !== "build") continue;
    const tool = modules.get(parts.slice(0, i).join("/"));
    if (tool !== (output === "target" ? "maven" : "gradle")) continue;
    const path = parts.slice(i + 1).join("/");
    if (/^generated-test-sources(\/|$)/.test(path) || /^generated\/.*\btest\b/.test(path)) return "generatedTest";
    if (/^(generated-sources|generated)(\/|$)/.test(path)) return "generatedSource";
    if (/^(classes|test-classes)(\/|$)/.test(path)) return "compiled";
    if (/^(site\/apidocs|apidocs|docs\/javadoc|javadoc)(\/|$)/.test(path)) return "javadoc";
  }
  return null;
}
