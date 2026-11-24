/** Which "New › Package" flavour a folder offers, from the project's roots. */
import { rootFor, type RootFolder } from "@/platform/languageSettings";
import type { PackageKind } from "./paths";

// `Gradle` marks the source sets a Gradle sync reported (ide-host `with_gradle_roots`).
const JVM_BUILD = /^Gradle$|(^|\/)(pom\.xml|build\.gradle(\.kts)?|\.classpath)$/;
const PY_BUILD = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements\.txt)$/;
const JVM_DIR = /(^|\/)(java|kotlin|scala|groovy)$/;

const moduleDir = (buildFile: string) =>
  buildFile.includes("/") ? buildFile.slice(0, buildFile.lastIndexOf("/")) : "";
const within = (rel: string, dir: string) => !dir || rel === dir || rel.startsWith(`${dir}/`);

/**
 * `jvm` inside a Java / Kotlin source or test root (IDEA shows "Package" there
 * instead of "Directory"); `python` inside a Python module (PyCharm's "Python Package").
 */
export function packageKindAt(
  rel: string,
  roots: readonly RootFolder[],
  detected: readonly RootFolder[] = [],
): PackageKind | null {
  const root = rootFor(roots, rel);
  if (root?.kind === "excluded") return null;
  if (
    (root?.kind === "source" || root?.kind === "test") &&
    (JVM_BUILD.test(root.detectedFrom ?? "") || JVM_DIR.test(root.path))
  )
    return "jvm";
  const python = [...roots, ...detected].some(
    (r) => r.detectedFrom && PY_BUILD.test(r.detectedFrom) && within(rel, moduleDir(r.detectedFrom)),
  );
  return python ? "python" : null;
}
