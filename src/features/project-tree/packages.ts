/** Which "New › Package" flavour a folder offers, from the project's roots. */
import { rootFor, type RootFolder } from "@/platform/languageSettings";
import { isJvmSourcePackage } from "@/ui/folderPresentation";
import type { PackageKind } from "./paths";

const PY_BUILD = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements\.txt)$/;

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
  if (rootFor(roots, rel)?.kind === "excluded") return null;
  if (isJvmSourcePackage(rel, roots)) return "jvm";
  const python = [...roots, ...detected].some(
    (r) => r.detectedFrom && PY_BUILD.test(r.detectedFrom) && within(rel, moduleDir(r.detectedFrom)),
  );
  return python ? "python" : null;
}
